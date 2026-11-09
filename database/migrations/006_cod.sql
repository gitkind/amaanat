-- ============================================================
-- AMAANAT — 006 Cash on Delivery (additive, re-runnable)
--
-- Adds COD alongside Razorpay (which stays intact and is still test-mode only):
--   * orders.payment_method  'razorpay' (default, all existing orders) | 'cod'
--   * site_settings.cod_enabled  OFF by default — the owner switches it on in Settings
--   * COD orders: stock is committed at checkout (no 30-minute reservation expiry),
--     payment_status stays 'pending' until the owner records the cash as collected
--     after delivery; they can be confirmed, processed, shipped and delivered while
--     pending, and cancelled (with restock) only before they are shipped.
--
-- Function bodies are the 003 versions with only the COD edits applied.
-- Run once in the Supabase SQL Editor after 005.
-- ============================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'razorpay';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('razorpay','cod'));
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);

ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS cod_enabled BOOLEAN NOT NULL DEFAULT false;

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
  v_method    TEXT := COALESCE(NULLIF(payload->>'paymentMethod',''), 'razorpay');
BEGIN
  IF v_token IS NULL OR length(v_token) < 32 THEN RAISE EXCEPTION 'missing_client_token'; END IF;
  IF v_minutes < 5 OR v_minutes > 120 THEN RAISE EXCEPTION 'invalid_reservation_window'; END IF;
  IF v_method NOT IN ('razorpay','cod') THEN RAISE EXCEPTION 'invalid_payment_method'; END IF;

  SELECT * INTO v_existing FROM orders WHERE client_token = v_token;
  IF FOUND THEN RETURN am_order_json(v_existing.id) || jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_settings FROM site_settings WHERE id = 1;
  IF NOT FOUND OR v_settings.shipping_confirmed IS NOT TRUE
     OR v_settings.shipping_paise IS NULL OR v_settings.shipping_paise < 0 THEN
    RAISE EXCEPTION 'shipping_unconfigured';
  END IF;
  -- COD is a business decision the owner switches on in Settings; never assumed.
  IF v_method = 'cod' AND v_settings.cod_enabled IS NOT TRUE THEN RAISE EXCEPTION 'cod_unavailable'; END IF;
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
                        address_state, address_pin, notes, client_token, reservation_expires_at, payment_method)
    VALUES (v_customer, v_user, lower(payload->>'email'), payload->>'fullName', payload->>'phone',
            payload->'address'->>'line', NULLIF(payload->'address'->>'apartment',''),
            payload->'address'->>'locality', payload->'address'->>'city',
            payload->'address'->>'state', payload->'address'->>'pin',
            NULLIF(payload->>'notes',''), v_token,
            -- Online payments hold stock for a short window; COD orders are committed sales.
            CASE WHEN v_method = 'cod' THEN NULL ELSE now() + make_interval(mins => v_minutes) END,
            v_method)
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
    v_unit := am_take_stock(v_line.product_id, v_line.variant_id, v_line.qty,
                          CASE WHEN v_method = 'cod' THEN 'Sold (COD) ' ELSE 'Reserved for order ' END || v_ref, v_order, NULL);
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
  IF v.payment_method = 'cod' AND v.fulfilment_status IN ('shipped','delivered') THEN
    RAISE EXCEPTION 'cod_already_shipped';  -- goods are with the courier/customer; handle as a return
  END IF;
  IF NOT v.stock_released THEN
    PERFORM am_restock_order(p_order_id, 'Released (' || p_status || ') ' || v.public_ref || COALESCE(': ' || p_reason, ''), NULL);
  END IF;
  UPDATE orders SET payment_status = p_status, fulfilment_status = 'cancelled', stock_released = true WHERE id = p_order_id;
  RETURN am_order_json(p_order_id) || jsonb_build_object('released', true);
END $$;

