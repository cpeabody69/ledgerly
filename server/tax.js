import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tax_workflows (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  season TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_started', 'gathering', 'in_review', 'blocked')),
  assignee_user_id TEXT REFERENCES users(id),
  blocked_reason TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (firm_id, client_id, season)
);

CREATE TABLE IF NOT EXISTS tax_events (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  workflow_id TEXT NOT NULL REFERENCES tax_workflows(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_notes (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  workflow_id TEXT NOT NULL REFERENCES tax_workflows(id),
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_workpapers (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  workflow_id TEXT NOT NULL REFERENCES tax_workflows(id),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
`;

const STATUS_LABEL = {
  not_started: "Not started",
  gathering: "Gathering",
  in_review: "In review",
  blocked: "Blocked",
};

const MEDIA_TYPES = new Set(["text/plain", "application/pdf", "image/png", "image/jpeg"]);
const MAX_BYTES = 48 * 1024;

function fail(status, error) {
  return { status, error };
}

export function ensureTax(db) {
  db.exec(SCHEMA);
}

function audit(db, session, action, entityId) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'tax_workflow', ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, session.selected_client_id, entityId, new Date().toISOString());
}

function countOf(row) {
  return Number(row?.count || 0);
}

function seasonYear() {
  return String(new Date().getFullYear());
}

function sameClient(session, clientId) {
  return clientId && clientId !== session.selected_client_id;
}

function recordEvent(db, session, workflow, fromStatus, toStatus, note) {
  db.prepare(
    `INSERT INTO tax_events (
      id, firm_id, client_id, workflow_id, actor_user_id, from_status, to_status, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    session.firm_id,
    session.selected_client_id,
    workflow.id,
    session.user_id,
    fromStatus,
    toStatus,
    note || "",
    new Date().toISOString(),
  );
}

function ensureWorkflow(db, session) {
  ensureTax(db);
  const season = seasonYear();
  const existing = db.prepare(
    "SELECT * FROM tax_workflows WHERE firm_id = ? AND client_id = ? AND season = ?",
  ).get(session.firm_id, session.selected_client_id, season);
  if (existing) return existing;
  const id = randomUUID();
  const now = new Date().toISOString();
  const workflow = {
    id,
    firm_id: session.firm_id,
    client_id: session.selected_client_id,
    season,
    status: "not_started",
    assignee_user_id: null,
    blocked_reason: "",
    updated_by: session.user_id,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO tax_workflows (
      id, firm_id, client_id, season, status, assignee_user_id, blocked_reason, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'not_started', NULL, '', ?, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, season, session.user_id, now, now);
  recordEvent(db, session, workflow, null, "not_started", `Opened ${season}`);
  audit(db, session, "tax.opened", id);
  return workflow;
}

function readiness(db, session) {
  const firmId = session.firm_id;
  const clientId = session.selected_client_id;
  const uncategorized = countOf(db.prepare(
    "SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ? AND status = 'for_review'",
  ).get(firmId, clientId));
  const uncategorizedNames = db.prepare(
    `SELECT description FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND status = 'for_review'
     ORDER BY posted_on, description LIMIT 6`,
  ).all(firmId, clientId).map((row) => row.description);
  const unfinished = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM bank_accounts
     WHERE firm_id = ? AND client_id = ?
       AND EXISTS (
         SELECT 1 FROM reconciliations
         WHERE reconciliations.bank_account_id = bank_accounts.id
           AND reconciliations.firm_id = bank_accounts.firm_id
           AND reconciliations.client_id = bank_accounts.client_id
           AND reconciliations.status = 'complete'
       )
       AND EXISTS (
         SELECT 1 FROM bank_transactions
         WHERE bank_transactions.bank_account_id = bank_accounts.id
           AND bank_transactions.firm_id = bank_accounts.firm_id
           AND bank_transactions.client_id = bank_accounts.client_id
           AND bank_transactions.cleared_reconciliation_id IS NULL
       )`,
  ).get(firmId, clientId));
  const requests = db.prepare(
    `SELECT id, title, status FROM document_requests
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at, title`,
  ).all(firmId, clientId).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    statusLabel: row.status === "complete" ? "In" : "Requested",
  }));
  const missing = requests.filter((row) => row.status === "open");
  const openInvoices = db.prepare(
    `SELECT number FROM invoices
     WHERE firm_id = ? AND client_id = ? AND status IN ('sent', 'partial')
     ORDER BY number`,
  ).all(firmId, clientId);
  const items = [
    {
      key: "uncategorized",
      label: "Uncategorized transactions",
      ready: uncategorized === 0,
      count: uncategorized,
      detail: uncategorized === 0 ? "Every transaction is categorized." : uncategorizedNames.join(", "),
    },
    {
      key: "reconciliations",
      label: "Unfinished reconciliations",
      ready: unfinished === 0,
      count: unfinished,
      detail: unfinished === 0
        ? "No reconciliation was left unfinished."
        : `${unfinished} ${unfinished === 1 ? "account has" : "accounts have"} uncleared lines after a completed reconciliation.`,
    },
    {
      key: "documents",
      label: "Missing documents",
      ready: missing.length === 0,
      count: missing.length,
      detail: missing.length === 0 ? "Every request has a file." : missing.map((row) => row.title).join(", "),
    },
    {
      key: "invoices",
      label: "Invoices still open",
      ready: openInvoices.length === 0,
      count: openInvoices.length,
      detail: openInvoices.length === 0 ? "No invoice is still open." : openInvoices.map((row) => row.number).join(", "),
    },
  ];
  return {
    ready: items.every((item) => item.ready),
    items,
    requests,
  };
}

function userName(db, session, userId) {
  if (!userId) return null;
  return db.prepare("SELECT id, name FROM users WHERE id = ? AND firm_id = ?").get(userId, session.firm_id) || null;
}

function present(db, session) {
  const workflow = ensureWorkflow(db, session);
  const checks = readiness(db, session);
  const assignee = userName(db, session, workflow.assignee_user_id);
  const updatedBy = userName(db, session, workflow.updated_by);
  const members = db.prepare(
    "SELECT id, name, role FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id).map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
  }));
  const events = db.prepare(
    `SELECT tax_events.*, users.name AS actor_name
     FROM tax_events
     JOIN users ON users.id = tax_events.actor_user_id AND users.firm_id = tax_events.firm_id
     WHERE tax_events.workflow_id = ? AND tax_events.firm_id = ?
     ORDER BY tax_events.created_at DESC, tax_events.id DESC`,
  ).all(workflow.id, session.firm_id).map((row) => ({
    id: row.id,
    actorId: row.actor_user_id,
    actorName: row.actor_name,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    fromLabel: row.from_status ? STATUS_LABEL[row.from_status] || row.from_status : "",
    toLabel: STATUS_LABEL[row.to_status] || row.to_status,
    note: row.note,
    createdAt: row.created_at,
  }));
  const notes = db.prepare(
    `SELECT tax_notes.*, users.name AS author_name
     FROM tax_notes
     JOIN users ON users.id = tax_notes.created_by AND users.firm_id = tax_notes.firm_id
     WHERE tax_notes.workflow_id = ? AND tax_notes.firm_id = ?
     ORDER BY tax_notes.created_at, tax_notes.id`,
  ).all(workflow.id, session.firm_id).map((row) => ({
    id: row.id,
    body: row.body,
    authorName: row.author_name,
    createdAt: row.created_at,
  }));
  const workpapers = db.prepare(
    `SELECT tax_workpapers.id, tax_workpapers.name, tax_workpapers.media_type, tax_workpapers.byte_size,
            tax_workpapers.created_at, users.name AS author_name
     FROM tax_workpapers
     JOIN users ON users.id = tax_workpapers.created_by AND users.firm_id = tax_workpapers.firm_id
     WHERE tax_workpapers.workflow_id = ? AND tax_workpapers.firm_id = ?
     ORDER BY tax_workpapers.created_at, tax_workpapers.name`,
  ).all(workflow.id, session.firm_id).map((row) => ({
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: Number(row.byte_size),
    authorName: row.author_name,
    createdAt: row.created_at,
  }));
  const client = db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  return {
    status: 200,
    payload: {
      client: { id: client.id, name: client.name },
      season: workflow.season,
      ready: checks.ready,
      items: checks.items,
      requests: checks.requests,
      workflow: {
        id: workflow.id,
        season: workflow.season,
        status: workflow.status,
        statusLabel: STATUS_LABEL[workflow.status],
        assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
        blockedReason: workflow.blocked_reason,
        updatedBy: updatedBy ? { id: updatedBy.id, name: updatedBy.name } : null,
        updatedAt: workflow.updated_at,
      },
      events,
      notes,
      workpapers,
      members,
    },
  };
}

export function readTax(db, session, clientId) {
  if (sameClient(session, clientId)) return fail(404, "Client not found.");
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  if (!client) return fail(404, "Client not found.");
  return present(db, session);
}

export function updateTax(db, session, input) {
  const body = input || {};
  if (sameClient(session, body.clientId)) return fail(404, "Client not found.");
  const workflow = ensureWorkflow(db, session);
  let status = workflow.status;
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    status = String(body.status || "");
    if (!STATUS_LABEL[status]) return fail(400, "Choose a workflow status.");
  }
  let assigneeId = workflow.assignee_user_id;
  if (Object.prototype.hasOwnProperty.call(body, "assigneeId")) {
    assigneeId = body.assigneeId ? String(body.assigneeId) : null;
    if (assigneeId) {
      const member = db.prepare("SELECT id FROM users WHERE id = ? AND firm_id = ?").get(assigneeId, session.firm_id);
      if (!member) return fail(404, "That person is not in this firm.");
    }
  }
  let blockedReason = status === "blocked" ? String(body.blockedReason ?? workflow.blocked_reason ?? "").trim() : "";
  if (status === "blocked" && (!blockedReason || blockedReason.length > 200)) {
    return fail(400, "Say what is blocked.");
  }
  const changed = status !== workflow.status
    || (assigneeId || null) !== (workflow.assignee_user_id || null)
    || blockedReason !== workflow.blocked_reason;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tax_workflows
     SET status = ?, assignee_user_id = ?, blocked_reason = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND firm_id = ?`,
  ).run(status, assigneeId, blockedReason, session.user_id, now, workflow.id, session.firm_id);
  if (changed) {
    const note = status === "blocked" ? blockedReason : "";
    recordEvent(db, session, workflow, workflow.status, status, note);
    audit(db, session, "tax.status_changed", workflow.id);
  }
  return present(db, session);
}

export function addTaxNote(db, session, input) {
  const body = input || {};
  if (sameClient(session, body.clientId)) return fail(404, "Client not found.");
  const workflow = ensureWorkflow(db, session);
  const text = String(body.body || "").trim();
  if (!text || text.length > 2000) return fail(400, "Enter a note.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tax_notes (id, firm_id, client_id, workflow_id, body, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, workflow.id, text, session.user_id, now);
  audit(db, session, "tax.note_stored", id);
  return present(db, session);
}

function fileName(value) {
  const name = String(value || "").replace(/\\/g, "/").split("/").pop().trim();
  if (!name || name === "." || name === ".." || name.length > 80) return "";
  if (/[\u0000-\u001f]/.test(name)) return "";
  return name;
}

function fileBytes(body) {
  const encoded = String(body?.contentBase64 || "").replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  return bytes;
}

export function storeTaxWorkpaper(db, session, input) {
  const body = input || {};
  if (sameClient(session, body.clientId)) return fail(404, "Client not found.");
  const workflow = ensureWorkflow(db, session);
  const name = fileName(body.name);
  if (!name) return fail(400, "Enter a file name.");
  const mediaType = String(body.mediaType || "");
  if (!MEDIA_TYPES.has(mediaType)) return fail(400, "Use a small text, PDF, or image file.");
  const bytes = fileBytes(body);
  if (!bytes) return fail(400, "Choose a synthetic file of 48 KB or less.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tax_workpapers (
      id, firm_id, client_id, workflow_id, name, media_type, byte_size, bytes, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, workflow.id, name, mediaType, bytes.length, bytes, session.user_id, now);
  audit(db, session, "tax.workpaper_stored", id);
  return present(db, session);
}

export function readTaxWorkpaper(db, session, id) {
  ensureTax(db);
  const row = db.prepare(
    "SELECT name, media_type, bytes, client_id FROM tax_workpapers WHERE id = ? AND firm_id = ?",
  ).get(id, session.firm_id);
  if (!row || row.client_id !== session.selected_client_id) return null;
  return {
    name: row.name,
    mediaType: row.media_type,
    bytes: Buffer.from(row.bytes),
  };
}
