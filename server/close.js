// Monthly close. Additive tables only. A lock rejects new journal posts for that
// month. It does not edit a posted entry, file a return, or calculate tax.
import { randomUUID } from "node:crypto";
import { lookupClient, scopeSql } from "./access.js";
import { canApproveBills, canManageFirm } from "./permissions.js";
import { loadStatement } from "./statements.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS period_locks (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL,
  due_on TEXT NOT NULL DEFAULT '',
  assignee_user_id TEXT REFERENCES users(id),
  locked_at TEXT,
  locked_by TEXT REFERENCES users(id),
  lock_reason TEXT NOT NULL DEFAULT '',
  reopened_at TEXT,
  reopened_by TEXT REFERENCES users(id),
  reopen_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS period_locks_month ON period_locks (firm_id, client_id, period);
CREATE TABLE IF NOT EXISTS close_checks (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  period TEXT NOT NULL,
  check_key TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS close_checks_key ON close_checks (firm_id, client_id, period, check_key);
CREATE TABLE IF NOT EXISTS close_packages (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  period TEXT NOT NULL,
  basis TEXT NOT NULL,
  review_status TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS close_packages_period ON close_packages (firm_id, client_id, period, basis);
`;

const CHECKS = [
  ["bank_reconciliation", "Bank reconciliation"],
  ["credit_card_reconciliation", "Credit card reconciliation"],
  ["uncategorized", "Uncategorized transactions"],
  ["accounts_receivable", "Accounts receivable"],
  ["accounts_payable", "Accounts payable"],
  ["journal_review", "Journal entry review"],
  ["balance_sheet", "Balance sheet review"],
  ["profit_and_loss", "Profit and loss review"],
  ["documents", "Supporting documents"],
  ["accountant_approval", "Accountant review and approval"],
];
const BLOCKING = new Set([
  "bank_reconciliation",
  "credit_card_reconciliation",
  "uncategorized",
  "accounts_receivable",
  "accounts_payable",
  "journal_review",
  "documents",
]);
const HUMAN = new Set(["balance_sheet", "profit_and_loss"]);
const STATUSES = ["not_started", "in_progress", "awaiting_client", "under_review", "closed"];
const STATUS_LABEL = {
  not_started: "Not Started",
  in_progress: "In Progress",
  awaiting_client: "Awaiting Client",
  under_review: "Under Review",
  closed: "Closed",
};
const TASK_KEYS = [
  ["bank", "bank_reconciliation", "Reconcile bank accounts"],
  ["card", "credit_card_reconciliation", "Reconcile credit cards"],
  ["uncategorized", "uncategorized", "Categorize this month's transactions"],
  ["receivables", "accounts_receivable", "Review accounts receivable"],
  ["payables", "accounts_payable", "Review accounts payable"],
  ["unbalanced", "journal_review", "Review an unbalanced journal"],
  ["unusual", "journal_review", "Review an unusual balance change"],
  ["duplicates", "duplicates", "Review possible duplicate transactions"],
  ["documents", "documents", "Clear supporting documents"],
  ["balanceSheet", "balance_sheet", "Review a balance sheet that does not balance"],
];
const UNUSUAL_CENTS = 10000;

function fail(status, error) {
  return { status, error };
}

export function ensureClose(db) {
  db.exec(SCHEMA);
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function countOf(row) {
  return Number(row?.count || 0);
}

function monthRange(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, "0")}` };
}

export function parseClosePeriod(value, today = todayIso()) {
  const text = String(value || "").trim() || today.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(text)) return null;
  const month = Number(text.slice(5, 7));
  if (month < 1 || month > 12) return null;
  return text;
}

