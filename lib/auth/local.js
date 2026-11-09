// LOCAL DEVELOPMENT / TEST auth provider backed by the PGlite auth.users shim.
// Mirrors the Supabase provider interface. Refuses to run in production.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { AuthError } from "./supabase.js";

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function checkPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored || "").split("$");
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), 32);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

// onEmail({ to, link }) stands in for the email service (dev: logged to the console; tests: captured).
export function createLocalAuth({ pg, secret, now = () => Date.now(), onEmail = () => {} }) {
  if (process.env.NODE_ENV === "production") throw new Error("Local auth is for development only");
  const key = secret || crypto.randomBytes(32).toString("hex");
  const resets = new Map(); // sha256(token) -> { id, email, exp }
  const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", key).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  function verify(token, typ) {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", key).update(body).digest("base64url");
    if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.typ !== typ || payload.exp * 1000 < now()) return null;
    return payload;
  }

  function session(user) {
    const t = Math.floor(now() / 1000);
    return {
      accessToken: sign({ sub: user.id, email: user.email, typ: "access", exp: t + 3600, jti: crypto.randomUUID() }),
      refreshToken: sign({ sub: user.id, email: user.email, typ: "refresh", exp: t + 30 * 86400, jti: crypto.randomUUID() }),
      expiresIn: 3600,
      user: { id: user.id, email: user.email },
    };
  }

  return {
    kind: "local",
    async signUp(email, password) {
      const hash = await hashPassword(password);
      try {
        const { rows } = await pg.query(
          "INSERT INTO auth.users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
          [email, hash],
        );
        return { user: rows[0], session: session(rows[0]), needsConfirmation: false };
      } catch (error) {
        if (String(error.message).includes("duplicate")) {
          throw new AuthError("email_taken", "An account with this email already exists.", 409);
        }
        throw error;
      }
    },
    async signIn(email, password) {
      const { rows } = await pg.query("SELECT id, email, password_hash FROM auth.users WHERE email = $1", [email]);
      if (!rows[0] || !(await checkPassword(password, rows[0].password_hash))) {
        throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401);
      }
      return session(rows[0]);
    },
    async refresh(refreshToken) {
      const p = verify(refreshToken, "refresh");
      return p ? session({ id: p.sub, email: p.email }) : null;
    },
    async getUser(accessToken) {
      const p = verify(accessToken, "access");
      return p ? { id: p.sub, email: p.email } : null;
    },
    async signOut() {},

    // Mirrors Supabase: silently does nothing for unknown emails.
    async recover(email, redirectTo) {
      const { rows } = await pg.query("SELECT id, email FROM auth.users WHERE email = $1", [email]);
      if (!rows[0]) return true;
      const token = crypto.randomBytes(24).toString("base64url");
      resets.set(sha(token), { id: rows[0].id, email: rows[0].email, exp: now() + 60 * 60 * 1000 });
      const base = redirectTo || "http://localhost:3000/reset-password";
      onEmail({ to: rows[0].email, link: `${base}?token_hash=${token}&type=recovery` });
      return true;
    },
    async verifyRecovery(tokenHash) {
      const entry = resets.get(sha(tokenHash));
      resets.delete(sha(tokenHash)); // single use
      if (!entry || entry.exp < now()) return null;
      return session({ id: entry.id, email: entry.email });
    },
    async updatePassword(accessToken, password) {
      const p = verify(accessToken, "access");
      if (!p) throw new AuthError("recovery_expired", "This reset link has expired. Request a new one.", 401);
      const { rows } = await pg.query("SELECT password_hash FROM auth.users WHERE id = $1", [p.sub]);
      if (rows[0] && (await checkPassword(password, rows[0].password_hash))) {
        throw new AuthError("same_password", "Choose a password that is different from your current one.", 422);
      }
      await pg.query("UPDATE auth.users SET password_hash = $1 WHERE id = $2", [await hashPassword(password), p.sub]);
      return true;
    },
  };
}
