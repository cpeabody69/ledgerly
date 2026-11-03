import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_files (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  request_id TEXT REFERENCES document_requests(id),
  transaction_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
`;

const MAX_BYTES = 48 * 1024;
const MEDIA_TYPES = new Set(["text/plain", "application/pdf", "image/png", "image/jpeg"]);

function fail(status, error) {
  return { status, error };
}

function audit(db, session, action, { clientId = null, entityType = null, entityId = null } = {}) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityType, entityId, new Date().toISOString());
}

export function ensureDocuments(db) {
  db.exec(SCHEMA);
}

function clientInFirm(db, session, clientId) {
  return db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
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

function fileJson(row) {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: Number(row.byte_size),
    clientId: row.client_id,
    clientName: row.client_name,
    requestId: row.request_id,
    requestTitle: row.request_title || "",
    transactionId: row.transaction_id,
    transactionDescription: row.transaction_description || "",
  };
}

export function createDocumentRequest(db, session, input) {
  ensureDocuments(db);
  const body = input || {};
  const clientId = body.clientId || session.selected_client_id;
  const client = clientInFirm(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const title = String(body.title || "").trim();
  if (!title || title.length > 120) return fail(400, "Enter a document title.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO document_requests (id, firm_id, client_id, title, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
  ).run(id, session.firm_id, client.id, title, now);
  audit(db, session, "document_request.created", { clientId: client.id, entityType: "document_request", entityId: id });
  return {
    status: 201,
    payload: {
      request: { id, title, status: "open", clientId: client.id, clientName: client.name },
    },
  };
}

export function listDocuments(db, session, clientId) {
  ensureDocuments(db);
  if (clientId && !clientInFirm(db, session, clientId)) return fail(404, "Client not found.");
  const rows = db.prepare(
    `SELECT client_files.*, clients.name AS client_name,
            document_requests.title AS request_title,
            bank_transactions.description AS transaction_description
     FROM client_files
     JOIN clients ON clients.id = client_files.client_id AND clients.firm_id = client_files.firm_id
     LEFT JOIN document_requests ON document_requests.id = client_files.request_id
       AND document_requests.firm_id = client_files.firm_id
     LEFT JOIN bank_transactions ON bank_transactions.id = client_files.transaction_id
       AND bank_transactions.firm_id = client_files.firm_id
       AND bank_transactions.client_id = client_files.client_id
     WHERE client_files.firm_id = ?
       AND (? IS NULL OR client_files.client_id = ?)
     ORDER BY client_files.created_at, client_files.name`,
  ).all(session.firm_id, clientId || null, clientId || null);
  return { status: 200, payload: { files: rows.map(fileJson) } };
}

export function storeDocument(db, session, input) {
  ensureDocuments(db);
  const body = input || {};
  const clientId = body.clientId || session.selected_client_id;
  const client = clientInFirm(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const name = fileName(body.name);
  if (!name) return fail(400, "Enter a file name.");
  const mediaType = String(body.mediaType || "");
  if (!MEDIA_TYPES.has(mediaType)) return fail(400, "Use a small text, PDF, or image file.");
  const bytes = fileBytes(body);
  if (!bytes) return fail(400, "Choose a synthetic file of 48 KB or less.");
  const requestId = body.requestId ? String(body.requestId) : null;
  const transactionId = body.transactionId ? String(body.transactionId) : null;
  if (requestId && transactionId) return fail(400, "Attach the file to a request or a transaction.");
  let request = null;
  if (requestId) {
    request = db.prepare(
      "SELECT id FROM document_requests WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).get(requestId, session.firm_id, client.id);
    if (!request) return fail(404, "Request not found.");
  }
  if (transactionId) {
    const transaction = db.prepare(
      "SELECT id FROM bank_transactions WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).get(transactionId, session.firm_id, client.id);
    if (!transaction) return fail(404, "Transaction not found.");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO client_files (
        id, firm_id, client_id, name, media_type, byte_size, bytes, request_id, transaction_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, session.firm_id, client.id, name, mediaType, bytes.length, bytes, requestId, transactionId, session.user_id, now);
    if (request) {
      db.prepare(
        "UPDATE document_requests SET status = 'complete' WHERE id = ? AND firm_id = ?",
      ).run(request.id, session.firm_id);
    }
    audit(db, session, "document.stored", { clientId: client.id, entityType: "client_file", entityId: id });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const stored = db.prepare(
    `SELECT client_files.*, clients.name AS client_name,
            document_requests.title AS request_title,
            bank_transactions.description AS transaction_description
     FROM client_files
     JOIN clients ON clients.id = client_files.client_id AND clients.firm_id = client_files.firm_id
     LEFT JOIN document_requests ON document_requests.id = client_files.request_id
       AND document_requests.firm_id = client_files.firm_id
     LEFT JOIN bank_transactions ON bank_transactions.id = client_files.transaction_id
       AND bank_transactions.firm_id = client_files.firm_id
     WHERE client_files.id = ? AND client_files.firm_id = ?`,
  ).get(id, session.firm_id);
  return { status: 201, payload: { file: fileJson(stored) } };
}

export function readDocument(db, session, id) {
  ensureDocuments(db);
  const row = db.prepare(
    "SELECT name, media_type, bytes FROM client_files WHERE id = ? AND firm_id = ?",
  ).get(id, session.firm_id);
  if (!row) return null;
  return {
    name: row.name,
    mediaType: row.media_type,
    bytes: Buffer.from(row.bytes),
  };
}

export function removeDocument(db, session, id) {
  ensureDocuments(db);
  const row = db.prepare(
    "SELECT id, client_id, request_id FROM client_files WHERE id = ? AND firm_id = ?",
  ).get(id, session.firm_id);
  if (!row) return fail(404, "File not found.");
  db.exec("BEGIN");
  try {
    audit(db, session, "document.removed", { clientId: row.client_id, entityType: "client_file", entityId: row.id });
    db.prepare("DELETE FROM client_files WHERE id = ? AND firm_id = ?").run(row.id, session.firm_id);
    if (row.request_id) {
      const remaining = db.prepare(
        "SELECT COUNT(*) AS count FROM client_files WHERE request_id = ? AND firm_id = ?",
      ).get(row.request_id, session.firm_id);
      if (Number(remaining.count) === 0) {
        db.prepare(
          "UPDATE document_requests SET status = 'open' WHERE id = ? AND firm_id = ?",
        ).run(row.request_id, session.firm_id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { status: 200, payload: { ok: true } };
}

export function filesForTransactions(db, session) {
  ensureDocuments(db);
  const rows = db.prepare(
    `SELECT id, name, media_type, byte_size, transaction_id
     FROM client_files
     WHERE firm_id = ? AND client_id = ? AND transaction_id IS NOT NULL
     ORDER BY created_at, name`,
  ).all(session.firm_id, session.selected_client_id);
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.transaction_id) || [];
    list.push({
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      size: Number(row.byte_size),
    });
    grouped.set(row.transaction_id, list);
  }
  return grouped;
}