function actor(db, session) {
  if (!session?.user_id || !session.firm_id || session.portal) return null;
  return db.prepare("SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function clientFor(db, session, clientId) {
  const row = lookupClient(db, session, clientId);
  if (!row) return null;
  return db.prepare(
    "SELECT id, name, status FROM clients WHERE id = ? AND firm_id = ?",
  ).get(row.id, session.firm_id);
}

function visibleClients(db, session) {
  const extra = scopeSql(db, session, "clients.id");
  return db.prepare(
    `SELECT id, name, status FROM clients
     WHERE firm_id = ? AND status != 'archived' ${extra.sql}
     ORDER BY position, name`,
  ).all(session.firm_id, ...extra.params);
}

function lockRow(db, session, clientId, period) {
  return db.prepare(
    "SELECT * FROM period_locks WHERE firm_id = ? AND client_id = ? AND period = ?",
  ).get(session.firm_id, clientId, period) || null;
}

function storedChecks(db, session, clientId, period) {
  const rows = db.prepare(
    "SELECT check_key, status, note, updated_at FROM close_checks WHERE firm_id = ? AND client_id = ? AND period = ?",
  ).all(session.firm_id, clientId, period);
  return new Map(rows.map((row) => [row.check_key, row]));
}

function quickBooksNote(db, session, clientId) {
  let row = null;
  try {
    row = db.prepare(
      "SELECT status, environment FROM quickbooks_connections WHERE firm_id = ? AND client_id = ?",
    ).get(session.firm_id, clientId);
  } catch {
    row = null;
  }
  return {
    connected: row?.status === "connected",
    environment: row?.environment || "sandbox",
    postsToBooks: false,
    locksQuickBooks: false,
    note: "This close locks Avenue's books. QuickBooks stays in sandbox. A sync does not post and does not lock the QuickBooks company.",
  };
}

function issuesFor(db, session, clientId, period) {
  const range = monthRange(period);
  const bank = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM bank_transactions
     JOIN bank_accounts ON bank_accounts.id = bank_transactions.bank_account_id
       AND bank_accounts.firm_id = bank_transactions.firm_id
     WHERE bank_transactions.firm_id = ? AND bank_transactions.client_id = ?
       AND bank_accounts.kind = 'bank'
       AND bank_transactions.cleared_reconciliation_id IS NULL
       AND bank_transactions.posted_on >= ? AND bank_transactions.posted_on <= ?`,
  ).get(session.firm_id, clientId, range.start, range.end));
  const card = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM bank_transactions
     JOIN bank_accounts ON bank_accounts.id = bank_transactions.bank_account_id
       AND bank_accounts.firm_id = bank_transactions.firm_id
     WHERE bank_transactions.firm_id = ? AND bank_transactions.client_id = ?
       AND bank_accounts.kind = 'card'
       AND bank_transactions.cleared_reconciliation_id IS NULL
       AND bank_transactions.posted_on >= ? AND bank_transactions.posted_on <= ?`,
  ).get(session.firm_id, clientId, range.start, range.end));
  const uncategorized = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND status = 'for_review'
       AND posted_on >= ? AND posted_on <= ?`,
  ).get(session.firm_id, clientId, range.start, range.end));
  const receivables = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM invoices
     WHERE firm_id = ? AND client_id = ? AND status IN ('sent', 'partial') AND issue_date <= ?`,
  ).get(session.firm_id, clientId, range.end));
  const awaiting = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM ap_bills
     WHERE firm_id = ? AND client_id = ? AND status = 'awaiting_approval' AND bill_date <= ?`,
  ).get(session.firm_id, clientId, range.end));
  const postedBills = db.prepare(
    `SELECT id, total_cents, due_date,
            COALESCE((SELECT SUM(amount_cents) FROM ap_payments
              WHERE ap_payments.bill_id = ap_bills.id AND ap_payments.firm_id = ap_bills.firm_id AND ap_payments.status = 'recorded'), 0) AS paid_cents
     FROM ap_bills
     WHERE firm_id = ? AND client_id = ? AND status = 'posted' AND bill_date <= ? AND due_date != '' AND due_date <= ?`,
  ).all(session.firm_id, clientId, range.end, range.end);
  const unpaid = postedBills.filter((bill) => Number(bill.total_cents) - Number(bill.paid_cents) > 0).length;
  const documents = countOf(db.prepare(
    `SELECT COUNT(*) AS count FROM document_requests
     WHERE firm_id = ? AND client_id = ? AND status = 'open' AND (due_on = '' OR due_on IS NULL OR due_on <= ?)`,
  ).get(session.firm_id, clientId, range.end));
  const unbalanced = db.prepare(
    `SELECT journal_entries.id, COALESCE(SUM(journal_lines.debit_cents), 0) AS debit_cents,
            COALESCE(SUM(journal_lines.credit_cents), 0) AS credit_cents
     FROM journal_entries
     JOIN journal_lines ON journal_lines.entry_id = journal_entries.id
       AND journal_lines.firm_id = journal_entries.firm_id
     WHERE journal_entries.firm_id = ? AND journal_entries.client_id = ?
       AND journal_entries.entry_date >= ? AND journal_entries.entry_date <= ?
     GROUP BY journal_entries.id
     HAVING COALESCE(SUM(journal_lines.debit_cents), 0) != COALESCE(SUM(journal_lines.credit_cents), 0)`,
  ).all(session.firm_id, clientId, range.start, range.end);
  const duplicates = db.prepare(
    `SELECT posted_on, amount_cents, lower(trim(description)) AS description, COUNT(*) AS count
     FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND status != 'excluded'
       AND posted_on >= ? AND posted_on <= ?
     GROUP BY posted_on, amount_cents, lower(trim(description))
     HAVING COUNT(*) > 1`,
  ).all(session.firm_id, clientId, range.start, range.end);
  const loaded = loadStatement(db, session.firm_id, clientId, { period, basis: "accrual" });
  const statement = loaded?.statement;
  const net = Number(statement?.profitAndLoss?.netIncomeCents || 0);
  const prior = Number(statement?.profitAndLoss?.priorNetIncomeCents || 0);
  const swing = Math.abs(net - prior);
  const unusual = swing >= UNUSUAL_CENTS && (prior === 0 || swing > Math.abs(prior));
  const balances = statement?.balanceSheet?.balances !== false;
  return {
    bank: { open: bank > 0, count: bank, detail: bank ? `${bank} bank ${bank === 1 ? "line is" : "lines are"} uncleared in this month.` : "Bank lines in this month are cleared." },
    card: { open: card > 0, count: card, detail: card ? `${card} credit card ${card === 1 ? "line is" : "lines are"} uncleared in this month.` : "Card lines in this month are cleared." },
    uncategorized: { open: uncategorized > 0, count: uncategorized, detail: uncategorized ? `${uncategorized} ${uncategorized === 1 ? "line is" : "lines are"} still for review.` : "Every line in this month has a category." },
    receivables: { open: receivables > 0, count: receivables, detail: receivables ? `${receivables} open ${receivables === 1 ? "invoice remains" : "invoices remain"}.` : "No open invoices through this month." },
    payables: { open: awaiting + unpaid > 0, count: awaiting + unpaid, detail: awaiting + unpaid ? `${awaiting} waiting for approval and ${unpaid} still unpaid.` : "No open bills through this month." },
    unbalanced: { open: unbalanced.length > 0, count: unbalanced.length, detail: unbalanced.length ? `${unbalanced.length} stored ${unbalanced.length === 1 ? "entry does" : "entries do"} not foot.` : "Every stored entry in this month foots. The books refuse an unbalanced post." },
    unusual: { open: unusual, count: unusual ? 1 : 0, detail: unusual ? "Net income moved more than the prior month and at least 100.00." : "Net income did not swing past the review threshold." },
    duplicates: { open: duplicates.length > 0, count: duplicates.length, detail: duplicates.length ? `${duplicates.length} amount, date, and description ${duplicates.length === 1 ? "group appears" : "groups appear"} more than once.` : "No duplicate statement lines in this month." },
    documents: { open: documents > 0, count: documents, detail: documents ? `${documents} document ${documents === 1 ? "request is" : "requests are"} still open.` : "No supporting request is open." },
    balanceSheet: { open: !balances, count: balances ? 0 : 1, detail: balances ? "The balance sheet balances." : "Assets do not equal liabilities and equity." },
    statement,
  };
}

function blockingOpen(key, issues) {
  if (key === "bank_reconciliation") return issues.bank.open;
  if (key === "credit_card_reconciliation") return issues.card.open;
  if (key === "uncategorized") return issues.uncategorized.open;
  if (key === "accounts_receivable") return issues.receivables.open;
  if (key === "accounts_payable") return issues.payables.open;
  if (key === "journal_review") return issues.unbalanced.open || issues.unusual.open || issues.duplicates.open;
  if (key === "documents") return issues.documents.open;
  return false;
}

function checkState(key, label, stored, issues) {
  const status = stored?.status || "";
  const waived = status === "waived";
  let satisfied = false;
  if (key === "accountant_approval") satisfied = status === "complete";
  else if (HUMAN.has(key)) satisfied = waived || (status === "complete" && !(key === "balance_sheet" && issues.balanceSheet.open));
  else satisfied = waived || !blockingOpen(key, issues);
  let display = "open";
  if (waived) display = "waived";
  else if (status === "complete" && satisfied) display = "complete";
  else if (satisfied) display = "clear";
  return {
    key,
    label,
    status: display,
    satisfied,
    note: stored?.note || "",
    updatedAt: stored?.updated_at || "",
  };
}

function buildChecks(stored, issues) {
  return CHECKS.map(([key, label]) => checkState(key, label, stored.get(key), issues));
}

function completionOf(checks) {
  const done = checks.filter((check) => check.satisfied).length;
  return checks.length ? Math.round((done / checks.length) * 100) : 0;
}

function displayStatus(row, checks) {
  if (row?.status === "closed") return "closed";
  if (row?.status === "awaiting_client" || row?.status === "under_review" || row?.status === "in_progress") return row.status;
  const blocking = checks.some((check) => BLOCKING.has(check.key) && !check.satisfied);
  const stored = checks.some((check) => check.status === "complete" || check.status === "waived");
  if (blocking || stored) return "in_progress";
  return "not_started";
}

function overdueOf(status, dueOn, today) {
  return status !== "closed" && Boolean(dueOn) && dueOn < today;
}

function ensureLock(db, session, clientId, period, status = "not_started") {
  const existing = lockRow(db, session, clientId, period);
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO period_locks (
      id, firm_id, client_id, period, status, due_on, assignee_user_id, locked_at, locked_by, lock_reason,
      reopened_at, reopened_by, reopen_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', NULL, NULL, '', ?, ?)`,
  ).run(id, session.firm_id, clientId, period, status, monthRange(period).end, now, now);
  return lockRow(db, session, clientId, period);
}

