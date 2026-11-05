import { randomBytes, randomUUID } from "node:crypto";
import { firms } from "./accounts.js";
import { hashPassword, verifyPassword } from "./db.js";
import { listDocuments, listRequestHistory, readDocument, storeDocument } from "./documents.js";
import { listInvoices } from "./invoices.js";

function column(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().find((row) => row.name === name);
}

function rebuildAudit(db) {
  const actor = column(db, "audit_events", "actor_user_id");
  const clientActor = column(db, "audit_events", "client_user_id");
  if (actor && actor.notnull === 0 && clientActor) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE audit_events_next (
        id TEXT PRIMARY KEY,
        firm_id TEXT NOT NULL REFERENCES firms(id),
        actor_user_id TEXT REFERENCES users(id),
        client_user_id TEXT REFERENCES client_users(id),
        action TEXT NOT NULL,
        client_id TEXT REFERENCES clients(id),
        entity_type TEXT,
        entity_id TEXT,
        created_at TEXT NOT NULL,
        CHECK (actor_user_id IS NOT NULL OR client_user_id IS NOT NULL)
      );
      INSERT INTO audit_events_next (
        id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at
      )
      SELECT id, firm_id, actor_user_id, NULL, action, client_id, entity_type, entity_id, created_at
      FROM audit_events;
      DROP TABLE audit_events;
      ALTER TABLE audit_events_next RENAME TO audit_events;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildFiles(db) {
  const created = column(db, "client_files", "created_by");
  const clientActor = column(db, "client_files", "client_user_id");
  if (!created) return;
  if (created.notnull === 0 && clientActor) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE client_files_next (
        id TEXT PRIMARY KEY,
        firm_id TEXT NOT NULL REFERENCES firms(id),
        client_id TEXT NOT NULL REFERENCES clients(id),
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        request_id TEXT REFERENCES document_requests(id),
        transaction_id TEXT,
        created_by TEXT REFERENCES users(id),
        client_user_id TEXT REFERENCES client_users(id),
        created_at TEXT NOT NULL,
        CHECK (created_by IS NOT NULL OR client_user_id IS NOT NULL)
      );
      INSERT INTO client_files_next (
        id, firm_id, client_id, name, media_type, byte_size, bytes, request_id, transaction_id, created_by, client_user_id, created_at
      )
      SELECT id, firm_id, client_id, name, media_type, byte_size, bytes, request_id, transaction_id, created_by, NULL, created_at
      FROM client_files;
      DROP TABLE client_files;
      ALTER TABLE client_files_next RENAME TO client_files;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function seedPortalUsers(db) {
  const insert = db.prepare(
    "INSERT INTO client_users (id, firm_id, client_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const firm of Object.values(firms)) {
    if (!firm.portal) continue;
    const email = firm.portal.email.toLowerCase();
    if (db.prepare("SELECT id FROM client_users WHERE email = ?").get(email)) continue;
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) continue;
    const firmRow = db.prepare("SELECT id FROM firms WHERE name = ?").get(firm.name);
    const client = firmRow
      ? db.prepare("SELECT id FROM clients WHERE firm_id = ? AND name = ?").get(firmRow.id, firm.portal.clientName)
      : null;
    if (!firmRow || !client) continue;
    insert.run(randomUUID(), firmRow.id, client.id, email, firm.portal.name, hashPassword(firm.portal.password), now);
  }
}

export function ensurePortal(db) {
  rebuildAudit(db);
  rebuildFiles(db);
  seedPortalUsers(db);
}

function clientJson(row) {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    initials: row.initials,
    industry: row.industry,
  };
}

function auditPortal(db, session, action, { entityType = null, entityId = null } = {}) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    session.firm_id,
    session.client_user_id,
    action,
    session.client_id,
    entityType,
    entityId,
    new Date().toISOString(),
  );
}

export function portalPayload(db, session) {
  const user = db.prepare(
    "SELECT id, email, name FROM client_users WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(session.client_user_id, session.firm_id, session.client_id);
  const firm = db.prepare("SELECT id, name FROM firms WHERE id = ?").get(session.firm_id);
  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND firm_id = ?").get(session.client_id, session.firm_id);
  return {
    portal: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: "client",
      roleLabel: "Business Client",
    },
    firm: { id: firm.id, name: firm.name },
    client: client ? clientJson(client) : null,
  };
}

