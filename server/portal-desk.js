// Portal messages, request templates, reminders, and retention.
// These sit on the existing portal and document tables.
import { randomUUID } from "node:crypto";
import { lookupClient } from "./access.js";
import { createDocumentRequest } from "./documents.js";
import { canApproveBills } from "./permissions.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portal_messages (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  body TEXT NOT NULL,
  author_user_id TEXT REFERENCES users(id),
  author_client_user_id TEXT REFERENCES client_users(id),
  created_at TEXT NOT NULL,
  CHECK (author_user_id IS NOT NULL OR author_client_user_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS document_request_templates (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  due_offset_days INTEGER NOT NULL DEFAULT 14,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, name)
);
CREATE TABLE IF NOT EXISTS portal_policies (
  firm_id TEXT PRIMARY KEY REFERENCES firms(id),
  request_approval INTEGER NOT NULL DEFAULT 0,
  retain_days INTEGER NOT NULL DEFAULT 0,
  client_downloads INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_reminders (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  request_id TEXT NOT NULL REFERENCES document_requests(id),
  reminded_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, request_id, reminded_on)
);
`;

function fail(status, error) {
  return { status, error };
}

export function ensurePortalDesk(db) {
  db.exec(SCHEMA);
}

function actor(db, session) {
  if (!session?.user_id || !session.firm_id || session.portal) return null;
  return db.prepare("SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function auditDesk(db, session, action, clientId, entityId, detail = "") {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, ?, ?, ?, 'portal_desk', ?, ?, ?)`,
  ).run(
    randomUUID(),
    session.firm_id,
    session.portal ? null : session.user_id,
    session.portal ? session.client_user_id : null,
    action,
    clientId,
    entityId,
    new Date().toISOString(),
    String(detail || "").slice(0, 500),
  );
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function policyFor(db, firmId) {
  ensurePortalDesk(db);
  return db.prepare(
    "SELECT request_approval, retain_days, client_downloads FROM portal_policies WHERE firm_id = ?",
  ).get(firmId) || { request_approval: 0, retain_days: 0, client_downloads: 1 };
}

export function readPortalPolicy(db, session) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const policy = policyFor(db, session.firm_id);
  return {
    status: 200,
    payload: {
      requestApproval: Number(policy.request_approval) === 1,
      retainDays: Number(policy.retain_days),
      clientDownloads: Number(policy.client_downloads) !== 0,
    },
  };
}