function auditClose(db, session, action, clientId, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, ?, ?, 'period_lock', ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityId, new Date().toISOString(), String(detail || "").slice(0, 500));
}

function snapshot(db, session, client, period) {
  const row = lockRow(db, session, client.id, period);
  const issues = issuesFor(db, session, client.id, period);
  const checks = buildChecks(storedChecks(db, session, client.id, period), issues);
  const status = displayStatus(row, checks);
  const dueOn = row?.due_on || monthRange(period).end;
  const today = todayIso();
  const assignee = row?.assignee_user_id
    ? db.prepare("SELECT id, name FROM users WHERE id = ? AND firm_id = ?").get(row.assignee_user_id, session.firm_id)
    : null;
  return {
    clientId: client.id,
    clientName: client.name,
    clientStatus: client.status || "active",
    period,
    status,
    statusLabel: STATUS_LABEL[status] || status,
    dueOn,
    overdue: overdueOf(status, dueOn, today),
    completion: completionOf(checks),
    outstanding: checks.filter((check) => !check.satisfied).length,
    assigneeId: assignee?.id || "",
    assigneeName: assignee?.name || "",
    checks,
    issueCounts: Object.fromEntries(Object.entries(issues).filter(([key]) => key !== "statement").map(([key, issue]) => [key, issue.count])),
    issues: Object.entries(issues).filter(([key, issue]) => key !== "statement" && issue.open).map(([key, issue]) => ({
      key,
      count: issue.count,
      detail: issue.detail,
    })),
    lockedAt: row?.locked_at || "",
    reopenReason: row?.reopen_reason || "",
    quickBooks: quickBooksNote(db, session, client.id),
    filesReturn: false,
    note: "This close does not file a tax return and does not calculate tax.",
  };
}

