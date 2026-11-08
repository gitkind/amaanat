// Fixed-window in-memory rate limiter.
// Note: on serverless (Vercel) each instance has its own memory, so limits are
// per instance. Good enough as a first line of defence; use a shared store
// (e.g. Upstash/Redis) for strict global limits.

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();

  function sweep(t) {
    if (buckets.size < 5000) return;
    for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
  }

  return {
    hit(key, limit, windowMs) {
      const t = now();
      sweep(t);
      let b = buckets.get(key);
      if (!b || b.reset <= t) {
        b = { count: 0, reset: t + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > limit) {
        return { ok: false, retryAfter: Math.ceil((b.reset - t) / 1000) };
      }
      return { ok: true, remaining: limit - b.count };
    },
    reset() {
      buckets.clear();
    },
  };
}
