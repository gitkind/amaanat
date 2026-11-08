-- ============================================================
-- AMAANAT — 003 admin dashboard & business management (additive, re-runnable)
--
-- Adds: admin roles, audit log, product variants (stock per variant),
-- refunds, extended store settings, editable content pages.
-- Replaces the Part 1 stock-moving functions with variant-aware versions.
-- Never changes existing prices, stock, settings values or orders.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. Roles + audit
-- ---------------------------------------------------------------
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'manager'));

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  actor_email TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON admin_audit_log(entity_type, entity_id);
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Audit rows are append-only, even for the service role.
CREATE OR REPLACE FUNCTION am_audit_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log_is_append_only'; END $$;
DROP TRIGGER IF EXISTS trg_audit_immutable ON admin_audit_log;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION am_audit_immutable();

CREATE OR REPLACE FUNCTION am_audit(p_actor JSONB, p_action TEXT, p_entity_type TEXT, p_entity_id TEXT, p_details JSONB)
RETURNS VOID LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO admin_audit_log (actor_id, actor_email, actor_role, action, entity_type, entity_id, details, ip)
  VALUES (NULLIF(p_actor->>'id','')::uuid, p_actor->>'email', p_actor->>'role', p_action, p_entity_type, p_entity_id,
          COALESCE(p_details, '{}'::jsonb), p_actor->>'ip');
$$;

-- ---------------------------------------------------------------
-- 2. Product variants
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  sku                 TEXT UNIQUE CHECK (sku IS NULL OR char_length(sku) <= 60),
  price_paise         INTEGER CHECK (price_paise IS NULL OR price_paise >= 0),
  stock_quantity      INTEGER CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  inventory_confirmed BOOLEAN NOT NULL DEFAULT false,
  active              BOOLEAN NOT NULL DEFAULT true,
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, name)
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, position);
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS variants_anon_select ON product_variants;
CREATE POLICY variants_anon_select ON product_variants FOR SELECT TO anon USING (active = true);

ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS line_key TEXT
  GENERATED ALWAYS AS (product_id || ':' || COALESCE(variant_id::text, '')) STORED;
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_pkey;
ALTER TABLE cart_items ADD CONSTRAINT cart_items_pkey PRIMARY KEY (cart_id, line_key);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id   UUID REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_name TEXT;

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS variant_id  UUID REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS actor_id    UUID;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS actor_email TEXT;
CREATE INDEX IF NOT EXISTS idx_inv_movements_created ON inventory_movements(created_at DESC);

-- ---------------------------------------------------------------
-- 3. Refunds + payment statuses
-- ---------------------------------------------------------------
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('pending','authorized','paid','partially_refunded','failed','cancelled','expired','refunded'));

CREATE TABLE IF NOT EXISTS refunds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id),
  razorpay_payment_id TEXT,
  razorpay_refund_id  TEXT UNIQUE,
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  status              TEXT NOT NULL CHECK (status IN ('creating','pending','processed','failed')),
  reason              TEXT,
  restock             BOOLEAN NOT NULL DEFAULT false,
  error               TEXT,
  created_by          UUID,
  created_by_email    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------
-- 4. Store settings + content pages
-- ---------------------------------------------------------------
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS store_name           TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS contact_phone        TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS business_address     TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS instagram_url        TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS facebook_url         TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS youtube_url          TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS pinterest_url        TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS logo_url             TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS announcement_text    TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS announcement_link    TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS announcement_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS homepage             JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS content_pages (
  slug       TEXT PRIMARY KEY CHECK (slug IN ('about','faq','privacy','terms','shipping','returns')),
  title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body       TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 50000),
  published  BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
ALTER TABLE content_pages ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------
-- 5. Stock primitives (variant-aware). Every stock change goes through these.
-- ---------------------------------------------------------------
-- Validates a sellable unit without locking (used by the cart).
CREATE OR REPLACE FUNCTION am_unit_check(p_product_id TEXT, p_variant_id UUID, p_qty INTEGER)
RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE p products%ROWTYPE; v product_variants%ROWTYPE;
BEGIN
  SELECT * INTO p FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
  IF p.active IS NOT TRUE THEN RAISE EXCEPTION 'inactive_product' USING DETAIL = p.name; END IF;
  IF p_variant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND active) THEN
      RAISE EXCEPTION 'variant_required' USING DETAIL = p.name;
    END IF;
    IF p.inventory_confirmed IS NOT TRUE OR p.stock_quantity IS NULL THEN RAISE EXCEPTION 'inventory_unconfirmed' USING DETAIL = p.name; END IF;
    IF p.stock_quantity < p_qty THEN RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p.name; END IF;
    RETURN;
  END IF;
  SELECT * INTO v FROM product_variants WHERE id = p_variant_id AND product_id = p.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_variant'; END IF;
  IF v.active IS NOT TRUE THEN RAISE EXCEPTION 'inactive_product' USING DETAIL = p.name || ' — ' || v.name; END IF;
  IF v.inventory_confirmed IS NOT TRUE OR v.stock_quantity IS NULL THEN RAISE EXCEPTION 'inventory_unconfirmed' USING DETAIL = p.name || ' — ' || v.name; END IF;
  IF v.stock_quantity < p_qty THEN RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p.name || ' — ' || v.name; END IF;
END $$;

-- Locks and decrements stock. Returns name / variant / unit price for the order line.
CREATE OR REPLACE FUNCTION am_take_stock(p_product_id TEXT, p_variant_id UUID, p_qty INTEGER,
                                         p_reason TEXT, p_order_id UUID, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p products%ROWTYPE; v product_variants%ROWTYPE;
BEGIN
  SELECT * INTO p FROM products WHERE id = p_product_id FOR UPDATE;
  IF p_variant_id IS NOT NULL THEN
    SELECT * INTO v FROM product_variants WHERE id = p_variant_id AND product_id = p_product_id FOR UPDATE;
  END IF;
  PERFORM am_unit_check(p_product_id, p_variant_id, p_qty);

  IF p_variant_id IS NULL THEN
    UPDATE products SET stock_quantity = stock_quantity - p_qty WHERE id = p.id;
    INSERT INTO inventory_movements (product_id, variant_id, previous_quantity, new_quantity, delta, reason, order_id, actor_id, actor_email)
    VALUES (p.id, NULL, p.stock_quantity, p.stock_quantity - p_qty, -p_qty, p_reason, p_order_id,
            NULLIF(p_actor->>'id','')::uuid, p_actor->>'email');
    RETURN jsonb_build_object('name', p.name, 'variant_name', NULL, 'unit_price', p.price_paise);
  END IF;

  UPDATE product_variants SET stock_quantity = stock_quantity - p_qty, updated_at = now() WHERE id = v.id;
  INSERT INTO inventory_movements (product_id, variant_id, previous_quantity, new_quantity, delta, reason, order_id, actor_id, actor_email)
  VALUES (p.id, v.id, v.stock_quantity, v.stock_quantity - p_qty, -p_qty, p_reason, p_order_id,
          NULLIF(p_actor->>'id','')::uuid, p_actor->>'email');
  RETURN jsonb_build_object('name', p.name, 'variant_name', v.name, 'unit_price', COALESCE(v.price_paise, p.price_paise));
END $$;

-- Returns stock (release / refund restock). Silently skips units that no longer exist.
CREATE OR REPLACE FUNCTION am_return_stock(p_product_id TEXT, p_variant_id UUID, p_qty INTEGER,
                                           p_reason TEXT, p_order_id UUID, p_actor JSONB)
RETURNS VOID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_prev INTEGER; v_found BOOLEAN;
BEGIN
  IF p_variant_id IS NULL THEN
    SELECT stock_quantity, true INTO v_prev, v_found FROM products WHERE id = p_product_id FOR UPDATE;
    IF v_found IS NULL THEN RETURN; END IF;
    UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) + p_qty WHERE id = p_product_id;
  ELSE
    SELECT stock_quantity, true INTO v_prev, v_found FROM product_variants WHERE id = p_variant_id FOR UPDATE;
    IF v_found IS NULL THEN RETURN; END IF;
    UPDATE product_variants SET stock_quantity = COALESCE(stock_quantity, 0) + p_qty, updated_at = now() WHERE id = p_variant_id;
  END IF;
  INSERT INTO inventory_movements (product_id, variant_id, previous_quantity, new_quantity, delta, reason, order_id, actor_id, actor_email)
  VALUES (p_product_id, p_variant_id, v_prev, COALESCE(v_prev, 0) + p_qty, p_qty, p_reason, p_order_id,
          NULLIF(p_actor->>'id','')::uuid, p_actor->>'email');