export function closeBoard(db, session, query = {}) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const today = todayIso();
  let period = query.period;
  if (!period && query.year && query.month) period = `${query.year}-${String(query.month).padStart(2, "0")}`;
  period = parseClosePeriod(period, today);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const statusFilter = String(query.status || "").trim();
  const assigneeFilter = String(query.assignee || "").trim();
  if (statusFilter && statusFilter !== "overdue" && !STATUSES.includes(statusFilter)) return fail(400, "Choose a close status.");
  const rows = visibleClients(db, session).map((client) => snapshot(db, session, client, period)).filter((row) => {
    if (statusFilter === "overdue") return row.overdue;
    if (statusFilter && row.status !== statusFilter) return false;
    if (assigneeFilter === "unassigned") return !row.assigneeId;
    if (assigneeFilter && row.assigneeId !== assigneeFilter) return false;
    return true;
  });
  const members = db.prepare("SELECT id, name, role FROM users WHERE firm_id = ? ORDER BY name").all(session.firm_id);
  const closed = rows.filter((row) => row.status === "closed").length;
  const outstanding = rows.reduce((sum, row) => sum + row.outstanding, 0);
  return {
    status: 200,
    payload: {
      period,
      today,
      counts: {
        clients: rows.length,
        closed,
        notStarted: rows.filter((row) => row.status === "not_started").length,
        inProgress: rows.filter((row) => row.status === "in_progress").length,
        awaitingClient: rows.filter((row) => row.status === "awaiting_client").length,
        underReview: rows.filter((row) => row.status === "under_review").length,
        overdue: rows.filter((row) => row.overdue).length,
        outstanding,
        completion: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.completion, 0) / rows.length) : 0,
        closedPercent: rows.length ? Math.round((closed / rows.length) * 100) : 0,
      },
      clients: rows.map((row) => ({
        id: row.clientId,
        name: row.clientName,
        status: row.status,
        statusLabel: row.statusLabel,
        completion: row.completion,
        outstanding: row.outstanding,
        overdue: row.overdue,
        dueOn: row.dueOn,
        assigneeId: row.assigneeId,
        assigneeName: row.assigneeName,
      })),
      members: members.map((member) => ({ id: member.id, name: member.name, role: member.role })),
      statuses: STATUSES.map((status) => ({ id: status, label: STATUS_LABEL[status] })),
      note: "This close does not file a tax return and does not calculate tax.",
    },
  };
}

export function readClose(db, session, clientId, periodValue) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const period = parseClosePeriod(periodValue);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  syncCloseIssues(db, session, period, client.id);
  return { status: 200, payload: snapshot(db, session, client, period) };
}

