import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { formatPlainText, jsonScript, toString } from "../lib/site/html.js";
import { startTestServer } from "./helpers.js";

let t;
before(async () => {
  t = await startTestServer();
  t.owner = await t.adminClient("site-owner@example.test", "owner");
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

const page = async (path) => {
  const res = await fetch(t.base + path, { redirect: "manual" });
  return { status: res.status, headers: res.headers, body: await res.text() };
};
const ldBlocks = (body) => [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const meta = (body, attr, name) => body.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];

describe("server-rendered pages and SEO", () => {
  test("every public page has a unique title, a description, a canonical URL and one h1", async () => {
    const paths = ["/", "/shop", "/collections/necklaces", "/collections/sets", "/products/marquise-clover-pendant", "/about", "/contact", "/track"];
    const titles = new Set();
    for (const p of paths) {
      const r = await page(p);
      assert.equal(r.status, 200, p);
      const title = r.body.match(/<title>([^<]+)<\/title>/)[1];
      assert.ok(!titles.has(title), `duplicate title ${title}`);
      titles.add(title);
      assert.ok(meta(r.body, "name", "description")?.length > 30, `${p} description`);
      assert.match(r.body, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal((r.body.match(/<h1[\s>]/g) || []).length, 1, `${p} h1 count`);
      assert.ok(meta(r.body, "property", "og:title"), `${p} og:title`);
      assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
      assert.match(r.body, /<html lang="en-IN">/);
      assert.match(r.body, /href="#main"/, "skip link");
    }
  });

  test("product page renders real data server-side; no price offer while stock is unconfirmed", async () => {
    const r = await page("/products/daisy-bloom-set");
    assert.match(r.body, /<h1>Daisy Bloom Set<\/h1>/);
    assert.match(r.body, /₹449/);
    assert.match(r.body, /Stock to be confirmed/);
    const product = ldBlocks(r.body).find((j) => j["@type"] === "Product");
    assert.equal(product.name, "Daisy Bloom Set");
    assert.equal(product.offers, undefined, "never advertise unconfirmed stock as an offer");
    assert.ok(!("aggregateRating" in product) && !("review" in product), "no invented ratings or reviews");
    assert.ok(ldBlocks(r.body).some((j) => j["@type"] === "BreadcrumbList"));
    assert.match(r.body, /srcset="\/assets\/opt\/daisy-bloom-set-400\.webp 400w/, "responsive images");
    assert.match(r.body, /fetchpriority="high"/, "main image prioritised");
  });

  test("offer appears once stock is confirmed, with the real price", async () => {
    await t.setStock("p07", 3);
    const r = await page("/products/petal-leaf-anklet");
    const product = ldBlocks(r.body).find((j) => j["@type"] === "Product");
    assert.deepEqual(
      { price: product.offers.price, currency: product.offers.priceCurrency, availability: product.offers.availability },
      { price: "399.00", currency: "INR", availability: "https://schema.org/InStock" },
    );
    assert.match(r.body, /Add to bag/);
  });

  test("shop filters work without JavaScript; filtered views are noindex", async () => {
    const r = await page("/shop?q=clover");
    assert.match(r.body, /2 pieces/);
    assert.match(r.body, /<meta name="robots" content="noindex, follow">/);
    assert.doesNotMatch((await page("/shop")).body, /noindex/);
    const coll = await page("/collections/anklets");
    assert.match(coll.body, /Petal Leaf Anklet/);
    assert.doesNotMatch(coll.body, /Marquise Clover Pendant<\/a><\/h3>/);
    assert.equal((await page("/collections/does-not-exist")).status, 404);
  });

  test("user content is escaped in pages", async () => {
    await t.owner.post("/api/admin/products", { name: "<script>alert(1)</script>", slug: "xss-test", description: "<img src=x onerror=alert(1)>", category: "Rings", pricePaise: 100 });
    const r = await page("/products/xss-test");
    assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(r.body, /<img src=x onerror/);
    assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(jsonScript({ a: "</script><b>" }), '{"a":"\\u003c/script>\\u003cb>"}');
  });

  test("homepage: no best-seller section without paid orders; admin content and announcement appear", async () => {
    let r = await page("/");
    assert.doesNotMatch(r.body, /Best sellers/, "no invented best sellers");
    assert.doesNotMatch(r.body, /class="announcement"/);
    assert.ok(ldBlocks(r.body).some((j) => j["@type"] === "Organization"));
    await t.owner.put("/api/admin/settings", { announcementText: "Test notice", announcementEnabled: true, homepage: { heroSubtitle: "Admin tagline" } });
    r = await page("/");
    assert.match(r.body, /<div class="announcement">Test notice<\/div>/);
    assert.match(r.body, /Admin tagline/);
    assert.match((await page("/shop")).body, /Test notice/, "announcement on every page");
  });

  test("policy pages show published admin text only; unpublished pages say so and are noindex", async () => {
    let r = await page("/shipping");
    assert.equal(r.status, 200);
    assert.match(r.body, /being prepared/);
    assert.match(r.body, /noindex/);
    assert.doesNotMatch(r.body, /href="\/shipping">Shipping<\/a>/, "footer hides unpublished policies");
    await t.owner.put("/api/admin/pages/shipping", { title: "Shipping policy", body: "## Dispatch\nTest dispatch text for the test suite.\n\n- First point\n- Second point", published: true });
    r = await page("/shipping");
    assert.match(r.body, /<h2>Dispatch<\/h2>/);
    assert.match(r.body, /<ul><li>First point<\/li><li>Second point<\/li><\/ul>/);
    assert.doesNotMatch(r.body, /noindex/);
    assert.match((await page("/")).body, /href="\/shipping">Shipping<\/a>/);
  });

  test("contact page uses only configured details", async () => {
    let r = await page("/contact");
    assert.doesNotMatch(r.body, /mailto:/, "no email until configured");
    assert.match(r.body, /instagram\.com\/amanaat\.ind/);
    await t.owner.put("/api/admin/settings", { contactEmail: "care@example.test", whatsappE164: "+919876543210" });
    r = await page("/contact");
    assert.match(r.body, /mailto:care@example\.test/);
    assert.match(r.body, /https:\/\/wa\.me\/919876543210/);
  });

  test("sitemap lists real pages; robots.txt blocks private areas; app pages are noindex", async () => {
    const sm = await page("/sitemap.xml");
    assert.match(sm.headers.get("content-type"), /xml/);
    assert.match(sm.body, /\/products\/marquise-clover-pendant<\/loc>/);
    assert.match(sm.body, /\/collections\/necklaces<\/loc>/);
    assert.doesNotMatch(sm.body, /\/cart|\/checkout|\/admin/);
    const robots = await page("/robots.txt");
    assert.equal(robots.body, "User-agent: *\nDisallow: /\n", "non-production servers ask not to be indexed");
    for (const p of ["/cart", "/checkout", "/account", "/order", "/wishlist"]) assert.match((await page(p)).body, /noindex/, p);
  });

  test("legacy URLs redirect permanently; unknown pages return a 404 page", async () => {
    const r = await page("/product.html?slug=daisy-bloom-set");
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/products/daisy-bloom-set");
    assert.equal((await page("/order.html?id=abc")).headers.get("location"), "/order?id=abc");
    const nf = await page("/no-such-page");
    assert.equal(nf.status, 404);
    assert.match(nf.body, /We couldn't find that page/);
    assert.match(nf.body, /noindex/);
  });

  test("versioned CSS/JS are cached long-term", async () => {
    const home = (await page("/")).body;
    const css = home.match(/href="(\/styles\.css\?v=[a-f0-9]+)"/)[1];
    const res = await fetch(t.base + css);
    assert.match(res.headers.get("cache-control"), /max-age=31536000, immutable/);
    assert.match(home, /<script src="\/app\.js\?v=[a-f0-9]+" defer>/);
  });
});

describe("newsletter", () => {
  test("validates, stores once, reveals nothing about existing sign-ups, owner can list", async () => {
    const c = t.client();
    assert.equal((await c.post("/api/newsletter", { email: "nope" })).status, 400);
    const a = await c.post("/api/newsletter", { email: "Reader@Example.test" });
    const b = await c.post("/api/newsletter", { email: "reader@example.test" });
    assert.equal(a.status, 200);
    assert.deepEqual({ ...a.body, _status: 0 }, { ...b.body, _status: 0 }, "same response for new and existing");
    const list = await t.owner.get("/api/admin/newsletter");
    assert.equal(list.body.subscribers.filter((s) => s.email === "reader@example.test").length, 1);
    assert.equal((await t.client().get("/api/admin/newsletter")).status, 401);
    for (let i = 0; i < 5; i++) await c.post("/api/newsletter", { email: `r${i}@example.test` });
    assert.equal((await c.post("/api/newsletter", { email: "late@example.test" })).status, 429);
  });
});

describe("policy text formatter", () => {
  test("supports headings, lists and paragraphs, never raw HTML", () => {
    const out = toString(formatPlainText("## Title\nline one\n\n- a\n- <b>b</b>\n\nPara <i>x</i>"));
    assert.equal(out, "<h2>Title</h2><p>line one</p>\n<ul><li>a</li><li>&lt;b&gt;b&lt;/b&gt;</li></ul>\n<p>Para &lt;i&gt;x&lt;/i&gt;</p>");
  });
});

describe("robots.txt in production", () => {
  test("allows indexing, blocks private areas and points to the sitemap", async () => {
    const { robotsTxt } = await import("../lib/site/pages.js");
    const txt = robotsTxt("https://shop.example", { production: true });
    assert.match(txt, /Disallow: \/admin\//);
    assert.match(txt, /Disallow: \/checkout/);
    assert.match(txt, /Sitemap: https:\/\/shop\.example\/sitemap\.xml/);
    assert.doesNotMatch(txt, /Disallow: \/\n/);
  });
});
