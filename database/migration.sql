-- ============================================================
-- AMAANAT — Supabase PostgreSQL Migration
-- ============================================================

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
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER set_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------
-- create_checkout_order(payload JSONB) → JSONB
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION create_checkout_order(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_token  TEXT;
  v_customer_id   UUID;
  v_order_id      UUID;
  v_public_ref    TEXT;
  v_subtotal      INTEGER := 0;
  v_shipping      INTEGER;
  v_tax           INTEGER := 0;
  v_tax_rate_bps  INTEGER;
  v_tax_confirmed BOOLEAN;
  v_total         INTEGER;
  v_line          JSONB;
  v_product       RECORD;
  v_settings      RECORD;
  v_existing      RECORD;
  v_rzp_order_id  TEXT;
BEGIN
  v_client_token := payload->>'clientToken';

  -- Idempotency: return existing pending order with same client_token
  SELECT id, public_ref, total_paise, razorpay_order_id
    INTO v_existing
    FROM orders
   WHERE client_token = v_client_token
     AND payment_status = 'pending'
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'order_id',          v_existing.id,
      'public_ref',        v_existing.public_ref,
      'total_paise',       v_existing.total_paise,
      'razorpay_order_id', v_existing.razorpay_order_id
    );
  END IF;

  -- Load site settings
  SELECT * INTO v_settings FROM site_settings WHERE id = 1;

  IF v_settings IS NULL OR v_settings.shipping_confirmed IS NOT TRUE
     OR v_settings.shipping_paise IS NULL OR v_settings.shipping_paise < 0 THEN
    RAISE EXCEPTION 'shipping_unconfigured';
  END IF;

  v_shipping      := v_settings.shipping_paise;
  v_tax_confirmed := v_settings.tax_confirmed;
  v_tax_rate_bps  := v_settings.tax_rate_bps;

  IF v_tax_confirmed IS TRUE THEN
    IF v_tax_rate_bps IS NULL OR v_tax_rate_bps < 0 OR v_tax_rate_bps > 10000 THEN
      RAISE EXCEPTION 'tax_misconfigured';
    END IF;
  END IF;

  -- Find or create customer
  INSERT INTO customers (full_name, email, phone)
  VALUES (
    payload->>'fullName',
    lower(payload->>'email'),
    payload->>'phone'
  )
  ON CONFLICT (email, phone) DO UPDATE SET full_name = EXCLUDED.full_name
  RETURNING id INTO v_customer_id;

  -- Create the order
  INSERT INTO orders (
    customer_id, email, full_name, phone,
    address_line, address_apartment, address_locality,
    address_city, address_state, address_pin,
    notes, client_token
  ) VALUES (
    v_customer_id,
    lower(payload->>'email'),
    payload->>'fullName',
    payload->>'phone',
    payload->'address'->>'line',
    payload->'address'->>'apartment',
    payload->'address'->>'locality',
    payload->'address'->>'city',
    payload->'address'->>'state',
    payload->'address'->>'pin',
    payload->>'notes',
    v_client_token
  )
  RETURNING id, public_ref INTO v_order_id, v_public_ref;

  -- Process each line item
  FOR v_line IN SELECT * FROM jsonb_array_elements(payload->'lines')
  LOOP
    -- Lock the product row to prevent race conditions
    SELECT * INTO v_product
      FROM products
     WHERE id = v_line->>'productId'
       FOR UPDATE;

    IF v_product IS NULL THEN
      RAISE EXCEPTION 'unknown_product';
    END IF;

    IF v_product.active IS NOT TRUE THEN
      RAISE EXCEPTION 'inactive_product';
    END IF;

    IF v_product.inventory_confirmed IS NOT TRUE THEN
      RAISE EXCEPTION 'inventory_unconfirmed';
    END IF;

    IF v_product.stock_quantity IS NULL
       OR v_product.stock_quantity < (v_line->>'quantity')::INTEGER THEN
      RAISE EXCEPTION 'insufficient_stock';
    END IF;

    IF (v_line->>'quantity')::INTEGER < 1 THEN
      RAISE EXCEPTION 'invalid_quantity';
    END IF;

    -- Create order item
    INSERT INTO order_items (order_id, product_id, name, quantity, unit_price_paise, line_total_paise)
    VALUES (
      v_order_id,
      v_product.id,
      v_product.name,
      (v_line->>'quantity')::INTEGER,
      v_product.price_paise,
      v_product.price_paise * (v_line->>'quantity')::INTEGER
    );

    v_subtotal := v_subtotal + (v_product.price_paise * (v_line->>'quantity')::INTEGER);

    -- Reserve stock
    UPDATE products
       SET stock_quantity = stock_quantity - (v_line->>'quantity')::INTEGER
     WHERE id = v_product.id;

    -- Record inventory movement
    INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason, order_id)
    VALUES (
      v_product.id,
      v_product.stock_quantity,
      v_product.stock_quantity - (v_line->>'quantity')::INTEGER,
      -(v_line->>'quantity')::INTEGER,
      'Reserved for order ' || v_public_ref,
      v_order_id
    );
  END LOOP;

  -- Calculate tax
  IF v_tax_confirmed IS TRUE AND v_tax_rate_bps > 0 THEN
    v_tax := round((v_subtotal::NUMERIC * v_tax_rate_bps) / 10000);
  END IF;

  v_total := v_subtotal + v_shipping + v_tax;

  -- Update order totals
  UPDATE orders
     SET subtotal_paise = v_subtotal,
         shipping_paise = v_shipping,
         tax_paise      = v_tax,
         total_paise    = v_total
   WHERE id = v_order_id;

  RETURN jsonb_build_object(
    'order_id',          v_order_id,
    'public_ref',        v_public_ref,
    'total_paise',       v_total,
    'razorpay_order_id', NULL
  );
