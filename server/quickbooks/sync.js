import { pullAccounts } from "./accounts.js";
import { pullCustomers } from "./customers.js";
import { pullInvoices } from "./invoices.js";
import { pullPayments } from "./payments.js";
import { pullTransactions } from "./transactions.js";
import { pullVendors } from "./vendors.js";
import { pullBills } from "./bills.js";
import { pullJournalEntries } from "./journal.js";
import { pullBalanceSheet, pullProfitAndLoss } from "./reports.js";
import { ensureMirror, failedSyncEntities, mirrorSummary } from "./mirror.js";
import { canManageFirm } from "../permissions.js";
import { quickBooksConfig } from "./config.js";
import { requestToken } from "./api.js";
import {
  markRefreshFailure,
  readRefreshToken,
  storeRefreshedToken,
} from "./oauth.js";
import {
  ensureQuickBooks,
  fail,
  loadConnection,
  publicConnection,
  publicPayload,
  recordSync,
  touchLastSync,
  writeAudit,
} from "./store.js";

const PULLS = [
  ["Customers", pullCustomers],
  ["Vendors", pullVendors],
  ["Accounts", pullAccounts],
  ["Transactions", pullTransactions],
  ["Invoices", pullInvoices],
  ["Bills", pullBills],
  ["JournalEntries", pullJournalEntries],
  ["Payments", pullPayments],
  ["ProfitAndLoss", pullProfitAndLoss],
  ["BalanceSheet", pullBalanceSheet],
];

function requireManager(db, session) {
  const role = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!role || !canManageFirm(role.role)) return fail(403, "Only an owner or administrator can sync QuickBooks.");
  return null;
}

async function accessTokenFor(db, session, connection, config, fetchImpl) {
  const secrets = readRefreshToken(db, session, config);
  if (!secrets.accessToken || !secrets.refreshToken) {
    markRefreshFailure(db, session, "Stored QuickBooks tokens could not be read.");
    return "";
  }
  const expires = Date.parse(secrets.accessExpiresAt || "");
  if (Number.isFinite(expires) && expires > Date.now() + 60_000) return secrets.accessToken;
  const refreshed = await requestToken(config, {
    grant_type: "refresh_token",
    refresh_token: secrets.refreshToken,
  }, fetchImpl);
  if (!refreshed.ok) {
    markRefreshFailure(db, session, refreshed.error);
    return "";
  }
  if (!storeRefreshedToken(db, session, config, refreshed.token)) {
    markRefreshFailure(db, session, "QuickBooks did not return a refreshed access token.");
    return "";
  }
  return refreshed.token.access_token;
}

export async function syncQuickBooks(db, session, input = {}, deps = {}) {
  ensureQuickBooks(db);
  ensureMirror(db);
  const denied = requireManager(db, session);
  if (denied) return denied;
  const config = quickBooksConfig();
  if (!config.configured) return fail(400, config.notice);
  const connection = loadConnection(db, session.firm_id, session.selected_client_id);
  if (!connection || connection.status !== "connected") return fail(409, "QuickBooks is not connected.");
  if (input.connectionId && input.connectionId !== connection.id) return fail(404, "QuickBooks connection not found.");
  const fetchImpl = deps.fetchImpl || fetch;
  const accessToken = await accessTokenFor(db, session, connection, config, fetchImpl);
  if (!accessToken) {
    recordSync(db, session, connection.id, "OAuth", "error", 0, "QuickBooks did not return a refreshed access token.");
    return {
      status: 502,
      error: "QuickBooks did not return a refreshed access token.",
      payload: publicPayload(config, publicConnection(db, session.firm_id, session.selected_client_id)),
    };
  }
  const ctx = {
    db,
    env: "sandbox",
    realmId: connection.realm_id,
    accessToken,
    fetchImpl,
    firmId: session.firm_id,
    clientId: session.selected_client_id,
    connectionId: connection.id,
  };
  const retryLabels = input.retryFailed === true ? new Set(failedSyncEntities(db, session.firm_id, session.selected_client_id)) : null;
  const pulls = retryLabels ? PULLS.filter(([label]) => retryLabels.has(label)) : PULLS;
  const results = [];
  let anyImported = false;
  let anyOk = false;
  if (!pulls.length && input.retryFailed === true) {
    const payload = publicPayload(config, publicConnection(db, session.firm_id, session.selected_client_id));
    payload.mirror = mirrorSummary(db, session.firm_id, session.selected_client_id);
    payload.sync = { ok: true, results: [], note: "Nothing failed on the last sync." };
    return { status: 200, payload };
  }
  for (const [label, pull] of pulls) {
    const result = await pull(ctx);
    const imported = result.importedIds?.length || 0;
    const unchanged = result.unchangedIds?.length || result.unchanged ? 1 : 0;
    const conflicts = result.conflictIds?.length || 0;
    if (result.ok) anyOk = true;
    if (imported > 0) anyImported = true;
    recordSync(db, session, connection.id, label, result.ok ? "ok" : "error", imported, result.ok ? "" : result.error, unchanged, conflicts);
    results.push({
      entity: label,
      status: result.ok ? "ok" : "error",
      imported,
      unchanged,
      conflicts,
      rejected: result.rejectedIds?.length || 0,
      error: result.ok ? "" : result.error,
    });
  }
  if (anyImported || anyOk) touchLastSync(db, session, connection.id, new Date().toISOString());
  writeAudit(db, session, "quickbooks.synced", connection.id, anyOk ? "QuickBooks returned records." : "QuickBooks sync failed.");
  const payload = publicPayload(config, publicConnection(db, session.firm_id, session.selected_client_id));
  payload.mirror = mirrorSummary(db, session.firm_id, session.selected_client_id);
  payload.sync = { ok: results.every((result) => result.status === "ok"), results, postsToLedger: false };
  return { status: 200, payload };
}
