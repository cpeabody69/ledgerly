// Read-only QuickBooks mirror. Rows here are sandbox copies.
// They are not journal entries and they do not replace Avenue statements.
import { createHash, randomUUID } from "node:crypto";
import { parseCents } from "../../shared/money.js";
import { canManageFirm } from "../permissions.js";
import { fail, loadConnection, rememberQuickBooksId } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quickbooks_records (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  realm_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  qbo_id TEXT NOT NULL,
  sync_token TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  txn_date TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,
  summary_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('synced', 'conflict')),
  updated_at TEXT NOT NULL,
  UNIQUE (firm_id, realm_id, entity_type, qbo_id)
);
CREATE TABLE IF NOT EXISTS quickbooks_conflicts (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  qbo_id TEXT NOT NULL,
  local_summary TEXT NOT NULL,
  remote_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'kept')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS quickbooks_reports (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  report_name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  UNIQUE (firm_id, client_id, report_name, start_date, end_date)
);
`;

function fingerprint(summary) {
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
}

function amountCents(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6) return null;
    return cents;
  }
  const text = String(value).trim();
  try {
    return parseCents(text.includes(".") ? text : `${text}.00`);
  } catch {
    return null;
  }
}

function text(value) {
  const cleaned = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!cleaned || /token|secret|bearer|authorization/i.test(cleaned)) return "";
  return cleaned.slice(0, 180);
}

export function summarizeQuickBooksRow(entity, row) {
  const qboId = row && (typeof row.Id === "string" || typeof row.Id === "number") ? String(row.Id) : "";
  if (!/^[0-9A-Za-z-]{1,40}$/.test(qboId)) return null;
  const lines = Array.isArray(row.Line) ? row.Line.slice(0, 40).map((line) => ({
    description: text(line?.Description),
    amountCents: amountCents(line?.Amount),
    account: text(line?.JournalEntryLineDetail?.AccountRef?.name || line?.AccountBasedExpenseLineDetail?.AccountRef?.name || ""),
    posting: text(line?.JournalEntryLineDetail?.PostingType || ""),
  })) : [];
  const summary = {
    entity,
    qboId,
    syncToken: text(row.SyncToken == null ? "" : String(row.SyncToken)),
    name: text(row.DisplayName || row.Name || row.DocNumber || row.PrivateNote || ""),
    date: text(row.TxnDate || ""),
    amountCents: amountCents(row.TotalAmt ?? row.Balance ?? row.CurrentBalance),
    lines,
    postsToLedger: false,
  };
  return summary;
}

export function ensureMirror(db) {
  db.exec(SCHEMA);
  const clients = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clients'").get();
  if (!clients) return;
  const columns = new Set(db.prepare("PRAGMA table_info(clients)").all().map((column) => column.name));
  if (!columns.has("books_authority")) {
    db.exec("ALTER TABLE clients ADD COLUMN books_authority TEXT NOT NULL DEFAULT 'avenue'");
  }
  const syncs = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quickbooks_syncs'").get();
  if (!syncs) return;
  const syncColumns = new Set(db.prepare("PRAGMA table_info(quickbooks_syncs)").all().map((column) => column.name));
  if (!syncColumns.has("unchanged_count")) db.exec("ALTER TABLE quickbooks_syncs ADD COLUMN unchanged_count INTEGER NOT NULL DEFAULT 0");
  if (!syncColumns.has("conflict_count")) db.exec("ALTER TABLE quickbooks_syncs ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0");
}

export function storeQuickBooksRow(db, ctx, entity, row) {
  ensureMirror(db);
  const summary = summarizeQuickBooksRow(entity, row);
  if (!summary) return { ok: false, error: `QuickBooks returned a ${entity} record without an id.` };
  const digest = fingerprint(summary);
  const encoded = JSON.stringify(summary);
  const existing = db.prepare(
    `SELECT id, fingerprint, summary_json FROM quickbooks_records
     WHERE firm_id = ? AND realm_id = ? AND entity_type = ? AND qbo_id = ?`,
  ).get(ctx.firmId, ctx.realmId, entity, summary.qboId);
  const now = new Date().toISOString();
  if (!existing) {
    const remembered = rememberQuickBooksId(db, {
      firmId: ctx.firmId,
      clientId: ctx.clientId,
      connectionId: ctx.connectionId,
      realmId: ctx.realmId,
      entityType: entity,
      qboId: summary.qboId,
    });
    if (!remembered.ok) return remembered;
    db.prepare(
      `INSERT INTO quickbooks_records (
        id, firm_id, client_id, connection_id, realm_id, entity_type, qbo_id, sync_token,
        display_name, txn_date, amount_cents, summary_json, fingerprint, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
    ).run(
      randomUUID(),
      ctx.firmId,
      ctx.clientId,
      ctx.connectionId,
      ctx.realmId,
      entity,
      summary.qboId,
      summary.syncToken,
      summary.name,
      summary.date,
      summary.amountCents,
      encoded,
      digest,
      now,
    );
    return { ok: true, imported: true };
  }
  if (existing.fingerprint === digest) return { ok: true, unchanged: true };
  const open = db.prepare(
    `SELECT id FROM quickbooks_conflicts
     WHERE firm_id = ? AND client_id = ? AND entity_type = ? AND qbo_id = ? AND status = 'open'`,
  ).get(ctx.firmId, ctx.clientId, entity, summary.qboId);
  if (!open) {
    db.prepare(
      `INSERT INTO quickbooks_conflicts (
        id, firm_id, client_id, connection_id, entity_type, qbo_id, local_summary, remote_summary, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
    ).run(randomUUID(), ctx.firmId, ctx.clientId, ctx.connectionId, entity, summary.qboId, existing.summary_json, encoded, now);
  } else {
    db.prepare(
      "UPDATE quickbooks_conflicts SET remote_summary = ? WHERE id = ? AND firm_id = ?",
    ).run(encoded, open.id, ctx.firmId);
  }
  db.prepare(
    "UPDATE quickbooks_records SET status = 'conflict', updated_at = ? WHERE id = ? AND firm_id = ?",
  ).run(now, existing.id, ctx.firmId);
  return { ok: true, conflict: true };
}

function reportRows(payload) {
  const rows = payload?.Rows?.Row;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 40).map((row) => {
    const cols = row?.Summary?.ColData || row?.ColData || [];
    return {
      label: text(cols[0]?.value || ""),
      amount: text(cols[1]?.value || ""),
    };
  }).filter((row) => row.label);
}

export function storeQuickBooksReport(db, ctx, name, payload) {
  ensureMirror(db);
  const summary = {
    name,
    start: text(payload?.Header?.StartPeriod || ""),
    end: text(payload?.Header?.EndPeriod || ""),
    rows: reportRows(payload),
    postsToLedger: false,
    source: "quickbooks-sandbox",
  };
  const digest = fingerprint(summary);
  const now = new Date().toISOString();
  const existing = db.prepare(
    `SELECT id, fingerprint FROM quickbooks_reports
     WHERE firm_id = ? AND client_id = ? AND report_name = ? AND start_date = ? AND end_date = ?`,
  ).get(ctx.firmId, ctx.clientId, name, summary.start, summary.end);
  if (!existing) {
    db.prepare(
      `INSERT INTO quickbooks_reports (
        id, firm_id, client_id, connection_id, report_name, start_date, end_date, summary_json, fingerprint, retrieved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), ctx.firmId, ctx.clientId, ctx.connectionId, name, summary.start, summary.end, JSON.stringify(summary), digest, now);
    return { imported: true };
  }
  if (existing.fingerprint === digest) return { unchanged: true };
  db.prepare(
    "UPDATE quickbooks_reports SET summary_json = ?, fingerprint = ?, retrieved_at = ? WHERE id = ? AND firm_id = ?",
  ).run(JSON.stringify(summary), digest, now, existing.id, ctx.firmId);
  return { imported: true };
}

