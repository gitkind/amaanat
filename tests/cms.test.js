import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { cleanDocument, cleanHref, defaultDocument } from "../lib/cms.js";
import { PNG_1PX as PNG, createClient, startTestServer } from "./helpers.js";

let t;
before(async () => {
  t = await startTestServer();
  t.owner = await t.adminClient("cms-owner@example.test", "owner");
  t.manager = await t.adminClient("cms-manager@example.test", "manager");
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

const page = async (path, client) => {
  if (client) {
    const r = await client.get(path);
    return { status: r.status, body: r.text ?? r.body, headers: r.headers };
  }
  const res = await fetch(t.base + path);
  return { status: res.status, body: await res.text(), headers: res.headers };
};


describe("CMS validation", () => {
  test("links: site paths and https only — script and protocol-relative links are refused", () => {
    assert.equal(cleanHref("/shop"), "/shop");
    assert.equal(cleanHref("https://instagram.com/x"), "https://instagram.com/x");
    assert.equal(cleanHref("mailto:hello@example.com"), "mailto:hello@example.com");
    for (const bad of ["javascript:alert(1)", "//evil.example", "data:text/html,x", "http://plain.example", "/x\"onmouseover=1"]) {
      assert.throws(() => cleanHref(bad), /not a valid link/, bad);
    }
  });

  test("sections are normalised: unknown fields dropped, layouts and sources constrained", () => {
    const doc = cleanDocument("home", { sections: [
      { type: "hero", layout: "evil", title: "<b>Hi</b>", injected: "x", buttons: [{ label: "Go", href: "/shop" }, { label: "", href: "/x" }] },
      { type: "featuredProducts", source: "sql", limit: "999" },
    ] });
    const [hero, fp] = doc.sections;
    assert.equal(hero.layout, "split-right");
    assert.equal(hero.title, "<b>Hi</b>", "stored as text; escaped when rendered");
    assert.equal(hero.injected, undefined);
    assert.deepEqual(hero.buttons, [{ label: "Go", href: "/shop" }]);
    assert.equal(fp.source, "featured");
    assert.equal(fp.limit, "4");
    assert.throws(() => cleanDocument("home", { sections: [{ type: "script" }] }), /Unknown section type/);
    assert.throws(() => cleanDocument("secret", {}), /Unknown content/);
    assert.throws(() => cleanDocument("home", { sections: [{ type: "imageText", image: { src: "javascript:x" } }] }), /image/);
  });

  test("default homepage reproduces the original sections", () => {
    const d = defaultDocument("home", { homepage: { heroSubtitle: "Some things are too precious to lose." }, promise: [["A", "B"]] });
    assert.deepEqual(d.sections.map((s) => s.type), ["hero", "categories", "featuredProducts", "featuredProducts", "story", "featuredProducts", "highlights"]);
  });
});

describe("CMS draft → preview → publish → restore", () => {
  test("only admins can read; only the owner can change", async () => {
    const anon = createClient(t.base);
    assert.equal((await anon.get("/api/admin/cms/home")).status, 401);
    assert.equal((await t.manager.get("/api/admin/cms/home")).status, 200);
    assert.equal((await t.manager.put("/api/admin/cms/home", { content: { sections: [] } })).status, 403);
    assert.equal((await t.manager.post("/api/admin/cms/home/publish", {})).status, 403);
    const schema = await t.owner.get("/api/admin/cms/schema");
    assert.equal(schema.status, 200);
    for (const type of ["hero", "imageText", "featuredProducts", "categories", "promo", "story", "testimonials", "newsletter", "text"]) {
      assert.ok(schema.body.sectionTypes[type], type);
    }
  });

  test("a draft is invisible to customers until published; preview shows it to admins only", async () => {
    const before = await t.owner.get("/api/admin/cms/home");
    assert.equal(before.body.isDefault, true);
    const sections = before.body.content.sections;
    const hero = { ...sections[0], title: "Draft headline <script>x</script>" };
    const promo = { type: "promo", layout: "gold", title: "Festive edit", text: "New pieces", buttons: [{ label: "See them", href: "/shop" }] };
    const saved = await t.owner.put("/api/admin/cms/home", { content: { sections: [promo, hero, ...sections.slice(1)] } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.hasUnpublishedChanges, true);

    assert.doesNotMatch((await page("/")).body, /Draft headline|Festive edit/, "public site unchanged");
    const anonPreview = await page("/?preview=draft");
    assert.doesNotMatch(anonPreview.body, /Draft headline/, "preview requires admin");
    assert.match(anonPreview.headers.get("cache-control"), /no-store/);

    const preview = await page("/?preview=draft", t.owner);
    assert.match(preview.body, /Draft headline &lt;script&gt;x&lt;\/script&gt;/, "escaped");
    assert.match(preview.body, /Preview of unpublished changes/);
    assert.match(preview.body, /noindex/);

    const pub = await t.owner.post("/api/admin/cms/home/publish", {});
    assert.equal(pub.status, 200);
    assert.equal(pub.body.publishedVersion, 1);
    assert.equal(pub.body.hasUnpublishedChanges, false);
    const live = (await page("/")).body;
    assert.match(live, /Festive edit/);
    assert.ok(live.indexOf("Festive edit") < live.indexOf("Draft headline"), "section order follows the editor");
    assert.equal((live.match(/<h1[\s>]/g) || []).length, 1, "exactly one h1");
  });

  test("hidden and removed sections disappear; earlier versions can be restored", async () => {
    const cur = (await t.owner.get("/api/admin/cms/home")).body.content.sections;
    const next = cur.map((s) => (s.type === "promo" ? { ...s, enabled: false } : s)).filter((s) => s.type !== "highlights");
    await t.owner.post("/api/admin/cms/home/publish", { content: { sections: next } });
    let live = (await page("/")).body;
    assert.doesNotMatch(live, /Festive edit/, "hidden");
    assert.doesNotMatch(live, /Jewellery you can live in/, "removed");

    const state = (await t.owner.get("/api/admin/cms/home")).body;
    assert.deepEqual(state.versions.map((v) => v.version), [2, 1]);
    const restored = await t.owner.post("/api/admin/cms/home/restore", { version: 1 });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.hasUnpublishedChanges, true);
    assert.doesNotMatch((await page("/")).body, /Festive edit/, "restore only changes the draft");
    await t.owner.post("/api/admin/cms/home/publish", {});
    live = (await page("/")).body;
    assert.match(live, /Festive edit/);
    assert.equal((await t.owner.post("/api/admin/cms/home/restore", { version: 99 })).status, 404);
  });

  test("discarding a draft returns to the live version", async () => {
    const cur = (await t.owner.get("/api/admin/cms/home")).body.content;
    await t.owner.put("/api/admin/cms/home", { content: { sections: [] } });
    const d = await t.owner.post("/api/admin/cms/home/discard", {});
    assert.equal(d.body.hasUnpublishedChanges, false);
    assert.equal(d.body.content.sections.length, cur.sections.length);
  });

  test("Meet the Founder: placeholder until the owner publishes real details", async () => {
    let r = await page("/meet-the-founder");
    assert.equal(r.status, 200);
    assert.match(r.body, /coming soon/);
    assert.match(r.body, /noindex/);
    assert.doesNotMatch((await page("/sitemap.xml")).body, /meet-the-founder/);

    const up = await t.owner.upload("/api/admin/cms/images", PNG);
    assert.equal(up.status, 201);
    const content = { visible: true, name: "Test Founder", designation: "Founder", image: { src: up.body.url, alt: "Portrait" }, bio: "Bio text.", story: "Story text.", mission: "Mission text.", vision: "Vision text.", message: "Hello." };
    await t.owner.post("/api/admin/cms/founder/publish", { content });
    r = await page("/meet-the-founder");
    assert.match(r.body, /<h1>Test Founder<\/h1>/);
    assert.match(r.body, /Story text\./);
    assert.match(r.body, new RegExp(up.body.url.replace(/[/.]/g, "\\$&")));
    assert.doesNotMatch(r.body, /name="robots" content="noindex/);
    assert.match((await page("/sitemap.xml")).body, /meet-the-founder/);
    assert.match((await page("/")).body, /href="\/meet-the-founder"/, "linked once live");
  });

  test("image upload checks the real file type and needs the owner", async () => {
    assert.equal((await t.owner.upload("/api/admin/cms/images", Buffer.from("<svg onload=alert(1)>............"))).status, 415);
    assert.equal((await t.manager.upload("/api/admin/cms/images", PNG)).status, 403);
  });

  test("menu & footer content is published site-wide", async () => {
    await t.owner.post("/api/admin/cms/site/publish", { content: { tagline: "Footer tagline test", footerLinks: [{ label: "Gift guide", href: "/collections/sets" }] } });
    const home = (await page("/shop")).body;
    assert.match(home, /Footer tagline test/);
    assert.match(home, /href="\/collections\/sets">Gift guide/);
    assert.equal((await t.owner.put("/api/admin/cms/site", { content: { footerLinks: [{ label: "x", href: "javascript:alert(1)" }] } })).status, 400);
  });
});