END $$;

-- ---------------------------------------------------------------
-- 6. Catalogue reads now include variants
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION am_product_json(p products)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(p) || jsonb_build_object('variants', COALESCE((
    SELECT jsonb_agg(to_jsonb(v) ORDER BY v.position, v.created_at)
      FROM product_variants v WHERE v.product_id = p.id AND v.active), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_list_products(p_include_inactive BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(am_product_json(p) ORDER BY p.created_at, p.id), '[]'::jsonb)
    FROM products p WHERE p_include_inactive OR p.active = true;
$$;

CREATE OR REPLACE FUNCTION am_order_json(p_order_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(o) || jsonb_build_object(
           'items', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'product_id', i.product_id, 'variant_id', i.variant_id, 'variant_name', i.variant_name,
                      'name', i.name, 'quantity', i.quantity,
                      'unit_price_paise', i.unit_price_paise, 'line_total_paise', i.line_total_paise,
                      'image_path', p.image_path, 'slug', p.slug)
                    ORDER BY i.created_at, i.product_id)
               FROM order_items i LEFT JOIN products p ON p.id = i.product_id
              WHERE i.order_id = o.id), '[]'::jsonb),
           'refunded_paise', COALESCE((SELECT sum(amount_paise) FROM refunds r WHERE r.order_id = o.id AND r.status = 'processed'), 0))
    FROM orders o WHERE o.id = p_order_id;
$$;

-- ---------------------------------------------------------------
-- 7. Cart (variant-aware)
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS api_cart_put(UUID, TEXT, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION api_cart_get(p_cart_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'quantity', ci.quantity, 'product', am_product_json(p),
           'variant', CASE WHEN v.id IS NULL THEN NULL ELSE to_jsonb(v) END)
         ORDER BY ci.added_at, ci.line_key), '[]'::jsonb)
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    LEFT JOIN product_variants v ON v.id = ci.variant_id
   WHERE ci.cart_id = p_cart_id;
$$;

CREATE OR REPLACE FUNCTION api_cart_put(p_cart_id UUID, p_product_id TEXT, p_variant_id UUID, p_quantity INTEGER, p_mode TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_current INTEGER; v_new INTEGER;
BEGIN
  IF p_cart_id IS NULL THEN RAISE EXCEPTION 'cart_missing'; END IF;
  IF p_mode NOT IN ('set','add') OR p_quantity IS NULL OR p_quantity < 0 OR p_quantity > 50 THEN
    RAISE EXCEPTION 'invalid_quantity';
  END IF;
  SELECT quantity INTO v_current FROM cart_items
   WHERE cart_id = p_cart_id AND product_id = p_product_id AND variant_id IS NOT DISTINCT FROM p_variant_id;
  v_new := CASE WHEN p_mode = 'add' THEN COALESCE(v_current, 0) + p_quantity ELSE p_quantity END;

  IF v_new = 0 THEN
    DELETE FROM cart_items WHERE cart_id = p_cart_id AND product_id = p_product_id
       AND variant_id IS NOT DISTINCT FROM p_variant_id;
    RETURN api_cart_get(p_cart_id);
  END IF;
  IF v_new > 50 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  PERFORM am_unit_check(p_product_id, p_variant_id, v_new);

  INSERT INTO cart_items (cart_id, product_id, variant_id, quantity) VALUES (p_cart_id, p_product_id, p_variant_id, v_new)
  ON CONFLICT (cart_id, line_key) DO UPDATE SET quantity = EXCLUDED.quantity;
  UPDATE carts SET updated_at = now() WHERE id = p_cart_id;
  RETURN api_cart_get(p_cart_id);
END $$;

CREATE OR REPLACE FUNCTION api_cart_merge(p_guest_hash TEXT, p_user_id UUID)
RETURNS UUID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_guest UUID; v_user UUID;
BEGIN
  v_user := api_cart_resolve(p_user_id, NULL, true);
  SELECT id INTO v_guest FROM carts WHERE guest_token_hash = p_guest_hash AND user_id IS NULL;
  IF v_guest IS NULL OR v_guest = v_user THEN RETURN v_user; END IF;
  INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, added_at)
  SELECT v_user, product_id, variant_id, quantity, added_at FROM cart_items WHERE cart_id = v_guest
  ON CONFLICT (cart_id, line_key)
    DO UPDATE SET quantity = LEAST(50, cart_items.quantity + EXCLUDED.quantity);
  DELETE FROM carts WHERE id = v_guest;
  RETURN v_user;
END $$;

-- ---------------------------------------------------------------
-- 8. Checkout / release / finalize (variant-aware; same guarantees as 002)
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
  v_unit      JSONB;
  v_price     INTEGER;
