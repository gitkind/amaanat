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
    // scope "global" ends every session of the user (used after a password reset).
    async signOut(accessToken, { scope } = {}) {
      await call(`/logout${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { token: accessToken }).catch(() => {});
    },

    // Same endpoint supabase-js resetPasswordForEmail() uses. Never reveals whether the email exists.
    async recover(email, redirectTo) {
      const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
      const r = await call(`/recover${query}`, { body: { email } });
      if (r.status === 429) throw new AuthError("rate_limited", "Too many reset emails were requested. Try again later.", 429);
      if (r.status >= 500) throw new AuthError("recover_failed", "The reset email could not be sent right now.", 502);
      return true;
    },

    // For email links that carry a token_hash (recommended template). Returns a short session or null.
    async verifyRecovery(tokenHash) {
      const r = await call("/verify", { body: { type: "recovery", token_hash: tokenHash } });
      return r.ok ? normaliseSession(r.json) : null;
    },

    async updatePassword(accessToken, password) {
      const r = await call("/user", { method: "PUT", token: accessToken, body: { password } });
      if (r.ok) return true;
      const code = String(r.json?.error_code || r.json?.code || "");
      const msg = String(r.json?.msg || r.json?.message || r.json?.error_description || "");
      if (code === "same_password" || /different from the old/i.test(msg)) {
        throw new AuthError("same_password", "Choose a password that is different from your current one.", 422);
      }
      if (code === "weak_password" || /password/i.test(msg)) {
        throw new AuthError("weak_password", msg || "That password is too weak. Choose a stronger one.", 422);
      }
      if (r.status === 401 || r.status === 403) {
        throw new AuthError("recovery_expired", "This reset link has expired. Request a new one.", 401);
      }
      throw new AuthError("reset_failed", "The password could not be changed right now. Try again.", 502);
    },
  };
}