export function authorityFor(db, firmId, clientId) {
  ensureMirror(db);
  const row = db.prepare("SELECT books_authority FROM clients WHERE id = ? AND firm_id = ?").get(clientId, firmId);
  return row?.books_authority === "quickbooks" ? "quickbooks" : "avenue";
}

export function booksBlockJournal(db, session) {
  if (!session?.firm_id || !session.selected_client_id) return null;
  if (authorityFor(db, session.firm_id, session.selected_client_id) !== "quickbooks") return null;
  return fail(409, "QuickBooks is the authoritative ledger for this client. This entry was not posted.");
}

export function setBooksAuthority(db, session, input) {
  ensureMirror(db);
  const role = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!role || !canManageFirm(role.role)) return fail(403, "Only an owner or administrator can choose the authoritative ledger.");
  const authority = String(input?.authority || "");
  if (authority !== "avenue" && authority !== "quickbooks") return fail(400, "Choose Avenue or QuickBooks as the authoritative ledger.");
  if (authority === "quickbooks") {
    const connection = loadConnection(db, session.firm_id, session.selected_client_id);
    if (!connection || connection.status !== "connected") {
      return fail(409, "Connect QuickBooks before making it the authoritative ledger.");
    }
  }
  db.prepare("UPDATE clients SET books_authority = ? WHERE id = ? AND firm_id = ?").run(authority, session.selected_client_id, session.firm_id);
  return { status: 200, authority };
}