BEGIN
  IF v_token IS NULL OR length(v_token) < 32 THEN RAISE EXCEPTION 'missing_client_token'; END IF;
  IF v_minutes < 5 OR v_minutes > 120 THEN RAISE EXCEPTION 'invalid_reservation_window'; END IF;

  SELECT * INTO v_existing FROM orders WHERE client_token = v_token;
  IF FOUND THEN RETURN am_order_json(v_existing.id) || jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_settings FROM site_settings WHERE id = 1;
  IF NOT FOUND OR v_settings.shipping_confirmed IS NOT TRUE
     OR v_settings.shipping_paise IS NULL OR v_settings.shipping_paise < 0 THEN
    RAISE EXCEPTION 'shipping_unconfigured';
  END IF;
  IF v_settings.tax_confirmed IS TRUE AND (v_settings.tax_rate_bps IS NULL
     OR v_settings.tax_rate_bps < 0 OR v_settings.tax_rate_bps > 10000) THEN
    RAISE EXCEPTION 'tax_misconfigured';
  END IF;

  IF jsonb_typeof(payload->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'lines') = 0 THEN
    RAISE EXCEPTION 'empty_cart';
  END IF;
  IF jsonb_array_length(payload->'lines') > 30 THEN RAISE EXCEPTION 'too_many_lines'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'lines') l
              WHERE jsonb_typeof(l->'quantity') <> 'number'
                 OR (l->>'quantity')::numeric <> trunc((l->>'quantity')::numeric)
                 OR (l->>'quantity')::numeric < 1 OR (l->>'quantity')::numeric > 50) THEN
    RAISE EXCEPTION 'invalid_quantity';
  END IF;
  IF (SELECT count(DISTINCT (l->>'productId') || ':' || COALESCE(l->>'variantId','')) FROM jsonb_array_elements(payload->'lines') l)
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
    SELECT * INTO v_existing FROM orders WHERE client_token = v_token;
    IF FOUND THEN RETURN am_order_json(v_existing.id) || jsonb_build_object('replayed', true); END IF;
    RAISE;
  END;

  FOR v_line IN
    SELECT l->>'productId' AS product_id, NULLIF(l->>'variantId','')::uuid AS variant_id, (l->>'quantity')::int AS qty
      FROM jsonb_array_elements(payload->'lines') l
     ORDER BY 1, 2 NULLS FIRST
  LOOP
    v_unit := am_take_stock(v_line.product_id, v_line.variant_id, v_line.qty, 'Reserved for order ' || v_ref, v_order, NULL);
    v_price := (v_unit->>'unit_price')::int;
    INSERT INTO order_items (order_id, product_id, variant_id, variant_name, name, quantity, unit_price_paise, line_total_paise)
    VALUES (v_order, v_line.product_id, v_line.variant_id, v_unit->>'variant_name',
            (v_unit->>'name') || COALESCE(' — ' || (v_unit->>'variant_name'), ''),
            v_line.qty, v_price, v_price * v_line.qty);
    v_subtotal := v_subtotal + v_price::bigint * v_line.qty;
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

CREATE OR REPLACE FUNCTION am_restock_order(p_order_id UUID, p_reason TEXT, p_actor JSONB)
RETURNS VOID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_item RECORD;
BEGIN
  FOR v_item IN SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = p_order_id
                 ORDER BY product_id, variant_id NULLS FIRST LOOP
    PERFORM am_return_stock(v_item.product_id, v_item.variant_id, v_item.quantity, p_reason, p_order_id, p_actor);
  END LOOP;
  UPDATE orders SET stock_released = true WHERE id = p_order_id;
END $$;

