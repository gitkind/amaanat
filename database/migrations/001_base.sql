-- ============================================================
-- AMAANAT — 001 base schema (Supabase PostgreSQL)
--
-- Run first, once, in the Supabase SQL Editor. Then run 002, 003, 004.
-- Contains no SECURITY DEFINER functions and no publicly executable
-- function that can change stock or orders: all store logic lives in
-- 002+ and is executable by service_role only.
-- ============================================================

BEGIN;

-- =========================
-- TABLES
-- =========================

CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL,
  price_paise      INTEGER NOT NULL CHECK (price_paise >= 0),
  image_path       TEXT DEFAULT '',
  alt_text         TEXT DEFAULT '',
  sku              TEXT,
  stock_quantity   INTEGER,
  inventory_confirmed BOOLEAN DEFAULT false,
  active           BOOLEAN DEFAULT true,
  featured         BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(email, phone)
);

CREATE TABLE IF NOT EXISTS orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref           TEXT UNIQUE NOT NULL DEFAULT ('AM-' || upper(substring(gen_random_uuid()::text from 1 for 8))),
  customer_id          UUID REFERENCES customers(id),
  email                TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  phone                TEXT NOT NULL,
  address_line         TEXT,
  address_apartment    TEXT,
  address_locality     TEXT,
  address_city         TEXT,
  address_state        TEXT,
  address_pin          TEXT,
  notes                TEXT,
  subtotal_paise       INTEGER NOT NULL DEFAULT 0,
  shipping_paise       INTEGER NOT NULL DEFAULT 0,
  tax_paise            INTEGER NOT NULL DEFAULT 0,
  total_paise          INTEGER NOT NULL DEFAULT 0,
  payment_status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (payment_status IN ('pending','paid','failed','cancelled','refunded')),
  fulfilment_status    TEXT NOT NULL DEFAULT 'pending'
                       CHECK (fulfilment_status IN ('pending','confirmed','processing','shipped','delivered','cancelled','refunded')),
  razorpay_order_id    TEXT,
  razorpay_payment_id  TEXT,
  razorpay_signature   TEXT,
  tracking_number      TEXT,
  courier_name         TEXT,
  tracking_url         TEXT,
  dispatched_at        TIMESTAMPTZ,
  client_token         TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID REFERENCES orders(id) ON DELETE CASCADE,
  product_id       TEXT REFERENCES products(id),
  name             TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise INTEGER NOT NULL,
  line_total_paise INTEGER NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        TEXT REFERENCES products(id) ON DELETE CASCADE,
  previous_quantity INTEGER,
  new_quantity      INTEGER NOT NULL,
  delta             INTEGER NOT NULL,
  reason            TEXT,
  order_id          UUID REFERENCES orders(id),
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID REFERENCES orders(id),
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  status              TEXT NOT NULL,
  amount_paise        INTEGER,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_settings (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shipping_paise      INTEGER,
  shipping_confirmed  BOOLEAN DEFAULT false,
  tax_confirmed       BOOLEAN DEFAULT false,
  tax_rate_bps        INTEGER,
  whatsapp_e164       TEXT,
  contact_email       TEXT,
  low_stock_threshold INTEGER DEFAULT 2,
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- =========================
-- INDEXES
-- =========================

CREATE INDEX IF NOT EXISTS idx_orders_public_ref        ON orders(public_ref);
CREATE INDEX IF NOT EXISTS idx_orders_razorpay_order_id ON orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id       ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status    ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_fulfilment_status ON orders(fulfilment_status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_movements_product_id ON inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_products_slug            ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category        ON products(category);

-- =========================
-- FUNCTIONS
-- =========================

-- auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Trigger functions need no EXECUTE grant to fire; keep them uncallable by browser roles.
REVOKE ALL ON FUNCTION trigger_set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION trigger_set_updated_at() FROM anon, authenticated;

CREATE OR REPLACE TRIGGER set_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Checkout, payment, release and stock functions are defined in
-- 002_ecommerce_core.sql / 003_admin.sql (SECURITY INVOKER, pinned search_path,
-- EXECUTE granted to service_role only). The earlier SECURITY DEFINER versions
-- that lived here were publicly executable and have been removed.

-- =========================
-- ROW LEVEL SECURITY
-- =========================

ALTER TABLE products             ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings        ENABLE ROW LEVEL SECURITY;

-- Public/anon: read active products only (public catalogue)
DROP POLICY IF EXISTS products_anon_select ON products;
CREATE POLICY products_anon_select ON products
  FOR SELECT TO anon
  USING (active = true);

-- Service role bypasses RLS by default in Supabase.
-- No other anon policies needed — all access goes through the API with the service role key.

-- =========================
-- SEED DATA
-- =========================

-- Site settings (single row)
INSERT INTO site_settings (id, shipping_paise, shipping_confirmed, tax_confirmed, tax_rate_bps, whatsapp_e164, contact_email, low_stock_threshold)
VALUES (1, NULL, false, false, NULL, NULL, NULL, 2)
ON CONFLICT (id) DO NOTHING;

-- Products
INSERT INTO products (id, slug, name, description, category, price_paise, image_path, alt_text, stock_quantity, inventory_confirmed, active, featured, created_at, updated_at)
VALUES
  ('p01', 'marquise-clover-pendant', 'Marquise Clover Pendant',
   'Four sparkling petals on a fine gold-tone chain. Minimal, dainty, goes with everything.',
   'Necklaces', 19900, 'assets/products/marquise-clover-pendant.jpg',
   'Gold-tone chain with a four-petal marquise clover pendant on terracotta stone.',
   NULL, false, true, true,
   '2026-11-08T08:01:00.000Z', '2026-11-08T08:01:00.000Z'),

  ('p02', 'vintage-clover-pendant', 'Vintage Clover Pendant',
   'Four pear-cut stones in a beaded gold-tone frame on a fine chain. Vintage-inspired and classy.',
   'Necklaces', 37900, 'assets/products/vintage-clover-pendant.jpg',
   'Catalogue photograph of the Vintage Clover Pendant.',
   NULL, false, true, true,
   '2026-11-08T08:02:00.000Z', '2026-11-08T08:02:00.000Z'),

  ('p03', 'starflower-pendant', 'Starflower Pendant',
   'A five-petal star in glittering stones with a beaded gold edge.',
   'Necklaces', 37900, 'assets/products/starflower-pendant.jpg',
   'Catalogue photograph of the Starflower Pendant.',
   NULL, false, true, true,
   '2026-11-08T08:03:00.000Z', '2026-11-08T08:03:00.000Z'),

  ('p04', 'daisy-bloom-set', 'Daisy Bloom Set',
   'Pear-cut stones set in a full daisy pendant. Comes with earrings.',
   'Sets', 44900, 'assets/products/daisy-bloom-set.jpg',
   'Daisy pendant of pear-cut stones, worn at the collarbone.',
   NULL, false, true, true,
   '2026-11-08T08:04:00.000Z', '2026-11-08T08:04:00.000Z'),

  ('p05', 'boho-charm-necklace', 'Boho Charm Necklace',
   'Handknotted cotton cord with gemstone beads, a gold cross and a coin charm.',
   'Necklaces', 47900, 'assets/products/boho-charm-necklace.jpg',
   'Handknotted cotton cord necklace with gemstone beads, a gold cross, and a coin charm.',
   NULL, false, true, false,
   '2026-11-08T08:05:00.000Z', '2026-11-08T08:05:00.000Z'),

  ('p06', 'cherry-charm-necklace', 'Cherry Charm Necklace',
   'Colourful braided cord with cherries, a golden cross and crystal charms. Super trendy.',
   'Necklaces', 49900, 'assets/products/cherry-charm-necklace.jpg',
   'Braided cord necklace with red cherry charms, a gold cross, and stones, on a grey bust.',
   NULL, false, true, false,
   '2026-11-08T08:06:00.000Z', '2026-11-08T08:06:00.000Z'),

  ('p07', 'petal-leaf-anklet', 'Petal Leaf Anklet',
   'Delicate gold-tone anklet with sparkling leaf motifs and tiny beads.',
   'Anklets', 39900, 'assets/products/petal-leaf-anklet.jpg',
   'Gold-tone leaf anklet on an ankle, with pink fabric behind it.',
   NULL, false, true, false,
   '2026-11-08T08:07:00.000Z', '2026-11-08T08:07:00.000Z')
ON CONFLICT (id) DO NOTHING;

COMMIT;
