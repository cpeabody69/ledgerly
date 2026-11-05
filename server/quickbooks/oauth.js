import { randomBytes, randomUUID } from "node:crypto";
import { canManageFirm } from "../permissions.js";
import { fetchCompanyName, requestToken, requestedScope, revokeToken } from "./api.js";
import { AUTH_URL, quickBooksConfig } from "./config.js";
import { decryptToken, encryptToken } from "./crypto.js";
import {
  ensureQuickBooks,
  fail,
  loadConnection,
  loadConnectionForFirm,
  publicConnection,
  publicPayload,
  recordConnectionError,
  writeAudit,
} from "./store.js";

function actorRole(db, session) {
  return db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function requireManager(db, session) {
  const role = actorRole(db, session);
  if (!role || !canManageFirm(role.role)) return fail(403, "Only an owner or administrator can change the QuickBooks connection.");
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  if (!client) return fail(404, "Client not found.");
  return null;
}

function expiryFrom(seconds) {
  const value = Number(seconds);
  if (!Number.isInteger(value) || value <= 0) return null;
  return new Date(Date.now() + value * 1000).toISOString();
}

function redirect(code) {
  if (code === "connected") return { redirect: "/?quickbooks=connected" };
  return { redirect: `/?quickbooks=error&quickbooks_code=${code}` };
}

function actorFrom(row) {
  return { firm_id: row.firm_id, user_id: row.user_id, selected_client_id: row.client_id, client_id: row.client_id };
}

function clientOf(actor) {
  return actor.client_id || actor.selected_client_id;
}

function saveFailure(db, actor, message) {
  const now = new Date().toISOString();
  const existing = loadConnection(db, actor.firm_id, actor.client_id);
  if (existing?.status === "connected") {
    recordConnectionError(db, actor, existing.id, message);
    writeAudit(db, actor, "quickbooks.connect_failed", existing.id, message);
    return;
  }
  let connectionId = existing?.id;
  if (!existing) {
    connectionId = randomUUID();
    db.prepare(
      `INSERT INTO quickbooks_connections (
        id, firm_id, client_id, realm_id, company_name, status, environment, error_message,
        last_sync_at, connected_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, '', '', 'error', '', ?, NULL, NULL, ?, ?, ?)`,
    ).run(connectionId, actor.firm_id, actor.client_id, message, actor.user_id, now, now);
    db.prepare(
      `INSERT INTO quickbooks_oauth (
        id, connection_id, firm_id, client_id, access_token_enc, refresh_token_enc, token_type, scope,
        access_expires_at, refresh_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, '', '', '', '', NULL, NULL, ?)`,
    ).run(randomUUID(), connectionId, actor.firm_id, actor.client_id, now);
  } else {
    db.prepare(
      `UPDATE quickbooks_connections
       SET status = 'error', error_message = ?, environment = '', updated_at = ?
       WHERE id = ? AND firm_id = ? AND client_id = ?`,
    ).run(message, now, existing.id, actor.firm_id, actor.client_id);
    db.prepare(
      `UPDATE quickbooks_oauth
       SET access_token_enc = '', refresh_token_enc = '', token_type = '', access_expires_at = NULL, refresh_expires_at = NULL, updated_at = ?
       WHERE connection_id = ? AND firm_id = ?`,
    ).run(now, existing.id, actor.firm_id);
  }
  recordConnectionError(db, actor, connectionId, message);
  writeAudit(db, actor, "quickbooks.connect_failed", connectionId, message);
}

function storeConnected(db, actor, config, token, realmId, companyName, companyError) {
  const now = new Date().toISOString();
  const accessEnc = encryptToken(token.access_token, config.clientSecret);
  const refreshEnc = encryptToken(token.refresh_token, config.clientSecret);
  if (decryptToken(accessEnc, config.clientSecret) !== token.access_token) {
    return fail(500, "QuickBooks tokens could not be stored.");
  }
  if (decryptToken(refreshEnc, config.clientSecret) !== token.refresh_token) {
    return fail(500, "QuickBooks tokens could not be stored.");
  }
  const scope = typeof token.scope === "string" && token.scope.length <= 300 && !/token|secret/i.test(token.scope)
    ? token.scope
    : requestedScope();
  const accessExpires = expiryFrom(token.expires_in);
  const refreshExpires = expiryFrom(token.x_refresh_token_expires_in);
  const errorMessage = companyError || "";
  const existing = loadConnection(db, actor.firm_id, actor.client_id);
  let connectionId = existing?.id || randomUUID();
  db.exec("BEGIN");
  try {
    if (!existing) {
      db.prepare(
        `INSERT INTO quickbooks_connections (
          id, firm_id, client_id, realm_id, company_name, status, environment, error_message,
          last_sync_at, connected_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'connected', 'sandbox', ?, NULL, ?, ?, ?, ?)`,
      ).run(connectionId, actor.firm_id, actor.client_id, realmId, companyName, errorMessage, now, actor.user_id, now, now);
      db.prepare(
        `INSERT INTO quickbooks_oauth (
          id, connection_id, firm_id, client_id, access_token_enc, refresh_token_enc, token_type, scope,
          access_expires_at, refresh_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'bearer', ?, ?, ?, ?)`,
      ).run(randomUUID(), connectionId, actor.firm_id, actor.client_id, accessEnc, refreshEnc, scope, accessExpires, refreshExpires, now);
    } else {
      db.prepare(
        `UPDATE quickbooks_connections
         SET realm_id = ?, company_name = ?, status = 'connected', environment = 'sandbox', error_message = ?,
             connected_at = ?, updated_at = ?
         WHERE id = ? AND firm_id = ? AND client_id = ?`,
      ).run(realmId, companyName, errorMessage, now, now, connectionId, actor.firm_id, actor.client_id);
      const oauth = db.prepare("SELECT id FROM quickbooks_oauth WHERE connection_id = ? AND firm_id = ?").get(connectionId, actor.firm_id);
      if (oauth) {
        db.prepare(
          `UPDATE quickbooks_oauth
           SET access_token_enc = ?, refresh_token_enc = ?, token_type = 'bearer', scope = ?,
               access_expires_at = ?, refresh_expires_at = ?, updated_at = ?
           WHERE connection_id = ? AND firm_id = ?`,
        ).run(accessEnc, refreshEnc, scope, accessExpires, refreshExpires, now, connectionId, actor.firm_id);
      } else {
        db.prepare(
          `INSERT INTO quickbooks_oauth (
            id, connection_id, firm_id, client_id, access_token_enc, refresh_token_enc, token_type, scope,
            access_expires_at, refresh_expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'bearer', ?, ?, ?, ?)`,
        ).run(randomUUID(), connectionId, actor.firm_id, actor.client_id, accessEnc, refreshEnc, scope, accessExpires, refreshExpires, now);
      }
    }
    const stored = db.prepare(
      "SELECT status FROM quickbooks_connections WHERE id = ? AND firm_id = ? AND status = 'connected' AND realm_id = ?",
    ).get(connectionId, actor.firm_id, realmId);
    const secrets = db.prepare(
      "SELECT access_token_enc, refresh_token_enc FROM quickbooks_oauth WHERE connection_id = ? AND firm_id = ?",
    ).get(connectionId, actor.firm_id);
    if (!stored || !secrets?.access_token_enc || !secrets?.refresh_token_enc) {
      throw new Error("connection was not stored");
    }
    writeAudit(db, actor, "quickbooks.connected", connectionId, "QuickBooks returned a token.");
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    return fail(500, "QuickBooks tokens could not be stored.");
  }
  return null;
}

export function readQuickBooks(db, session) {
  ensureQuickBooks(db);
  const config = quickBooksConfig();
  return { status: 200, payload: publicPayload(config, publicConnection(db, session.firm_id, session.selected_client_id)) };
}

export function beginQuickBooksConnect(db, session) {
  ensureQuickBooks(db);
  const denied = requireManager(db, session);
  if (denied) return denied;
  const config = quickBooksConfig();
  if (!config.configured) return fail(400, config.notice);
  const state = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM quickbooks_oauth_states WHERE expires_at <= ? OR used_at IS NOT NULL").run(now.toISOString());
  db.prepare(
    `INSERT INTO quickbooks_oauth_states (state, firm_id, client_id, user_id, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(state, session.firm_id, session.selected_client_id, session.user_id, now.toISOString(), expires);
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", requestedScope());
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  writeAudit(db, session, "quickbooks.authorize", null, "Authorization started.");
  return { status: 200, payload: { authorizationUrl: url.toString() } };
}

export async function handleQuickBooksCallback(db, url, deps = {}) {
  ensureQuickBooks(db);
  const fetchImpl = deps.fetchImpl || fetch;
  const config = quickBooksConfig();
  const state = String(url.searchParams.get("state") || "");
  const stateRow = state
    ? db.prepare("SELECT state, firm_id, client_id, user_id, expires_at, used_at FROM quickbooks_oauth_states WHERE state = ?").get(state)
    : null;
  if (!stateRow || stateRow.used_at || stateRow.expires_at <= new Date().toISOString()) return redirect("state");
  const usedAt = new Date().toISOString();
  db.prepare(
    "UPDATE quickbooks_oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL",
  ).run(usedAt, state);
  const used = db.prepare("SELECT used_at FROM quickbooks_oauth_states WHERE state = ?").get(state);
  if (used?.used_at !== usedAt) return redirect("state");
  const actor = actorFrom(stateRow);
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(actor.client_id, actor.firm_id);
  if (!client) return redirect("state");
  if (!config.configured) {
    saveFailure(db, actor, config.notice);
    return redirect("missing_token");
  }
  if (url.searchParams.get("error")) {
    saveFailure(db, actor, "QuickBooks authorization was declined.");
    return redirect("denied");
  }
  const realmId = String(url.searchParams.get("realmId") || "");
  if (!/^[0-9]{1,32}$/.test(realmId)) {
    saveFailure(db, actor, "QuickBooks did not return a company id.");
    return redirect("realm");
  }
  const code = String(url.searchParams.get("code") || "");
  if (!code || code.length > 2048) {
    saveFailure(db, actor, "QuickBooks did not return an authorization code.");
    return redirect("missing_token");
  }
  const exchanged = await requestToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  }, fetchImpl);
  if (!exchanged.ok) {
    saveFailure(db, actor, exchanged.error);
    return redirect("missing_token");
  }
  const company = await fetchCompanyName({
    env: "sandbox",
    realmId,
    accessToken: exchanged.token.access_token,
    fetchImpl,
  });
  const stored = storeConnected(
    db,
    actor,
    config,
    exchanged.token,
    realmId,
    company.ok ? company.companyName : "",
    company.ok ? "" : company.error,
  );
  if (stored?.error) return redirect("intuit");
  return redirect("connected");
}

export function readRefreshToken(db, actor, config) {
  const oauth = db.prepare(
    `SELECT access_token_enc, refresh_token_enc, access_expires_at
     FROM quickbooks_oauth WHERE firm_id = ? AND client_id = ?`,
  ).get(actor.firm_id, clientOf(actor));
  if (!oauth) return { accessToken: "", refreshToken: "", accessExpiresAt: null };
  return {
    accessToken: decryptToken(oauth.access_token_enc, config.clientSecret),
    refreshToken: decryptToken(oauth.refresh_token_enc, config.clientSecret),
    accessExpiresAt: oauth.access_expires_at,
  };
}

export function storeRefreshedToken(db, actor, config, token) {
  const now = new Date().toISOString();
  const accessEnc = encryptToken(token.access_token, config.clientSecret);
  const refreshEnc = encryptToken(token.refresh_token, config.clientSecret);
  if (decryptToken(accessEnc, config.clientSecret) !== token.access_token) return false;
  if (decryptToken(refreshEnc, config.clientSecret) !== token.refresh_token) return false;
  db.prepare(
    `UPDATE quickbooks_oauth
     SET access_token_enc = ?, refresh_token_enc = ?, token_type = 'bearer', access_expires_at = ?, refresh_expires_at = ?, updated_at = ?
     WHERE firm_id = ? AND client_id = ?`,
  ).run(accessEnc, refreshEnc, expiryFrom(token.expires_in), expiryFrom(token.x_refresh_token_expires_in), now, actor.firm_id, clientOf(actor));
  db.prepare(
    `UPDATE quickbooks_connections
     SET status = 'connected', error_message = '', updated_at = ?
     WHERE firm_id = ? AND client_id = ? AND status = 'connected'`,
  ).run(now, actor.firm_id, clientOf(actor));
  return true;
}

export function markRefreshFailure(db, actor, message) {
  const now = new Date().toISOString();
  const existing = loadConnection(db, actor.firm_id, clientOf(actor));
  if (!existing) return;
  db.prepare(
    `UPDATE quickbooks_connections
     SET status = 'error', error_message = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ?`,
  ).run(message, now, existing.id, actor.firm_id, clientOf(actor));
  recordConnectionError(db, actor, existing.id, message);
  writeAudit(db, actor, "quickbooks.refresh_failed", existing.id, message);
}

export async function disconnectQuickBooks(db, session, input, deps = {}) {
  ensureQuickBooks(db);
  const denied = requireManager(db, session);
  if (denied) return denied;
  const connectionId = String(input?.connectionId || "");
  const row = loadConnectionForFirm(db, session.firm_id, session.selected_client_id, connectionId);
  if (!row) return fail(404, "QuickBooks connection not found.");
  const config = quickBooksConfig();
  const secrets = readRefreshToken(db, session, config);
  const fetchImpl = deps.fetchImpl || fetch;
  let revokeError = "";
  if (secrets.refreshToken) {
    const revoked = await revokeToken(config, secrets.refreshToken, fetchImpl);
    if (!revoked.ok) revokeError = revoked.error;
  }
  const now = new Date().toISOString();
  const message = revokeError || "";
  db.prepare(
    `UPDATE quickbooks_connections
     SET status = 'disconnected', error_message = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ?`,
  ).run(message, now, row.id, session.firm_id, session.selected_client_id);
  db.prepare(
    `UPDATE quickbooks_oauth
     SET access_token_enc = '', refresh_token_enc = '', token_type = '', access_expires_at = NULL, refresh_expires_at = NULL, updated_at = ?
     WHERE connection_id = ? AND firm_id = ? AND client_id = ?`,
  ).run(now, row.id, session.firm_id, session.selected_client_id);
  if (revokeError) recordConnectionError(db, session, row.id, revokeError);
  writeAudit(db, session, "quickbooks.disconnected", row.id, revokeError || "Disconnected.");
  return readQuickBooks(db, session);
}