CREATE OR REPLACE FUNCTION api_release_order(p_order_id UUID, p_status TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE;
BEGIN
  IF p_status NOT IN ('cancelled','expired','failed') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.payment_status <> 'pending' THEN
    RETURN am_order_json(p_order_id) || jsonb_build_object('released', false);
  END IF;
  IF NOT v.stock_released THEN
    PERFORM am_restock_order(p_order_id, 'Released (' || p_status || ') ' || v.public_ref || COALESCE(': ' || p_reason, ''), NULL);
  END IF;
  UPDATE orders SET payment_status = p_status, fulfilment_status = 'cancelled', stock_released = true WHERE id = p_order_id;
  RETURN am_order_json(p_order_id) || jsonb_build_object('released', true);
END $$;

CREATE OR REPLACE FUNCTION api_finalize_payment(p_order_id UUID, p_razorpay_order_id TEXT,
                                                p_razorpay_payment_id TEXT, p_amount INTEGER,
                                                p_currency TEXT, p_source TEXT, p_signature TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE; v_item RECORD; v_short BOOLEAN := false;
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
    RETURN jsonb_build_object('error', 'amount_mismatch');
  END IF;

  IF v.payment_status IN ('paid', 'partially_refunded', 'refunded') THEN
    IF v.razorpay_payment_id = p_razorpay_payment_id THEN
      RETURN am_order_json(v.id) || jsonb_build_object('alreadyPaid', true);
    END IF;
    PERFORM am_log_payment(v.id, p_razorpay_order_id, p_razorpay_payment_id, 'duplicate_payment', p_amount, p_currency, p_source, NULL);
    UPDATE orders SET needs_review = true, review_reason = 'Duplicate payment ' || p_razorpay_payment_id || ' needs refund' WHERE id = v.id;
    RETURN am_order_json(v.id) || jsonb_build_object('alreadyPaid', true, 'duplicatePayment', true);
  END IF;

  -- Late payment after release: try to take the stock again, all-or-nothing.
  IF v.stock_released THEN
    BEGIN
      FOR v_item IN SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = v.id
                     ORDER BY product_id, variant_id NULLS FIRST LOOP
        PERFORM am_take_stock(v_item.product_id, v_item.variant_id, v_item.quantity,
                              'Re-reserved for late payment ' || v.public_ref, v.id, NULL);
      END LOOP;
    EXCEPTION WHEN raise_exception THEN
      v_short := true;  -- sub-transaction rolled back: nothing was taken
    END;
  END IF;

  UPDATE orders
     SET payment_status = 'paid',
         fulfilment_status = CASE WHEN v_short THEN 'on_hold' ELSE 'confirmed' END,
         stock_released = v_short,
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

-- ---------------------------------------------------------------
-- 9. Refunds
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION am_refund_settle(p_order_id UUID, p_actor JSONB)
RETURNS VOID LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE; v_processed BIGINT; v_restock BOOLEAN;
BEGIN
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  SELECT COALESCE(sum(amount_paise), 0), bool_or(restock) INTO v_processed, v_restock
    FROM refunds WHERE order_id = p_order_id AND status = 'processed';
  IF v_processed >= v.total_paise THEN
    IF v_restock AND NOT v.stock_released AND v.fulfilment_status NOT IN ('shipped','delivered') THEN
      PERFORM am_restock_order(p_order_id, 'Restocked after full refund ' || v.public_ref, p_actor);
    END IF;
    UPDATE orders SET payment_status = 'refunded',
           fulfilment_status = CASE WHEN fulfilment_status IN ('shipped','delivered') THEN 'refunded' ELSE 'cancelled' END
     WHERE id = p_order_id;
  ELSIF v_processed > 0 THEN
    UPDATE orders SET payment_status = 'partially_refunded' WHERE id = p_order_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION api_admin_refund_begin(p_order_id UUID, p_amount INTEGER, p_reason TEXT, p_restock BOOLEAN, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE; v_committed BIGINT; v_remaining BIGINT; v_id UUID;
BEGIN
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.payment_status NOT IN ('paid','partially_refunded') OR v.razorpay_payment_id IS NULL THEN
    RAISE EXCEPTION 'order_not_refundable';
  END IF;
  IF EXISTS (SELECT 1 FROM refunds WHERE order_id = p_order_id AND status = 'creating') THEN
    RAISE EXCEPTION 'refund_in_progress';
  END IF;
  SELECT COALESCE(sum(amount_paise), 0) INTO v_committed FROM refunds
   WHERE order_id = p_order_id AND status IN ('pending','processed');
  v_remaining := v.total_paise - v_committed;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > v_remaining THEN RAISE EXCEPTION 'refund_amount_invalid'; END IF;
  IF p_restock AND (p_amount <> v_remaining OR v_committed > 0 OR v.fulfilment_status IN ('shipped','delivered')) THEN
    RAISE EXCEPTION 'restock_not_allowed';
  END IF;
  IF char_length(COALESCE(p_reason,'')) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;

  INSERT INTO refunds (order_id, razorpay_payment_id, amount_paise, status, reason, restock, created_by, created_by_email)
  VALUES (p_order_id, v.razorpay_payment_id, p_amount, 'creating', left(p_reason, 300), COALESCE(p_restock, false),
          NULLIF(p_actor->>'id','')::uuid, p_actor->>'email')
  RETURNING id INTO v_id;
  PERFORM am_audit(p_actor, 'refund.requested', 'order', p_order_id::text,
                   jsonb_build_object('refund_id', v_id, 'amount_paise', p_amount, 'reason', p_reason, 'restock', p_restock));
  RETURN jsonb_build_object('refund_id', v_id, 'razorpay_payment_id', v.razorpay_payment_id, 'amount_paise', p_amount, 'public_ref', v.public_ref);
END $$;

CREATE OR REPLACE FUNCTION api_admin_refund_result(p_refund_id UUID, p_razorpay_refund_id TEXT, p_status TEXT, p_error TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE r refunds%ROWTYPE;
BEGIN
  IF p_status NOT IN ('pending','processed','failed') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  SELECT * INTO r FROM refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund_not_found'; END IF;
  UPDATE refunds SET razorpay_refund_id = COALESCE(p_razorpay_refund_id, razorpay_refund_id), status = p_status,
         error = left(p_error, 500), updated_at = now() WHERE id = p_refund_id;
  IF p_status = 'processed' THEN PERFORM am_refund_settle(r.order_id, p_actor); END IF;
  PERFORM am_audit(p_actor, 'refund.' || p_status, 'order', r.order_id::text,
                   jsonb_build_object('refund_id', r.id, 'razorpay_refund_id', p_razorpay_refund_id, 'amount_paise', r.amount_paise, 'error', p_error));
  RETURN am_order_json(r.order_id);
END $$;

-- Razorpay refund webhooks (also captures refunds created in the Razorpay dashboard).
CREATE OR REPLACE FUNCTION api_refund_webhook(p_razorpay_refund_id TEXT, p_razorpay_payment_id TEXT, p_amount INTEGER, p_status TEXT)
RETURNS TEXT LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE r refunds%ROWTYPE; v_order UUID;
BEGIN
  IF p_status NOT IN ('pending','processed','failed') THEN RETURN 'ignored'; END IF;
  SELECT * INTO r FROM refunds WHERE razorpay_refund_id = p_razorpay_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    -- An admin refund whose API call timed out: attach by payment + amount.
    SELECT * INTO r FROM refunds
     WHERE razorpay_payment_id = p_razorpay_payment_id AND razorpay_refund_id IS NULL
       AND status = 'creating' AND amount_paise = p_amount
     ORDER BY created_at LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE refunds SET razorpay_refund_id = p_razorpay_refund_id, status = p_status, updated_at = now() WHERE id = r.id;
      IF p_status = 'processed' THEN PERFORM am_refund_settle(r.order_id, NULL); END IF;
      RETURN 'refund_' || p_status;
    END IF;
    SELECT id INTO v_order FROM orders WHERE razorpay_payment_id = p_razorpay_payment_id;
    IF v_order IS NULL THEN RETURN 'unknown_payment'; END IF;
    INSERT INTO refunds (order_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason)
    VALUES (v_order, p_razorpay_payment_id, p_razorpay_refund_id, p_amount, p_status, 'Created outside the admin (Razorpay dashboard)')
    RETURNING * INTO r;
    PERFORM am_audit(jsonb_build_object('email', 'razorpay-webhook'), 'refund.external', 'order', v_order::text,
                     jsonb_build_object('razorpay_refund_id', p_razorpay_refund_id, 'amount_paise', p_amount));
  ELSIF r.status = p_status OR r.status = 'processed' THEN
    RETURN 'unchanged';
  ELSE
    UPDATE refunds SET status = p_status, updated_at = now() WHERE id = r.id;
  END IF;
  IF p_status = 'processed' THEN PERFORM am_refund_settle(r.order_id, NULL); END IF;
  RETURN 'refund_' || p_status;
END $$;

-- ---------------------------------------------------------------
-- 10. Admin: identity
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_admin_role(p_user_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT role FROM admin_users WHERE user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION api_admin_audit_write(p_actor JSONB, p_action TEXT, p_entity_type TEXT, p_entity_id TEXT, p_details JSONB)
RETURNS VOID LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT am_audit(p_actor, p_action, p_entity_type, p_entity_id, p_details);
$$;

-- ---------------------------------------------------------------
-- 11. Admin: products, images, variants
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_admin_products()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(
           to_jsonb(p) || jsonb_build_object(
             'variants', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.position, v.created_at)
                                     FROM product_variants v WHERE v.product_id = p.id), '[]'::jsonb),
             'units_sold', COALESCE((SELECT sum(i.quantity) FROM order_items i JOIN orders o ON o.id = i.order_id
                                      WHERE i.product_id = p.id AND o.payment_status IN ('paid','partially_refunded')), 0),
             'has_orders', EXISTS (SELECT 1 FROM order_items i WHERE i.product_id = p.id))
           ORDER BY p.created_at, p.id), '[]'::jsonb)
    FROM products p;
$$;

CREATE OR REPLACE FUNCTION api_admin_product_save(p_id TEXT, p JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_id TEXT := p_id; v_before JSONB;
BEGIN
  BEGIN
    IF v_id IS NULL THEN
      v_id := 'p_' || substr(md5(gen_random_uuid()::text), 1, 10);
      INSERT INTO products (id, slug, name, description, category, price_paise, alt_text, featured, active,
                            stock_quantity, inventory_confirmed, images, image_path)
      VALUES (v_id, p->>'slug', p->>'name', p->>'description', p->>'category', (p->>'pricePaise')::int,
              COALESCE(p->>'alt', ''), COALESCE((p->>'featured')::boolean, false), true, NULL, false, '[]'::jsonb, '');
      PERFORM am_audit(p_actor, 'product.created', 'product', v_id, p);
    ELSE
      SELECT to_jsonb(x) INTO v_before FROM products x WHERE id = v_id FOR UPDATE;
      IF v_before IS NULL THEN RAISE EXCEPTION 'unknown_product'; END IF;
      UPDATE products SET slug = p->>'slug', name = p->>'name', description = p->>'description',
             category = p->>'category', price_paise = (p->>'pricePaise')::int, alt_text = COALESCE(p->>'alt', ''),
             featured = COALESCE((p->>'featured')::boolean, false)
       WHERE id = v_id;
      PERFORM am_audit(p_actor, 'product.updated', 'product', v_id, jsonb_build_object(
        'before', jsonb_build_object('name', v_before->'name', 'slug', v_before->'slug', 'category', v_before->'category',
                                     'price_paise', v_before->'price_paise', 'featured', v_before->'featured'),
        'after', p));
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'slug_taken';
  END;
  RETURN (SELECT am_product_json(x) FROM products x WHERE id = v_id);
END $$;

CREATE OR REPLACE FUNCTION api_admin_product_set_active(p_id TEXT, p_active BOOLEAN, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE products SET active = p_active WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
  PERFORM am_audit(p_actor, CASE WHEN p_active THEN 'product.restored' ELSE 'product.archived' END, 'product', p_id, '{}'::jsonb);
  RETURN (SELECT am_product_json(x) FROM products x WHERE id = p_id);
END $$;

-- Hard delete only for products that were never ordered (order history is preserved).
CREATE OR REPLACE FUNCTION api_admin_product_delete(p_id TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_images JSONB; v_name TEXT;
BEGIN
  SELECT images, name INTO v_images, v_name FROM products WHERE id = p_id FOR UPDATE;
  IF v_name IS NULL THEN RAISE EXCEPTION 'unknown_product'; END IF;
  IF EXISTS (SELECT 1 FROM order_items WHERE product_id = p_id) THEN RAISE EXCEPTION 'product_has_orders'; END IF;
  DELETE FROM inventory_movements WHERE product_id = p_id;
  DELETE FROM products WHERE id = p_id;
  PERFORM am_audit(p_actor, 'product.deleted', 'product', p_id, jsonb_build_object('name', v_name, 'images', v_images));
  RETURN jsonb_build_object('deleted', true, 'images', v_images);
END $$;

CREATE OR REPLACE FUNCTION api_admin_product_images(p_id TEXT, p_images JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_before JSONB;
BEGIN
  IF jsonb_typeof(p_images) <> 'array' OR jsonb_array_length(p_images) > 10
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_images) e WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') > 500) THEN
    RAISE EXCEPTION 'invalid_images';
  END IF;
  SELECT images INTO v_before FROM products WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
  -- Reorder only: the new list must be exactly the existing images (no injected URLs).
  IF (SELECT array_agg(e ORDER BY e) FROM jsonb_array_elements_text(p_images) e)
     IS DISTINCT FROM (SELECT array_agg(e ORDER BY e) FROM jsonb_array_elements_text(v_before) e) THEN
    RAISE EXCEPTION 'invalid_images';
  END IF;
  UPDATE products SET images = p_images, image_path = COALESCE(p_images->>0, '') WHERE id = p_id;
  PERFORM am_audit(p_actor, 'product.images_updated', 'product', p_id, jsonb_build_object('before', v_before, 'after', p_images));
  RETURN (SELECT am_product_json(x) FROM products x WHERE id = p_id);
END $$;

CREATE OR REPLACE FUNCTION api_admin_product_image_add(p_id TEXT, p_url TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_images JSONB;
BEGIN
  SELECT images INTO v_images FROM products WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
  IF jsonb_array_length(v_images) >= 10 THEN RAISE EXCEPTION 'too_many_images'; END IF;
  v_images := v_images || jsonb_build_array(p_url);
  UPDATE products SET images = v_images, image_path = v_images->>0 WHERE id = p_id;
  PERFORM am_audit(p_actor, 'product.image_added', 'product', p_id, jsonb_build_object('url', p_url));
  RETURN (SELECT am_product_json(x) FROM products x WHERE id = p_id);
END $$;

CREATE OR REPLACE FUNCTION api_admin_product_image_remove(p_id TEXT, p_url TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_images JSONB; v_new JSONB;
BEGIN
  SELECT images INTO v_images FROM products WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_product'; END IF;
  SELECT COALESCE(jsonb_agg(e ORDER BY o), '[]'::jsonb) INTO v_new
    FROM jsonb_array_elements(v_images) WITH ORDINALITY t(e, o) WHERE e #>> '{}' <> p_url;
  IF jsonb_array_length(v_new) = jsonb_array_length(v_images) THEN RAISE EXCEPTION 'image_not_found'; END IF;
  UPDATE products SET images = v_new, image_path = COALESCE(v_new->>0, '') WHERE id = p_id;
  PERFORM am_audit(p_actor, 'product.image_removed', 'product', p_id, jsonb_build_object('url', p_url));
  RETURN (SELECT am_product_json(x) FROM products x WHERE id = p_id);
END $$;

CREATE OR REPLACE FUNCTION api_admin_variant_save(p_product_id TEXT, p_variant_id UUID, p JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_id UUID := p_variant_id;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_product_id) THEN RAISE EXCEPTION 'unknown_product'; END IF;
  BEGIN
    IF v_id IS NULL THEN
      INSERT INTO product_variants (product_id, name, sku, price_paise, active, position)
      VALUES (p_product_id, p->>'name', NULLIF(p->>'sku',''), (p->>'pricePaise')::int,
              COALESCE((p->>'active')::boolean, true), COALESCE((p->>'position')::int, 0))
      RETURNING id INTO v_id;
      PERFORM am_audit(p_actor, 'variant.created', 'product', p_product_id, p || jsonb_build_object('variant_id', v_id));
    ELSE
      UPDATE product_variants SET name = p->>'name', sku = NULLIF(p->>'sku',''), price_paise = (p->>'pricePaise')::int,
             active = COALESCE((p->>'active')::boolean, true), position = COALESCE((p->>'position')::int, 0), updated_at = now()
       WHERE id = v_id AND product_id = p_product_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'unknown_variant'; END IF;
      PERFORM am_audit(p_actor, 'variant.updated', 'product', p_product_id, p || jsonb_build_object('variant_id', v_id));
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'variant_name_taken';
  END;
  RETURN (SELECT to_jsonb(v) FROM product_variants v WHERE id = v_id);
END $$;

CREATE OR REPLACE FUNCTION api_admin_variant_delete(p_variant_id UUID, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v product_variants%ROWTYPE;
BEGIN
  SELECT * INTO v FROM product_variants WHERE id = p_variant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_variant'; END IF;
  IF EXISTS (SELECT 1 FROM order_items WHERE variant_id = p_variant_id) THEN
    UPDATE product_variants SET active = false, updated_at = now() WHERE id = p_variant_id;
    PERFORM am_audit(p_actor, 'variant.archived', 'product', v.product_id, jsonb_build_object('variant_id', v.id, 'name', v.name));
    RETURN jsonb_build_object('archived', true);
  END IF;
  DELETE FROM product_variants WHERE id = p_variant_id;
  PERFORM am_audit(p_actor, 'variant.deleted', 'product', v.product_id, jsonb_build_object('variant_id', v.id, 'name', v.name));
  RETURN jsonb_build_object('deleted', true);
END $$;

-- ---------------------------------------------------------------
-- 12. Admin: inventory
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_admin_inventory()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH reserved AS (
    SELECT i.product_id, i.variant_id, sum(i.quantity) AS qty
      FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.payment_status IN ('pending','authorized') AND NOT o.stock_released
     GROUP BY 1, 2)
  SELECT COALESCE(jsonb_agg(u ORDER BY u->>'product_name', u->>'variant_name' NULLS FIRST), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('product_id', p.id, 'variant_id', NULL, 'product_name', p.name, 'variant_name', NULL,
             'active', p.active, 'stock_quantity', p.stock_quantity, 'inventory_confirmed', p.inventory_confirmed,
             'reserved', COALESCE(r.qty, 0)) AS u
      FROM products p LEFT JOIN reserved r ON r.product_id = p.id AND r.variant_id IS NULL
     WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active)
    UNION ALL
    SELECT jsonb_build_object('product_id', p.id, 'variant_id', v.id, 'product_name', p.name, 'variant_name', v.name,
             'active', p.active AND v.active, 'stock_quantity', v.stock_quantity, 'inventory_confirmed', v.inventory_confirmed,
             'reserved', COALESCE(r.qty, 0))
      FROM product_variants v JOIN products p ON p.id = v.product_id
      LEFT JOIN reserved r ON r.product_id = p.id AND r.variant_id = v.id
     WHERE v.active) s(u);
$$;

-- mode 'set' = count on hand (confirms inventory); 'delta' = +/- adjustment. Reason required.
CREATE OR REPLACE FUNCTION api_admin_stock_adjust(p_product_id TEXT, p_variant_id UUID, p_mode TEXT,
                                                  p_quantity INTEGER, p_reason TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_prev INTEGER; v_new INTEGER; v_found BOOLEAN;
BEGIN
  IF p_mode NOT IN ('set','delta') OR p_quantity IS NULL THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF char_length(COALESCE(trim(p_reason), '')) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;
  IF p_variant_id IS NULL THEN
    SELECT stock_quantity, true INTO v_prev, v_found FROM products WHERE id = p_product_id FOR UPDATE;
    IF v_found IS NULL THEN RAISE EXCEPTION 'unknown_product'; END IF;
  ELSE
    SELECT stock_quantity, true INTO v_prev, v_found FROM product_variants
     WHERE id = p_variant_id AND product_id = p_product_id FOR UPDATE;
    IF v_found IS NULL THEN RAISE EXCEPTION 'unknown_variant'; END IF;
  END IF;
  IF p_mode = 'delta' AND v_prev IS NULL THEN RAISE EXCEPTION 'set_count_first'; END IF;
  v_new := CASE WHEN p_mode = 'set' THEN p_quantity ELSE v_prev + p_quantity END;
  IF v_new < 0 OR v_new > 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;

  IF p_variant_id IS NULL THEN
    UPDATE products SET stock_quantity = v_new, inventory_confirmed = true WHERE id = p_product_id;
  ELSE
    UPDATE product_variants SET stock_quantity = v_new, inventory_confirmed = true, updated_at = now() WHERE id = p_variant_id;
  END IF;
  INSERT INTO inventory_movements (product_id, variant_id, previous_quantity, new_quantity, delta, reason, actor_id, actor_email)
  VALUES (p_product_id, p_variant_id, v_prev, v_new, v_new - COALESCE(v_prev, 0), left(trim(p_reason), 200),
          NULLIF(p_actor->>'id','')::uuid, p_actor->>'email');
  PERFORM am_audit(p_actor, 'stock.' || p_mode, 'product', p_product_id,
                   jsonb_build_object('variant_id', p_variant_id, 'previous', v_prev, 'new', v_new, 'reason', p_reason));
  RETURN jsonb_build_object('product_id', p_product_id, 'variant_id', p_variant_id, 'previous', v_prev, 'stock_quantity', v_new);
END $$;

CREATE OR REPLACE FUNCTION api_admin_movements(p_product_id TEXT, p_limit INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(m ORDER BY m->>'created_at' DESC), '[]'::jsonb) FROM (
    SELECT to_jsonb(im) || jsonb_build_object('product_name', p.name, 'variant_name', v.name,
                                              'order_ref', o.public_ref) AS m
      FROM inventory_movements im
      LEFT JOIN products p ON p.id = im.product_id
      LEFT JOIN product_variants v ON v.id = im.variant_id
      LEFT JOIN orders o ON o.id = im.order_id
     WHERE p_product_id IS NULL OR im.product_id = p_product_id
     ORDER BY im.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)) s;
$$;

-- ---------------------------------------------------------------
-- 13. Admin: orders
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_admin_orders(p JSONB)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH f AS (
    SELECT o.* FROM orders o
     WHERE (COALESCE(p->>'q','') = '' OR o.public_ref ILIKE '%' || (p->>'q') || '%' OR o.email ILIKE '%' || (p->>'q') || '%'
            OR o.full_name ILIKE '%' || (p->>'q') || '%' OR o.phone LIKE '%' || (p->>'q') || '%')
       AND (COALESCE(p->>'payment','') = '' OR o.payment_status = p->>'payment')
       AND (COALESCE(p->>'fulfilment','') = '' OR o.fulfilment_status = p->>'fulfilment')
       AND (COALESCE((p->>'review')::boolean, false) = false OR o.needs_review))
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'public_ref', public_ref, 'created_at', created_at, 'full_name', full_name, 'email', email,
        'total_paise', total_paise, 'payment_status', payment_status, 'fulfilment_status', fulfilment_status,
        'needs_review', needs_review,
        'item_count', (SELECT COALESCE(sum(quantity),0) FROM order_items i WHERE i.order_id = s.id)) ORDER BY created_at DESC)
      FROM (SELECT * FROM f ORDER BY created_at DESC
             LIMIT LEAST(GREATEST(COALESCE((p->>'limit')::int, 25), 1), 100)
             OFFSET GREATEST(COALESCE((p->>'offset')::int, 0), 0)) s), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_admin_order_get(p_order_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT am_order_json(p_order_id) || jsonb_build_object(
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at) FROM payment_transactions t WHERE t.order_id = p_order_id), '[]'::jsonb),
    'refunds',  COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at) FROM refunds r WHERE r.order_id = p_order_id), '[]'::jsonb),
    'history',  COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at) FROM admin_audit_log a
                           WHERE a.entity_type = 'order' AND a.entity_id = p_order_id::text), '[]'::jsonb))
  WHERE EXISTS (SELECT 1 FROM orders WHERE id = p_order_id);
