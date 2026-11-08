import crypto from "node:crypto";

export function razorpayMode() {
  const key = process.env.RAZORPAY_KEY_ID || "";
  if (!key || !process.env.RAZORPAY_KEY_SECRET) return "off";
  if (key.startsWith("rzp_test_")) return "test";
  if (key.startsWith("rzp_live_")) return "live";
  return "unknown";
}

export function paymentsConfigured() {
  return razorpayMode() === "test" || razorpayMode() === "live";
}

export function verifyPaymentSignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createRazorpayOrder({ amountPaise, receipt }) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.description || "Razorpay order was not created.");
    error.status = response.status;
    throw error;
  }
  return body;
}
