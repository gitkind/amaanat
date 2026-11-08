import crypto from "node:crypto";

export function razorpayMode({ keyId, keySecret }) {
  if (!keyId || !keySecret) return "off";
  if (keyId.startsWith("rzp_test_")) return "test";
  if (keyId.startsWith("rzp_live_")) return "live";
  return "unknown";
}

// Part 1 runs in TEST mode only. Live keys are refused unless explicitly allowed.
export function paymentsEnabled(rzpConfig) {
  const mode = razorpayMode(rzpConfig);
  return mode === "test" || (mode === "live" && rzpConfig.allowLive === true);
}

function safeEqualHex(expected, actual) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(actual ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Checkout success signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
export function verifyPaymentSignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

// Webhook signature: HMAC_SHA256(raw request body, webhook_secret)
export function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}

export class RazorpayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RazorpayError";
    this.status = status;
  }
}

export function createRazorpayClient({ keyId, keySecret, fetchImpl = fetch, baseUrl = "https://api.razorpay.com/v1", timeoutMs = 10000 }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;

  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RazorpayError(`Razorpay unreachable: ${error.message}`, 0);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new RazorpayError(json?.error?.description || `Razorpay error ${response.status}`, response.status);
    return json;
  }

  return {
    createOrder: ({ amount, receipt, notes }) =>
      call("POST", "/orders", { amount, currency: "INR", receipt, notes }),
    fetchPayment: (paymentId) => call("GET", `/payments/${encodeURIComponent(paymentId)}`),
    fetchOrderPayments: async (orderId) => (await call("GET", `/orders/${encodeURIComponent(orderId)}/payments`)).items || [],
    createRefund: (paymentId, { amount, notes }) =>
      call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, notes, speed: "normal" }),
  };
}