CREATE OR REPLACE FUNCTION api_admin_set_fulfilment(p_order_id UUID, p_status TEXT, p_tracking JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE; v_ok BOOLEAN;
BEGIN
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  -- Online orders ship only after verified payment; COD orders ship before payment by definition.
  IF v.payment_status NOT IN ('paid','partially_refunded')
     AND NOT (v.payment_method = 'cod' AND v.payment_status = 'pending') THEN
    RAISE EXCEPTION 'order_not_paid';
  END IF;
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

CREATE OR REPLACE FUNCTION api_admin_orders(p JSONB)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH f AS (
    SELECT o.* FROM orders o
     WHERE (COALESCE(p->>'q','') = '' OR o.public_ref ILIKE '%' || (p->>'q') || '%' OR o.email ILIKE '%' || (p->>'q') || '%'
            OR o.full_name ILIKE '%' || (p->>'q') || '%' OR o.phone LIKE '%' || (p->>'q') || '%')
       AND (COALESCE(p->>'payment','') = '' OR o.payment_status = p->>'payment')
       AND (COALESCE(p->>'fulfilment','') = '' OR o.fulfilment_status = p->>'fulfilment')
       AND (COALESCE(p->>'method','') = '' OR o.payment_method = p->>'method')
       AND (COALESCE((p->>'review')::boolean, false) = false OR o.needs_review))
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'public_ref', public_ref, 'created_at', created_at, 'full_name', full_name, 'email', email,
        'total_paise', total_paise, 'payment_status', payment_status, 'fulfilment_status', fulfilment_status,
        'payment_method', payment_method,
        'needs_review', needs_review,
        'item_count', (SELECT COALESCE(sum(quantity),0) FROM order_items i WHERE i.order_id = s.id)) ORDER BY created_at DESC)
      FROM (SELECT * FROM f ORDER BY created_at DESC
             LIMIT LEAST(GREATEST(COALESCE((p->>'limit')::int, 25), 1), 100)
             OFFSET GREATEST(COALESCE((p->>'offset')::int, 0), 0)) s), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION api_admin_overview()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'orders_total',        (SELECT count(*) FROM orders),
    'orders_paid',         (SELECT count(*) FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')),
    'awaiting_payment',    (SELECT count(*) FROM orders WHERE payment_method = 'razorpay' AND payment_status IN ('pending','authorized')),
    'to_fulfil',           (SELECT count(*) FROM orders WHERE (payment_status IN ('paid','partially_refunded')
                                                        AND fulfilment_status IN ('confirmed','processing','on_hold'))
                              OR (payment_method = 'cod' AND payment_status = 'pending'
                                  AND fulfilment_status IN ('pending','confirmed','processing','on_hold'))),
    'cod_to_collect',      (SELECT count(*) FROM orders WHERE payment_method = 'cod' AND payment_status = 'pending'
                                                        AND fulfilment_status NOT IN ('cancelled')),
    'needs_review',        (SELECT count(*) FROM orders WHERE needs_review),
    'gross_paid_paise',    (SELECT COALESCE(sum(total_paise),0) FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')),
    'refunded_paise',      (SELECT COALESCE(sum(amount_paise),0) FROM refunds WHERE status = 'processed'),
    'products_active',     (SELECT count(*) FROM products WHERE active),
    'products_archived',   (SELECT count(*) FROM products WHERE NOT active),
    'stock_unconfirmed',   (SELECT count(*) FROM products p WHERE p.active AND NOT p.inventory_confirmed
                              AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active)),
    'low_stock_threshold', (SELECT low_stock_threshold FROM site_settings WHERE id = 1),
    'recent_orders',       (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'public_ref', public_ref, 'created_at', created_at,
                               'full_name', full_name, 'total_paise', total_paise, 'payment_status', payment_status, 'payment_method', payment_method,
                               'fulfilment_status', fulfilment_status) ORDER BY created_at DESC), '[]'::jsonb)
                              FROM (SELECT * FROM orders ORDER BY created_at DESC LIMIT 8) r));
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
    cod_enabled          = CASE WHEN p ? 'cod_enabled'          THEN (p->>'cod_enabled')::boolean       ELSE cod_enabled END,
    updated_at = now()
  WHERE id = 1;
  PERFORM am_audit(p_actor, 'settings.updated', 'settings', '1', jsonb_build_object(
    'changed', p, 'before', (SELECT jsonb_object_agg(k, v_before->k) FROM jsonb_object_keys(p) k)));
  RETURN (SELECT to_jsonb(s) FROM site_settings s WHERE id = 1);
END $$;

-- Records that the courier/customer paid cash for a delivered COD order.
-- Only for COD orders that are delivered and still pending; logged and audited.
CREATE OR REPLACE FUNCTION api_admin_cod_collected(p_order_id UUID, p_note TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v orders%ROWTYPE;
BEGIN
  SELECT * INTO v FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v.payment_method <> 'cod' THEN RAISE EXCEPTION 'not_cod_order'; END IF;
  IF v.payment_status <> 'pending' THEN RAISE EXCEPTION 'cod_not_pending'; END IF;
  IF v.fulfilment_status <> 'delivered' THEN RAISE EXCEPTION 'cod_not_delivered'; END IF;
  IF char_length(COALESCE(trim(p_note), '')) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;
  UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = p_order_id;
  PERFORM am_log_payment(p_order_id, NULL, NULL, 'paid', v.total_paise, v.currency, 'cod_collected', left(trim(p_note), 300));
  PERFORM am_audit(p_actor, 'order.cod_collected', 'order', p_order_id::text,
                   jsonb_build_object('amount_paise', v.total_paise, 'note', p_note));
  RETURN api_admin_order_get(p_order_id);
END $$;

-- Lock down execution (same policy as 002/003): service_role only.
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname IN ('api_create_checkout_order', 'api_release_order', 'api_admin_set_fulfilment',
                         'api_admin_orders', 'api_admin_overview', 'api_admin_settings_update',
                         'api_admin_cod_collected')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('006_cod') ON CONFLICT DO NOTHING;

COMMIT;
