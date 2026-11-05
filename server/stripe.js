import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const STRIPE_ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PRACTICE",
  "STRIPE_PRICE_FIRM",
];

const SECRET_TEXT = /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g;

export const MISSING_STRIPE_KEYS = "Stripe test keys are not configured. Add STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRACTICE, and STRIPE_PRICE_FIRM in the server environment. No charge is attempted.";
export const LIVE_STRIPE_KEY = "A Stripe live key was refused. Ledgerly uses Stripe test mode only, so no charge is attempted.";
export const MISSING_STRIPE_PRICES = "Stripe test mode is missing a price id. Set STRIPE_PRICE_PRACTICE and STRIPE_PRICE_FIRM. No charge is attempted.";

export function redact(value) {
  return String(value || "").replace(SECRET_TEXT, "[redacted]");
}

export function loadStripeEnv(filePath) {
  let text = "";
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!STRIPE_ENV_KEYS.includes(key) || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function stripeSetup(env = process.env) {
  const secretKey = String(env.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || "").trim();
  const prices = {
    practice: String(env.STRIPE_PRICE_PRACTICE || "").trim(),
    firm: String(env.STRIPE_PRICE_FIRM || "").trim(),
  };
  const live = secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_");
  const testKey = secretKey.startsWith("sk_test_");
  const hasPrice = Boolean(prices.practice || prices.firm);
  const configured = testKey && hasPrice && !live;
  let notice = MISSING_STRIPE_KEYS;
  if (live) notice = LIVE_STRIPE_KEY;
  else if (testKey && !hasPrice) notice = MISSING_STRIPE_PRICES;
  else if (configured) notice = "Stripe test mode. Checkout does not create a real charge.";
  return {
    webhookSecret,
    prices,
    configured,
    live,
    notice,
    testMode: true,
    secretKey: testKey && !live ? secretKey : "",
  };
}

export function publicStripe(setup) {
  return {
    testMode: true,
    configured: setup.configured,
    notice: setup.notice,
    plans: [
      {
        id: "practice",
        name: "Practice",
        summary: "For a smaller firm. The seat count is the Checkout quantity.",
        available: setup.configured && Boolean(setup.prices.practice),
      },
      {
        id: "firm",
        name: "Firm",
        summary: "For a larger firm. The seat count is the Checkout quantity.",
        available: setup.configured && Boolean(setup.prices.firm),
      },
    ],
  };
}

function encodeForm(params) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const encoded = encodeURIComponent(String(value)).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
      return `${encodeURIComponent(key)}=${encoded}`;
    })
    .join("&");
}

export async function stripeRequest({ secretKey, method = "GET", path, params, fetchImpl = fetch }) {
  const url = new URL(`https://api.stripe.com/v1${path}`);
  let body;
  if (method === "GET" && params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  } else if (method !== "GET") {
    body = encodeForm(params);
  }
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message = redact(payload?.error?.message || "Stripe could not complete that request.");
    throw Object.assign(new Error(message), { status: 502 });
  }
  return payload;
}

export function signStripePayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { timestamp, header: `t=${timestamp},v1=${signature}` };
}

export function verifyStripeSignature(rawBody, header, secret, now = Date.now()) {
  if (!secret) return { ok: false, error: MISSING_STRIPE_KEYS };
  const parts = String(header || "").split(",").map((part) => part.trim()).filter(Boolean);
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !signatures.length) return { ok: false, error: "Stripe signature is missing." };
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(Number(timestamp)) || age > 300) return { ok: false, error: "Stripe signature is expired." };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const matches = signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  });
  if (!matches) return { ok: false, error: "Stripe signature does not match." };
  return { ok: true };
}