$$;

-- Fulfilment only moves forward along allowed transitions, and only for paid orders.
-- Payment status is never set here: it changes only through verified payment evidence.
CREATE OR REPLACE FUNCTION api_admin_set_fulfilment(p_order_id UUID, p_status TEXT, p_tracking JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE; v_ok BOOLEAN;
BEGIN
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.payment_status NOT IN ('paid','partially_refunded') THEN RAISE EXCEPTION 'order_not_paid'; END IF;
  v_ok := p_status = v.fulfilment_status OR (v.fulfilment_status, p_status) IN (
    ('confirmed','processing'), ('confirmed','shipped'), ('confirmed','on_hold'),
    ('processing','shipped'), ('processing','on_hold'), ('processing','confirmed'),
    ('on_hold','confirmed'), ('on_hold','processing'),
    ('shipped','delivered'), ('pending','confirmed'));
  IF NOT v_ok THEN RAISE EXCEPTION 'invalid_transition' USING DETAIL = v.fulfilment_status || ' → ' || p_status; END IF;
  IF p_status IN ('confirmed','processing','shipped') AND v.stock_released THEN
    RAISE EXCEPTION 'stock_not_reserved';  -- late payment without stock: resolve before fulfilling
  END IF;

  UPDATE orders SET fulfilment_status = p_status,
         tracking_number = CASE WHEN p_tracking ? 'number'  THEN NULLIF(p_tracking->>'number','')  ELSE tracking_number END,
         courier_name    = CASE WHEN p_tracking ? 'courier' THEN NULLIF(p_tracking->>'courier','') ELSE courier_name END,
         tracking_url    = CASE WHEN p_tracking ? 'url'     THEN NULLIF(p_tracking->>'url','')     ELSE tracking_url END,
         dispatched_at   = CASE WHEN p_status = 'shipped' AND dispatched_at IS NULL THEN now() ELSE dispatched_at END
   WHERE id = p_order_id;
  PERFORM am_audit(p_actor, 'order.fulfilment', 'order', p_order_id::text,
                   jsonb_build_object('from', v.fulfilment_status, 'to', p_status, 'tracking', p_tracking, 'note', p_tracking->>'note'));
  RETURN api_admin_order_get(p_order_id);
END $$;

CREATE OR REPLACE FUNCTION api_admin_resolve_review(p_order_id UUID, p_note TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF char_length(COALESCE(trim(p_note),'')) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;
  UPDATE orders SET needs_review = false WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  PERFORM am_audit(p_actor, 'order.review_resolved', 'order', p_order_id::text, jsonb_build_object('note', p_note));
  RETURN api_admin_order_get(p_order_id);
END $$;

-- ---------------------------------------------------------------
-- 14. Admin: overview, customers, settings, pages, audit
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_admin_overview()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'orders_total',        (SELECT count(*) FROM orders),
    'orders_paid',         (SELECT count(*) FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')),
    'awaiting_payment',    (SELECT count(*) FROM orders WHERE payment_status IN ('pending','authorized')),
    'to_fulfil',           (SELECT count(*) FROM orders WHERE payment_status IN ('paid','partially_refunded')
                                                        AND fulfilment_status IN ('confirmed','processing','on_hold')),
    'needs_review',        (SELECT count(*) FROM orders WHERE needs_review),
    'gross_paid_paise',    (SELECT COALESCE(sum(total_paise),0) FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')),
    'refunded_paise',      (SELECT COALESCE(sum(amount_paise),0) FROM refunds WHERE status = 'processed'),
    'products_active',     (SELECT count(*) FROM products WHERE active),
    'products_archived',   (SELECT count(*) FROM products WHERE NOT active),
    'stock_unconfirmed',   (SELECT count(*) FROM products p WHERE p.active AND NOT p.inventory_confirmed
                              AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active)),
    'low_stock_threshold', (SELECT low_stock_threshold FROM site_settings WHERE id = 1),
    'recent_orders',       (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'public_ref', public_ref, 'created_at', created_at,
                               'full_name', full_name, 'total_paise', total_paise, 'payment_status', payment_status,
                               'fulfilment_status', fulfilment_status) ORDER BY created_at DESC), '[]'::jsonb)
                              FROM (SELECT * FROM orders ORDER BY created_at DESC LIMIT 8) r));
