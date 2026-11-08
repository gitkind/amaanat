export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function readRaw(req) {
  if (req.rawBody) return Buffer.from(req.rawBody);
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
