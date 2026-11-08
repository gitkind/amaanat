const CSP = [
  "default-src 'self'",
  "script-src 'self' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function setSecurityHeaders(res, { html = false, production = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self \"https://checkout.razorpay.com\" \"https://api.razorpay.com\")");
  if (html) res.setHeader("Content-Security-Policy", CSP);
  if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

export function requestOrigin(req, trustProxy) {
  const proto = trustProxy && req.headers["x-forwarded-proto"]
    ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
    : req.socket?.encrypted ? "https" : "http";
  const host = trustProxy && req.headers["x-forwarded-host"]
    ? String(req.headers["x-forwarded-host"]).split(",")[0].trim()
    : req.headers.host;
  return host ? `${proto}://${host}` : null;
}

// CSRF defence for cookie-authenticated, state-changing requests:
// the browser must report a same-origin request.
export function isSameOriginRequest(req, { trustProxy, allowed = [] }) {
  const origin = req.headers.origin;
  if (origin) {
    if (origin === "null") return false;
    const self = requestOrigin(req, trustProxy);
    return origin === self || allowed.includes(origin);
  }
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  // Non-browser clients (curl, server-to-server) send neither header.
  return true;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}