$$;

CREATE OR REPLACE FUNCTION api_admin_customers(p JSONB)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH c AS (
    SELECT lower(o.email) AS email,
           (array_agg(o.full_name ORDER BY o.created_at DESC))[1] AS full_name,
           (array_agg(o.phone ORDER BY o.created_at DESC))[1] AS phone,
           count(*) AS orders,
           count(*) FILTER (WHERE o.payment_status IN ('paid','partially_refunded','refunded')) AS paid_orders,
           COALESCE(sum(o.total_paise) FILTER (WHERE o.payment_status IN ('paid','partially_refunded','refunded')), 0) AS paid_paise,
           max(o.created_at) AS last_order_at,
           bool_or(o.user_id IS NOT NULL) AS has_account
      FROM orders o GROUP BY lower(o.email))
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM c WHERE COALESCE(p->>'q','') = '' OR email ILIKE '%' || (p->>'q') || '%' OR full_name ILIKE '%' || (p->>'q') || '%'),
    'customers', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.last_order_at DESC) FROM (
       SELECT * FROM c WHERE COALESCE(p->>'q','') = '' OR email ILIKE '%' || (p->>'q') || '%' OR full_name ILIKE '%' || (p->>'q') || '%'
        ORDER BY last_order_at DESC
        LIMIT LEAST(GREATEST(COALESCE((p->>'limit')::int, 25), 1), 100)
        OFFSET GREATEST(COALESCE((p->>'offset')::int, 0), 0)) s), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_admin_customer(p_email TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'email', lower(p_email),
    'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'public_ref', public_ref, 'created_at', created_at,
                 'full_name', full_name, 'phone', phone, 'address_city', address_city, 'address_pin', address_pin,
                 'total_paise', total_paise, 'payment_status', payment_status, 'fulfilment_status', fulfilment_status)
                 ORDER BY created_at DESC) FROM orders WHERE lower(email) = lower(p_email)), '[]'::jsonb),
    -- Account details come only from public tables (no auth schema access needed).
    'account', (SELECT jsonb_build_object('user_id', o.user_id, 'full_name', pr.full_name, 'phone', pr.phone,
                         'addresses', (SELECT count(*) FROM addresses a WHERE a.user_id = o.user_id))
                  FROM orders o LEFT JOIN profiles pr ON pr.user_id = o.user_id
                 WHERE lower(o.email) = lower(p_email) AND o.user_id IS NOT NULL
                 ORDER BY o.created_at DESC LIMIT 1));
