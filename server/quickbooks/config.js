import { readFileSync } from "node:fs";

export const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
export const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com";
export const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export const MINOR_VERSION = "75";

export const QUICKBOOKS_ENV_KEYS = [
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_REDIRECT_URI",
  "QUICKBOOKS_ENV",
  "QUICKBOOKS_WEBHOOK_VERIFIER",
];

const MISSING = "QuickBooks credentials are not configured. Add QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REDIRECT_URI, and set QUICKBOOKS_ENV to sandbox. Connect does not start, and no company is marked connected.";
const SANDBOX_ONLY = "QuickBooks is limited to the sandbox. Set QUICKBOOKS_ENV to sandbox. Connect does not start, and no company is marked connected.";
const REDIRECT = "QUICKBOOKS_REDIRECT_URI must be an absolute http or https URL. Connect does not start, and no company is marked connected.";

export function loadQuickBooksEnv(filePath) {
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
    if (!QUICKBOOKS_ENV_KEYS.includes(key) || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function redirectUri(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function quickBooksConfig(env = process.env) {
  const clientId = String(env.QUICKBOOKS_CLIENT_ID || "").trim();
  const clientSecret = String(env.QUICKBOOKS_CLIENT_SECRET || "").trim();
  const redirect = redirectUri(String(env.QUICKBOOKS_REDIRECT_URI || "").trim());
  const quickbooksEnv = String(env.QUICKBOOKS_ENV || "").trim();
  const webhookVerifier = String(env.QUICKBOOKS_WEBHOOK_VERIFIER || "").trim();
  const keysPresent = Boolean(clientId && clientSecret && redirect);
  const sandbox = quickbooksEnv === "sandbox";
  const configured = keysPresent && sandbox;
  let notice = MISSING;
  if (keysPresent && !sandbox) notice = SANDBOX_ONLY;
  else if ((clientId || clientSecret) && !redirect && sandbox) notice = REDIRECT;
  else if (configured && !webhookVerifier) {
    notice = "QuickBooks sandbox OAuth is configured. Webhooks stay off until QUICKBOOKS_WEBHOOK_VERIFIER is set. A company is marked connected only after Intuit returns a token.";
  } else if (configured) {
    notice = "QuickBooks sandbox. A company is marked connected only after Intuit returns a token. Imported ids are stored here and are not posted to the books.";
  }
  return {
    clientId: configured ? clientId : "",
    clientSecret: configured ? clientSecret : "",
    redirectUri: configured ? redirect : "",
    env: configured ? "sandbox" : "",
    webhookVerifier,
    configured,
    notice,
  };
}

export function isTokenResponse(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.access_token !== "string" || payload.access_token.trim().length < 8) return false;
  if (typeof payload.refresh_token !== "string" || payload.refresh_token.trim().length < 8) return false;
  if (String(payload.token_type || "").toLowerCase() !== "bearer") return false;
  return true;
}

export function safeText(value, fallback) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || /token|secret|bearer|authorization/i.test(text)) return fallback;
  return text.slice(0, 180);
}
