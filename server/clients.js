import { randomUUID } from "node:crypto";
import { accessScope, ensureClientGrants, lookupClient } from "./access.js";
import { listRequestHistory } from "./documents.js";
import { canSeeTeamWork, ROLE_LABEL } from "./permissions.js";
import { loadStatement } from "./statements.js";
import { ensureWork } from "./work.js";

const REQUESTS = `
CREATE TABLE IF NOT EXISTS document_requests (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'complete')),
  created_at TEXT NOT NULL
);
`;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function countOf(row) {
  return Number(row?.count || 0);
}

function formatDay(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return "";
  return `${name} ${Number(day)}, ${year}`;
}

const CLIENT_COLUMNS = [
  ["business_type", "TEXT NOT NULL DEFAULT ''"],
  ["contact_name", "TEXT NOT NULL DEFAULT ''"],
  ["contact_email", "TEXT NOT NULL DEFAULT ''"],
  ["contact_phone", "TEXT NOT NULL DEFAULT ''"],
  ["address", "TEXT NOT NULL DEFAULT ''"],
  ["tax_id", "TEXT NOT NULL DEFAULT ''"],
  ["fiscal_year_start", "TEXT NOT NULL DEFAULT 'January'"],
  ["accounting_method", "TEXT NOT NULL DEFAULT 'accrual'"],
  ["assigned_user_id", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["notes", "TEXT NOT NULL DEFAULT ''"],
  ["client_kind", "TEXT NOT NULL DEFAULT 'business'"],
  ["services", "TEXT NOT NULL DEFAULT '[]'"],
];

const TEAM = `
CREATE TABLE IF NOT EXISTS client_team (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, client_id, user_id)
);
CREATE INDEX IF NOT EXISTS client_team_by_client ON client_team (firm_id, client_id);
CREATE TABLE IF NOT EXISTS client_notes (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_notes_by_client ON client_notes (firm_id, client_id, created_at);
`;

const MONTHS_LONG = MONTHS;
const METHODS = new Set(["cash", "accrual"]);
const STATUSES = new Set(["prospect", "onboarding", "active", "inactive", "archived"]);
const KINDS = new Set(["individual", "business"]);
const SERVICES = ["bookkeeping", "tax", "payroll", "advisory", "other"];
const BUSINESS_TYPES = ["", "Sole proprietorship", "Partnership", "LLC", "S corporation", "C corporation", "Nonprofit"];
const STATUS_ORDER = ["prospect", "onboarding", "active", "inactive", "archived"];

// Additive migration when a process opens its own database:
// client_kind and services columns, plus client_team and client_notes.
// Existing client rows stay business profiles with no services. No row rewrite.
export function ensureFirmCrm(db) {
  db.exec(REQUESTS);
  db.exec(TEAM);
  const present = new Set(db.prepare("PRAGMA table_info(clients)").all().map((column) => column.name));
  for (const [name, definition] of CLIENT_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE clients ADD COLUMN ${name} ${definition}`);
  }
}

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function memberInFirm(db, session, userId) {
  if (!userId) return null;
  return db.prepare("SELECT id FROM users WHERE id = ? AND firm_id = ?").get(userId, session.firm_id) || null;
}

export function profileFields(db, session, body) {
  const input = body || {};
  const hasKind = Object.hasOwn(input, "clientKind");
  const clientKind = hasKind ? clean(input.clientKind, 20) : undefined;
  if (hasKind && !KINDS.has(clientKind)) return { error: "Choose an individual or a business.", status: 400 };
  const businessType = clean(input.businessType, 40);
  if (clientKind === "individual") {
    if (businessType) return { error: "An individual does not use a business type.", status: 400 };
  } else if (!BUSINESS_TYPES.includes(businessType)) {
    return { error: "Choose a business type.", status: 400 };
  }
  const contactName = clean(input.contactName, 120);
  const contactEmail = clean(input.contactEmail, 120).toLowerCase();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return { error: "Enter a contact email.", status: 400 };
  const contactPhone = clean(input.contactPhone, 40);
  if (contactPhone && !/^[0-9+().\-\s]{7,40}$/.test(contactPhone)) return { error: "Enter a contact phone.", status: 400 };
  const address = clean(input.address, 300);
  const taxId = clientKind === "individual" ? "" : clean(input.taxId, 20);
  if (clientKind === "individual" && clean(input.taxId, 20)) {
    return { error: "An individual profile does not store a tax ID.", status: 400 };
  }
  if (taxId && !/^\d{2}-\d{7}$/.test(taxId)) return { error: "Enter a tax ID like 12-3456789, or leave it blank.", status: 400 };
  const fiscalYearStart = clean(input.fiscalYearStart, 20) || "January";
  if (!MONTHS_LONG.includes(fiscalYearStart)) return { error: "Choose the fiscal year start.", status: 400 };
  const accountingMethod = clean(input.accountingMethod, 20) || "accrual";
  if (!METHODS.has(accountingMethod)) return { error: "Choose cash or accrual.", status: 400 };
  const notes = clean(input.notes, 2000);
  let assignedUserId = clean(input.assignedUserId, 80);
  if (assignedUserId) {
    if (!memberInFirm(db, session, assignedUserId)) return { error: "Assign someone from this firm.", status: 400 };
  } else {
    assignedUserId = null;
  }
  let status = clean(input.status, 20) || "active";
  if (!STATUSES.has(status)) return { error: "Choose a client status.", status: 400 };
  let services;
  if (Object.hasOwn(input, "services")) {
    if (!Array.isArray(input.services)) return { error: "Choose the services this client receives.", status: 400 };
    services = [...new Set(input.services.map((service) => clean(service, 20)).filter(Boolean))];
    if (services.some((service) => !SERVICES.includes(service))) return { error: "Choose bookkeeping, tax preparation, payroll, advisory, or other.", status: 400 };
    if (services.length > SERVICES.length) return { error: "Choose bookkeeping, tax preparation, payroll, advisory, or other.", status: 400 };
  }
  let teamUserIds;
  if (Object.hasOwn(input, "teamUserIds")) {
    if (!Array.isArray(input.teamUserIds)) return { error: "Choose team members from this firm.", status: 400 };
    teamUserIds = [...new Set(input.teamUserIds.map((id) => clean(id, 80)).filter(Boolean))];
    if (teamUserIds.length > 20) return { error: "Choose up to 20 team members.", status: 400 };
    if (teamUserIds.some((id) => !memberInFirm(db, session, id))) return { error: "Choose team members from this firm.", status: 400 };
  }
  return {
    clientKind,
    businessType: clientKind === "individual" ? "" : businessType,
    contactName,
    contactEmail,
    contactPhone,
    address,
    taxId,
    fiscalYearStart,
    accountingMethod,
    assignedUserId,
    status,
    notes,
    services,
    teamUserIds,
  };
}

const STATUS_LABEL = {
  prospect: "Prospect",
  onboarding: "Onboarding",
  active: "Active",
  inactive: "Inactive",
  archived: "Archived",
};
const KIND_LABEL = { individual: "Individual", business: "Business" };
const SERVICE_LABEL = {
  bookkeeping: "Bookkeeping",
  tax: "Tax preparation",
  payroll: "Payroll",
  advisory: "Advisory",
  other: "Other",
};
const METHOD_LABEL = { cash: "Cash", accrual: "Accrual" };

function ownedClient(db, session, clientId) {
  return db.prepare(
    `SELECT clients.*, users.name AS assigned_name
     FROM clients
     LEFT JOIN users ON users.id = clients.assigned_user_id AND users.firm_id = clients.firm_id
     WHERE clients.id = ? AND clients.firm_id = ?`,
  ).get(clientId, session.firm_id);
}

function parseServices(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((service) => SERVICES.includes(service));
  } catch {
    return [];
  }
}

function teamFor(db, firmId, clientId) {
  return db.prepare(
    `SELECT users.id, users.name, users.role
     FROM client_team
     JOIN users ON users.id = client_team.user_id AND users.firm_id = client_team.firm_id
     WHERE client_team.firm_id = ? AND client_team.client_id = ?
     ORDER BY users.name`,
  ).all(firmId, clientId).map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role] || row.role,
  }));
}

function publicProfile(row, team = []) {
  const status = row.status || "active";
  const services = parseServices(row.services);
  const clientKind = row.client_kind === "individual" ? "individual" : "business";
  return {
    clientKind,
    clientKindLabel: KIND_LABEL[clientKind],
    businessType: clientKind === "individual" ? "" : (row.business_type || ""),
    services,
    serviceLabels: services.map((service) => SERVICE_LABEL[service]),
    contactName: row.contact_name || "",
    contactEmail: row.contact_email || "",
    contactPhone: row.contact_phone || "",
    address: row.address || "",
    fiscalYearStart: row.fiscal_year_start || "January",
    accountingMethod: row.accounting_method || "accrual",
    accountingMethodLabel: METHOD_LABEL[row.accounting_method] || "Accrual",
    assignedUserId: row.assigned_user_id || "",
    assignedUserName: row.assigned_name || "",
    team,
    status,
    statusLabel: STATUS_LABEL[status] || status,
    notes: row.notes || "",
    createdAt: row.created_at,
  };
}

function tasksFor(uncategorized, unreconciled, requests) {
  const tasks = [];
  if (uncategorized) tasks.push({ kind: "uncategorized", label: `${uncategorized} uncategorized` });
  if (unreconciled) tasks.push({ kind: "unreconciled", label: `${unreconciled} unreconciled` });
  for (const request of requests) tasks.push({ kind: "request", id: request.id, label: request.title });
  return tasks;
}

function activityFor(db, session, clientId) {
  return db.prepare(
    `SELECT action, created_at FROM audit_events
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at DESC LIMIT 8`,
  ).all(session.firm_id, clientId).map((row) => ({
    action: row.action,
    label: row.action.replaceAll(".", " ").replaceAll("_", " "),
    createdAt: row.created_at,
  }));
}

function recentlyAdded(createdAt) {
  const then = Date.parse(createdAt || "");
  if (Number.isNaN(then)) return false;
  return Date.now() - then <= 30 * 24 * 60 * 60 * 1000;
}

export function listFirm(db, session, filters = {}) {
  ensureFirmCrm(db);
  const firm = db.prepare("SELECT id, name FROM firms WHERE id = ?").get(session.firm_id);
  const scope = accessScope(db, session);
  const rows = db.prepare(
    `SELECT clients.*, users.name AS assigned_name
     FROM clients
     LEFT JOIN users ON users.id = clients.assigned_user_id AND users.firm_id = clients.firm_id
     WHERE clients.firm_id = ?
     ORDER BY clients.position, clients.name`,
  ).all(session.firm_id).filter((row) => scope.unrestricted || scope.clientIds.includes(row.id));
  const uncategorizedFor = db.prepare(
    "SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ? AND status = 'for_review'",
  );
  const unreconciledFor = db.prepare(
    `SELECT COUNT(*) AS count FROM bank_accounts
     WHERE firm_id = ? AND client_id = ?
       AND EXISTS (
         SELECT 1 FROM bank_transactions
         WHERE bank_transactions.bank_account_id = bank_accounts.id
           AND bank_transactions.firm_id = bank_accounts.firm_id
           AND bank_transactions.client_id = bank_accounts.client_id
           AND bank_transactions.cleared_reconciliation_id IS NULL
       )`,
  );
  const lastJournal = db.prepare(
    "SELECT MAX(entry_date) AS day FROM journal_entries WHERE firm_id = ? AND client_id = ?",
  );
  const lastBank = db.prepare(
    "SELECT MAX(posted_on) AS day FROM bank_transactions WHERE firm_id = ? AND client_id = ?",
  );
  let periodLabel = "";
  const history = listRequestHistory(db, session);
  const openRequests = history.outstanding;
  const clients = rows.map((row) => {
    const loaded = loadStatement(db, session.firm_id, row.id, { period: "May 1 – May 31", basis: "accrual" });
    if (!periodLabel && loaded?.period?.label) periodLabel = loaded.period.label;
    const uncategorized = countOf(uncategorizedFor.get(session.firm_id, row.id));
    const unreconciled = countOf(unreconciledFor.get(session.firm_id, row.id));
    const days = [lastJournal.get(session.firm_id, row.id)?.day, lastBank.get(session.firm_id, row.id)?.day].filter(Boolean).sort();
    const profit = loaded?.statement?.profitAndLoss;
    const requestsForClient = openRequests.filter((request) => request.clientId === row.id);
    const ready = uncategorized > 0 || unreconciled > 0;
    const tasks = tasksFor(uncategorized, unreconciled, requestsForClient);
    const team = teamFor(db, session.firm_id, row.id);
    return {
      id: row.id,
      name: row.name,
      legalName: row.legal_name,
      initials: row.initials,
      industry: row.industry,
      ...publicProfile(row, team),
      revenue: profit ? profit.income : "",
      netIncome: profit ? profit.netIncome : "",
      revenueCents: profit ? profit.incomeCents : null,
      netIncomeCents: profit ? profit.netIncomeCents : null,
      booksUpdated: formatDay(days.at(-1)),
      uncategorized,
      unreconciled,
      openRequestCount: requestsForClient.length,
      ready,
      needsAttention: tasks.length > 0,
      tasks,
      activity: activityFor(db, session, row.id),
      recentlyAdded: recentlyAdded(row.created_at),
    };
  });
  const requests = history.outstanding;
  const uncategorized = clients.reduce((total, client) => total + client.uncategorized, 0);
  const unreconciled = clients.reduce((total, client) => total + client.unreconciled, 0);
  const query = String(filters.q || "").trim().toLowerCase();
  const status = String(filters.status || "").trim();
  const assignee = String(filters.assignee || "").trim();
  const kind = String(filters.kind || "").trim();
  const service = String(filters.service || "").trim();
  const sort = String(filters.sort || "").trim();
  let visible = clients.filter((client) => {
    if (status && client.status !== status) return false;
    if (kind && client.clientKind !== kind) return false;
    if (service && !client.services.includes(service)) return false;
    const onTeam = client.team.some((member) => member.id === assignee);
    if (assignee === "unassigned" && (client.assignedUserId || client.team.length)) return false;
    if (assignee && assignee !== "unassigned" && client.assignedUserId !== assignee && !onTeam) return false;
    if (!query) return true;
    const haystack = [
      client.name, client.legalName, client.industry, client.businessType, client.clientKindLabel,
      client.contactName, client.contactEmail, client.notes, ...client.serviceLabels, ...client.team.map((member) => member.name),
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
  if (sort === "name") visible = visible.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "status") {
    visible = visible.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  }
  if (sort === "assignee") {
    visible = visible.sort((a, b) => (a.assignedUserName || "Unassigned").localeCompare(b.assignedUserName || "Unassigned") || a.name.localeCompare(b.name));
  }
  if (sort === "newest") visible = visible.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.name.localeCompare(b.name));
  const members = db.prepare(
    "SELECT id, name, role FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id).map((row) => ({ id: row.id, name: row.name, role: row.role }));
  return {
    status: 200,
    payload: {
      firm: { id: firm.id, name: firm.name },
      period: { label: periodLabel },
      counts: {
        total: clients.length,
        prospect: clients.filter((client) => client.status === "prospect").length,
        onboarding: clients.filter((client) => client.status === "onboarding").length,
        active: clients.filter((client) => client.status === "active").length,
        inactive: clients.filter((client) => client.status === "inactive").length,
        archived: clients.filter((client) => client.status === "archived").length,
        needingAttention: clients.filter((client) => client.needsAttention && client.status !== "archived").length,
        recentlyAdded: clients.filter((client) => client.recentlyAdded).length,
        readyToReview: clients.filter((client) => client.ready).length,
        openRequests: requests.length,
        uncategorized,
        unreconciled,
      },
      members,
      clients: visible,
      requests,
      requestHistory: history,
    },
  };
}

function noteHistory(db, session, clientId) {
  return db.prepare(
    `SELECT client_notes.id, client_notes.body, client_notes.created_at, users.name AS author_name
     FROM client_notes
     JOIN users ON users.id = client_notes.created_by AND users.firm_id = client_notes.firm_id
     WHERE client_notes.firm_id = ? AND client_notes.client_id = ?
     ORDER BY client_notes.created_at DESC, client_notes.id DESC
     LIMIT 30`,
  ).all(session.firm_id, clientId).map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    authorName: row.author_name || "",
  }));
}

function rememberNote(db, session, clientId, body) {
  const text = clean(body, 2000);
  if (!text) return;
  ensureClientGrants(db);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO client_notes (id, firm_id, client_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, session.firm_id, clientId, text, session.user_id, now);
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, 'client.note', ?, 'client_note', ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, clientId, id, now, "Added a client note.");
}

function deadlinesFor(db, session, clientId) {
  ensureWork(db);
  const user = db.prepare("SELECT id, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  const assignedOnly = !user || !canSeeTeamWork(user.role);
  const tasks = db.prepare(
    `SELECT work_tasks.id, work_tasks.title, work_tasks.due_on, work_tasks.status, users.name AS assignee_name
     FROM work_tasks
     LEFT JOIN users ON users.id = work_tasks.assignee_user_id AND users.firm_id = work_tasks.firm_id
     WHERE work_tasks.firm_id = ? AND work_tasks.client_id = ? AND work_tasks.status != 'completed' AND work_tasks.due_on != ''
       AND (? = 0 OR work_tasks.assignee_user_id = ?)
     ORDER BY work_tasks.due_on, work_tasks.title`,
  ).all(session.firm_id, clientId, assignedOnly ? 1 : 0, session.user_id).map((row) => ({
    id: row.id,
    kind: "task",
    title: row.title,
    dueOn: row.due_on,
    status: row.status,
    assigneeName: row.assignee_name || "",
  }));
  const requests = db.prepare(
    `SELECT id, title, due_on, status FROM document_requests
     WHERE firm_id = ? AND client_id = ? AND status = 'open' AND due_on != ''
     ORDER BY due_on, title`,
  ).all(session.firm_id, clientId).map((row) => ({
    id: row.id,
    kind: "request",
    title: row.title,
    dueOn: row.due_on,
    status: row.status,
    assigneeName: "",
  }));
  return [...tasks, ...requests].sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title));
}

function detailFor(db, session, row) {
  const summary = listFirm(db, session).payload.clients.find((client) => client.id === row.id);
  const history = listRequestHistory(db, session, row.id) || { outstanding: [], completed: [] };
  return {
    ...summary,
    taxId: row.client_kind === "individual" ? "" : (row.tax_id || ""),
    noteHistory: noteHistory(db, session, row.id),
    deadlines: deadlinesFor(db, session, row.id),
    documentRequests: {
      outstanding: history.outstanding,
      completed: history.completed,
    },
  };
}

export function applyProfile(db, session, clientId, fields) {
  writeProfile(db, session, clientId, fields);
}

export function readClient(db, session, clientId) {
  ensureFirmCrm(db);
  if (!lookupClient(db, session, clientId)) return { status: 404, error: "Client not found." };
  const row = ownedClient(db, session, clientId);
  if (!row) return { status: 404, error: "Client not found." };
  return { status: 200, payload: { client: detailFor(db, session, row) } };
}

function writeTeam(db, session, clientId, userIds) {
  const now = new Date().toISOString();
  db.prepare("DELETE FROM client_team WHERE firm_id = ? AND client_id = ?").run(session.firm_id, clientId);
  const insert = db.prepare(
    "INSERT INTO client_team (id, firm_id, client_id, user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const userId of userIds) insert.run(randomUUID(), session.firm_id, clientId, userId, session.user_id, now);
}

function includeAssignee(db, session, clientId, userId) {
  if (!userId) return;
  const existing = db.prepare(
    "SELECT id FROM client_team WHERE firm_id = ? AND client_id = ? AND user_id = ?",
  ).get(session.firm_id, clientId, userId);
  if (existing) return;
  db.prepare(
    "INSERT INTO client_team (id, firm_id, client_id, user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, clientId, userId, session.user_id, new Date().toISOString());
}

function writeProfile(db, session, clientId, fields) {
  const previous = db.prepare("SELECT notes FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
  db.prepare(
    `UPDATE clients SET
      business_type = ?, contact_name = ?, contact_email = ?, contact_phone = ?, address = ?, tax_id = ?,
      fiscal_year_start = ?, accounting_method = ?, assigned_user_id = ?, status = ?, notes = ?
     WHERE id = ? AND firm_id = ?`,
  ).run(
    fields.businessType,
    fields.contactName,
    fields.contactEmail,
    fields.contactPhone,
    fields.address,
    fields.taxId,
    fields.fiscalYearStart,
    fields.accountingMethod,
    fields.assignedUserId,
    fields.status,
    fields.notes,
    clientId,
    session.firm_id,
  );
  if (fields.clientKind) {
    db.prepare("UPDATE clients SET client_kind = ? WHERE id = ? AND firm_id = ?").run(fields.clientKind, clientId, session.firm_id);
  }
  if (fields.services) {
    db.prepare("UPDATE clients SET services = ? WHERE id = ? AND firm_id = ?").run(JSON.stringify(fields.services), clientId, session.firm_id);
  }
  if (fields.teamUserIds) writeTeam(db, session, clientId, fields.teamUserIds);
  includeAssignee(db, session, clientId, fields.assignedUserId);
  if (fields.notes && fields.notes !== (previous?.notes || "")) rememberNote(db, session, clientId, fields.notes);
}

export function updateClient(db, session, clientId, input) {
  ensureFirmCrm(db);
  if (!lookupClient(db, session, clientId)) return { status: 404, error: "Client not found." };
  const existing = ownedClient(db, session, clientId);
  if (!existing) return { status: 404, error: "Client not found." };
  const body = input || {};
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return { status: 400, error: "Enter a client name." };
  const legalName = String(body.legalName || name).trim() || name;
  if (legalName.length > 120) return { status: 400, error: "That legal name is too long." };
  const industry = String(body.industry || "").trim();
  if (industry.length > 80) return { status: 400, error: "That industry is too long." };
  const duplicate = db.prepare(
    "SELECT id FROM clients WHERE firm_id = ? AND lower(name) = lower(?) AND id <> ?",
  ).get(session.firm_id, name, clientId);
  if (duplicate) return { status: 409, error: "That client is already in this firm." };
  const fields = profileFields(db, session, body);
  if (fields.error) return fields;
  const words = name.split(/\s+/).filter(Boolean);
  const initials = words.length === 1 ? words[0].slice(0, 2).toUpperCase() : `${words[0][0]}${words[1][0]}`.toUpperCase();
  db.prepare(
    "UPDATE clients SET name = ?, legal_name = ?, initials = ?, industry = ? WHERE id = ? AND firm_id = ?",
  ).run(name, legalName, initials, industry, clientId, session.firm_id);
  writeProfile(db, session, clientId, fields);
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, "client.updated", clientId, "client", clientId, new Date().toISOString());
  return readClient(db, session, clientId);
}

export function addClientNote(db, session, clientId, input) {
  ensureFirmCrm(db);
  if (!lookupClient(db, session, clientId)) return { status: 404, error: "Client not found." };
  const text = clean(input?.body, 2000);
  if (!text) return { status: 400, error: "Enter a note." };
  rememberNote(db, session, clientId, text);
  return readClient(db, session, clientId);
}

export function archiveClient(db, session, clientId) {
  ensureFirmCrm(db);
  if (!lookupClient(db, session, clientId)) return { status: 404, error: "Client not found." };
  const existing = ownedClient(db, session, clientId);
  if (!existing) return { status: 404, error: "Client not found." };
  if (existing.status !== "archived") {
    db.prepare("UPDATE clients SET status = 'archived' WHERE id = ? AND firm_id = ?").run(clientId, session.firm_id);
    db.prepare(
      "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), session.firm_id, session.user_id, "client.archived", clientId, "client", clientId, new Date().toISOString());
  }
  return readClient(db, session, clientId);
}
