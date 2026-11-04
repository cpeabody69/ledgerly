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
  created_by TEXT REFERENCES users(id),
  client_user_id TEXT REFERENCES client_users(id),
  created_at TEXT NOT NULL,
  CHECK (created_by IS NOT NULL OR client_user_id IS NOT NULL)
);
`;

const RECORDS = `
CREATE TABLE IF NOT EXISTS document_records (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  file_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'tag', 'note', 'version')),
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  media_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  bytes BLOB,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_records_by_file ON document_records (firm_id, file_id, kind);
CREATE INDEX IF NOT EXISTS document_records_by_client ON document_records (firm_id, client_id, kind);
`;

const FILE_COLUMNS = [
  ["category", "TEXT NOT NULL DEFAULT ''"],
  ["tax_year", "TEXT NOT NULL DEFAULT ''"],
  ["status", "TEXT NOT NULL DEFAULT 'stored'"],
  ["folder_id", "TEXT"],
];

const MAX_BYTES = 48 * 1024;
const MEDIA_TYPES = new Set([
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const CATEGORIES = new Set(["", "Receipt", "Bank statement", "Tax", "Invoice", "Other"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function fail(status, error) {
  return { status, error };
}

function audit(db, session, action, { clientId = null, entityType = null, entityId = null } = {}) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    session.firm_id,
    session.portal ? null : session.user_id,
    session.portal ? session.client_user_id : null,
    action,
    clientId,
    entityType,
    entityId,
    new Date().toISOString(),
  );
}

export function ensureDocuments(db) {
  db.exec(SCHEMA);
  db.exec(RECORDS);
  const present = new Set(db.prepare("PRAGMA table_info(client_files)").all().map((column) => column.name));
  for (const [name, definition] of FILE_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE client_files ADD COLUMN ${name} ${definition}`);
  }
  const requests = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_requests'").get();
  if (!requests) return;
  const requestColumns = new Set(db.prepare("PRAGMA table_info(document_requests)").all().map((column) => column.name));
  if (!requestColumns.has("due_on")) db.exec("ALTER TABLE document_requests ADD COLUMN due_on TEXT NOT NULL DEFAULT ''");
}

function previewKind(mediaType) {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "image/png" || mediaType === "image/jpeg") return "image";
  return "";
}

function dueDate(value) {
  const dueOn = String(value || "").trim();
  if (!dueOn) return { dueOn: "" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return { error: "Enter a due date." };
  const [year, month, day] = dueOn.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return { error: "Enter a due date." };
  return { dueOn };
}

function formatDue(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return "";
  return `${name} ${Number(day)}, ${year}`;
}

function requestJson(row) {
  const open = row.status !== "complete";
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    statusLabel: open ? "Outstanding" : "Completed",
    dueOn: row.due_on || "",
    dueOnLabel: formatDue(row.due_on || ""),
    clientId: row.client_id,
    clientName: row.client_name || "",
    createdAt: row.created_at,
  };
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 || 12;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${hour}:${minutes} ${suffix}`;
}

function cleanCategory(value) {
  const category = String(value || "").trim();
  if (!CATEGORIES.has(category)) return { error: "Choose a category." };
  return { category };
}

function cleanTaxYear(value) {
  const taxYear = String(value || "").trim();
  if (!taxYear) return { taxYear: "" };
  if (!/^\d{4}$/.test(taxYear)) return { error: "Enter a tax year." };
  return { taxYear };
}

function ownedFile(db, session, id) {
  return db.prepare(
    "SELECT * FROM client_files WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(id, session.firm_id, session.selected_client_id);
}

function ownedFolder(db, session, id) {
  if (!id) return null;
  return db.prepare(
    "SELECT * FROM document_records WHERE id = ? AND firm_id = ? AND client_id = ? AND kind = 'folder'",
  ).get(id, session.firm_id, session.selected_client_id);
}

function writeVersion(db, session, file, note) {
  db.prepare(
    `INSERT INTO document_records (
      id, firm_id, client_id, file_id, kind, name, body, parent_id, media_type, byte_size, bytes, created_by, created_at
    ) VALUES (?, ?, ?, ?, 'version', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    file.firm_id,
    file.client_id,
    file.id,
    file.name,
    note,
    file.folder_id || null,
    file.media_type,
    Number(file.byte_size),
    file.bytes,
    session.portal ? null : session.user_id,
    new Date().toISOString(),
  );
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
    preview: previewKind(row.media_type),
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
  const due = dueDate(body.dueOn);
  if (due.error) return fail(400, due.error);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO document_requests (id, firm_id, client_id, title, status, due_on, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
  ).run(id, session.firm_id, client.id, title, due.dueOn, now);
  audit(db, session, "document_request.created", { clientId: client.id, entityType: "document_request", entityId: id });
  const row = db.prepare(
    `SELECT document_requests.*, clients.name AS client_name
     FROM document_requests
     JOIN clients ON clients.id = document_requests.client_id AND clients.firm_id = document_requests.firm_id
     WHERE document_requests.id = ? AND document_requests.firm_id = ?`,
  ).get(id, session.firm_id);
  return { status: 201, payload: { request: requestJson(row) } };
}

