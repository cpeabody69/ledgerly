import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { ensureCharts } from "./ledger.js";
import { ensureBanking } from "./banking.js";
import { ensureFirmCrm } from "./clients.js";
import { ensureDocuments } from "./documents.js";
import { ensureInvoices } from "./invoices.js";
import { ensureExpenses } from "./expenses.js";
import { ensureTime } from "./time.js";
import { ensurePortal, loadPortalSession, portalPayload, signInPortal, signOutPortal } from "./portal.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  password_hash TEXT NOT NULL,
  invited_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  initials TEXT NOT NULL,
  industry TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_users (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  selected_client_id TEXT NOT NULL REFERENCES clients(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_user_id TEXT NOT NULL REFERENCES client_users(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
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
`;

const ROLE_LABEL = {
  owner: "Administrator",
  manager: "Manager",
  staff: "Staff",
};

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function openDatabase(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  seedIfEmpty(db);
  ensureCharts(db);
  ensureBanking(db);
  ensureFirmCrm(db);
  ensureDocuments(db);
  ensureInvoices(db);
  ensureExpenses(db);
  ensureTime(db);
  ensurePortal(db);
  return db;
}

function seedIfEmpty(db) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM firms").get();
  if (existing.count > 0) return;
  const now = new Date().toISOString();
  const insertFirm = db.prepare("INSERT INTO firms (id, name, created_at) VALUES (?, ?, ?)");
  const insertUser = db.prepare(
    "INSERT INTO users (id, firm_id, email, name, role, password_hash, invited_by, created_at) VALUES (?, ?, ?, ?, 'owner', ?, NULL, ?)",
  );
  const insertClient = db.prepare(
    "INSERT INTO clients (id, firm_id, name, legal_name, initials, industry, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const firm of Object.values(firms)) {
      const firmId = randomUUID();
      insertFirm.run(firmId, firm.name, now);
      insertUser.run(
        randomUUID(),
        firmId,
        firm.owner.email.toLowerCase(),
        firm.owner.name,
        hashPassword(firm.owner.password),
        now,
      );
      firm.clients.forEach((client, index) => {
        insertClient.run(randomUUID(), firmId, client[0], client[1], client[2], client[3], index, now);
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

function memberJson(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role] || row.role,
  };
}

export function sessionPayload(db, session) {
  if (session.portal) return portalPayload(db, session);
  const user = db.prepare("SELECT id, firm_id, email, name, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  const firm = db.prepare("SELECT id, name, require_receipt FROM firms WHERE id = ?").get(session.firm_id);
  const clients = db.prepare("SELECT * FROM clients WHERE firm_id = ? ORDER BY position, name").all(session.firm_id).map(clientJson);
  const selected = db.prepare("SELECT * FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  const members = db.prepare("SELECT id, name, email, role FROM users WHERE firm_id = ? ORDER BY created_at, name").all(session.firm_id).map(memberJson);
  return {
    user: memberJson(user),
    firm: { id: firm.id, name: firm.name, requireReceipt: firm.require_receipt === 1 },
    clients,
    client: selected ? clientJson(selected) : null,
    members,
  };
}

export function loadSession(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT sessions.id, sessions.token, sessions.firm_id, sessions.user_id, sessions.selected_client_id, sessions.expires_at
     FROM sessions
     JOIN users ON users.id = sessions.user_id AND users.firm_id = sessions.firm_id
     WHERE sessions.token = ? AND sessions.expires_at > ?`,
  ).get(token, new Date().toISOString());
  if (row) return row;
  return loadPortalSession(db, token);
}

function audit(db, session, action, { clientId = null, entityType = null, entityId = null } = {}) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityType, entityId, new Date().toISOString());
}

export function signIn(db, email, password) {
  const normalized = String(email || "").trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(normalized);
  if (!user) return signInPortal(db, normalized, password);
  if (!verifyPassword(password || "", user.password_hash)) return null;
  const client = db.prepare("SELECT id FROM clients WHERE firm_id = ? ORDER BY position, name LIMIT 1").get(user.firm_id);
  if (!client) return null;
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const session = {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    firm_id: user.firm_id,
    user_id: user.id,
    selected_client_id: client.id,
  };
  db.prepare(
    "INSERT INTO sessions (id, token, firm_id, user_id, selected_client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(session.id, session.token, session.firm_id, session.user_id, session.selected_client_id, now.toISOString(), expires.toISOString());
  audit(db, session, "session.started");
  return { token: session.token, payload: sessionPayload(db, session) };
}

export function signOut(db, session) {
  if (!session) return;
  if (session.portal) {
    signOutPortal(db, session);
    return;
  }
  audit(db, session, "session.ended");
  db.prepare("DELETE FROM sessions WHERE id = ? AND firm_id = ?").run(session.id, session.firm_id);
}

export function selectClient(db, session, clientId) {
  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
  if (!client) return null;
  db.prepare("UPDATE sessions SET selected_client_id = ? WHERE id = ? AND firm_id = ?").run(client.id, session.id, session.firm_id);
  const next = { ...session, selected_client_id: client.id };
  audit(db, next, "client.selected", { clientId: client.id, entityType: "client", entityId: client.id });
  return sessionPayload(db, next);
}

export function findClient(db, session, clientId) {
  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
  return client ? clientJson(client) : null;
}

function initialsFor(name) {
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length) return "CL";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function createClient(db, session, input) {
  const body = input || {};
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return { status: 400, error: "Enter a client name." };
  const legalName = String(body.legalName || name).trim() || name;
  if (legalName.length > 120) return { status: 400, error: "That legal name is too long." };
  const industry = String(body.industry || "").trim();
  if (industry.length > 80) return { status: 400, error: "That industry is too long." };
  const duplicate = db.prepare("SELECT id FROM clients WHERE firm_id = ? AND lower(name) = lower(?)").get(session.firm_id, name);
  if (duplicate) return { status: 409, error: "That client is already in this firm." };
  const position = Number(db.prepare("SELECT COALESCE(MAX(position), -1) AS max FROM clients WHERE firm_id = ?").get(session.firm_id).max);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO clients (id, firm_id, name, legal_name, initials, industry, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, session.firm_id, name, legalName, initialsFor(name), industry, position + 1, now);
  audit(db, session, "client.created", { clientId: id, entityType: "client", entityId: id });
  ensureCharts(db);
  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND firm_id = ?").get(id, session.firm_id);
  return { status: 201, payload: { client: clientJson(client), session: sessionPayload(db, session) } };
}

export function inviteMember(db, session, input) {
  const actor = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!actor || actor.role !== "owner") {
    return { status: 403, error: "Only an owner can invite someone into the firm." };
  }
  const name = String(input.name || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const role = String(input.role || "").trim();
  const password = String(input.password || "");
  if (!name || !email || !email.includes("@")) return { status: 400, error: "Enter a name and an email." };
  if (role !== "staff" && role !== "manager") return { status: 400, error: "Choose a staff or manager role." };
  if (password.length < 8) return { status: 400, error: "Use a password of at least 8 characters." };
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return { status: 409, error: "That email already has an account." };
  const existingPortal = db.prepare("SELECT id FROM client_users WHERE email = ?").get(email);
  if (existingPortal) return { status: 409, error: "That email already has an account." };
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, firm_id, email, name, role, password_hash, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, session.firm_id, email, name, role, hashPassword(password), session.user_id, now);
  ensureTime(db);
  audit(db, session, "member.invited", { entityType: "user", entityId: id });
  return { status: 201, payload: sessionPayload(db, session) };
}
