// Normalises database errors from PostgREST and PGlite into one shape.
// SQL functions raise short snake_case codes (e.g. 'insufficient_stock');
// those become `error.code`. Anything else is an internal error.

export class DbError extends Error {
  constructor(message, { code, detail, status } = {}) {
    super(message);
    this.name = "DbError";
    this.code = code || null;
    this.detail = detail || null;
    this.status = status || 500;
  }
}

const CODE_RE = /^[a-z][a-z0-9_]{2,60}$/;

export function toDbError(raw, status) {
  const message = String(raw?.message || "Database request failed.");
  const code = CODE_RE.test(message) ? message : null;
  const detail = raw?.detail ?? raw?.details ?? null;
  return new DbError(message, { code, detail: typeof detail === "string" ? detail : null, status });
}
