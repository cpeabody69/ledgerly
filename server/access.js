// Additive migration, applied only when a process opens its own database:
// 1. CREATE TABLE IF NOT EXISTS client_grants
// 2. ALTER TABLE audit_events ADD COLUMN detail, when that column is absent
// Existing rows are not rewritten. This file does not open data/ledgerly.sqlite.
// Do not point a test or a second process at the database the running server has open.
import { randomUUID } from "node:crypto";
import { canManageFirm, ROLE_LABEL } from "./permissions.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_grants (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, user_id, client_id)
);
CREATE INDEX IF NOT EXISTS client_grants_by_user ON client_grants (firm_id, user_id);
`;

function fail(status, error) {
  return { status, error };
}

export function ensureClientGrants(db) {
  db.exec(SCHEMA);
  const columns = new Set(db.prepare("PRAGMA table_info(audit_events)").all().map((column) => column.name));
  if (!columns.has("detail")) db.exec("ALTER TABLE audit_events ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
}

export function roleFor(db, session) {
  if (!session?.firm_id || !session.user_id || session.portal || session.onboarding) return null;
  return db.prepare(
    "SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?",
  ).get(session.user_id, session.firm_id);
}

export function accessScope(db, session) {
  ensureClientGrants(db);
  if (session?.portal && session.firm_id && session.client_id) {
    return { unrestricted: false, clientIds: [session.client_id] };
  }
  if (!session?.firm_id || !session.user_id || session.portal || session.onboarding) {
    return { unrestricted: false, clientIds: [] };
  }
  const user = roleFor(db, session);
  if (!user) return { unrestricted: false, clientIds: [] };
  if (canManageFirm(user.role)) return { unrestricted: true, clientIds: null };
  const grants = db.prepare(
    "SELECT client_id FROM client_grants WHERE firm_id = ? AND user_id = ?",
  ).all(session.firm_id, session.user_id);
  if (!grants.length) return { unrestricted: true, clientIds: null };
  return { unrestricted: false, clientIds: grants.map((grant) => grant.client_id) };
}

export function scopeSql(db, session, column) {
  if (!/^[a-z_]+\.[a-z_]+$/i.test(column)) throw new Error("Unexpected client column.");
  const scope = accessScope(db, session);
  if (scope.unrestricted) return { sql: "", params: [] };
  if (!scope.clientIds.length) return { sql: " AND 0", params: [] };
  return {
    sql: ` AND ${column} IN (${scope.clientIds.map(() => "?").join(",")})`,
    params: [...scope.clientIds],
  };
}

export function clientAllowed(db, session, clientId) {
  if (!clientId || !session?.firm_id) return false;
  if (session.portal) return clientId === session.client_id;
  const scope = accessScope(db, session);
  if (!scope.unrestricted && !scope.clientIds.includes(clientId)) return false;
  const row = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
  return Boolean(row);
}

export function firstVisibleClientId(db, user) {
  ensureClientGrants(db);
  if (!user?.firm_id) return null;
  const first = db.prepare(
    "SELECT id FROM clients WHERE firm_id = ? ORDER BY position, name LIMIT 1",
  ).get(user.firm_id);
  if (canManageFirm(user.role)) return first?.id || null;
  const grants = db.prepare(
    "SELECT client_id FROM client_grants WHERE firm_id = ? AND user_id = ?",
  ).all(user.firm_id, user.id);
  if (!grants.length) return first?.id || null;
  const ids = grants.map((grant) => grant.client_id);
  return db.prepare(
    `SELECT id FROM clients WHERE firm_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY position, name LIMIT 1`,
  ).get(user.firm_id, ...ids)?.id || null;
}

export function recordAccessDenial(db, session, detail, clientId = null) {
  if (!session?.firm_id || !session.user_id || session.portal) return;
  ensureClientGrants(db);
  let storedClient = null;
  if (clientId) {
    const row = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
    if (row) storedClient = row.id;
  }
  const text = String(detail || "Access was rejected.").slice(0, 300);
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, 'access.denied', ?, 'client', ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, storedClient, storedClient, new Date().toISOString(), text);
}

export function lookupClient(db, session, clientId) {
  if (!session?.firm_id || !clientId) return null;
  if (session.portal) {
    if (clientId !== session.client_id) return null;
    return db.prepare("SELECT id, firm_id, name FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id) || null;
  }
  const row = db.prepare("SELECT id, firm_id, name FROM clients WHERE id = ?").get(clientId);
  if (!row || row.firm_id !== session.firm_id) {
    recordAccessDenial(db, session, "Cross-firm client access was rejected.");
    return null;
  }
  if (!clientAllowed(db, session, row.id)) {
    recordAccessDenial(db, session, "This person is not granted this client.", row.id);
    return null;
  }
  return row;
}

export function alignSelectedClient(db, session) {
  if (!session?.firm_id || session.portal || session.onboarding) return session;
  if (clientAllowed(db, session, session.selected_client_id)) return session;
  const user = roleFor(db, session);
  if (!user) return session;
  const nextId = firstVisibleClientId(db, user);
  if (!nextId || nextId === session.selected_client_id || !clientAllowed(db, session, nextId)) return session;
  db.prepare("UPDATE sessions SET selected_client_id = ? WHERE id = ? AND firm_id = ?").run(nextId, session.id, session.firm_id);
  const next = { ...session, selected_client_id: nextId };
  ensureClientGrants(db);
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, 'client.scoped', ?, 'client', ?, ?, ?)`,
  ).run(
    randomUUID(),
    next.firm_id,
    next.user_id,
    nextId,
    nextId,
    new Date().toISOString(),
    "The open client moved to one this person is allowed to open.",
  );
  return next;
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const label = date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${label} ET`;
}

function actionLabel(action) {
  return String(action || "").replaceAll(".", " ").replaceAll("_", " ");
}

export function listAudit(db, session, filters = {}) {
  ensureClientGrants(db);
  const actor = roleFor(db, session);
  if (!actor || !canManageFirm(actor.role)) {
    recordAccessDenial(db, session, "The audit log is limited to owners and administrators.");
    return fail(403, "Only an owner or administrator can read the audit log.");
  }
  const clientId = String(filters.clientId || "").trim();
  const actorId = String(filters.actorId || "").trim();
  const action = String(filters.action || "").trim();
  const query = String(filters.q || "").trim().slice(0, 80);
  if (clientId && !db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id)) {
    return fail(404, "Client not found.");
  }
  if (actorId && !db.prepare("SELECT id FROM users WHERE id = ? AND firm_id = ?").get(actorId, session.firm_id)) {
    return fail(404, "Employee not found.");
  }
  if (action && !/^[a-z0-9._]{1,80}$/i.test(action)) return fail(400, "Choose an action.");
  const clauses = ["audit_events.firm_id = ?"];
  const params = [session.firm_id];
  if (clientId) {
    clauses.push("audit_events.client_id = ?");
    params.push(clientId);
  }
  if (actorId) {
    clauses.push("audit_events.actor_user_id = ?");
    params.push(actorId);
  }
  if (action) {
    clauses.push("audit_events.action = ?");
    params.push(action);
  }
  if (query) {
    clauses.push("(audit_events.action LIKE ? OR audit_events.detail LIKE ? OR audit_events.entity_type LIKE ? OR clients.name LIKE ? OR users.name LIKE ?)");
    const like = `%${query.replace(/[\\%_]/g, "")}%`;
    params.push(like, like, like, like, like);
  }
  const rows = db.prepare(
    `SELECT audit_events.*, users.name AS actor_name, clients.name AS client_name
     FROM audit_events
     LEFT JOIN users ON users.id = audit_events.actor_user_id AND users.firm_id = audit_events.firm_id
     LEFT JOIN clients ON clients.id = audit_events.client_id AND clients.firm_id = audit_events.firm_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY audit_events.created_at DESC, audit_events.id DESC
     LIMIT 200`,
  ).all(...params);
  const actors = db.prepare(
    "SELECT id, name FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id);
  const actions = db.prepare(
    "SELECT DISTINCT action FROM audit_events WHERE firm_id = ? ORDER BY action",
  ).all(session.firm_id).map((row) => row.action);
  const clients = db.prepare(
    "SELECT id, name FROM clients WHERE firm_id = ? ORDER BY position, name",
  ).all(session.firm_id);
  return {
    status: 200,
    payload: {
      events: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        createdAtLabel: formatWhen(row.created_at),
        actorId: row.actor_user_id || "",
        actorName: row.actor_name || "Former user",
        action: row.action,
        actionLabel: actionLabel(row.action),
        clientId: row.client_id || "",
        clientName: row.client_name || "",
        entityType: row.entity_type || "",
        entityId: row.entity_id || "",
        detail: row.detail || "",
      })),
      actors,
      actions,
      clients,
    },
  };
}

function memberAccess(db, session, member) {
  if (canManageFirm(member.role)) return { access: "firm", clientIds: [] };
  const grants = db.prepare(
    "SELECT client_id FROM client_grants WHERE firm_id = ? AND user_id = ? ORDER BY client_id",
  ).all(session.firm_id, member.id);
  if (!grants.length) return { access: "all", clientIds: [] };
  return { access: "selected", clientIds: grants.map((grant) => grant.client_id) };
}

export function listClientGrants(db, session) {
  ensureClientGrants(db);
  const actor = roleFor(db, session);
  if (!actor || !canManageFirm(actor.role)) {
    return fail(403, "Only an owner or administrator can assign client access.");
  }
  const members = db.prepare(
    "SELECT id, name, email, role FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id).map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    roleLabel: ROLE_LABEL[member.role] || member.role,
    assignable: !canManageFirm(member.role),
    ...memberAccess(db, session, member),
  }));
  const clients = db.prepare(
    "SELECT id, name FROM clients WHERE firm_id = ? ORDER BY position, name",
  ).all(session.firm_id);
  return { status: 200, payload: { members, clients } };
}

export function saveClientGrants(db, session, input) {
  ensureClientGrants(db);
  const actor = roleFor(db, session);
  if (!actor || !canManageFirm(actor.role)) {
    recordAccessDenial(db, session, "Client grants are limited to owners and administrators.");
    return fail(403, "Only an owner or administrator can assign client access.");
  }
  const body = input || {};
  const target = db.prepare(
    "SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?",
  ).get(String(body.userId || ""), session.firm_id);
  if (!target) return fail(404, "Employee not found.");
  if (canManageFirm(target.role)) return fail(400, "Owners and administrators already open every client.");
  const access = body.access === "all" || body.access === "selected" ? body.access : "";
  if (!access) return fail(400, "Choose every client or selected clients.");
  let clientIds = [];
  const names = [];
  if (access === "selected") {
    const raw = Array.isArray(body.clientIds) ? body.clientIds : [];
    clientIds = [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!clientIds.length || clientIds.length > 100) return fail(400, "Choose at least one client.");
    for (const id of clientIds) {
      const client = db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(id, session.firm_id);
      if (!client) return fail(404, "Client not found.");
      names.push(client.name);
    }
  }
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM client_grants WHERE firm_id = ? AND user_id = ?").run(session.firm_id, target.id);
    const insert = db.prepare(
      "INSERT INTO client_grants (id, firm_id, user_id, client_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const id of clientIds) insert.run(randomUUID(), session.firm_id, target.id, id, actor.id, now);
    const detail = access === "all"
      ? `${actor.name} let ${target.name} open every client.`
      : `${actor.name} limited ${target.name} to ${names.join(", ")}.`;
    db.prepare(
      `INSERT INTO audit_events (
        id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
      ) VALUES (?, ?, ?, 'access.granted', ?, 'user', ?, ?, ?)`,
    ).run(randomUUID(), session.firm_id, actor.id, clientIds[0] || null, target.id, now, detail);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listClientGrants(db, session);
}