export function updateCloseCheck(db, session, clientId, input) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const period = parseClosePeriod(body.period);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const key = String(body.checkKey || "").trim();
  if (!CHECKS.some(([check]) => check === key)) return fail(400, "Choose a close check.");
  const status = String(body.status || "").trim();
  if (!["open", "complete", "waived"].includes(status)) return fail(400, "Choose open, complete, or waived.");
  const note = String(body.note || "").trim();
  if (note.length > 400) return fail(400, "Keep the note to 400 characters.");
  const row = ensureLock(db, session, client.id, period);
  if (row.status === "closed") return fail(409, "Reopen the month before changing the checklist.");
  if (key === "accountant_approval" && status === "waived") return fail(400, "The accountant approval cannot be waived.");
  if (key === "accountant_approval" && status === "complete" && !canApproveBills(user.role)) {
    return fail(403, "Only an owner, administrator, manager, or accountant can approve a month.");
  }
  if (status === "waived" && note.length < 8) return fail(400, "Enter a reason to waive this check.");
  const issues = issuesFor(db, session, client.id, period);
  if (status === "complete" && key === "balance_sheet" && issues.balanceSheet.open) {
    return fail(400, "The balance sheet does not balance. Waive it with a reason or correct the books.");
  }
  if (status === "complete" && BLOCKING.has(key) && blockingOpen(key, issues)) {
    return fail(400, "This check is still open in the books. Clear it or waive it with a reason.");
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO close_checks (id, firm_id, client_id, period, check_key, status, note, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(firm_id, client_id, period, check_key)
     DO UPDATE SET status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(randomUUID(), session.firm_id, client.id, period, key, status, note, user.id, now);
  if (row.status === "not_started") {
    db.prepare("UPDATE period_locks SET status = 'in_progress', updated_at = ? WHERE id = ? AND firm_id = ?").run(now, row.id, session.firm_id);
  }
  syncCloseIssues(db, session, period, client.id);
  return { status: 200, payload: snapshot(db, session, client, period) };
}

export function updateCloseStatus(db, session, clientId, input) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const period = parseClosePeriod(body.period);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const row = ensureLock(db, session, client.id, period);
  if (row.status === "closed") return fail(409, "Reopen the month before changing its status.");
  let status = row.status;
  if (body.status !== undefined) {
    status = String(body.status || "").trim();
    if (!STATUSES.includes(status) || status === "closed") return fail(400, "Choose Not Started, In Progress, Awaiting Client, or Under Review.");
  }
  let assigneeId = row.assignee_user_id;
  if (body.assigneeId !== undefined) {
    if (!body.assigneeId) assigneeId = null;
    else {
      const member = db.prepare("SELECT id FROM users WHERE id = ? AND firm_id = ?").get(body.assigneeId, session.firm_id);
      if (!member) return fail(404, "Assignee not found.");
      assigneeId = member.id;
    }
  }
  let dueOn = row.due_on;
  if (body.dueOn !== undefined) {
    const due = String(body.dueOn || "").trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return fail(400, "Enter a due date.");
    dueOn = due;
  }
  db.prepare(
    "UPDATE period_locks SET status = ?, assignee_user_id = ?, due_on = ?, updated_at = ? WHERE id = ? AND firm_id = ?",
  ).run(status, assigneeId, dueOn, new Date().toISOString(), row.id, session.firm_id);
  return { status: 200, payload: snapshot(db, session, client, period) };
}

export function lockClose(db, session, clientId, input) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can close a month.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const period = parseClosePeriod(input?.period);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const row = ensureLock(db, session, client.id, period);
  if (row.status === "closed") return { status: 200, payload: snapshot(db, session, client, period) };
  const view = snapshot(db, session, client, period);
  if (view.checks.some((check) => !check.satisfied)) return fail(400, "Finish or waive every check before closing the month.");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE period_locks
     SET status = 'closed', locked_at = ?, locked_by = ?, lock_reason = ?, updated_at = ?
     WHERE id = ? AND firm_id = ?`,
  ).run(now, user.id, "Closed the month. This lock is not a tax filing.", now, row.id, session.firm_id);
  auditClose(db, session, "period.closed", client.id, row.id, `Closed ${period}. This lock is not a tax filing.`);
  return { status: 200, payload: snapshot(db, session, client, period) };
}

export function reopenClose(db, session, clientId, input) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canManageFirm(user.role)) return fail(403, "Only an owner or administrator can reopen a closed month.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const period = parseClosePeriod(body.period);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const reason = String(body.reason || "").trim();
  if (reason.length < 8 || reason.length > 500) return fail(400, "Enter a reason to reopen the month.");
  const row = lockRow(db, session, client.id, period);
  if (!row || row.status !== "closed") return fail(400, "That month is not closed.");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE period_locks
     SET status = 'in_progress', locked_at = NULL, reopened_at = ?, reopened_by = ?, reopen_reason = ?, updated_at = ?
     WHERE id = ? AND firm_id = ?`,
  ).run(now, user.id, reason, now, row.id, session.firm_id);
  auditClose(db, session, "period.reopened", client.id, row.id, `Reopened ${period}. ${reason}`);
  return { status: 200, payload: snapshot(db, session, client, period) };
}

