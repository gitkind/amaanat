-- ============================================================
-- AMAANAT — 002 ecommerce core (additive, idempotent)
--
-- Safe to run on a database that already has 001_base.sql applied.
-- It never updates product prices, stock, settings or existing orders,
-- except to backfill products.images from the existing image_path.
--
-- Security model: the browser never talks to Postgres. All access goes
-- through the Node API using the service-role key. Every function below
-- is revoked from PUBLIC/anon/authenticated and granted to service_role.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------
-- 0. Remove the vulnerable 001 functions (anon could call them).
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS create_checkout_order(JSONB);
DROP FUNCTION IF EXISTS finalize_paid_order(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS release_checkout_order(UUID, TEXT);
DROP FUNCTION IF EXISTS record_payment_event(UUID, TEXT, TEXT, TEXT, INTEGER);

-- ---------------------------------------------------------------
-- 1. Products
-- ---------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE products
   SET images = jsonb_build_array(image_path)
 WHERE images = '[]'::jsonb AND COALESCE(image_path, '') <> '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_nonnegative') THEN
    ALTER TABLE products ADD CONSTRAINT products_stock_nonnegative
      CHECK (stock_quantity IS NULL OR stock_quantity >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_active_created ON products(active, created_at);

-- ---------------------------------------------------------------
-- 2. Orders: statuses, reservation expiry, ownership, payment binding
-- ---------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id                UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_released         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency               TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at                TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS needs_review           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_reason          TEXT;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('pending','authorized','paid','failed','cancelled','expired','refunded'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfilment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfilment_status_check
  CHECK (fulfilment_status IN ('pending','confirmed','processing','shipped','delivered','cancelled','refunded','on_hold'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_totals_nonnegative') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_totals_nonnegative CHECK (
      subtotal_paise >= 0 AND shipping_paise >= 0 AND tax_paise >= 0
      AND total_paise = subtotal_paise + shipping_paise + tax_paise);
  END IF;
END $$;

-- Idempotency + one Razorpay order / payment per AMAANAT order.
-- These fail loudly if historic duplicates exist; resolve them by hand first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_token        ON orders(client_token)        WHERE client_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_razorpay_order_id   ON orders(razorpay_order_id)   WHERE razorpay_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_razorpay_payment_id ON orders(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user_id      ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_expiry       ON orders(reservation_expires_at) WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_email        ON orders(lower(email));

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_amounts_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_amounts_check
  CHECK (unit_price_paise >= 0 AND line_total_paise = unit_price_paise * quantity) NOT VALID;

-- ---------------------------------------------------------------
-- 3. Payment log + webhook dedupe
-- ---------------------------------------------------------------
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS source   TEXT;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS detail   TEXT;
CREATE INDEX IF NOT EXISTS idx_payment_tx_order ON payment_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_rzp_payment ON payment_transactions(razorpay_payment_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,                -- x-razorpay-event-id
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  result       TEXT
);

-- ---------------------------------------------------------------
-- 4. Customers: accounts, profiles, addresses
-- ---------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 2 AND 120),
  phone      TEXT CHECK (phone IS NULL OR phone ~ '^[6-9][0-9]{9}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS addresses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label      TEXT CHECK (label IS NULL OR char_length(label) <= 40),
  full_name  TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  phone      TEXT NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  line       TEXT NOT NULL CHECK (char_length(line) BETWEEN 3 AND 200),
  apartment  TEXT CHECK (apartment IS NULL OR char_length(apartment) <= 200),
  locality   TEXT NOT NULL CHECK (char_length(locality) BETWEEN 1 AND 120),
  city       TEXT NOT NULL CHECK (char_length(city) BETWEEN 1 AND 120),
  state      TEXT NOT NULL CHECK (char_length(state) BETWEEN 1 AND 80),
  pin        TEXT NOT NULL CHECK (pin ~ '^[1-9][0-9]{5}$'),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_addresses_default ON addresses(user_id) WHERE is_default;

-- ---------------------------------------------------------------
-- 5. Carts + wishlist
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  guest_token_hash TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR guest_token_hash IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id    UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity   INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- ---------------------------------------------------------------
-- 6. Row Level Security (defence in depth; server uses service role)
-- ---------------------------------------------------------------
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_own_select  ON profiles;
CREATE POLICY profiles_own_select  ON profiles       FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS addresses_own_select ON addresses;
CREATE POLICY addresses_own_select ON addresses      FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS wishlist_own_select  ON wishlist_items;
CREATE POLICY wishlist_own_select  ON wishlist_items FOR SELECT TO authenticated USING (user_id = auth.uid());
-- orders_own_select was removed: the backend reads orders only through
-- service_role RPC functions, and a direct-read policy would expose internal
-- columns (client_token hash, razorpay_signature, review notes) to the customer.
-- The DROP keeps re-runs and databases that already have the policy consistent.
DROP POLICY IF EXISTS orders_own_select    ON orders;

-- ---------------------------------------------------------------
-- 7. Helpers
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION am_order_json(p_order_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(o) || jsonb_build_object(
           'items', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'product_id', i.product_id, 'name', i.name, 'quantity', i.quantity,
                      'unit_price_paise', i.unit_price_paise, 'line_total_paise', i.line_total_paise,
                      'image_path', p.image_path, 'slug', p.slug)
                    ORDER BY i.created_at, i.product_id)
               FROM order_items i LEFT JOIN products p ON p.id = i.product_id
              WHERE i.order_id = o.id), '[]'::jsonb))
    FROM orders o WHERE o.id = p_order_id;
$$;

CREATE OR REPLACE FUNCTION am_log_payment(p_order_id UUID, p_rzp_order TEXT, p_rzp_payment TEXT,
                                          p_status TEXT, p_amount INTEGER, p_currency TEXT,
                                          p_source TEXT, p_detail TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO payment_transactions (order_id, razorpay_order_id, razorpay_payment_id, status,
                                    amount_paise, currency, source, detail)
  VALUES (p_order_id, p_rzp_order, p_rzp_payment, p_status, p_amount, p_currency, p_source, p_detail);
$$;

-- ---------------------------------------------------------------
-- 8. Catalogue + settings reads
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_list_products(p_include_inactive BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id), '[]'::jsonb)
    FROM products p WHERE p_include_inactive OR p.active = true;
$$;

CREATE OR REPLACE FUNCTION api_get_settings()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(s) FROM site_settings s WHERE id = 1;
$$;

-- ---------------------------------------------------------------
-- 9. Cart
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_cart_resolve(p_user_id UUID, p_guest_hash TEXT, p_create BOOLEAN)
RETURNS UUID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT id INTO v_id FROM carts WHERE user_id = p_user_id;
    IF v_id IS NULL AND p_create THEN
      INSERT INTO carts (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING id INTO v_id;
    END IF;
  ELSIF p_guest_hash IS NOT NULL THEN
    SELECT id INTO v_id FROM carts WHERE guest_token_hash = p_guest_hash AND user_id IS NULL;
    IF v_id IS NULL AND p_create THEN
      INSERT INTO carts (guest_token_hash) VALUES (p_guest_hash)
      ON CONFLICT (guest_token_hash) DO UPDATE SET updated_at = now() RETURNING id INTO v_id;
    END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION api_cart_get(p_cart_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('quantity', ci.quantity, 'product', to_jsonb(p))
                            ORDER BY ci.added_at, ci.product_id), '[]'::jsonb)
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
   WHERE ci.cart_id = p_cart_id;
$$;

-- Sets (p_mode = 'set') or increments (p_mode = 'add') a line. Quantity 0 with 'set' removes.
CREATE OR REPLACE FUNCTION api_cart_put(p_cart_id UUID, p_product_id TEXT, p_quantity INTEGER, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_product products%ROWTYPE;
  v_current INTEGER;
  v_new     INTEGER;
BEGIN
  IF p_cart_id IS NULL THEN RAISE EXCEPTION 'cart_missing'; END IF;
  IF p_mode NOT IN ('set','add') OR p_quantity IS NULL OR p_quantity < 0 OR p_quantity > 50 THEN
    RAISE EXCEPTION 'invalid_quantity';
  END IF;

  SELECT quantity INTO v_current FROM cart_items WHERE cart_id = p_cart_id AND product_id = p_product_id;
  v_new := CASE WHEN p_mode = 'add' THEN COALESCE(v_current, 0) + p_quantity ELSE p_quantity END;

  IF v_new = 0 THEN
    DELETE FROM cart_items WHERE cart_id = p_cart_id AND product_id = p_product_id;
    RETURN api_cart_get(p_cart_id);
  END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
  IF v_product.active IS NOT TRUE THEN RAISE EXCEPTION 'inactive_product'; END IF;
  IF v_product.inventory_confirmed IS NOT TRUE OR v_product.stock_quantity IS NULL THEN
    RAISE EXCEPTION 'inventory_unconfirmed';
  END IF;
  IF v_new > 50 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF v_product.stock_quantity < v_new THEN RAISE EXCEPTION 'insufficient_stock'; END IF;

  INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (p_cart_id, p_product_id, v_new)
  ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity;
  UPDATE carts SET updated_at = now() WHERE id = p_cart_id;
  RETURN api_cart_get(p_cart_id);
END $$;

CREATE OR REPLACE FUNCTION api_cart_clear(p_cart_id UUID)
RETURNS JSONB LANGUAGE sql SET search_path = public, pg_temp AS $$
  DELETE FROM cart_items WHERE cart_id = p_cart_id;
  SELECT '[]'::jsonb;
$$;

-- Moves a guest cart into the user's cart (quantities summed, capped at 50).
CREATE OR REPLACE FUNCTION api_cart_merge(p_guest_hash TEXT, p_user_id UUID)
RETURNS UUID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_guest UUID; v_user UUID;
BEGIN
  v_user := api_cart_resolve(p_user_id, NULL, true);
  SELECT id INTO v_guest FROM carts WHERE guest_token_hash = p_guest_hash AND user_id IS NULL;
  IF v_guest IS NULL OR v_guest = v_user THEN RETURN v_user; END IF;
  INSERT INTO cart_items (cart_id, product_id, quantity, added_at)
  SELECT v_user, product_id, quantity, added_at FROM cart_items WHERE cart_id = v_guest
  ON CONFLICT (cart_id, product_id)
    DO UPDATE SET quantity = LEAST(50, cart_items.quantity + EXCLUDED.quantity);
  DELETE FROM carts WHERE id = v_guest;
  RETURN v_user;
END $$;

-- ---------------------------------------------------------------
-- 10. Wishlist
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_wishlist_list(p_user_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY w.created_at DESC), '[]'::jsonb)
    FROM wishlist_items w JOIN products p ON p.id = w.product_id
   WHERE w.user_id = p_user_id AND p.active;
$$;

CREATE OR REPLACE FUNCTION api_wishlist_set(p_user_id UUID, p_product_id TEXT, p_on BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF p_on THEN
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_product_id AND active) THEN
      RAISE EXCEPTION 'unknown_product';
    END IF;
    IF (SELECT count(*) FROM wishlist_items WHERE user_id = p_user_id) >= 200 THEN
      RAISE EXCEPTION 'wishlist_full';
    END IF;
    INSERT INTO wishlist_items (user_id, product_id) VALUES (p_user_id, p_product_id)
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM wishlist_items WHERE user_id = p_user_id AND product_id = p_product_id;
  END IF;
  RETURN api_wishlist_list(p_user_id);
END $$;

-- ---------------------------------------------------------------
-- 11. Profile + addresses
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_profile_get(p_user_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'profile',   (SELECT to_jsonb(p) FROM profiles p WHERE p.user_id = p_user_id),
    'addresses', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.is_default DESC, a.created_at)
                             FROM addresses a WHERE a.user_id = p_user_id), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_profile_upsert(p_user_id UUID, p_full_name TEXT, p_phone TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO profiles (user_id, full_name, phone) VALUES (p_user_id, p_full_name, p_phone)
  ON CONFLICT (user_id) DO UPDATE
    SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, updated_at = now();
  RETURN api_profile_get(p_user_id);
END $$;

CREATE OR REPLACE FUNCTION api_address_save(p_user_id UUID, p_address_id UUID, p JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_id UUID; v_default BOOLEAN := COALESCE((p->>'isDefault')::boolean, false);
BEGIN
  IF p_address_id IS NULL THEN
    IF (SELECT count(*) FROM addresses WHERE user_id = p_user_id) >= 10 THEN
      RAISE EXCEPTION 'too_many_addresses';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM addresses WHERE user_id = p_user_id) THEN v_default := true; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM addresses WHERE id = p_address_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'address_not_found';
  END IF;

  IF v_default THEN
    UPDATE addresses SET is_default = false WHERE user_id = p_user_id AND is_default
       AND id IS DISTINCT FROM p_address_id;
  END IF;

  IF p_address_id IS NULL THEN
    INSERT INTO addresses (user_id, label, full_name, phone, line, apartment, locality, city, state, pin, is_default)
    VALUES (p_user_id, NULLIF(p->>'label',''), p->>'fullName', p->>'phone', p->>'line',
            NULLIF(p->>'apartment',''), p->>'locality', p->>'city', p->>'state', p->>'pin', v_default)
    RETURNING id INTO v_id;
  ELSE
    UPDATE addresses SET label = NULLIF(p->>'label',''), full_name = p->>'fullName', phone = p->>'phone',
           line = p->>'line', apartment = NULLIF(p->>'apartment',''), locality = p->>'locality',
           city = p->>'city', state = p->>'state', pin = p->>'pin', is_default = v_default, updated_at = now()
     WHERE id = p_address_id AND user_id = p_user_id;
  END IF;
  RETURN api_profile_get(p_user_id);
END $$;

CREATE OR REPLACE FUNCTION api_address_delete(p_user_id UUID, p_address_id UUID)
RETURNS JSONB LANGUAGE sql SET search_path = public, pg_temp AS $$
  DELETE FROM addresses WHERE id = p_address_id AND user_id = p_user_id;
  SELECT api_profile_get(p_user_id);
$$;

-- ---------------------------------------------------------------
-- 12. Checkout: atomic reservation with idempotency
--
-- payload: { clientTokenHash, userId?, fullName, email, phone, notes,
--            address{line,apartment,locality,city,state,pin},
--            lines[{productId, quantity}], reservationMinutes }
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_create_checkout_order(payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_token     TEXT := payload->>'clientTokenHash';
  v_user      UUID := NULLIF(payload->>'userId','')::uuid;
  v_minutes   INTEGER := COALESCE((payload->>'reservationMinutes')::int, 30);
  v_existing  orders%ROWTYPE;
  v_settings  site_settings%ROWTYPE;
  v_customer  UUID;
  v_order     UUID;
  v_ref       TEXT;
  v_subtotal  BIGINT := 0;
  v_tax       INTEGER := 0;
  v_line      RECORD;
  v_product   products%ROWTYPE;
  v_count     INTEGER := 0;
BEGIN
  IF v_token IS NULL OR length(v_token) < 32 THEN RAISE EXCEPTION 'missing_client_token'; END IF;
  IF v_minutes < 5 OR v_minutes > 120 THEN RAISE EXCEPTION 'invalid_reservation_window'; END IF;

  -- Idempotent replay: same token returns the same order, whatever its state.
  SELECT * INTO v_existing FROM orders WHERE client_token = v_token;
  IF FOUND THEN
    RETURN am_order_json(v_existing.id) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_settings FROM site_settings WHERE id = 1;
  IF NOT FOUND OR v_settings.shipping_confirmed IS NOT TRUE
     OR v_settings.shipping_paise IS NULL OR v_settings.shipping_paise < 0 THEN
    RAISE EXCEPTION 'shipping_unconfigured';
  END IF;
  IF v_settings.tax_confirmed IS TRUE AND (v_settings.tax_rate_bps IS NULL
     OR v_settings.tax_rate_bps < 0 OR v_settings.tax_rate_bps > 10000) THEN
    RAISE EXCEPTION 'tax_misconfigured';
  END IF;

  IF jsonb_typeof(payload->'lines') IS DISTINCT FROM 'array'
     OR jsonb_array_length(payload->'lines') = 0 THEN
    RAISE EXCEPTION 'empty_cart';
  END IF;
  IF jsonb_array_length(payload->'lines') > 30 THEN RAISE EXCEPTION 'too_many_lines'; END IF;

  -- Validate quantities before touching stock.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'lines') l
              WHERE jsonb_typeof(l->'quantity') <> 'number'
                 OR (l->>'quantity')::numeric <> trunc((l->>'quantity')::numeric)
                 OR (l->>'quantity')::numeric < 1 OR (l->>'quantity')::numeric > 50) THEN
    RAISE EXCEPTION 'invalid_quantity';
  END IF;
  IF (SELECT count(DISTINCT l->>'productId') FROM jsonb_array_elements(payload->'lines') l)
     <> jsonb_array_length(payload->'lines') THEN
    RAISE EXCEPTION 'duplicate_lines';
  END IF;

  INSERT INTO customers (full_name, email, phone, user_id)
  VALUES (payload->>'fullName', lower(payload->>'email'), payload->>'phone', v_user)
  ON CONFLICT (email, phone) DO UPDATE
    SET full_name = EXCLUDED.full_name, user_id = COALESCE(customers.user_id, EXCLUDED.user_id)
  RETURNING id INTO v_customer;

  BEGIN
    INSERT INTO orders (customer_id, user_id, email, full_name, phone,
                        address_line, address_apartment, address_locality, address_city,
                        address_state, address_pin, notes, client_token, reservation_expires_at)
    VALUES (v_customer, v_user, lower(payload->>'email'), payload->>'fullName', payload->>'phone',
            payload->'address'->>'line', NULLIF(payload->'address'->>'apartment',''),
            payload->'address'->>'locality', payload->'address'->>'city',
            payload->'address'->>'state', payload->'address'->>'pin',
            NULLIF(payload->>'notes',''), v_token, now() + make_interval(mins => v_minutes))
    RETURNING id, public_ref INTO v_order, v_ref;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent request with the same token won the race.
    SELECT * INTO v_existing FROM orders WHERE client_token = v_token;
    IF FOUND THEN RETURN am_order_json(v_existing.id) || jsonb_build_object('replayed', true); END IF;
    RAISE;
  END;

  -- Lock products in a stable order to avoid deadlocks between concurrent checkouts.
  FOR v_line IN
    SELECT l->>'productId' AS product_id, (l->>'quantity')::int AS qty
      FROM jsonb_array_elements(payload->'lines') l
     ORDER BY 1
  LOOP
    SELECT * INTO v_product FROM products WHERE id = v_line.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
    IF v_product.active IS NOT TRUE THEN
      RAISE EXCEPTION 'inactive_product' USING DETAIL = v_product.name;
    END IF;
    IF v_product.inventory_confirmed IS NOT TRUE OR v_product.stock_quantity IS NULL THEN
      RAISE EXCEPTION 'inventory_unconfirmed' USING DETAIL = v_product.name;
    END IF;
    IF v_product.stock_quantity < v_line.qty THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_product.name;
    END IF;

    INSERT INTO order_items (order_id, product_id, name, quantity, unit_price_paise, line_total_paise)
    VALUES (v_order, v_product.id, v_product.name, v_line.qty, v_product.price_paise,
            v_product.price_paise * v_line.qty);

    UPDATE products SET stock_quantity = stock_quantity - v_line.qty WHERE id = v_product.id;

    INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason, order_id)
    VALUES (v_product.id, v_product.stock_quantity, v_product.stock_quantity - v_line.qty, -v_line.qty,
            'Reserved for order ' || v_ref, v_order);

    v_subtotal := v_subtotal + v_product.price_paise::bigint * v_line.qty;
    v_count := v_count + 1;
  END LOOP;

  IF v_subtotal > 2000000000 THEN RAISE EXCEPTION 'order_too_large'; END IF;
  IF v_settings.tax_confirmed IS TRUE THEN
    v_tax := round((v_subtotal::numeric * v_settings.tax_rate_bps) / 10000);
  END IF;

  UPDATE orders
     SET subtotal_paise = v_subtotal, shipping_paise = v_settings.shipping_paise,
         tax_paise = v_tax, total_paise = v_subtotal + v_settings.shipping_paise + v_tax
   WHERE id = v_order;

  RETURN am_order_json(v_order) || jsonb_build_object('replayed', false);