export function savePortalPolicy(db, session, input) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can change portal policy.");
  const body = input || {};
  const retainDays = Number(body.retainDays ?? 0);
  if (!Number.isInteger(retainDays) || retainDays < 0 || retainDays > 3650) return fail(400, "Enter a retention period from 0 to 3650 days.");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_policies (firm_id, request_approval, retain_days, client_downloads, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(firm_id) DO UPDATE SET
       request_approval = excluded.request_approval,
       retain_days = excluded.retain_days,
       client_downloads = excluded.client_downloads,
       updated_at = excluded.updated_at`,
  ).run(
    session.firm_id,
    body.requestApproval ? 1 : 0,
    retainDays,
    body.clientDownloads === false ? 0 : 1,
    now,
  );
  auditDesk(db, session, "portal.policy_saved", null, session.firm_id, "Updated the portal document policy.");
  return readPortalPolicy(db, session);
}

export function listTemplates(db, session) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  ensurePortalDesk(db);
  const templates = db.prepare(
    "SELECT id, name, title, category, due_offset_days FROM document_request_templates WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id).map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    category: row.category,
    dueOffsetDays: Number(row.due_offset_days),
  }));
  return { status: 200, payload: { templates } };
}

export function saveTemplate(db, session, input) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can save a request template.");
  const body = input || {};
  const name = String(body.name || "").trim();
  const title = String(body.title || "").trim();
  if (name.length < 3 || name.length > 80 || title.length < 3 || title.length > 120) return fail(400, "Enter a template name and a request title.");
  const offset = Number(body.dueOffsetDays ?? 14);
  if (!Number.isInteger(offset) || offset < 0 || offset > 365) return fail(400, "Enter a due offset from 0 to 365 days.");
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO document_request_templates (
        id, firm_id, name, title, category, due_offset_days, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, session.firm_id, name, title, String(body.category || "").trim().slice(0, 40), offset, user.id, new Date().toISOString());
  } catch (error) {
    if (String(error.message || error).includes("UNIQUE")) return fail(409, "A template with that name already exists.");
    throw error;
  }
  auditDesk(db, session, "portal.template_saved", null, id, name);
  return listTemplates(db, session);
}

export function applyTemplate(db, session, templateId, input) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const template = db.prepare(
    "SELECT * FROM document_request_templates WHERE id = ? AND firm_id = ?",
  ).get(templateId, session.firm_id);
  if (!template) return fail(404, "Template not found.");
  const client = lookupClient(db, session, input?.clientId || session.selected_client_id);
  if (!client) return fail(404, "Client not found.");
  const dueOn = addDays(todayIso(), Number(template.due_offset_days));
  const created = createDocumentRequest(db, session, { clientId: client.id, title: template.title, dueOn });
  if (created.error) return created;
  auditDesk(db, session, "portal.template_applied", client.id, template.id, template.name);
  return created;
}

export function approveRequest(db, session, requestId) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can approve a document request.");
  const request = db.prepare(
    "SELECT id, client_id, status, review_status FROM document_requests WHERE id = ? AND firm_id = ?",
  ).get(requestId, session.firm_id);
  if (!request || !lookupClient(db, session, request.client_id)) return fail(404, "Request not found.");
  if (request.review_status !== "submitted") return fail(400, "This request is not waiting for review.");
  db.prepare(
    "UPDATE document_requests SET status = 'complete', review_status = 'accepted' WHERE id = ? AND firm_id = ?",
  ).run(request.id, session.firm_id);
  auditDesk(db, session, "portal.request_approved", request.client_id, request.id, "Approved the uploaded request.");
  return { status: 200, payload: { id: request.id, status: "complete", reviewStatus: "accepted" } };
}

function messageRows(db, firmId, clientId) {
  return db.prepare(
    `SELECT portal_messages.*, users.name AS user_name, client_users.name AS client_name
     FROM portal_messages
     LEFT JOIN users ON users.id = portal_messages.author_user_id AND users.firm_id = portal_messages.firm_id
     LEFT JOIN client_users ON client_users.id = portal_messages.author_client_user_id AND client_users.firm_id = portal_messages.firm_id
     WHERE portal_messages.firm_id = ? AND portal_messages.client_id = ?
     ORDER BY portal_messages.created_at, portal_messages.id`,
  ).all(firmId, clientId).map((row) => ({
    id: row.id,
    body: row.body,
    authorName: row.user_name || row.client_name || "",
    fromClient: Boolean(row.author_client_user_id),
    createdAt: row.created_at,
  }));
}

export function listMessages(db, session, clientId) {
  ensurePortalDesk(db);
  if (session?.portal) {
    if (clientId && clientId !== session.client_id) return fail(404, "Client not found.");
    return { status: 200, payload: { messages: messageRows(db, session.firm_id, session.client_id) } };
  }
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = lookupClient(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  return { status: 200, payload: { messages: messageRows(db, session.firm_id, client.id) } };
}

export function postMessage(db, session, clientId, input) {
  ensurePortalDesk(db);
  const body = String(input?.body || "").trim();
  if (!body || body.length > 1000) return fail(400, "Enter a message.");
  let target = "";
  if (session?.portal) {
    if (clientId && clientId !== session.client_id) return fail(404, "Client not found.");
    target = session.client_id;
  } else {
    const user = actor(db, session);
    if (!user) return fail(401, "Sign in required.");
    const client = lookupClient(db, session, clientId);
    if (!client) return fail(404, "Client not found.");
    target = client.id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO portal_messages (
      id, firm_id, client_id, body, author_user_id, author_client_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session.firm_id,
    target,
    body,
    session.portal ? null : session.user_id,
    session.portal ? session.client_user_id : null,
    new Date().toISOString(),
  );
  auditDesk(db, session, "portal.message_sent", target, id, "");
  return listMessages(db, session, target);
}

export function portalHomeExtras(db, session) {
  ensurePortalDesk(db);
  const uncategorized = db.prepare(
    "SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ? AND status = 'for_review'",
  ).get(session.firm_id, session.client_id);
  const closed = db.prepare(
    "SELECT COUNT(*) AS count FROM period_locks WHERE firm_id = ? AND client_id = ? AND status = 'closed'",
  ).get(session.firm_id, session.client_id);
  const user = db.prepare(
    "SELECT mfa_confirmed FROM client_users WHERE id = ? AND firm_id = ?",
  ).get(session.client_user_id, session.firm_id);
  const reminders = db.prepare(
    `SELECT document_reminders.id, document_requests.title, document_reminders.reminded_on
     FROM document_reminders
     JOIN document_requests ON document_requests.id = document_reminders.request_id AND document_requests.firm_id = document_reminders.firm_id
     WHERE document_reminders.firm_id = ? AND document_reminders.client_id = ? AND document_requests.status = 'open'
     ORDER BY document_reminders.reminded_on DESC
     LIMIT 8`,
  ).all(session.firm_id, session.client_id);
  return {
    progress: {
      uncategorized: Number(uncategorized?.count || 0),
      monthsClosed: Number(closed?.count || 0),
    },
    messages: messageRows(db, session.firm_id, session.client_id),
    reminders: reminders.map((row) => ({
      id: row.id,
      title: row.title,
      remindedOn: row.reminded_on,
    })),
    mfaEnabled: Number(user?.mfa_confirmed) === 1,
  };
}

export function noteDocumentReminder(db, session, request, today) {
  if (!request?.due_on || request.due_on >= today) return;
  ensurePortalDesk(db);
  const id = randomUUID();
  const result = db.prepare(
    `INSERT INTO document_reminders (id, firm_id, client_id, request_id, reminded_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(firm_id, request_id, reminded_on) DO NOTHING`,
  ).run(id, session.firm_id, request.client_id, request.id, today, new Date().toISOString());
  if (Number(result.changes) === 1) {
    auditDesk(db, session, "portal.reminder_recorded", request.client_id, request.id, request.title);
  }
}

export function applyRetention(db, session) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can apply retention.");
  const policy = policyFor(db, session.firm_id);
  const days = Number(policy.retain_days);
  if (!days) return fail(400, "Set a retention period before deleting files.");
  const cutoff = `${addDays(todayIso(), -days)}T00:00:00.000Z`;
  const files = db.prepare(
    "SELECT id, client_id, name FROM client_files WHERE firm_id = ? AND created_at < ?",
  ).all(session.firm_id, cutoff);
  for (const file of files) {
    db.prepare("DELETE FROM document_records WHERE firm_id = ? AND file_id = ?").run(session.firm_id, file.id);
    db.prepare("DELETE FROM client_files WHERE id = ? AND firm_id = ?").run(file.id, session.firm_id);
    auditDesk(db, session, "document.purged", file.client_id, file.id, file.name);
  }
  return { status: 200, payload: { removed: files.length } };
}
