# AMAANAT — setup, deployment and launch checklist

## 1. Run it locally (no accounts needed)

```bash
npm install
npm run check                          # lint + 71 automated tests (real Postgres via PGlite)
npm run build                          # production build check (pages, SEO tags, images, no secrets)
npm run dev:local -- --test-fixtures   # http://localhost:3000 on a throwaway DB in ./.local-db
```

`--test-fixtures` puts placeholder stock (5 of each) and ₹0 shipping into the **local database only**, so checkout can be exercised. Delete `.local-db/` to reset it.

To try the admin locally:
1. Register an account at `/account`.
2. Restart with `npm run dev:local -- --make-admin you@example.com`.
3. Sign in at `/admin/`.

There are no demo or shared admin accounts.

## 2. Environment variables (server only — never put these in front-end code)

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | yes | Database, customer and admin login, image storage. The service-role key stays on the server. |
| `SUPABASE_STORAGE_BUCKET` | no (default `product-images`) | Public bucket for product images and the logo. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | **Test** keys (`rzp_test_…`). Live keys are refused unless `RAZORPAY_ALLOW_LIVE=true`. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret of the Razorpay webhook (see §5). |
| `APP_BASE_URL` | yes in production | e.g. `https://amaanat.in`. Used for canonical URLs, the sitemap and Secure cookies. **Search engines are only allowed to index when this is set and `NODE_ENV=production`.** |
| `CRON_SECRET` | yes | Protects `/api/internal/reconcile`; Vercel Cron sends it automatically. |
| `RESERVATION_MINUTES` | no (30) | How long a checkout holds stock. |
| `NODE_ENV` | — | Vercel sets `production`. |

## 3. Database migrations (Supabase → SQL editor, in order)

| File | Notes |
|---|---|
| `001_base.sql` | Only on a fresh project. Skip it if it's already applied. |
| `002_ecommerce_core.sql` | Hardened checkout and payments, carts, accounts. Before running it on a DB that has orders, check for duplicate `client_token` / `razorpay_order_id` (see below). |
| `003_admin.sql` | Admin roles, audit log, product options (variants), refunds, settings, policy pages. |
| `004_newsletter.sql` | Newsletter sign-ups. |

All of them only add things and can be re-run safely. None of them changes prices, stock, settings values or existing orders.

To find duplicate client tokens (if any rows come back, the 002 unique index will fail):

```sql
select client_token, count(*) from orders where client_token is not null group by 1 having count(*) > 1;
```

### Make yourself the owner

Create your login, then run this in the SQL editor:

```sql
-- 1. Sign up at https://<your-site>/account (or create the user in Supabase → Authentication).
-- 2. Then:
insert into admin_users (user_id, role)
select id, 'owner' from auth.users where email = 'you@example.com'
on conflict (user_id) do update set role = 'owner';
-- Staff who should manage products, stock and shipping but not refunds or settings: role 'manager'.
```

## 4. Image storage

1. In Supabase, go to **Storage** and create a bucket named `product-images`.
2. Mark it **Public**, so images can be shown on the store.

Uploads go through the server only. The server checks each file's real type (JPEG, PNG or WebP only, max 4 MB).

## 5. Razorpay (TEST mode)

1. In the Razorpay Dashboard, switch to **Test mode**, open **API Keys**, and generate keys. Put them in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Under **Webhooks**, add `https://<your-site>/api/webhooks/razorpay` with these events:
   - `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`
   - `refund.processed`, `refund.failed`, `refund.created`

   Copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
3. Payment capture should be **automatic** (the default). Orders are marked paid only once Razorpay reports the payment as captured.

## 6. Deploy to Vercel (only when you approve it)

1. Import the GitHub repository in Vercel. The framework preset is "Other". `vercel.json` already sets:
   - the build command (`npm run build`)
   - the output directory (`public/`)
   - routing: every page goes to the server function, static files are served directly
   - security headers
   - a reconcile cron every 15 minutes
2. Add the environment variables from §2 to the **Production** and **Preview** environments. Use **test** keys for both.
3. Deploy a **Preview** first and run through §7.
4. After the custom domain works, set `APP_BASE_URL` to it and redeploy.
5. Submit `https://<domain>/sitemap.xml` in Google Search Console.

Not verified yet: this config has not been deployed. In particular, check on the Preview deployment that `/`, `/shop` and `/products/<slug>` render, and that `/styles.css` and `/assets/...` are served as static files.

## 7. Before launch — owner checklist (in `/admin/`)

1. **Inventory:** set the counted stock for each piece. Products stay unbuyable until you do.
2. **Settings → Checkout:** enter the shipping charge (0 for free) and tick "Shipping confirmed". Enable tax only if it applies.
3. **Settings → Contact:** add your email, WhatsApp and phone. Add social links if you want them shown.
4. **Pages:** write and publish your Privacy, Terms, Shipping, Returns and FAQ texts. Until they're published, those pages tell customers they're being prepared and aren't indexed.
5. **Check the brand claims:** the homepage and About page still carry your original wording ("No tarnish", "No fading", "No skin irritation"). Keep them only if they are true for every piece.
6. **Do one Razorpay test-card payment:** shop → bag → checkout → pay → confirmation. Then, in the admin, mark the order shipped and try a refund.

## 8. How payments stay safe (summary)

- Prices and totals are calculated in the database. The browser's numbers are never trusted.
- Stock is reserved in the same transaction that creates the order, and reservations expire.
- An order becomes **paid** only after all three checks pass:
  - the Razorpay signature is valid,
  - the Razorpay order matches the AMAANAT order,
  - Razorpay confirms the payment was captured for the full amount.

  Webhooks are verified against the raw request body and processed once per event.
- Admins cannot set "paid". They can only ask Razorpay to re-check, issue refunds through Razorpay (owner only), and cancel orders that are still unpaid (Razorpay is checked first).
- Every admin action is recorded in an audit log that can't be edited.