export function resolveQuickBooksConflict(db, session, conflictId, input) {
  ensureMirror(db);
  const role = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!role || !canManageFirm(role.role)) return fail(403, "Only an owner or administrator can resolve a QuickBooks conflict.");
  const action = String(input?.action || "");
  if (action !== "accept" && action !== "keep") return fail(400, "Accept the QuickBooks change or keep the stored copy.");
  const conflict = db.prepare(
    "SELECT * FROM quickbooks_conflicts WHERE id = ? AND firm_id = ? AND client_id = ? AND status = 'open'",
  ).get(conflictId, session.firm_id, session.selected_client_id);
  if (!conflict) return fail(404, "Conflict not found.");
  const now = new Date().toISOString();
  if (action === "accept") {
    const summary = JSON.parse(conflict.remote_summary);
    db.prepare(
      `UPDATE quickbooks_records
       SET sync_token = ?, display_name = ?, txn_date = ?, amount_cents = ?, summary_json = ?, fingerprint = ?, status = 'synced', updated_at = ?
       WHERE firm_id = ? AND client_id = ? AND entity_type = ? AND qbo_id = ?`,
    ).run(
      summary.syncToken || "",
      summary.name || "",
      summary.date || "",
      summary.amountCents,
      conflict.remote_summary,
      fingerprint(summary),
      now,
      session.firm_id,
      session.selected_client_id,
      conflict.entity_type,
      conflict.qbo_id,
    );
  } else {
    db.prepare(
      `UPDATE quickbooks_records SET status = 'synced', updated_at = ?
       WHERE firm_id = ? AND client_id = ? AND entity_type = ? AND qbo_id = ?`,
    ).run(now, session.firm_id, session.selected_client_id, conflict.entity_type, conflict.qbo_id);
  }
  db.prepare(
    "UPDATE quickbooks_conflicts SET status = ?, resolved_at = ? WHERE id = ? AND firm_id = ?",
  ).run(action === "accept" ? "accepted" : "kept", now, conflict.id, session.firm_id);
  return { status: 200, action };
}

export function mirrorSummary(db, firmId, clientId) {
  ensureMirror(db);
  const records = db.prepare(
    `SELECT entity_type, status, COUNT(*) AS count
     FROM quickbooks_records WHERE firm_id = ? AND client_id = ?
     GROUP BY entity_type, status`,
  ).all(firmId, clientId);
  const conflicts = db.prepare(
    `SELECT id, entity_type, qbo_id, local_summary, remote_summary, created_at
     FROM quickbooks_conflicts
     WHERE firm_id = ? AND client_id = ? AND status = 'open'
     ORDER BY created_at`,
  ).all(firmId, clientId).map((row) => ({
    id: row.id,
    entity: row.entity_type,
    qboId: row.qbo_id,
    local: JSON.parse(row.local_summary),
    remote: JSON.parse(row.remote_summary),
    createdAt: row.created_at,
  }));
  const reports = db.prepare(
    `SELECT report_name, start_date, end_date, summary_json, retrieved_at
     FROM quickbooks_reports WHERE firm_id = ? AND client_id = ?
     ORDER BY report_name`,
  ).all(firmId, clientId).map((row) => ({
    name: row.report_name,
    start: row.start_date,
    end: row.end_date,
    retrievedAt: row.retrieved_at,
    ...JSON.parse(row.summary_json),
  }));
  return {
    authority: authorityFor(db, firmId, clientId),
    authorityLabel: authorityFor(db, firmId, clientId) === "quickbooks" ? "QuickBooks Online sandbox" : "Avenue books",
    postsToLedger: false,
    counts: records.map((row) => ({ entity: row.entity_type, status: row.status, count: Number(row.count) })),
    conflicts,
    reports,
  };
}

export function failedSyncEntities(db, firmId, clientId) {
  const rows = db.prepare(
    `SELECT entity_type, status FROM quickbooks_syncs
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at DESC, rowid DESC`,
  ).all(firmId, clientId);
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.entity_type)) latest.set(row.entity_type, row.status);
  }
  return [...latest.entries()].filter(([, status]) => status === "error").map(([entity]) => entity);
}