$$;

CREATE OR REPLACE FUNCTION api_admin_settings_update(p JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_before JSONB;
BEGIN
  SELECT to_jsonb(s) INTO v_before FROM site_settings s WHERE id = 1 FOR UPDATE;
  UPDATE site_settings SET
    shipping_paise       = CASE WHEN p ? 'shipping_paise'       THEN (p->>'shipping_paise')::int        ELSE shipping_paise END,
    shipping_confirmed   = CASE WHEN p ? 'shipping_confirmed'   THEN (p->>'shipping_confirmed')::boolean ELSE shipping_confirmed END,
    tax_confirmed        = CASE WHEN p ? 'tax_confirmed'        THEN (p->>'tax_confirmed')::boolean     ELSE tax_confirmed END,
    tax_rate_bps         = CASE WHEN p ? 'tax_rate_bps'         THEN (p->>'tax_rate_bps')::int          ELSE tax_rate_bps END,
    low_stock_threshold  = CASE WHEN p ? 'low_stock_threshold'  THEN (p->>'low_stock_threshold')::int   ELSE low_stock_threshold END,
    store_name           = CASE WHEN p ? 'store_name'           THEN p->>'store_name'                   ELSE store_name END,
    contact_email        = CASE WHEN p ? 'contact_email'        THEN p->>'contact_email'                ELSE contact_email END,
    contact_phone        = CASE WHEN p ? 'contact_phone'        THEN p->>'contact_phone'                ELSE contact_phone END,
    whatsapp_e164        = CASE WHEN p ? 'whatsapp_e164'        THEN p->>'whatsapp_e164'                ELSE whatsapp_e164 END,
    business_address     = CASE WHEN p ? 'business_address'     THEN p->>'business_address'             ELSE business_address END,
    instagram_url        = CASE WHEN p ? 'instagram_url'        THEN p->>'instagram_url'                ELSE instagram_url END,
    facebook_url         = CASE WHEN p ? 'facebook_url'         THEN p->>'facebook_url'                 ELSE facebook_url END,
    youtube_url          = CASE WHEN p ? 'youtube_url'          THEN p->>'youtube_url'                  ELSE youtube_url END,
    pinterest_url        = CASE WHEN p ? 'pinterest_url'        THEN p->>'pinterest_url'                ELSE pinterest_url END,
    logo_url             = CASE WHEN p ? 'logo_url'             THEN p->>'logo_url'                     ELSE logo_url END,
    announcement_text    = CASE WHEN p ? 'announcement_text'    THEN p->>'announcement_text'            ELSE announcement_text END,
    announcement_link    = CASE WHEN p ? 'announcement_link'    THEN p->>'announcement_link'            ELSE announcement_link END,
    announcement_enabled = CASE WHEN p ? 'announcement_enabled' THEN (p->>'announcement_enabled')::boolean ELSE announcement_enabled END,
    homepage             = CASE WHEN p ? 'homepage'             THEN p->'homepage'                      ELSE homepage END,
    updated_at = now()
  WHERE id = 1;
  PERFORM am_audit(p_actor, 'settings.updated', 'settings', '1', jsonb_build_object(
    'changed', p, 'before', (SELECT jsonb_object_agg(k, v_before->k) FROM jsonb_object_keys(p) k)));
  RETURN (SELECT to_jsonb(s) FROM site_settings s WHERE id = 1);
END $$;

CREATE OR REPLACE FUNCTION api_public_content()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'store_name', s.store_name, 'contact_email', s.contact_email, 'contact_phone', s.contact_phone,
    'whatsapp_e164', s.whatsapp_e164, 'business_address', s.business_address,
    'instagram_url', s.instagram_url, 'facebook_url', s.facebook_url, 'youtube_url', s.youtube_url, 'pinterest_url', s.pinterest_url,
    'logo_url', s.logo_url,
    'announcement', CASE WHEN s.announcement_enabled AND COALESCE(s.announcement_text,'') <> ''
                         THEN jsonb_build_object('text', s.announcement_text, 'link', s.announcement_link) END,
    'homepage', s.homepage,
    'pages', COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', slug, 'title', title) ORDER BY slug)
                         FROM content_pages WHERE published), '[]'::jsonb),
    'best_sellers', COALESCE((SELECT jsonb_agg(product_id ORDER BY units DESC, product_id) FROM (
        SELECT i.product_id, sum(i.quantity) AS units FROM order_items i JOIN orders o ON o.id = i.order_id
          JOIN products p ON p.id = i.product_id AND p.active
         WHERE o.payment_status IN ('paid','partially_refunded') GROUP BY 1 ORDER BY 2 DESC LIMIT 8) b), '[]'::jsonb))
  FROM site_settings s WHERE s.id = 1;
