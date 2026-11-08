// Customer authentication via Supabase Auth (GoTrue REST) using the anon key.
// Tokens are kept in HttpOnly cookies by lib/session.js, never in JS storage.

export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

function normaliseSession(json) {
  if (!json?.access_token) return null;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: Number(json.expires_in) || 3600,
    user: { id: json.user?.id, email: json.user?.email },
  };
}

export function createSupabaseAuth({ url, anonKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = `${url.replace(/\/+$/, "")}/auth/v1`;

  async function call(path, { method = "POST", body, token } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, json };
  }

  return {
    kind: "supabase",
    async signUp(email, password) {
      const r = await call("/signup", { body: { email, password } });
      if (!r.ok) {
        const msg = String(r.json?.msg || r.json?.error_description || r.json?.message || "");
        if (/already/i.test(msg)) throw new AuthError("email_taken", "An account with this email already exists.", 409);
        if (/password/i.test(msg)) throw new AuthError("weak_password", msg, 400);
        throw new AuthError("signup_failed", "The account could not be created.", r.status >= 500 ? 502 : 400);
      }
      const session = normaliseSession(r.json);
      const user = session?.user || { id: r.json?.id || r.json?.user?.id, email };
      return { user, session, needsConfirmation: !session };
    },
    async signIn(email, password) {
      const r = await call("/token?grant_type=password", { body: { email, password } });
      if (!r.ok) {
        const msg = String(r.json?.error_description || r.json?.msg || "");
        if (/confirm/i.test(msg)) throw new AuthError("email_not_confirmed", "Confirm your email first.", 403);
        throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401);
      }
      return normaliseSession(r.json);
    },
    async refresh(refreshToken) {
      const r = await call("/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
      return r.ok ? normaliseSession(r.json) : null;
    },
    async getUser(accessToken) {
      const r = await call("/user", { method: "GET", token: accessToken });
      return r.ok && r.json?.id ? { id: r.json.id, email: r.json.email } : null;
    },
    async signOut(accessToken) {
      await call("/logout", { token: accessToken }).catch(() => {});
    },
  };
}