export function listRequestHistory(db, session, clientId = null) {
  ensureDocuments(db);
  if (clientId && !clientInFirm(db, session, clientId)) return null;
  const rows = db.prepare(
    `SELECT document_requests.*, clients.name AS client_name
     FROM document_requests
     JOIN clients ON clients.id = document_requests.client_id AND clients.firm_id = document_requests.firm_id
     WHERE document_requests.firm_id = ?
       AND (? IS NULL OR document_requests.client_id = ?)
     ORDER BY document_requests.created_at, clients.name, document_requests.title`,
  ).all(session.firm_id, clientId || null, clientId || null).map(requestJson);
  return {
    outstanding: rows.filter((request) => request.status === "open"),
    completed: rows.filter((request) => request.status === "complete"),
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
       AND client_files.status = 'stored'
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
  if (!MEDIA_TYPES.has(mediaType)) return fail(400, "Use a PDF, PNG, JPG, DOCX, XLSX, CSV, or text file.");
  const category = cleanCategory(body.category);
  if (category.error) return fail(400, category.error);
  const taxYear = cleanTaxYear(body.taxYear);
  if (taxYear.error) return fail(400, taxYear.error);
  const folder = body.folderId ? ownedFolder(db, session, String(body.folderId)) : null;
  if (body.folderId && (!folder || folder.client_id !== client.id)) return fail(404, "Folder not found.");
  const bytes = fileBytes(body);
  if (!bytes) return fail(400, "Choose a synthetic file of 48 KB or less.");
  const duplicate = db.prepare(
    "SELECT id FROM client_files WHERE firm_id = ? AND client_id = ? AND name = ? AND byte_size = ?",
  ).get(session.firm_id, client.id, name, bytes.length);
  if (duplicate) return fail(409, "This file is already stored for this client. It was not uploaded again.");
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
        id, firm_id, client_id, name, media_type, byte_size, bytes, request_id, transaction_id, created_by, client_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      session.firm_id,
      client.id,
      name,
      mediaType,
      bytes.length,
      bytes,
      requestId,
      transactionId,
      session.portal ? null : session.user_id,
      session.portal ? session.client_user_id : null,
      now,
    );
    if (request) {
      db.prepare(
        "UPDATE document_requests SET status = 'complete' WHERE id = ? AND firm_id = ?",
      ).run(request.id, session.firm_id);
    }
    db.prepare(
      "UPDATE client_files SET category = ?, tax_year = ?, folder_id = ? WHERE id = ? AND firm_id = ?",
    ).run(category.category, taxYear.taxYear, folder?.id || null, id, session.firm_id);
    const storedRow = db.prepare("SELECT * FROM client_files WHERE id = ? AND firm_id = ?").get(id, session.firm_id);
    writeVersion(db, session, storedRow, "uploaded");
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

function recordsFor(db, session, fileIds) {
  if (!fileIds.length) return [];
  const marks = fileIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT * FROM document_records
     WHERE firm_id = ? AND client_id = ? AND file_id IN (${marks})
     ORDER BY created_at, id`,
  ).all(session.firm_id, session.selected_client_id, ...fileIds);
}

function libraryFile(row, records, folders) {
  const mine = records.filter((record) => record.file_id === row.id);
  const folder = folders.find((item) => item.id === row.folder_id);
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    size: Number(row.byte_size),
    category: row.category || "",
    taxYear: row.tax_year || "",
    uploadedAt: row.created_at,
    uploadedAtLabel: formatWhen(row.created_at),
    status: row.status || "stored",
    statusLabel: row.status === "archived" ? "Archived" : "Stored",
    preview: previewKind(row.media_type),
    folderId: row.folder_id || "",
    folderName: folder?.name || "",
    tags: mine.filter((record) => record.kind === "tag").map((record) => ({ id: record.id, name: record.name })),
    notes: mine.filter((record) => record.kind === "note").map((record) => ({
      id: record.id,
      body: record.body,
      createdAt: record.created_at,
      createdAtLabel: formatWhen(record.created_at),
    })),
    versions: mine.filter((record) => record.kind === "version").map((record) => ({
      id: record.id,
      name: record.name,
      note: record.body,
      size: Number(record.byte_size),
      createdAt: record.created_at,
      createdAtLabel: formatWhen(record.created_at),
    })),
  };
}

export function readLibrary(db, session, filters = {}) {
  ensureDocuments(db);
  const folders = db.prepare(
    `SELECT id, name, parent_id, created_at FROM document_records
     WHERE firm_id = ? AND client_id = ? AND kind = 'folder'
     ORDER BY name`,
  ).all(session.firm_id, session.selected_client_id);
  const files = db.prepare(
    `SELECT * FROM client_files
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at DESC, name`,
  ).all(session.firm_id, session.selected_client_id);
  const records = recordsFor(db, session, files.map((file) => file.id));
  const query = String(filters.q || "").trim().toLowerCase();
  const category = String(filters.category || "").trim();
  const taxYear = String(filters.taxYear || "").trim();
  const status = String(filters.status || "").trim();
  const folderId = String(filters.folderId || "").trim();
  const visible = files.filter((file) => {
    if (status && (file.status || "stored") !== status) return false;
    if (category && (file.category || "") !== category) return false;
    if (taxYear && (file.tax_year || "") !== taxYear) return false;
    if (folderId === "root" && file.folder_id) return false;
    if (folderId && folderId !== "root" && file.folder_id !== folderId) return false;
    if (!query) return true;
    return String(file.name || "").toLowerCase().includes(query);
  }).map((file) => libraryFile(file, records, folders));
  return {
    status: 200,
    payload: {
      clientId: session.selected_client_id,
      folders: folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parent_id || "" })),
      files: visible,
    },
  };
}

export function createFolder(db, session, input) {
  ensureDocuments(db);
  const name = fileName(input?.name);
  if (!name) return fail(400, "Enter a folder name.");
  const parent = input?.parentId ? ownedFolder(db, session, String(input.parentId)) : null;
  if (input?.parentId && !parent) return fail(404, "Folder not found.");
  const duplicate = db.prepare(
    `SELECT id FROM document_records
     WHERE firm_id = ? AND client_id = ? AND kind = 'folder' AND name = ? AND IFNULL(parent_id, '') = ?`,
  ).get(session.firm_id, session.selected_client_id, name, parent?.id || "");
  if (duplicate) return fail(409, "That folder already exists.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO document_records (
      id, firm_id, client_id, file_id, kind, name, body, parent_id, media_type, byte_size, bytes, created_by, created_at
    ) VALUES (?, ?, ?, NULL, 'folder', ?, '', ?, '', 0, NULL, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, name, parent?.id || null, session.portal ? null : session.user_id, now);
  audit(db, session, "document.folder_created", { clientId: session.selected_client_id, entityType: "document_record", entityId: id });
  return { status: 201, payload: { folder: { id, name, parentId: parent?.id || "" } } };
}

export function updateDocument(db, session, id, input) {
  ensureDocuments(db);
  const existing = ownedFile(db, session, id);
  if (!existing) return fail(404, "File not found.");
  const body = input || {};
  const name = body.name === undefined ? existing.name : fileName(body.name);
  if (!name) return fail(400, "Enter a file name.");
  const category = body.category === undefined ? { category: existing.category || "" } : cleanCategory(body.category);
  if (category.error) return fail(400, category.error);
  const taxYear = body.taxYear === undefined ? { taxYear: existing.tax_year || "" } : cleanTaxYear(body.taxYear);
  if (taxYear.error) return fail(400, taxYear.error);
  let folderId = existing.folder_id || null;
  if (body.folderId !== undefined) {
    if (!body.folderId) folderId = null;
    else {
      const folder = ownedFolder(db, session, String(body.folderId));
      if (!folder) return fail(404, "Folder not found.");
      folderId = folder.id;
    }
  }
  const changed = name !== existing.name || category.category !== (existing.category || "") || taxYear.taxYear !== (existing.tax_year || "") || folderId !== (existing.folder_id || null);
  if (changed) writeVersion(db, session, existing, "updated");
  db.prepare(
    "UPDATE client_files SET name = ?, category = ?, tax_year = ?, folder_id = ? WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).run(name, category.category, taxYear.taxYear, folderId, existing.id, session.firm_id, session.selected_client_id);
  audit(db, session, "document.updated", { clientId: existing.client_id, entityType: "client_file", entityId: existing.id });
  const library = readLibrary(db, session, {});
  return { status: 200, payload: { file: library.payload.files.find((file) => file.id === existing.id) } };
}

export function addTag(db, session, id, input) {
  ensureDocuments(db);
  const existing = ownedFile(db, session, id);
  if (!existing) return fail(404, "File not found.");
  const name = String(input?.name || "").trim();
  if (!name || name.length > 40) return fail(400, "Enter a tag.");
  const duplicate = db.prepare(
    "SELECT id FROM document_records WHERE file_id = ? AND firm_id = ? AND kind = 'tag' AND lower(name) = lower(?)",
  ).get(existing.id, session.firm_id, name);
  if (duplicate) return fail(409, "That tag is already on the file.");
  const tagId = randomUUID();
  db.prepare(
    `INSERT INTO document_records (
      id, firm_id, client_id, file_id, kind, name, body, parent_id, media_type, byte_size, bytes, created_by, created_at
    ) VALUES (?, ?, ?, ?, 'tag', ?, '', NULL, '', 0, NULL, ?, ?)`,
  ).run(tagId, session.firm_id, existing.client_id, existing.id, name, session.portal ? null : session.user_id, new Date().toISOString());
  return { status: 201, payload: { tag: { id: tagId, name } } };
}

export function addNote(db, session, id, input) {
  ensureDocuments(db);
  const existing = ownedFile(db, session, id);
  if (!existing) return fail(404, "File not found.");
  const body = String(input?.body || "").trim();
  if (!body || body.length > 1000) return fail(400, "Enter a note.");
  const noteId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO document_records (
      id, firm_id, client_id, file_id, kind, name, body, parent_id, media_type, byte_size, bytes, created_by, created_at
    ) VALUES (?, ?, ?, ?, 'note', '', ?, NULL, '', 0, NULL, ?, ?)`,
  ).run(noteId, session.firm_id, existing.client_id, existing.id, body, session.portal ? null : session.user_id, now);
  return { status: 201, payload: { note: { id: noteId, body, createdAt: now, createdAtLabel: formatWhen(now) } } };
}

export function archiveDocument(db, session, id) {
  ensureDocuments(db);
  const existing = ownedFile(db, session, id);
  if (!existing) return fail(404, "File not found.");
  if (existing.status !== "archived") {
    writeVersion(db, session, existing, "archived");
    db.prepare(
      "UPDATE client_files SET status = 'archived' WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).run(existing.id, session.firm_id, session.selected_client_id);
    audit(db, session, "document.archived", { clientId: existing.client_id, entityType: "client_file", entityId: existing.id });
  }
  const row = db.prepare(
    "SELECT bytes, byte_size, status FROM client_files WHERE id = ? AND firm_id = ?",
  ).get(existing.id, session.firm_id);
  return {
    status: 200,
    payload: {
      file: { id: existing.id, status: row.status, size: Number(row.byte_size) },
    },
  };
}
