export const MAX_QTY = 50;

export function mergeItems(items) {
  const map = new Map();
  for (const item of items || []) {
    const id = String(item.productId || "");
    const qty = Number(item.quantity);
    if (!id) continue;
    map.set(id, (map.get(id) || 0) + qty);
  }
  return [...map.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

export function availability(product) {
  if (!product || product.active === false) {
    return { code: "inactive", label: "Unavailable", canBuy: false };
  }
  if (!product.inventoryConfirmed || product.stockQuantity == null) {
    return { code: "unconfirmed", label: "Stock to be confirmed", canBuy: false };
  }
  if (product.stockQuantity <= 0) {
    return { code: "out", label: "Sold out", canBuy: false };
  }
  return { code: "in", label: "In stock", canBuy: true };
}

export function validateCustomer(input = {}) {
  const errors = {};
  const fullName = String(input.fullName || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const phone = String(input.phone || "").replace(/[\s-]/g, "").replace(/^\+91/, "").replace(/^0/, "");
  const address = String(input.address || "").trim();
  const apartment = String(input.apartment || "").trim();
  const locality = String(input.locality || "").trim();
  const city = String(input.city || "").trim();
  const state = String(input.state || "").trim();
  const pin = String(input.pin || "").trim();
  const notes = String(input.notes || "").trim();

  if (fullName.length < 2) errors.fullName = "Enter the name for this order.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email address.";
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = "Enter a 10-digit Indian mobile number.";
  if (address.length < 3) errors.address = "Enter the address.";
  if (!locality) errors.locality = "Enter the locality.";
  if (!city) errors.city = "Enter the city.";
  if (!state) errors.state = "Choose the state.";
  if (!/^[1-9]\d{5}$/.test(pin)) errors.pin = "Enter a 6-digit PIN code.";
  if (notes.length > 500) errors.notes = "Keep the note under 500 characters.";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    customer: { fullName, email, phone, address, apartment, locality, city, state, pin, notes },
  };
}

export function quoteOrder({ catalogue, items, settings }) {
  const linesIn = mergeItems(items);
  if (!linesIn.length) return { ok: false, error: "empty_cart" };

  const lines = [];
  for (const item of linesIn) {
    const product = (catalogue || []).find((entry) => entry.id === item.productId);
    if (!product) return { ok: false, error: "unknown_product" };
    if (product.active === false) {
      return { ok: false, error: "inactive_product", productName: product.name };
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QTY) {
      return { ok: false, error: "invalid_quantity", productName: product.name };
    }
    if (!product.inventoryConfirmed || !Number.isInteger(product.stockQuantity)) {
      return { ok: false, error: "inventory_unconfirmed", productName: product.name };
    }
    if (product.stockQuantity < item.quantity) {
      return { ok: false, error: "insufficient_stock", productName: product.name };
    }
    if (!Number.isInteger(product.pricePaise) || product.pricePaise < 0) {
      return { ok: false, error: "invalid_price", productName: product.name };
    }
    lines.push({
      productId: product.id,
      name: product.name,
      unitPricePaise: product.pricePaise,
      quantity: item.quantity,
      lineTotalPaise: product.pricePaise * item.quantity,
    });
  }

  const subtotalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
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

export function reasonMessage(error, productName) {
  const name = productName || "This piece";
  switch (error) {
    case "empty_cart":
      return "Your bag is empty.";
    case "unknown_product":
      return "A piece in the bag is no longer in the catalogue.";
    case "inactive_product":
      return `${name} is not available.`;
    case "invalid_quantity":
      return `Choose a valid quantity for ${name}.`;
    case "inventory_unconfirmed":
      return `${name} cannot be ordered until stock is confirmed.`;
    case "insufficient_stock":
      return `There are not enough of ${name} left.`;
    case "shipping_unconfigured":
      return "Shipping has not been set yet, so payment cannot open.";
    case "tax_misconfigured":
      return "Tax is marked confirmed but the rate is missing. Payment is paused.";
    case "payments_not_configured":
      return "Razorpay is not configured, so a real payment cannot start.";
    case "database_not_configured":
      return "Order storage is not configured yet.";
    case "invalid_customer":
      return "Check the delivery details and try again.";
    default:
      return "The order could not be started.";
  }
}