$$;

CREATE OR REPLACE FUNCTION api_admin_pages()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.slug), '[]'::jsonb) FROM content_pages c;
$$;

CREATE OR REPLACE FUNCTION api_admin_page_save(p_slug TEXT, p_title TEXT, p_body TEXT, p_published BOOLEAN, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO content_pages (slug, title, body, published, updated_at, updated_by)
  VALUES (p_slug, p_title, COALESCE(p_body, ''), COALESCE(p_published, false), now(), p_actor->>'email')
  ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, published = EXCLUDED.published,
                                   updated_at = now(), updated_by = EXCLUDED.updated_by;
  PERFORM am_audit(p_actor, 'page.saved', 'page', p_slug, jsonb_build_object('title', p_title, 'published', p_published, 'length', char_length(p_body)));
  RETURN (SELECT to_jsonb(c) FROM content_pages c WHERE slug = p_slug);
END $$;

CREATE OR REPLACE FUNCTION api_public_page(p_slug TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('slug', slug, 'title', title, 'body', body, 'updated_at', updated_at)
    FROM content_pages WHERE slug = p_slug AND published;
$$;

CREATE OR REPLACE FUNCTION api_admin_audit(p JSONB)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb) FROM (
    SELECT * FROM admin_audit_log
     WHERE (COALESCE(p->>'entity_type','') = '' OR entity_type = p->>'entity_type')
       AND (COALESCE(p->>'action','') = '' OR action LIKE (p->>'action') || '%')
     ORDER BY created_at DESC
     LIMIT LEAST(GREATEST(COALESCE((p->>'limit')::int, 50), 1), 200)
     OFFSET GREATEST(COALESCE((p->>'offset')::int, 0), 0)) a;
$$;

-- Old helper no longer needed (stock functions write audit + movements directly).
-- set_product_stock is kept for compatibility but now also writes an audit row.
CREATE OR REPLACE FUNCTION set_product_stock(p_product_id TEXT, p_quantity INTEGER, p_note TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM api_admin_stock_adjust(p_product_id, NULL, 'set', p_quantity, COALESCE(NULLIF(p_note,''), 'Stock set'),
                                 jsonb_build_object('email', 'set_product_stock'));
  RETURN (SELECT to_jsonb(p) FROM products p WHERE id = p_product_id);
END $$;

-- ---------------------------------------------------------------
-- 15. Lock down execution (same policy as 002)
-- ---------------------------------------------------------------
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND (p.proname LIKE 'api\_%' OR p.proname LIKE 'am\_%'
            OR p.proname IN ('set_product_stock', 'trigger_set_updated_at'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

REVOKE ALL ON admin_audit_log, refunds, content_pages FROM anon;

INSERT INTO schema_migrations (version) VALUES ('003_admin') ON CONFLICT DO NOTHING;

COMMIT;