END $$;

-- Binds the Razorpay order once. Amount must equal the stored total.
CREATE OR REPLACE FUNCTION api_attach_razorpay_order(p_order_id UUID, p_razorpay_order_id TEXT, p_amount INTEGER)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE;
BEGIN
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.payment_status <> 'pending' THEN RAISE EXCEPTION 'order_not_payable'; END IF;
  IF p_amount <> v.total_paise THEN RAISE EXCEPTION 'amount_mismatch'; END IF;
  IF v.razorpay_order_id IS NOT NULL AND v.razorpay_order_id <> p_razorpay_order_id THEN
    RAISE EXCEPTION 'razorpay_order_already_attached';
  END IF;
  UPDATE orders SET razorpay_order_id = p_razorpay_order_id WHERE id = p_order_id;
  RETURN am_order_json(p_order_id);
END $$;

-- Returns reserved stock to inventory. Only for orders that hold a reservation
-- and have not been paid or authorised.
CREATE OR REPLACE FUNCTION api_release_order(p_order_id UUID, p_status TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE; v_item RECORD; v_prev INTEGER;
BEGIN
  IF p_status NOT IN ('cancelled','expired','failed') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.payment_status <> 'pending' THEN
    RETURN am_order_json(p_order_id) || jsonb_build_object('released', false);
  END IF;

  IF NOT v.stock_released THEN
    FOR v_item IN SELECT product_id, quantity FROM order_items WHERE order_id = p_order_id ORDER BY product_id LOOP
      SELECT stock_quantity INTO v_prev FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF FOUND THEN
        UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity WHERE id = v_item.product_id;
        INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason, order_id)
        VALUES (v_item.product_id, v_prev, COALESCE(v_prev, 0) + v_item.quantity, v_item.quantity,
                'Released (' || p_status || ') ' || v.public_ref || COALESCE(': ' || p_reason, ''), p_order_id);
      END IF;
    END LOOP;
  END IF;

  UPDATE orders SET payment_status = p_status, fulfilment_status = 'cancelled', stock_released = true
   WHERE id = p_order_id;
  RETURN am_order_json(p_order_id) || jsonb_build_object('released', true);
