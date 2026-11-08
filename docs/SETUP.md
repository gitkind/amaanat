# AMAANAT — setup and Part 1 status

## Run locally

```bash
npm install
npm run check                          # lint + 35 tests (real Postgres via PGlite)
npm run dev:local -- --test-fixtures   # http://localhost:3000, throwaway DB in ./.local-db
```

`--test-fixtures` sets placeholder stock (5 of each piece) and ₹0 shipping, **in the local DB only**, so checkout can be tried. Delete `.local-db/` to reset it.

To use Supabase instead, fill `.env` from `.env.example` and run `npm run dev`.

## Database migrations (Supabase SQL editor, in order)

| File | When |
|---|---|
| `database/migrations/001_base.sql` | Only on a fresh project. If it's already applied, skip it. |
| `database/migrations/002_ecommerce_core.sql` | Always. It's additive and re-runnable. |

`002` drops the four vulnerable 001 functions, revokes all function execution from `anon`/`authenticated`, and adds carts, wishlist, profiles, addresses, webhook dedupe, reservation expiry and the new `api_*` functions.

**Before running `002` on a database with orders:** if two orders share a `client_token`, `razorpay_order_id` or `razorpay_payment_id`, the unique indexes will fail and the whole migration rolls back. Check with:

```sql
select client_token, count(*) from orders where client_token is not null group by 1 having count(*) > 1;
```

`002` never changes prices, stock, settings or existing orders. The only write is backfilling `products.images` from `image_path`.

## Going live in Razorpay TEST mode (business owner steps)

1. **Supabase:** set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (server env only), then run the migrations.
2. **Razorpay** (Dashboard → Test mode):
   - Set `RAZORPAY_KEY_ID` (`rzp_test_…`) and `RAZORPAY_KEY_SECRET`.
   - Add a webhook to `https://<host>/api/webhooks/razorpay` with the events `payment.captured`, `payment.failed`, `payment.authorized` and `order.paid`.
   - Set `RAZORPAY_WEBHOOK_SECRET` to that webhook's secret.
3. Set `CRON_SECRET`. `vercel.json` calls `/api/internal/reconcile` every 15 minutes to release expired reservations, after checking Razorpay first.
4. **Confirm real business data** with the admin API. The code will not invent it:
   - Stock: `POST /api/admin/stock {productId, stockQuantity}` per product.
   - Shipping: `PATCH /api/admin/settings {shippingPaise, shippingConfirmed: true}`.
   - Tax: `taxConfirmed`/`taxRateBps`, only if it applies.
   - Admins are rows in `admin_users` (Supabase Auth user ids).
5. In Supabase Auth, decide whether email confirmation is on. Both cases are handled.

## Order and payment lifecycle

1. **Checkout:** a single transaction validates, locks products, decrements stock and creates a `pending` order with `reservation_expires_at`. Prices come from the DB.
2. **Razorpay order:** created server-side. The amount must equal the stored total, and the Razorpay order is bound to the AMAANAT order once.
3. **Verify:** the server checks the HMAC, checks the Razorpay order matches the stored one, and fetches the payment from Razorpay. Only `captured` with a matching amount becomes `paid`. `authorized` waits.
4. **Webhook:** raw-body HMAC, deduped on event id, idempotent on payment id. `payment.failed` is logged but doesn't release stock, because the customer may retry.
5. **Cancel or expiry:** asks Razorpay first. A captured payment finalizes the order, otherwise the reservation is released.
6. **Late payment after release:** stock is re-reserved if available. If not, the order is `paid` + `on_hold` + `needs_review` (refund by hand).
