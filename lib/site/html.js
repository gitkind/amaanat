// Tiny safe templating: every interpolation is HTML-escaped unless wrapped in raw().
const RAW = Symbol("raw");

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function raw(value) {
  return { [RAW]: true, value: String(value ?? "") };
}

function render(v) {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (typeof v === "object" && v[RAW]) return v.value;
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

export const toString = (v) => render(v);

export function formatINR(paise) {
  if (!Number.isInteger(paise)) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: paise % 100 === 0 ? 0 : 2 }).format(paise / 100);
}

// JSON for <script type="application/ld+json"> / application/json: escape "<" so it can't close the tag.
export function jsonScript(obj) {
  return JSON.stringify(obj).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// Minimal, safe formatter for admin-written policy text:
// blank line = paragraph, "## " = heading, "- " = list item. No raw HTML.
export function formatPlainText(text) {
  const blocks = String(text || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return raw(blocks.map((block) => {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) return "";
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
    }
    if (lines[0].startsWith("## ")) {
      const rest = lines.slice(1);
      return `<h2>${esc(lines[0].slice(3))}</h2>${rest.length ? `<p>${rest.map(esc).join("<br>")}</p>` : ""}`;
    }
    return `<p>${lines.map(esc).join("<br>")}</p>`;
  }).join("\n"));
}