END $$;

-- ---------------------------------------------------------------
-- 13. Payment finalisation (called only after server-side verification)
--
-- The Razorpay order id is authoritative: the AMAANAT order is looked up by it,
-- and the amount must match the stored total. Idempotent on payment id.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_finalize_payment(p_order_id UUID, p_razorpay_order_id TEXT,
                                                p_razorpay_payment_id TEXT, p_amount INTEGER,
                                                p_currency TEXT, p_source TEXT, p_signature TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v orders%ROWTYPE;
  v_item RECORD;
  v_stock INTEGER;
  v_short BOOLEAN := false;
BEGIN
  IF p_razorpay_order_id IS NULL OR p_razorpay_payment_id IS NULL THEN RAISE EXCEPTION 'missing_payment_ids'; END IF;

  SELECT * INTO v FROM orders WHERE razorpay_order_id = p_razorpay_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF p_order_id IS NOT NULL AND p_order_id <> v.id THEN
    PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, 'order_mismatch', p_amount, p_currency, p_source, p_order_id::text);
    RETURN jsonb_build_object('error', 'order_mismatch');
  END IF;
  IF p_amount IS DISTINCT FROM v.total_paise OR upper(COALESCE(p_currency,'')) <> v.currency THEN
    PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, 'amount_mismatch', p_amount, p_currency, p_source, NULL);
    UPDATE orders SET needs_review = true, review_reason = 'Captured amount did not match order total' WHERE id = v.id;
    -- Returned (not raised) so the log row and review flag are committed.
    RETURN jsonb_build_object('error', 'amount_mismatch');
  END IF;

  IF v.payment_status = 'paid' THEN
    IF v.razorpay_payment_id = p_razorpay_payment_id THEN
      RETURN am_order_json(v.id) || jsonb_build_object('alreadyPaid', true);
    END IF;
    -- A second successful payment on the same order: keep the first, flag for refund.
    PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, 'duplicate_payment', p_amount, p_currency, p_source, NULL);
    UPDATE orders SET needs_review = true, review_reason = 'Duplicate payment ' || p_razorpay_payment_id || ' needs refund'
     WHERE id = v.id;
    RETURN am_order_json(v.id) || jsonb_build_object('alreadyPaid', true, 'duplicatePayment', true);
  END IF;

  IF v.payment_status = 'refunded' THEN
    PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, 'paid_after_refund', p_amount, p_currency, p_source, NULL);
    UPDATE orders SET needs_review = true, review_reason = 'Payment received on a refunded order' WHERE id = v.id;
    RETURN jsonb_build_object('error', 'order_refunded');
  END IF;

  -- Late payment after the reservation was released: try to take stock again.
  IF v.stock_released THEN
    FOR v_item IN SELECT product_id, quantity FROM order_items WHERE order_id = v.id ORDER BY product_id LOOP
      v_stock := NULL;
      SELECT stock_quantity INTO v_stock FROM products
       WHERE id = v_item.product_id AND active AND inventory_confirmed FOR UPDATE;
      IF v_stock IS NULL OR v_stock < v_item.quantity THEN v_short := true; END IF;
    END LOOP;
    IF NOT v_short THEN
      FOR v_item IN SELECT product_id, quantity FROM order_items WHERE order_id = v.id ORDER BY product_id LOOP
        SELECT stock_quantity INTO v_stock FROM products WHERE id = v_item.product_id;
        UPDATE products SET stock_quantity = stock_quantity - v_item.quantity WHERE id = v_item.product_id;
        INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason, order_id)
        VALUES (v_item.product_id, v_stock, v_stock - v_item.quantity, -v_item.quantity,
                'Re-reserved for late payment ' || v.public_ref, v.id);
      END LOOP;
    END IF;
  END IF;

  UPDATE orders
     SET payment_status = 'paid',
         fulfilment_status = CASE WHEN v_short THEN 'on_hold' ELSE 'confirmed' END,
         stock_released = CASE WHEN v_short THEN true ELSE false END,
         needs_review = v_short OR needs_review,
         review_reason = CASE WHEN v_short THEN 'Paid after reservation expired; stock unavailable — refund or restock' ELSE review_reason END,
         razorpay_payment_id = p_razorpay_payment_id,
         razorpay_signature = COALESCE(p_signature, razorpay_signature),
         paid_at = now(),
         reservation_expires_at = NULL
   WHERE id = v.id;

  PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, 'paid', p_amount, p_currency, p_source, NULL);
  RETURN am_order_json(v.id) || jsonb_build_object('alreadyPaid', false);
