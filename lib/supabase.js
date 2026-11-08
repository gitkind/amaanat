function envReady() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY);
}

export function databaseConfigured() {
  return envReady();
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(json?.message || json?.error || "Database request failed.");
    error.status = response.status;
    error.details = json;
    throw error;
  }
  return json;
}

export async function rpc(name, args) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(json?.message || "Database function failed.");
    error.status = response.status;
    error.details = json;
    throw error;
  }
  return json;
}

export const sb = { rest, rpc };

export async function signInAdmin(email, password) {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return json;
}

export async function userFromToken(token) {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return null;
  return response.json();
}

export async function requireAdmin(req) {
  if (!databaseConfigured()) return { ok: false, status: 503, error: "database_not_configured" };
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401, error: "admin_required" };
  const user = await userFromToken(token);
  if (!user?.id) return { ok: false, status: 401, error: "admin_required" };
  const rows = await rest(`admin_users?user_id=eq.${user.id}&select=user_id`);
  if (!rows?.length) return { ok: false, status: 403, error: "admin_required" };
  return { ok: true, user };
}