END;
$$;

-- ---------------------------------------------------------
-- finalize_paid_order(…) → JSONB
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION finalize_paid_order(
  p_order_id            UUID,
  p_razorpay_order_id   TEXT,
  p_razorpay_payment_id TEXT,
  p_signature           TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order RECORD;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Already paid — return existing (idempotent)
  IF v_order.payment_status = 'paid' THEN
    RETURN jsonb_build_object(
      'order_id',         v_order.id,
      'public_ref',       v_order.public_ref,
      'email',            v_order.email,
      'payment_status',   v_order.payment_status,
      'fulfilment_status', v_order.fulfilment_status
    );
  END IF;

  UPDATE orders
     SET payment_status      = 'paid',
         fulfilment_status   = 'confirmed',
         razorpay_order_id   = p_razorpay_order_id,
         razorpay_payment_id = p_razorpay_payment_id,
         razorpay_signature  = p_signature
   WHERE id = p_order_id;

  -- Record payment transaction
  INSERT INTO payment_transactions (order_id, razorpay_order_id, razorpay_payment_id, status, amount_paise)
  VALUES (p_order_id, p_razorpay_order_id, p_razorpay_payment_id, 'paid', v_order.total_paise);

  RETURN jsonb_build_object(
    'order_id',         v_order.id,
    'public_ref',       v_order.public_ref,
    'email',            v_order.email,
    'payment_status',   'paid',
    'fulfilment_status', 'confirmed'
  );
END;
$$;

-- ---------------------------------------------------------
-- release_checkout_order(…) → JSONB
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION release_checkout_order(
  p_order_id       UUID,
  p_payment_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order RECORD;
  v_item  RECORD;
  v_product RECORD;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Only release if currently pending
  IF v_order.payment_status <> 'pending' THEN
    RETURN jsonb_build_object(
      'order_id',       v_order.id,
      'public_ref',     v_order.public_ref,
      'payment_status', v_order.payment_status
    );
  END IF;

  -- Restore stock for each item
  FOR v_item IN SELECT * FROM order_items WHERE order_id = p_order_id
  LOOP
    SELECT * INTO v_product FROM products WHERE id = v_item.product_id FOR UPDATE;

    IF v_product IS NOT NULL THEN
      UPDATE products
         SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
       WHERE id = v_item.product_id;

      INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason, order_id)
      VALUES (
        v_item.product_id,
        v_product.stock_quantity,
        COALESCE(v_product.stock_quantity, 0) + v_item.quantity,
        v_item.quantity,
        'Released from ' || p_payment_status || ' order ' || v_order.public_ref,
        p_order_id
      );
    END IF;
  END LOOP;

  UPDATE orders
     SET payment_status = p_payment_status
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'order_id',       v_order.id,
    'public_ref',     v_order.public_ref,
    'payment_status', p_payment_status
  );
END;
$$;

-- ---------------------------------------------------------
-- set_product_stock(…) → JSONB
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION set_product_stock(
  p_product_id TEXT,
  p_quantity   INTEGER,
  p_note       TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_product RECORD;
  v_prev    INTEGER;
BEGIN
  SELECT * INTO v_product FROM products WHERE id = p_product_id FOR UPDATE;

  IF v_product IS NULL THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  v_prev := v_product.stock_quantity;

  UPDATE products
     SET stock_quantity      = p_quantity,
         inventory_confirmed = true
   WHERE id = p_product_id;

  INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason)
  VALUES (
    p_product_id,
    v_prev,
    p_quantity,
    p_quantity - COALESCE(v_prev, 0),
    COALESCE(NULLIF(p_note, ''), 'Stock set via admin')
  );

  SELECT to_jsonb(p.*) INTO v_product FROM products p WHERE id = p_product_id;

  RETURN v_product::JSONB;
END;
$$;

-- ---------------------------------------------------------
-- record_payment_event(…) → VOID
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION record_payment_event(
  p_order_id            UUID,
  p_razorpay_order_id   TEXT,
  p_razorpay_payment_id TEXT,
  p_status              TEXT,
  p_amount_paise        INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO payment_transactions (order_id, razorpay_order_id, razorpay_payment_id, status, amount_paise)
  VALUES (p_order_id, p_razorpay_order_id, p_razorpay_payment_id, p_status, p_amount_paise);
END;
$$;

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

-- Public/anon: read active products only
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
