import { ACCOUNTING_SCOPE, MINOR_VERSION, REVOKE_URL, SANDBOX_API, TOKEN_URL, isTokenResponse, safeText } from "./config.js";
import { rememberQuickBooksId } from "./store.js";

function intuitMessage(payload, fallback) {
  const message = payload?.Fault?.Error?.[0]?.Message || payload?.error_description;
  return safeText(message, fallback);
}

export async function intuitGet(ctx, url) {
  if (ctx.env !== "sandbox") return { ok: false, status: 400, error: "QuickBooks is limited to the sandbox." };
  if (!ctx.accessToken || !/^[0-9]{1,32}$/.test(String(ctx.realmId || ""))) {
    return { ok: false, status: 409, error: "QuickBooks is not connected." };
  }
  let response;
  try {
    response = await ctx.fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, status: 502, error: "QuickBooks could not be reached." };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") {
    return { ok: false, status: 502, error: intuitMessage(payload, "QuickBooks did not accept the request.") };
  }
  return { ok: true, payload };
}

export async function requestToken(config, params, fetchImpl = fetch) {
  const body = new URLSearchParams(params).toString();
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, error: "QuickBooks could not be reached." };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !isTokenResponse(payload)) {
    return { ok: false, error: "QuickBooks did not return a token." };
  }
  return { ok: true, token: payload };
}

export async function revokeToken(config, refreshToken, fetchImpl = fetch) {
  if (!config.configured || !refreshToken) {
    return { ok: false, error: "QuickBooks credentials are not configured, so Intuit was not asked to revoke the token." };
  }
  let response;
  try {
    response = await fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, error: "QuickBooks could not be reached to revoke the connection." };
  }
  if (!response.ok) return { ok: false, error: "QuickBooks did not revoke the connection." };
  return { ok: true };
}

export async function fetchCompanyName(ctx) {
  const url = new URL(`${SANDBOX_API}/v3/company/${ctx.realmId}/companyinfo/${ctx.realmId}`);
  url.searchParams.set("minorversion", MINOR_VERSION);
  const result = await intuitGet(ctx, url);
  if (!result.ok) return result;
  const name = safeText(result.payload?.CompanyInfo?.CompanyName, "");
  if (!name) return { ok: false, error: "QuickBooks did not return a company name." };
  return { ok: true, companyName: name };
}

export async function pullOfficialQuery(ctx, entity, query) {
  const url = new URL(`${SANDBOX_API}/v3/company/${ctx.realmId}/query`);
  url.searchParams.set("query", query);
  url.searchParams.set("minorversion", MINOR_VERSION);
  const result = await intuitGet(ctx, url);
  if (!result.ok) {
    return { ok: false, entity, importedIds: [], rejectedIds: [], error: result.error };
  }
  const queryResponse = result.payload?.QueryResponse;
  if (!queryResponse || typeof queryResponse !== "object" || Array.isArray(queryResponse)) {
    return { ok: false, entity, importedIds: [], rejectedIds: [], error: "QuickBooks returned an unexpected payload." };
  }
  const rows = queryResponse[entity];
  if (rows === undefined) return { ok: true, entity, importedIds: [], rejectedIds: [], error: "" };
  if (!Array.isArray(rows)) {
    return { ok: false, entity, importedIds: [], rejectedIds: [], error: `QuickBooks returned an unexpected ${entity} payload.` };
  }
  const importedIds = [];
  const rejectedIds = [];
  let error = "";
  for (const row of rows) {
    const rawId = row && (typeof row.Id === "string" || typeof row.Id === "number") ? String(row.Id) : "";
    if (!/^[0-9A-Za-z-]{1,40}$/.test(rawId)) {
      error = error || `QuickBooks returned a ${entity} record without an id.`;
      continue;
    }
    const saved = rememberQuickBooksId(ctx.db, {
      firmId: ctx.firmId,
      clientId: ctx.clientId,
      connectionId: ctx.connectionId,
      realmId: ctx.realmId,
      entityType: entity,
      qboId: rawId,
    });
    if (!saved.ok) {
      rejectedIds.push(rawId);
      error = error || saved.error;
    } else importedIds.push(rawId);
  }
  if (rows.length >= 1000) error = error || `QuickBooks returned a full page of ${entity} records. Additional records were not imported.`;
  return { ok: !error, entity, importedIds, rejectedIds, error };
}

export function requestedScope() {
  return ACCOUNTING_SCOPE;
}
