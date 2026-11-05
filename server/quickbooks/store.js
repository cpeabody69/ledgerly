import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quickbooks_connections (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  realm_id TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('not_connected', 'connected', 'error', 'disconnected')),
  environment TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  connected_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (firm_id, client_id)
);

CREATE TABLE IF NOT EXISTS quickbooks_oauth (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE REFERENCES quickbooks_connections(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  access_token_enc TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT NOT NULL DEFAULT '',
  token_type TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  access_expires_at TEXT,
  refresh_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quickbooks_oauth_states (
  state TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS quickbooks_syncs (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  connection_id TEXT NOT NULL REFERENCES quickbooks_connections(id),
  entity_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  imported_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quickbooks_sync_errors (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  connection_id TEXT NOT NULL REFERENCES quickbooks_connections(id),
  sync_id TEXT,
  entity_type TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quickbooks_imports (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  connection_id TEXT NOT NULL REFERENCES quickbooks_connections(id),
  realm_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  qbo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, realm_id, entity_type, qbo_id)
);

CREATE TABLE IF NOT EXISTS quickbooks_connection_errors (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  connection_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quickbooks_audit (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  connection_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quickbooks_webhook_events (
  id TEXT PRIMARY KEY,
  firm_id TEXT,
  client_id TEXT,
  connection_id TEXT,
  realm_id TEXT NOT NULL DEFAULT '',
  entity_name TEXT NOT NULL DEFAULT '',
  qbo_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

const CONNECTION_FIELDS = `id, firm_id, client_id, realm_id, company_name, status, environment, error_message, last_sync_at, connected_at, created_by, created_at, updated_at`;

export function ensureQuickBooks(db) {
  db.exec(SCHEMA);
}

export function fail(status, error) {
  return { status, error };
}

function stampLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusLabel(status) {
  if (status === "connected") return "Connected";
  if (status === "error") return "Connection error";
  if (status === "disconnected") return "Disconnected";
  return "Not connected";
}

export function emptyConnection() {
  return {
    id: "",
    status: "not_connected",
    statusLabel: "Not connected",
    companyName: "",
    realmId: "",
    lastSyncAt: null,
    lastSyncLabel: "",
    error: "",
    history: [],
  };
}

export function loadConnection(db, firmId, clientId) {
  return db.prepare(
    `SELECT ${CONNECTION_FIELDS} FROM quickbooks_connections WHERE firm_id = ? AND client_id = ?`,
  ).get(firmId, clientId) || null;
}

export function loadConnectionForFirm(db, firmId, clientId, connectionId) {
  return db.prepare(
    `SELECT ${CONNECTION_FIELDS} FROM quickbooks_connections WHERE id = ? AND firm_id = ? AND client_id = ?`,
  ).get(connectionId, firmId, clientId) || null;
}

export function publicConnection(db, firmId, clientId) {
  const row = loadConnection(db, firmId, clientId);
  if (!row) return emptyConnection();
  const history = db.prepare(
    `SELECT id, entity_type, status, imported_count, error_message, created_at
     FROM quickbooks_syncs
     WHERE firm_id = ? AND client_id = ? AND connection_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 20`,
  ).all(firmId, clientId, row.id).map((item) => ({
    id: item.id,
    entity: item.entity_type,
    status: item.status,
    imported: Number(item.imported_count),
    error: item.error_message,
    createdAt: item.created_at,
    createdLabel: stampLabel(item.created_at),
  }));
  return {
    id: row.id,
    status: row.status,
    statusLabel: statusLabel(row.status),
    companyName: row.company_name,
    realmId: row.realm_id,
    lastSyncAt: row.last_sync_at,
    lastSyncLabel: stampLabel(row.last_sync_at),
    error: row.error_message,
    history,
  };
}

export function publicPayload(config, connection) {
  return {
    configured: config.configured,
    env: config.configured ? "sandbox" : null,
    notice: config.notice,
    connection,
  };
}

export function writeAudit(db, actor, action, connectionId, detail = "") {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO quickbooks_audit (
      id, firm_id, client_id, actor_user_id, action, connection_id, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), actor.firm_id, actor.selected_client_id || actor.client_id || null, actor.user_id || null, action, connectionId || null, detail, now);
  if (!actor.user_id) return;
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'quickbooks_connection', ?, ?)`,
  ).run(randomUUID(), actor.firm_id, actor.user_id, action, actor.selected_client_id || actor.client_id || null, connectionId || null, now);
}

export function recordConnectionError(db, actor, connectionId, message) {
  db.prepare(
    `INSERT INTO quickbooks_connection_errors (id, firm_id, client_id, connection_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), actor.firm_id, actor.selected_client_id || actor.client_id, connectionId || null, message, new Date().toISOString());
}

export function recordSync(db, actor, connectionId, entity, status, importedCount, errorMessage) {
  const now = new Date().toISOString();
  const syncId = randomUUID();
  db.prepare(
    `INSERT INTO quickbooks_syncs (
      id, firm_id, client_id, connection_id, entity_type, status, imported_count, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(syncId, actor.firm_id, actor.selected_client_id || actor.client_id, connectionId, entity, status, importedCount, errorMessage || "", now);
  if (status === "error" && errorMessage) {
    db.prepare(
      `INSERT INTO quickbooks_sync_errors (
        id, firm_id, client_id, connection_id, sync_id, entity_type, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), actor.firm_id, actor.selected_client_id || actor.client_id, connectionId, syncId, entity, errorMessage, now);
  }
  return syncId;
}

export function rememberQuickBooksId(db, input) {
  const qboId = String(input.qboId || "");
  if (!qboId || !input.firmId || !input.realmId || !input.entityType || !input.connectionId || !input.clientId) {
    return { ok: false, status: 400, error: "QuickBooks import id is incomplete." };
  }
  const existing = db.prepare(
    `SELECT id FROM quickbooks_imports
     WHERE firm_id = ? AND realm_id = ? AND entity_type = ? AND qbo_id = ?`,
  ).get(input.firmId, input.realmId, input.entityType, qboId);
  if (existing) return { ok: false, status: 409, error: "That QuickBooks record was already imported." };
  try {
    db.prepare(
      `INSERT INTO quickbooks_imports (
        id, firm_id, client_id, connection_id, realm_id, entity_type, qbo_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), input.firmId, input.clientId, input.connectionId, input.realmId, input.entityType, qboId, new Date().toISOString());
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE")) {
      return { ok: false, status: 409, error: "That QuickBooks record was already imported." };
    }
    throw error;
  }
  return { ok: true };
}

export function touchLastSync(db, actor, connectionId, when) {
  db.prepare(
    `UPDATE quickbooks_connections
     SET last_sync_at = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ? AND status = 'connected'`,
  ).run(when, when, connectionId, actor.firm_id, actor.selected_client_id || actor.client_id);
}
