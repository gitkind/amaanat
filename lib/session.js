import crypto from "node:crypto";
import { appendCookie, parseCookies, serializeCookie } from "./http.js";

export const COOKIE = { access: "am_at", refresh: "am_rt", cart: "am_cart" };
const REFRESH_MAX_AGE = 30 * 86400;
const CART_MAX_AGE = 180 * 86400;

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function createSessionManager({ auth, secure }) {
  function setSession(res, session) {
    appendCookie(res, serializeCookie(COOKIE.access, session.accessToken, { maxAge: session.expiresIn, secure }));
    appendCookie(res, serializeCookie(COOKIE.refresh, session.refreshToken, { maxAge: REFRESH_MAX_AGE, secure }));
  }

  function clearSession(res) {
    appendCookie(res, serializeCookie(COOKIE.access, "", { maxAge: 0, secure }));
    appendCookie(res, serializeCookie(COOKIE.refresh, "", { maxAge: 0, secure }));
  }

  // Returns the signed-in user or null. Transparently refreshes an expired access token.
  async function currentUser(req, res) {
    if (req._amUser !== undefined) return req._amUser;
    req._amUser = null;
    if (!auth) return null;
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE.access]) {
      const user = await auth.getUser(cookies[COOKIE.access]).catch(() => null);
      if (user) return (req._amUser = user);
    }
    if (cookies[COOKIE.refresh]) {
      const session = await auth.refresh(cookies[COOKIE.refresh]).catch(() => null);
      if (session?.user?.id) {
        setSession(res, session);
        return (req._amUser = session.user);
      }
      clearSession(res);
    }
    return null;
  }

  function guestCartToken(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE.cart];
    return value && /^[A-Za-z0-9_-]{32,64}$/.test(value) ? value : null;
  }

  function ensureGuestCartToken(req, res) {
    let token = guestCartToken(req);
    if (!token) {
      token = randomToken();
      appendCookie(res, serializeCookie(COOKIE.cart, token, { maxAge: CART_MAX_AGE, secure }));
      req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ""}${COOKIE.cart}=${token}`;
    }
    return token;
  }

  function clearGuestCart(res) {
    appendCookie(res, serializeCookie(COOKIE.cart, "", { maxAge: 0, secure }));
  }

  return { setSession, clearSession, currentUser, guestCartToken, ensureGuestCartToken, clearGuestCart };
}
