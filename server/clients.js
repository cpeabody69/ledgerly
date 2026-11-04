import { randomUUID } from "node:crypto";
import { listRequestHistory } from "./documents.js";
import { loadStatement } from "./statements.js";

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
];

const MONTHS_LONG = MONTHS;
const METHODS = new Set(["cash", "accrual"]);
const STATUSES = new Set(["active", "inactive"]);
const BUSINESS_TYPES = ["", "Sole proprietorship", "Partnership", "LLC", "S corporation", "C corporation", "Nonprofit"];

export function ensureFirmCrm(db) {
  db.exec(REQUESTS);
  const present = new Set(db.prepare("PRAGMA table_info(clients)").all().map((column) => column.name));
  for (const [name, definition] of CLIENT_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE clients ADD COLUMN ${name} ${definition}`);
  }
}

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function profileFields(db, session, body) {
  const input = body || {};
  const businessType = clean(input.businessType, 40);
  if (!BUSINESS_TYPES.includes(businessType)) return { error: "Choose a business type.", status: 400 };
  const contactName = clean(input.contactName, 120);
  const contactEmail = clean(input.contactEmail, 120).toLowerCase();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return { error: "Enter a contact email.", status: 400 };
  const contactPhone = clean(input.contactPhone, 40);
  if (contactPhone && !/^[0-9+().\-\s]{7,40}$/.test(contactPhone)) return { error: "Enter a contact phone.", status: 400 };
  const address = clean(input.address, 300);
  const taxId = clean(input.taxId, 20);
  if (taxId && !/^\d{2}-\d{7}$/.test(taxId)) return { error: "Enter a tax ID like 12-3456789, or leave it blank.", status: 400 };
  const fiscalYearStart = clean(input.fiscalYearStart, 20) || "January";
  if (!MONTHS_LONG.includes(fiscalYearStart)) return { error: "Choose the fiscal year start.", status: 400 };
  const accountingMethod = clean(input.accountingMethod, 20) || "accrual";
  if (!METHODS.has(accountingMethod)) return { error: "Choose cash or accrual.", status: 400 };
  const notes = clean(input.notes, 2000);
  let assignedUserId = clean(input.assignedUserId, 80);
  if (assignedUserId) {
    const member = db.prepare("SELECT id FROM users WHERE id = ? AND firm_id = ?").get(assignedUserId, session.firm_id);
    if (!member) return { error: "Assign someone from this firm.", status: 400 };
  } else {
    assignedUserId = null;
  }
  let status = clean(input.status, 20) || "active";
  if (!STATUSES.has(status)) return { error: "Choose active or inactive.", status: 400 };
  return {
    businessType,
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
  };
}

const STATUS_LABEL = { active: "Active", inactive: "Inactive", archived: "Archived" };
const METHOD_LABEL = { cash: "Cash", accrual: "Accrual" };

function ownedClient(db, session, clientId) {
  return db.prepare(
    `SELECT clients.*, users.name AS assigned_name
     FROM clients
     LEFT JOIN users ON users.id = clients.assigned_user_id AND users.firm_id = clients.firm_id
     WHERE clients.id = ? AND clients.firm_id = ?`,
  ).get(clientId, session.firm_id);
}

function publicProfile(row) {
  const status = row.status || "active";
  return {
    businessType: row.business_type || "",
    contactName: row.contact_name || "",
    contactEmail: row.contact_email || "",
    contactPhone: row.contact_phone || "",
    address: row.address || "",
    fiscalYearStart: row.fiscal_year_start || "January",
    accountingMethod: row.accounting_method || "accrual",
    accountingMethodLabel: METHOD_LABEL[row.accounting_method] || "Accrual",
    assignedUserId: row.assigned_user_id || "",
    assignedUserName: row.assigned_name || "",
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
  const rows = db.prepare(
    `SELECT clients.*, users.name AS assigned_name
     FROM clients
     LEFT JOIN users ON users.id = clients.assigned_user_id AND users.firm_id = clients.firm_id
     WHERE clients.firm_id = ?
     ORDER BY clients.position, clients.name`,
  ).all(session.firm_id);
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
    return {
      id: row.id,
      name: row.name,
      legalName: row.legal_name,
      initials: row.initials,
      industry: row.industry,
      ...publicProfile(row),
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
  const visible = clients.filter((client) => {
    if (status && client.status !== status) return false;
    if (assignee === "unassigned" && client.assignedUserId) return false;
    if (assignee && assignee !== "unassigned" && client.assignedUserId !== assignee) return false;
    if (!query) return true;
    const haystack = [client.name, client.legalName, client.industry, client.businessType, client.contactName, client.contactEmail, client.notes]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
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

function detailFor(db, session, row) {
  const summary = listFirm(db, session).payload.clients.find((client) => client.id === row.id);
  return {
    ...summary,
    taxId: row.tax_id || "",
  };
}

export function applyProfile(db, session, clientId, fields) {
  writeProfile(db, session, clientId, fields);
}

export function readClient(db, session, clientId) {
  ensureFirmCrm(db);
  const row = ownedClient(db, session, clientId);
  if (!row) return { status: 404, error: "Client not found." };
  return { status: 200, payload: { client: detailFor(db, session, row) } };
}

function writeProfile(db, session, clientId, fields) {
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
}

export function updateClient(db, session, clientId, input) {
  ensureFirmCrm(db);
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

export function archiveClient(db, session, clientId) {
  ensureFirmCrm(db);
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
