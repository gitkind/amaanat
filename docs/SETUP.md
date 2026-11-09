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
| `005_service_role_grants.sql` | Table access for the server's `service_role` (needed on projects without default grants). |
| `006_cod.sql` | Cash on Delivery: `orders.payment_method`, the `cod_enabled` switch (off by default) and COD-aware checkout, fulfilment and admin functions. |
| `007_cms.sql` | Website editor: drafts, publishing and version history for the homepage, About, Meet the Founder and menu/footer. Until it is applied the store shows the original design and the editor asks for it. |
| `008_team.sql` | Admin → Team: the owner can add, re-role and remove admins from the dashboard. |

All of them only add things and can be re-run safely. None of them changes prices, stock, settings values or existing orders.

To find duplicate client tokens (if any rows come back, the 002 unique index will fail):

```sql
select client_token, count(*) from orders where client_token is not null group by 1 having count(*) > 1;
```

### Adding more admins

After `008_team.sql` is applied, the owner can do this in **Admin → Team**: the person first creates an account at `/account`, then the owner enters that email and picks **Manager** or **Owner**. Owners can't remove or demote themselves, and the store always keeps at least one owner. The SQL below is only needed for the very first owner.

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

## 4a. Website editor (Admin → Website editor)

- **Homepage** and **About**: add, remove, hide, duplicate and reorder sections (drag the ⋮⋮ handle, or use ↑ ↓). Templates: hero banner, image with text, featured products, product categories, promotional banner, brand story, testimonials, newsletter, custom text and highlights. Each has predefined layouts.
- **Meet the Founder** (`/meet-the-founder`): name, designation, photo, biography, story, inspiration, mission, vision and an optional message. The page says "coming soon" (and isn't linked or indexed) until it's switched on and has a name. Fill in only real details.
- **Menu & footer**: footer tagline, newsletter text, extra menu/footer links, small print.
- **Policies** and **Settings** (announcement bar, contact details, social links) are edited as before.
- **Save draft** stores changes without showing them; **Preview** opens the page with the draft (visible to signed-in admins only); **Publish** makes it live (cached pages refresh within about a minute); **More → Version history** restores any earlier published version into the draft.
- Only the **owner** can change website content; managers can view it. Every save, publish and restore is in the audit log.
- Images: JPEG/PNG/WebP up to 4 MB, checked by the server and stored in the `product-images` bucket under `site/`. Replaced images stay in storage because older versions may still use them.

## 4b. Password reset emails (Supabase Auth → dashboard)

The site sends reset requests to Supabase (`/forgot-password` → Supabase emails a link → `/reset-password`).

1. **Authentication → URL Configuration**
   - **Site URL**: your live address (e.g. `https://amaanat.in`). While testing locally: `http://localhost:3000`.
   - **Redirect URLs**: add `http://localhost:3000/reset-password` and `https://<your-domain>/reset-password`.
   - Set `APP_BASE_URL` in production so the reset link always points at your domain.
2. **Authentication → Emails → Reset Password template (recommended)**: change the link to
   `<a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery">Reset your password</a>`
   so the token is handled by the server and works from any device. The default template also works.
3. **Authentication → Emails → SMTP Settings**: Supabase's built-in sender only delivers to your project's
   team members' addresses and is heavily rate-limited. For customers, set up custom SMTP
   (e.g. Resend, Postmark, Amazon SES, Zoho) before launch.
4. **Authentication → Rate Limits**: check "emails sent per hour" suits you.
5. **Authentication → Sign In / Providers → Email → "Confirm email"**: keep it **on**. Registration never says whether an email is already registered; with confirmation on, new and existing emails get exactly the same response.

## 5. Razorpay (TEST mode)

1. In the Razorpay Dashboard, switch to **Test mode**, open **API Keys**, and generate keys. Put them in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Under **Webhooks**, add `https://<your-site>/api/webhooks/razorpay` with these events:
   - `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`
   - `refund.processed`, `refund.failed`, `refund.created`

   Copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
3. Payment capture should be **automatic** (the default). Orders are marked paid only once Razorpay reports the payment as captured.

## 6. Deploy to Vercel

1. Import the GitHub repository in Vercel. The framework preset is "Other". `vercel.json` already sets:
   - the build command (`npm run build`)
   - the output directory (`public/`)
   - routing: every page goes to the server function, static files are served directly
   - security headers
   - a daily reconcile cron (03:00 IST; Hobby plans allow daily crons only — checkout also releases expired reservations itself. On Pro you can change it to `*/15 * * * *`)
2. Add the environment variables from §2 to the **Production** and **Preview** environments:
   - required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `CRON_SECRET` (any long random string), `TRUST_PROXY=true`
   - `APP_BASE_URL` = the production address (Production only; leave unset on Preview so previews are never indexed)
   - Razorpay: leave `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` **unset** until KYC is approved — checkout then offers Cash on Delivery only. Never set `RAZORPAY_ALLOW_LIVE=true` before live keys are approved and tested.
   - Do not set `DATABASE_DRIVER=pglite` or `STORAGE_DRIVER=local` (refused in production).
3. Deploy a **Preview** first and run through §7.
4. After the custom domain works, set `APP_BASE_URL` to it and redeploy.
5. Submit `https://<domain>/sitemap.xml` in Google Search Console.

Not verified yet: this config has not been deployed. In particular, check on the Preview deployment that `/`, `/shop` and `/products/<slug>` render, and that `/styles.css` and `/assets/...` are served as static files.

## 7. Before launch — owner checklist (in `/admin/`)

1. **Inventory:** set the counted stock for each piece. Products stay unbuyable until you do.
2. **Settings → Checkout:** enter the shipping charge (0 for free) and tick "Shipping confirmed". Enable tax only if it applies.
   To accept **Cash on Delivery**, tick "Offer Cash on Delivery at checkout". COD orders are placed straight away (no Razorpay needed): confirm, pack, ship and mark them delivered in Orders, then use "Record … received" once the cash is collected. They can be cancelled (stock returned) only before shipping.
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