function packageRow(db, session, clientId, period, basis) {
  return db.prepare(
    "SELECT * FROM close_packages WHERE firm_id = ? AND client_id = ? AND period = ? AND basis = ?",
  ).get(session.firm_id, clientId, period, basis);
}

function packageBody(db, session, client, period, basis) {
  const loaded = loadStatement(db, session.firm_id, client.id, { period, basis });
  const statement = loaded?.statement;
  const range = monthRange(period);
  const lines = db.prepare(
    `SELECT accounts.code, accounts.name,
            COALESCE(SUM(journal_lines.debit_cents), 0) AS debit_cents,
            COALESCE(SUM(journal_lines.credit_cents), 0) AS credit_cents
     FROM journal_lines
     JOIN journal_entries ON journal_entries.id = journal_lines.entry_id AND journal_entries.firm_id = journal_lines.firm_id
     JOIN accounts ON accounts.id = journal_lines.account_id AND accounts.firm_id = journal_lines.firm_id
     WHERE journal_lines.firm_id = ? AND journal_lines.client_id = ? AND journal_entries.entry_date <= ?
     GROUP BY accounts.code, accounts.name
     HAVING COALESCE(SUM(journal_lines.debit_cents), 0) != 0 OR COALESCE(SUM(journal_lines.credit_cents), 0) != 0
     ORDER BY accounts.code`,
  ).all(session.firm_id, client.id, range.end);
  const debits = lines.reduce((sum, line) => sum + Number(line.debit_cents), 0);
  const credits = lines.reduce((sum, line) => sum + Number(line.credit_cents), 0);
  const stored = packageRow(db, session, client.id, period, basis);
  return {
    clientId: client.id,
    clientName: client.name,
    period,
    periodLabel: loaded?.period?.label || period,
    basis,
    reviewStatus: stored?.review_status || "draft",
    filesReturn: false,
    quickBooks: quickBooksNote(db, session, client.id),
    profitAndLoss: {
      incomeCents: Number(statement?.profitAndLoss?.incomeCents || 0),
      expenseCents: Number(statement?.profitAndLoss?.expenseCents || 0),
      netIncomeCents: Number(statement?.profitAndLoss?.netIncomeCents || 0),
    },
    balanceSheet: {
      assetsCents: Number(statement?.balanceSheet?.assetsCents || 0),
      liabilitiesCents: Number(statement?.balanceSheet?.liabilitiesCents || 0),
      equityCents: Number(statement?.balanceSheet?.equityCents || 0),
      balances: statement?.balanceSheet?.balances !== false,
    },
    cashFlow: {
      beginningCents: Number(statement?.cashFlow?.beginningCents || 0),
      receivedCents: Number(statement?.cashFlow?.receivedCents || 0),
      paidCents: Number(statement?.cashFlow?.paidCents || 0),
      endingCents: Number(statement?.cashFlow?.endingCents || 0),
    },
    trialBalance: {
      debitsCents: debits,
      creditsCents: credits,
      foots: debits === credits,
      rows: lines.map((line) => ({
        code: line.code,
        name: line.name,
        debitCents: Number(line.debit_cents),
        creditCents: Number(line.credit_cents),
      })),
    },
  };
}

export function readClosePackage(db, session, clientId, query = {}) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const period = parseClosePeriod(query.period);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const basis = query.basis === "cash" ? "cash" : "accrual";
  const now = new Date().toISOString();
  if (!packageRow(db, session, client.id, period, basis)) {
    db.prepare(
      `INSERT INTO close_packages (id, firm_id, client_id, period, basis, review_status, approved_at, approved_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL, ?)`,
    ).run(randomUUID(), session.firm_id, client.id, period, basis, now);
  }
  return { status: 200, payload: packageBody(db, session, client, period, basis) };
}

