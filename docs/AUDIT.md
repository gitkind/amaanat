# AMAANAT — Part 1 audit (2026-11-08)

Branch audited: `feature/amaanat-ecommerce` at `a661718`.

## Architecture as found

- **Runtime:** plain Node (ESM, no dependencies). `api/index.js` is both a local `http` server and a Vercel handler. Route table maps `METHOD /path` to handlers in `lib/server.js`.
- **Data:** `lib/supabase.js` calls Supabase PostgREST with the **service-role key** from the server. If Supabase isn't configured, it falls back to `data/products.json` and `data/settings.json`.
- **Schema:** `database/migration.sql` holds 8 tables, plpgsql functions for checkout/finalize/release/stock, RLS enabled, and seeds for 7 products (`p01`–`p07`).
- **Payments:** `lib/razorpay.js` does order creation through the REST API and HMAC verification for payment and webhook signatures.
- **Frontend:** `index.html` is the landing page, with no shop. `app.js` and the storefront CSS in `styles.css` were written for `shop.html`, `product.html`, `cart.html`, `checkout.html` and `order-tracking.html`, **but none of those pages exist**.
- **Deploy:** `vercel.json` (legacy `builds`). There are no tests, no lint and no build step. No `.env` file is present.

## Implemented / partial / missing

| Area | Status | Notes |
|---|---|---|
| Product data (7 items, images) | Implemented | All `stockQuantity: null`, `inventoryConfirmed: false`, so nothing is buyable. This is correct per business rules. |
| Settings (shipping/tax) | Implemented | Shipping and tax are unconfirmed (`null`), so checkout is correctly blocked. |
| Products API | Partial | List only. No detail endpoint (`app.js` calls the non-existent `/api/products/:slug`), no search/filter/sort. |
| Storefront pages | Missing | Only the landing page exists. |
| Cart | Partial | localStorage only. Not persistent server-side, no wishlist. |
| Customer auth/profile/addresses | Missing | Only admin login exists. |
| Checkout + stock reservation | Partial | An atomic `FOR UPDATE` reservation exists, but see the bugs below. |
| Razorpay order + verify | Partial | Works in principle, but has critical flaws (below). |
| Webhook | Partial / incorrect | See below. |
| Order tracking | Partial | Works by ref + email, but has no rate limiting. |
| Admin APIs | Implemented | Products, stock, orders and settings, with no UI. |
| Rate limiting, security headers | Missing | |
| Tests / lint | Missing | |

## Critical security and correctness defects found

1. **Source and secrets are served publicly.** `serveStatic` serves *any* file under the repo root, so `/.env`, `/lib/server.js`, `/database/migration.sql` and `/.git/config` are all downloadable.
2. **Anyone can mark an order paid.** The `SECURITY DEFINER` functions (`finalize_paid_order`, `set_product_stock`, `release_checkout_order` …) keep Postgres's default `EXECUTE` grant to `PUBLIC`. With the public anon key, anyone can call `/rest/v1/rpc/finalize_paid_order` directly. The functions also have no `search_path` pinned.
3. **A payment for one order can finalize another.** `/api/verify` checks the HMAC for `(razorpayOrderId, paymentId)` but then finalizes `body.orderId`, a different, client-chosen order. `finalize_paid_order` never checks that the Razorpay order ID or the amount belongs to that order. Pay ₹1 on order A and you can mark order B paid.
4. **The webhook never finalizes real payments.** It expects `payment.notes.client_signature`, which Razorpay never sends, so every captured payment is recorded as `captured_unverified`.
5. **A failed payment attempt releases stock.** `payment.failed` releases the reservation, but Razorpay lets the customer retry on the same order. A later success then produces a paid order whose stock was already released, which causes overselling.
6. **Anyone can cancel any order.** `/api/cancel` releases stock for any `orderId` without checking ownership, and without checking whether Razorpay already captured a payment.
7. **Idempotency isn't enforced.** `client_token` has no unique constraint, so concurrent duplicate submits create two orders.
8. **Reservations never expire.** Abandoned checkouts hold stock forever.
9. **PostgREST filter injection.** Admin endpoints interpolate `id` into filters unencoded, e.g. `orders?id=eq.${id}`.
10. **CORS is `*` by default.**
11. **Quantity validation runs after the stock comparison** in SQL, so negative quantities reach the stock check.
12. **Vercel config won't serve static files.** With a `builds` array, only `api/index.js` is built. `data/*.json` also isn't bundled for the function.

## Implementation plan (phased)

1. **Safety first:** move the public site to `public/` and serve only that folder. Add security headers, same-origin CORS and an Origin check on mutating requests. Add rate limiting.
2. **DB migration `002`** (idempotent, additive, no data overwrite):
   - Revoke function execution from `PUBLIC`/`anon`/`authenticated`.
   - Replace the checkout, finalize and release functions with order-bound, amount-checked, idempotent versions.
   - Add reservation expiry, `payment_transactions` uniqueness and `webhook_events` dedupe.
   - Add customer profiles, addresses, carts, cart items and wishlist.
   - Add product `images`, indexes and RLS on new tables.
   - Expose read RPCs so the server never builds filter strings.
3. **Data layer:** a single `rpc()` interface with a Supabase PostgREST adapter (production) and a PGlite adapter (local dev and tests, real Postgres).
4. **APIs:**
   - Catalogue list/detail/search/filter/sort and collections.
   - Customer auth (Supabase Auth; HttpOnly cookie sessions), profile and addresses.
   - Server cart (guest cookie or user) with merge-on-login, and wishlist.
   - Checkout with server-side pricing, Razorpay order creation, verify with Razorpay payment fetch, webhook, cancel with reconcile, and order view/tracking.
5. **Frontend:** shop, product, cart, checkout (Razorpay Checkout.js), order confirmation, tracking and account pages, using the existing design system.
6. **Tests and lint:** `node:test` against real migrations in PGlite (stock races, idempotency, signature checks, cross-order attack, webhook dedupe, expiry) and ESLint.

### What will NOT be invented

Stock counts, shipping charges, tax rate and business policies stay as they are (unconfirmed). Checkout stays blocked until an admin confirms stock and shipping. Tests and local dev use clearly-marked throwaway fixture values only, never production data.
