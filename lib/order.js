export const MAX_QTY = 50;

export function availability(product) {
  if (!product || product.active === false) {
    return { code: "inactive", label: "Unavailable", canBuy: false };
  }
  const variants = (product.variants || []).filter((v) => v.active !== false);
  if (variants.length) {
    const states = variants.map((v) => availability({ ...v, variants: [] }));
    return states.find((x) => x.canBuy) || states.find((x) => x.code === "unconfirmed") || states[0];
  }
  if (!product.inventoryConfirmed || !Number.isInteger(product.stockQuantity)) {
    return { code: "unconfirmed", label: "Stock to be confirmed", canBuy: false };
  }
  if (product.stockQuantity <= 0) {
    return { code: "out", label: "Sold out", canBuy: false };
  }
  return { code: "in", label: "In stock", canBuy: true };
}

const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export function normalisePhone(value) {
  return String(value || "").replace(/[\s-]/g, "").replace(/^\+91/, "").replace(/^0/, "");
}

export function validateAddress(input = {}) {
  const errors = {};
  const a = {
    fullName: clean(input.fullName, 120),
    phone: normalisePhone(input.phone),
    line: clean(input.line ?? input.address, 200),
    apartment: clean(input.apartment, 200),
    locality: clean(input.locality, 120),
    city: clean(input.city, 120),
    state: clean(input.state, 80),
    pin: clean(input.pin, 10),
    label: clean(input.label, 40),
  };
  if (a.fullName.length < 2) errors.fullName = "Enter the name for this order.";
  if (!/^[6-9]\d{9}$/.test(a.phone)) errors.phone = "Enter a 10-digit Indian mobile number.";
  if (a.line.length < 3) errors.line = "Enter the address.";
  if (!a.locality) errors.locality = "Enter the locality.";
  if (!a.city) errors.city = "Enter the city.";
  if (!a.state) errors.state = "Choose the state.";
  if (!/^[1-9]\d{5}$/.test(a.pin)) errors.pin = "Enter a 6-digit PIN code.";
  return { ok: Object.keys(errors).length === 0, errors, address: a };
}

export function validateCustomer(input = {}) {
  const addr = validateAddress({ ...input, line: input.address ?? input.line });
  const errors = { ...addr.errors };
  if (errors.line) {
    errors.address = errors.line;
    delete errors.line;
  }
  const email = clean(input.email, 254).toLowerCase();
  const notes = clean(input.notes, 600);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email address.";
  if (notes.length > 500) errors.notes = "Keep the note under 500 characters.";
  const a = addr.address;
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    customer: {
      fullName: a.fullName, email, phone: a.phone, address: a.line, apartment: a.apartment,
      locality: a.locality, city: a.city, state: a.state, pin: a.pin, notes,
    },
  };
}

// Server-side price calculation used for cart summaries and the checkout quote.
// The authoritative calculation is repeated inside the database transaction.
export function quoteOrder({ lines: input, settings }) {
  if (!input?.length) return { ok: false, error: "empty_cart" };
  const lines = [];
  for (const { product, quantity } of input) {
    if (!product) return { ok: false, error: "unknown_product" };
    const a = availability(product);
    if (a.code === "inactive") return { ok: false, error: "inactive_product", productName: product.name };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      return { ok: false, error: "invalid_quantity", productName: product.name };
    }
    if (a.code === "unconfirmed") return { ok: false, error: "inventory_unconfirmed", productName: product.name };
    if (product.stockQuantity < quantity) return { ok: false, error: "insufficient_stock", productName: product.name };
    lines.push({
      productId: product.id,
      name: product.name,
      unitPricePaise: product.pricePaise,
      quantity,
      lineTotalPaise: product.pricePaise * quantity,
    });
  }
  const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  if (!settings || settings.shippingConfirmed !== true || !Number.isInteger(settings.shippingPaise) || settings.shippingPaise < 0) {
    return { ok: false, error: "shipping_unconfigured", lines, subtotalPaise };
  }
  let taxPaise = 0;
  if (settings.taxConfirmed === true) {
    if (!Number.isInteger(settings.taxRateBps) || settings.taxRateBps < 0 || settings.taxRateBps > 10000) {
      return { ok: false, error: "tax_misconfigured", lines, subtotalPaise };
    }
    taxPaise = Math.round((subtotalPaise * settings.taxRateBps) / 10000);
  }
  return {
    ok: true,
    lines,
    subtotalPaise,
    shippingPaise: settings.shippingPaise,
    taxPaise,
    totalPaise: subtotalPaise + settings.shippingPaise + taxPaise,
  };
}

export function publicSettings(settings) {
  return {
    shippingPaise: settings?.shippingConfirmed ? settings.shippingPaise : null,
    shippingConfirmed: settings?.shippingConfirmed === true,
    taxConfirmed: settings?.taxConfirmed === true,
    taxRateBps: settings?.taxConfirmed ? settings.taxRateBps : null,
    whatsappE164: settings?.whatsappE164 || null,
    contactEmail: settings?.contactEmail || null,
    lowStockThreshold: Number.isInteger(settings?.lowStockThreshold) ? settings.lowStockThreshold : 2,
  };
}

const MESSAGES = {
  empty_cart: "Your bag is empty.",
  unknown_product: "A piece in the bag is no longer in the catalogue.",
  inactive_product: "{name} is not available.",
  invalid_quantity: "Choose a valid quantity for {name}.",
  duplicate_lines: "The bag has a duplicate line. Refresh and try again.",
  too_many_lines: "The bag has too many different pieces for one order.",
  inventory_unconfirmed: "{name} cannot be ordered until stock is confirmed.",
  insufficient_stock: "There are not enough of {name} left.",
  shipping_unconfigured: "Shipping has not been set yet, so payment cannot open.",
  tax_misconfigured: "Tax is marked confirmed but the rate is missing. Payment is paused.",
  payments_not_configured: "Razorpay test payments are not configured, so payment cannot start.",
  database_not_configured: "Order storage is not configured yet.",
  invalid_customer: "Check the delivery details and try again.",
  missing_client_token: "The checkout session was missing. Refresh and try again.",
  order_not_payable: "This order can no longer be paid.",
  order_too_large: "This order is too large to process online.",
  wishlist_full: "Your wishlist is full.",
  too_many_addresses: "You can save up to 10 addresses.",
  address_not_found: "That address was not found.",
  cart_missing: "Your bag could not be found.",
  variant_required: "Choose an option for {name}.",
  unknown_variant: "That option is no longer available.",
};

export function reasonMessage(error, productName) {
  const template = MESSAGES[error] || "The request could not be completed.";
  return template.replace("{name}", productName || "This piece");
}