END $$;

-- Records non-final payment states (authorized / failed) without releasing stock:
-- Razorpay lets the customer retry on the same order after a failure.
CREATE OR REPLACE FUNCTION api_record_payment_state(p_razorpay_order_id TEXT, p_razorpay_payment_id TEXT,
                                                    p_status TEXT, p_amount INTEGER, p_currency TEXT,
                                                    p_source TEXT, p_detail TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE;
BEGIN
  SELECT * INTO v FROM orders WHERE razorpay_order_id = p_razorpay_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, p_status, p_amount, p_currency, p_source, left(p_detail, 500));
  IF p_status = 'authorized' AND v.payment_status = 'pending' THEN
    UPDATE orders SET payment_status = 'authorized' WHERE id = v.id;
  END IF;
  RETURN am_order_json(v.id);
END $$;

CREATE OR REPLACE FUNCTION api_list_expired_pending(p_limit INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'razorpay_order_id', razorpay_order_id)), '[]'::jsonb)
    FROM (SELECT id, razorpay_order_id FROM orders
           WHERE payment_status = 'pending' AND reservation_expires_at < now()
           ORDER BY reservation_expires_at LIMIT LEAST(GREATEST(p_limit, 1), 100)) s;
$$;

-- ---------------------------------------------------------------
-- 14. Order reads
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_get_order(p_order_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT am_order_json(p_order_id);
$$;

CREATE OR REPLACE FUNCTION api_find_order(p_public_ref TEXT, p_email TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT am_order_json(id) FROM orders
   WHERE public_ref = upper(p_public_ref) AND email = lower(p_email) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION api_list_user_orders(p_user_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(am_order_json(id) ORDER BY created_at DESC), '[]'::jsonb)
    FROM (SELECT id, created_at FROM orders WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 50) o;
$$;

-- ---------------------------------------------------------------
-- 15. Webhook dedupe
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_webhook_begin(p_event_id TEXT, p_event TEXT, p_payload JSONB)
RETURNS TEXT LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v webhook_events%ROWTYPE;
BEGIN
  INSERT INTO webhook_events (id, event, payload) VALUES (p_event_id, p_event, p_payload)
  ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN RETURN 'new'; END IF;
  SELECT * INTO v FROM webhook_events WHERE id = p_event_id FOR UPDATE;
  IF v.processed_at IS NOT NULL THEN RETURN 'duplicate'; END IF;
  RETURN 'retry';
END $$;

CREATE OR REPLACE FUNCTION api_webhook_finish(p_event_id TEXT, p_result TEXT)
RETURNS TEXT LANGUAGE sql SET search_path = public, pg_temp AS $$
  UPDATE webhook_events SET processed_at = now(), result = left(p_result, 500) WHERE id = p_event_id;
  SELECT p_result;
$$;

-- ---------------------------------------------------------------
-- 16. Existing admin stock function: pin search_path, reject negatives.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_product_stock(p_product_id TEXT, p_quantity INTEGER, p_note TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_prev INTEGER; v_found BOOLEAN;
BEGIN
  IF p_quantity IS NULL OR p_quantity < 0 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  SELECT stock_quantity, true INTO v_prev, v_found FROM products WHERE id = p_product_id FOR UPDATE;
  IF v_found IS NULL THEN RAISE EXCEPTION 'unknown_product'; END IF;
  UPDATE products SET stock_quantity = p_quantity, inventory_confirmed = true WHERE id = p_product_id;
  INSERT INTO inventory_movements (product_id, previous_quantity, new_quantity, delta, reason)
  VALUES (p_product_id, v_prev, p_quantity, p_quantity - COALESCE(v_prev, 0),
          COALESCE(NULLIF(p_note, ''), 'Stock set via admin'));
  RETURN (SELECT to_jsonb(p) FROM products p WHERE id = p_product_id);
END $$;

-- ---------------------------------------------------------------
-- 17. Lock down execution: only service_role may call functions.
-- ---------------------------------------------------------------
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND (p.proname LIKE 'api\_%' OR p.proname LIKE 'am\_%'
            OR p.proname IN ('set_product_stock', 'trigger_set_updated_at'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

-- Stop future functions in public being executable by anon by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- Sensitive tables: no direct grants to browser roles (RLS already denies).
REVOKE ALL ON customers, orders, order_items, inventory_movements, payment_transactions,
              webhook_events, admin_users, profiles, addresses, carts, cart_items, wishlist_items
  FROM anon;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Migration bookkeeping is server-only: RLS on (no policies) and no browser grants.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON schema_migrations FROM PUBLIC;
REVOKE ALL ON schema_migrations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON schema_migrations TO service_role;
INSERT INTO schema_migrations (version) VALUES ('002_ecommerce_core') ON CONFLICT DO NOTHING;

COMMIT;