export function reviewClosePackage(db, session, clientId, input) {
  ensureClose(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const period = parseClosePeriod(body.period);
  if (!period) return fail(400, "Enter a month as YYYY-MM.");
  const basis = body.basis === "cash" ? "cash" : "accrual";
  const reviewStatus = String(body.reviewStatus || "").trim();
  if (!["draft", "in_review", "approved"].includes(reviewStatus)) return fail(400, "Choose a report review status.");
  if (reviewStatus === "approved" && !canApproveBills(user.role)) {
    return fail(403, "Only an owner, administrator, manager, or accountant can approve the report.");
  }
  readClosePackage(db, session, client.id, { period, basis });
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE close_packages
     SET review_status = ?, approved_at = ?, approved_by = ?, updated_at = ?
     WHERE firm_id = ? AND client_id = ? AND period = ? AND basis = ?`,
  ).run(
    reviewStatus,
    reviewStatus === "approved" ? now : null,
    reviewStatus === "approved" ? user.id : null,
    now,
    session.firm_id,
    client.id,
    period,
    basis,
  );
  if (reviewStatus === "in_review") {
    const row = ensureLock(db, session, client.id, period);
    if (row.status !== "closed") {
      db.prepare("UPDATE period_locks SET status = 'under_review', updated_at = ? WHERE id = ? AND firm_id = ?").run(now, row.id, session.firm_id);
    }
  }
  if (reviewStatus === "approved") auditClose(db, session, "period.report_approved", client.id, client.id, `Approved the ${basis} package for ${period}.`);
  return { status: 200, payload: packageBody(db, session, client, period, basis) };
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function closePackageFile(db, session, clientId, query, kind) {
  const result = readClosePackage(db, session, clientId, query);
  if (result.error) return result;
  const pack = result.payload;
  const lines = [
    ["section", "label", "debit_cents", "credit_cents", "amount_cents"],
    ["profit_and_loss", "income", "", "", pack.profitAndLoss.incomeCents],
    ["profit_and_loss", "expenses", "", "", pack.profitAndLoss.expenseCents],
    ["profit_and_loss", "net_income", "", "", pack.profitAndLoss.netIncomeCents],
    ["balance_sheet", "assets", "", "", pack.balanceSheet.assetsCents],
    ["balance_sheet", "liabilities", "", "", pack.balanceSheet.liabilitiesCents],
    ["balance_sheet", "equity", "", "", pack.balanceSheet.equityCents],
    ["cash_flow", "beginning", "", "", pack.cashFlow.beginningCents],
    ["cash_flow", "received", "", "", pack.cashFlow.receivedCents],
    ["cash_flow", "paid", "", "", pack.cashFlow.paidCents],
    ["cash_flow", "ending", "", "", pack.cashFlow.endingCents],
    ...pack.trialBalance.rows.map((row) => ["trial_balance", `${row.code} ${row.name}`, row.debitCents, row.creditCents, ""]),
  ];
  if (kind === "csv") {
    return {
      status: 200,
      body: lines.map((line) => line.map(csvCell).join(",")).join("\n") + "\n",
      contentType: "text/csv; charset=utf-8",
      filename: `avenue-close-${pack.period}.csv`,
    };
  }
  const text = [
    `${pack.clientName} ${pack.periodLabel}`,
    `${pack.basis} package, review ${pack.reviewStatus}`,
    "This package does not file a tax return.",
    `Net income cents ${pack.profitAndLoss.netIncomeCents}`,
    `Assets cents ${pack.balanceSheet.assetsCents}`,
    `Liabilities cents ${pack.balanceSheet.liabilitiesCents}`,
    `Equity cents ${pack.balanceSheet.equityCents}`,
    `Cash ending cents ${pack.cashFlow.endingCents}`,
    `Trial balance debits ${pack.trialBalance.debitsCents} credits ${pack.trialBalance.creditsCents}`,
    pack.quickBooks.note,
  ];
  return {
    status: 200,
    body: pdfDocument(text),
    contentType: "application/pdf",
    filename: `avenue-close-${pack.period}.pdf`,
  };
}

function pdfDocument(lines) {
  const safe = lines.map((line) => String(line).replace(/[^\x20-\x7E]/g, "?"));
  const commands = safe.map((line) => `(${line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")}) Tj`).join(" T*\n");
  const stream = `BT /F1 11 Tf 50 760 Td 16 TL\n${commands}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj ${object} endobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return body;
}

function taskSourceId(clientId, period, key) {
  return `${clientId}:${period}:${key}`;
}

function writeCloseTask(db, session, client, period, key, title, detail, priority) {
  const sourceId = taskSourceId(client.id, period, key);
  const existing = db.prepare(
    "SELECT * FROM work_tasks WHERE firm_id = ? AND source_type = 'close_issue' AND source_id = ?",
  ).get(session.firm_id, sourceId);
  const now = new Date().toISOString();
  const assigneeId = lockRow(db, session, client.id, period)?.assignee_user_id || null;
  if (existing) {
    if (existing.status === "completed") {
      db.prepare(
        `UPDATE work_tasks
         SET status = 'open', stage = 'ready', detail = ?, completed_by_user_id = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ? AND firm_id = ?`,
      ).run(detail, now, existing.id, session.firm_id);
      db.prepare(
        `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
         VALUES (?, ?, ?, ?, 'reopen', 'The accounting issue is open again.', ?)`,
      ).run(randomUUID(), session.firm_id, existing.id, session.user_id, now);
    } else if (existing.detail !== detail) {
      db.prepare("UPDATE work_tasks SET detail = ?, updated_at = ? WHERE id = ? AND firm_id = ?").run(detail, now, existing.id, session.firm_id);
    }
    return;
  }
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO work_tasks (
        id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
        source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at,
        stage, recurrence, blocked_by_task_id, schedule_id
      ) VALUES (?, ?, ?, ?, ?, '', 'bookkeeping', 'open', ?, ?, ?, 'close_issue', ?, NULL, NULL, ?, ?, ?, 'ready', '', NULL, NULL)`,
    ).run(id, session.firm_id, client.id, title, detail, priority, assigneeId, monthRange(period).end, sourceId, session.user_id, now, now);
    db.prepare(
      `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
       VALUES (?, ?, ?, ?, 'create', ?, ?)`,
    ).run(randomUUID(), session.firm_id, id, session.user_id, title, now);
  } catch (error) {
    if (!String(error.message || error).includes("UNIQUE")) throw error;
  }
}

function finishCloseTask(db, session, taskId) {
  const now = new Date().toISOString();
  const changed = db.prepare(
    `UPDATE work_tasks
     SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND status != 'completed'`,
  ).run(session.user_id, now, now, taskId, session.firm_id);
  if (!changed.changes) return;
  db.prepare(
    `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'The accounting issue is resolved.', ?)`,
  ).run(randomUUID(), session.firm_id, taskId, session.user_id, now);
}

export function syncCloseIssues(db, session, periodValue = "", onlyClientId = "") {
  if (!session?.firm_id || !session.user_id || session.portal) return;
  ensureClose(db);
  const period = parseClosePeriod(periodValue || todayIso().slice(0, 7));
  if (!period) return;
  const clients = visibleClients(db, session).filter((client) => !onlyClientId || client.id === onlyClientId);
  const openIds = new Set();
  for (const client of clients) {
    const issues = issuesFor(db, session, client.id, period);
    const waived = storedChecks(db, session, client.id, period);
    for (const [issueKey, checkKey, title] of TASK_KEYS) {
      const issue = issues[issueKey];
      if (!issue?.open) continue;
      const waiverKey = issueKey === "duplicates" || issueKey === "unbalanced" || issueKey === "unusual" ? "journal_review" : checkKey;
      if (waived.get(waiverKey)?.status === "waived") continue;
      const sourceId = taskSourceId(client.id, period, issueKey);
      openIds.add(sourceId);
      const priority = issueKey === "bank" || issueKey === "uncategorized" || issueKey === "unbalanced" ? "high" : "normal";
      writeCloseTask(db, session, client, period, issueKey, `${title} for ${client.name}`, issue.detail, priority);
    }
  }
  const extra = scopeSql(db, session, "work_tasks.client_id");
  const openTasks = db.prepare(
    `SELECT id, source_id, client_id FROM work_tasks
     WHERE firm_id = ? AND source_type = 'close_issue' AND status != 'completed' AND source_id LIKE ?
     ${extra.sql}`,
  ).all(session.firm_id, `%:${period}:%`, ...extra.params);
  for (const task of openTasks) {
    if (onlyClientId && task.client_id !== onlyClientId) continue;
    if (!openIds.has(task.source_id)) finishCloseTask(db, session, task.id);
  }
}

export function closedPeriod(db, session, entryDate) {
  if (!session?.firm_id || !session.selected_client_id) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entryDate || ""))) return null;
  ensureClose(db);
  const row = db.prepare(
    "SELECT id, status, period FROM period_locks WHERE firm_id = ? AND client_id = ? AND period = ?",
  ).get(session.firm_id, session.selected_client_id, String(entryDate).slice(0, 7));
  return row?.status === "closed" ? row : null;
}

export function periodLockError(db, session, entryDate, adjustment) {
  const closed = closedPeriod(db, session, entryDate);
  if (!closed) return null;
  const user = actor(db, session);
  if (adjustment === true && user && canManageFirm(user.role)) return null;
  if (adjustment === true) return fail(403, "Only an owner or administrator can post an adjustment into a closed month.");
  return fail(409, "That month is closed. A closed month does not take a new entry unless an owner or administrator posts an adjustment.");
}

export function noteClosedAdjustment(db, session, entryDate, entryId) {
  const closed = closedPeriod(db, session, entryDate);
  if (!closed) return;
  auditClose(db, session, "period.adjustment", session.selected_client_id, entryId, `Posted an adjustment into closed ${closed.period}. Earlier entries were not edited.`);
}