export function loadPortalSession(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT client_sessions.id, client_sessions.token, client_sessions.firm_id, client_sessions.client_user_id,
            client_sessions.client_id, client_sessions.expires_at
     FROM client_sessions
     JOIN client_users ON client_users.id = client_sessions.client_user_id
       AND client_users.firm_id = client_sessions.firm_id
       AND client_users.client_id = client_sessions.client_id
     WHERE client_sessions.token = ? AND client_sessions.expires_at > ?`,
  ).get(token, new Date().toISOString());
  if (!row) return null;
  return {
    ...row,
    portal: true,
    selected_client_id: row.client_id,
  };
}

export function signInPortal(db, email, password) {
  const user = db.prepare("SELECT * FROM client_users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password || "", user.password_hash)) return null;
  if (user.status === "deactivated") return { error: "This portal access is deactivated.", status: 403 };
  const membership = db.prepare(
    "SELECT status FROM portal_memberships WHERE client_user_id = ? AND firm_id = ? AND client_id = ?",
  ).get(user.id, user.firm_id, user.client_id);
  if (membership && membership.status !== "active") return { error: "This portal access is deactivated.", status: 403 };
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const session = {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    firm_id: user.firm_id,
    client_user_id: user.id,
    client_id: user.client_id,
    portal: true,
    selected_client_id: user.client_id,
  };
  db.prepare(
    `INSERT INTO client_sessions (id, token, firm_id, client_user_id, client_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(session.id, session.token, session.firm_id, session.client_user_id, session.client_id, now.toISOString(), expires.toISOString());
  auditPortal(db, session, "session.started");
  return { token: session.token, payload: portalPayload(db, session) };
}

export function signOutPortal(db, session) {
  auditPortal(db, session, "session.ended");
  db.prepare("DELETE FROM client_sessions WHERE id = ? AND firm_id = ?").run(session.id, session.firm_id);
}

export function listPortal(db, session, clientId) {
  if (clientId && clientId !== session.client_id) return { status: 404, error: "Client not found." };
  const history = listRequestHistory(db, session, session.client_id);
  if (!history) return { status: 404, error: "Client not found." };
  const requests = [...history.outstanding, ...history.completed];
  const notifications = history.outstanding.map((request) => ({
    id: request.id,
    title: request.title,
    status: request.status,
    statusLabel: request.statusLabel,
    dueOn: request.dueOn,
    dueOnLabel: request.dueOnLabel,
    message: request.dueOnLabel
      ? `Document requested: ${request.title}. Due ${request.dueOnLabel}.`
      : `Document requested: ${request.title}.`,
  }));
  const documents = listDocuments(db, session, session.client_id);
  if (documents.error) return documents;
  const invoices = listInvoices(db, session);
  if (invoices.error) return invoices;
  return {
    status: 200,
    payload: {
      requests,
      requestHistory: history,
      notifications,
      files: documents.payload.files,
      invoices: invoices.payload.invoices.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        customerName: invoice.customerName,
        issueDate: invoice.issueDate,
        issueDateLabel: invoice.issueDateLabel,
        dueDateLabel: invoice.dueDateLabel,
        status: invoice.status,
        statusLabel: invoice.statusLabel,
        total: invoice.total,
        balance: invoice.balance,
      })),
    },
  };
}

export function submitPortalFile(db, session, input) {
  const body = input || {};
  if (body.clientId && body.clientId !== session.client_id) return { status: 404, error: "Client not found." };
  if (body.transactionId) return { status: 404, error: "Not found." };
  const requestId = String(body.requestId || "");
  if (!requestId) return { status: 400, error: "Choose a request." };
  return storeDocument(db, session, {
    name: body.name,
    mediaType: body.mediaType,
    contentBase64: body.contentBase64,
    requestId,
    clientId: session.client_id,
  });
}

export function readPortalDocument(db, session, id) {
  const row = db.prepare(
    "SELECT client_id FROM client_files WHERE id = ? AND firm_id = ?",
  ).get(id, session.firm_id);
  if (!row || row.client_id !== session.client_id) return null;
  return readDocument(db, session, id);
}
