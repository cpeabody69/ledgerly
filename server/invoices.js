import { randomUUID } from "node:crypto";
import { percentChange } from "../shared/statements.js";
import { addCents, formatMoney, parseCents } from "../shared/money.js";
import { postJournalEntry } from "./ledger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  number TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  memo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'partial', 'paid', 'void')),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  sent_entry_id TEXT,
  void_entry_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (client_id, number)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_on TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS invoices_by_client ON invoices (firm_id, client_id, issue_date);
CREATE INDEX IF NOT EXISTS invoice_payments_by_invoice ON invoice_payments (firm_id, invoice_id);
`;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fail(status, error) {
  return { status, error };
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function audit(db, session, action, entityId) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, 'invoice', ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, session.selected_client_id, entityId, new Date().toISOString());
}

export function ensureInvoices(db) {
  db.exec(SCHEMA);
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function formatDate(value) {
  const [year, month, day] = String(value || "").split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return value || "";
  return `${name} ${Number(day)}, ${year}`;
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysBetween(start, end) {
  const left = Date.parse(`${start}T00:00:00Z`);
  const right = Date.parse(`${end}T00:00:00Z`);
  return Math.round((right - left) / 86400000);
}

function centsText(cents) {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function initials(name) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "");
  return letters.join("") || "IN";
}

function accountId(db, session, code) {
  const row = db.prepare(
    "SELECT id FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, code);
  return row?.id || null;
}

function postLines(db, session, entryDate, memo, lines) {
  return postJournalEntry(db, session, {
    entryDate,
    memo,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      debit: line.debit ? centsText(line.debit) : "",
      credit: line.credit ? centsText(line.credit) : "",
    })),
  });
}

function loadInvoice(db, session, id) {
  const invoice = db.prepare(
    "SELECT * FROM invoices WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(id, session.firm_id, session.selected_client_id);
  if (!invoice) return null;
  const lines = db.prepare(
    "SELECT * FROM invoice_lines WHERE invoice_id = ? AND firm_id = ? ORDER BY position",
  ).all(invoice.id, session.firm_id);
  const payments = db.prepare(
    "SELECT * FROM invoice_payments WHERE invoice_id = ? AND firm_id = ? ORDER BY paid_on, created_at",
  ).all(invoice.id, session.firm_id);
  return { invoice, lines, payments };
}

function invoiceJson(row, lines, payments, today) {
  const totalCents = asCents(row.total_cents);
  const paidCents = payments.reduce((sum, payment) => addCents(sum, asCents(payment.amount_cents)), 0);
  const balanceCents = row.status === "void" || row.status === "draft" ? (row.status === "draft" ? totalCents : 0) : totalCents - paidCents;
  const outstanding = row.status === "sent" || row.status === "partial";
  const overdue = outstanding && row.due_date < today;
  let statusLabel = "Draft";
  if (row.status === "sent") statusLabel = overdue ? "Overdue" : "Sent";
  else if (row.status === "partial") statusLabel = overdue ? "Overdue" : "Partial";
  else if (row.status === "paid") statusLabel = "Paid";
  else if (row.status === "void") statusLabel = "Void";
  return {
    id: row.id,
    number: row.number,
    customerName: row.customer_name,
    initials: initials(row.customer_name),
    issueDate: row.issue_date,
    issueDateLabel: formatDate(row.issue_date),
    dueDate: row.due_date,
    dueDateLabel: formatDate(row.due_date),
    memo: row.memo,
    status: row.status,
    statusLabel,
    overdue,
    daysOverdue: overdue ? daysBetween(row.due_date, today) : 0,
    total: formatMoney(totalCents),
    totalCents,
    paid: formatMoney(paidCents),
    paidCents,
    balance: formatMoney(outstanding || row.status === "draft" ? (row.status === "draft" ? totalCents : balanceCents) : balanceCents),
    balanceCents: outstanding ? balanceCents : (row.status === "draft" ? totalCents : 0),
    sentEntryId: row.sent_entry_id,
    voidEntryId: row.void_entry_id,
    lines: lines.map((line) => ({
      id: line.id,
      description: line.description,
      amount: formatMoney(asCents(line.amount_cents)),
      amountCents: asCents(line.amount_cents),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: formatMoney(asCents(payment.amount_cents)),
      amountCents: asCents(payment.amount_cents),
      paidOn: payment.paid_on,
      paidOnLabel: formatDate(payment.paid_on),
      journalEntryId: payment.journal_entry_id,
    })),
  };
}

function metricsFor(invoices, payments, today) {
  const outstanding = invoices.filter((invoice) => invoice.status === "sent" || invoice.status === "partial");
  let outstandingCents = 0;
  let overdueCents = 0;
  let overdueCount = 0;
  let oldestOverdue = 0;
  for (const invoice of outstanding) {
    const paid = payments
      .filter((payment) => payment.invoice_id === invoice.id)
      .reduce((sum, payment) => addCents(sum, asCents(payment.amount_cents)), 0);
    const balance = asCents(invoice.total_cents) - paid;
    outstandingCents = addCents(outstandingCents, balance);
    if (invoice.due_date < today) {
      overdueCents = addCents(overdueCents, balance);
      overdueCount += 1;
      oldestOverdue = Math.max(oldestOverdue, daysBetween(invoice.due_date, today));
    }
  }
  const month = today.slice(0, 7);
  const priorDate = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1));
  priorDate.setUTCMonth(priorDate.getUTCMonth() - 1);
  const prior = `${priorDate.getUTCFullYear()}-${String(priorDate.getUTCMonth() + 1).padStart(2, "0")}`;
  let paidThisMonthCents = 0;
  let paidPriorMonthCents = 0;
  for (const payment of payments) {
    const stamp = payment.paid_on.slice(0, 7);
    if (stamp === month) paidThisMonthCents = addCents(paidThisMonthCents, asCents(payment.amount_cents));
    if (stamp === prior) paidPriorMonthCents = addCents(paidPriorMonthCents, asCents(payment.amount_cents));
  }
  const paidInvoices = invoices.filter((invoice) => invoice.status === "paid");
  let averageDaysToPay = null;
  if (paidInvoices.length) {
    const totalDays = paidInvoices.reduce((sum, invoice) => {
      const last = payments.filter((payment) => payment.invoice_id === invoice.id).at(-1);
      return sum + (last ? Math.max(0, daysBetween(invoice.issue_date, last.paid_on)) : 0);
    }, 0);
    averageDaysToPay = Math.round(totalDays / paidInvoices.length);
  }
  const billed = invoices
    .filter((invoice) => invoice.status !== "draft" && invoice.status !== "void")
    .reduce((sum, invoice) => addCents(sum, asCents(invoice.total_cents)), 0);
  const collected = invoices
    .filter((invoice) => invoice.status !== "draft" && invoice.status !== "void")
    .reduce((sum, invoice) => addCents(sum, payments.filter((payment) => payment.invoice_id === invoice.id).reduce((inner, payment) => addCents(inner, asCents(payment.amount_cents)), 0)), 0);
  return {
    count: invoices.length,
    outstanding: formatMoney(outstandingCents),
    outstandingCents,
    outstandingCount: outstanding.length,
    overdue: formatMoney(overdueCents),
    overdueCents,
    overdueCount,
    overdueDays: overdueCount ? oldestOverdue : null,
    paidThisMonth: formatMoney(paidThisMonthCents),
    paidThisMonthCents,
    paidChange: percentChange(paidThisMonthCents, paidPriorMonthCents),
    averageDaysToPay,
    collectedPercent: billed ? Math.round((collected * 100) / billed) : null,
  };
}

function sameClient(session, body) {
  if (body && Object.prototype.hasOwnProperty.call(body, "clientId") && body.clientId !== session.selected_client_id) {
    return fail(404, "Client not found.");
  }
  return null;
}

export function listInvoices(db, session) {
  ensureInvoices(db);
  const today = todayISO();
  const invoices = db.prepare(
    "SELECT * FROM invoices WHERE firm_id = ? AND client_id = ? ORDER BY issue_date DESC, number DESC",
  ).all(session.firm_id, session.selected_client_id);
  const payments = db.prepare(
    "SELECT * FROM invoice_payments WHERE firm_id = ? AND client_id = ? ORDER BY paid_on, created_at",
  ).all(session.firm_id, session.selected_client_id);
  const lines = db.prepare(
    "SELECT * FROM invoice_lines WHERE firm_id = ? AND client_id = ? ORDER BY position",
  ).all(session.firm_id, session.selected_client_id);
  return {
    status: 200,
    payload: {
      client: { id: session.selected_client_id },
      today,
      metrics: metricsFor(invoices, payments, today),
      invoices: invoices.map((invoice) => invoiceJson(
        invoice,
        lines.filter((line) => line.invoice_id === invoice.id),
        payments.filter((payment) => payment.invoice_id === invoice.id),
        today,
      )),
    },
  };
}

function parseLines(body) {
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 20) {
    return fail(400, "Add at least one invoice line.");
  }
  const lines = [];
  let total = 0;
  for (const line of body.lines) {
    const description = String(line?.description || "").trim();
    if (!description || description.length > 120) return fail(400, "Enter a line description.");
    let amount = 0;
    try {
      amount = parseCents(line?.amount);
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    if (amount <= 0) return fail(400, "Enter an amount.");
    total = addCents(total, amount);
    lines.push({ description, amount });
  }
  return { lines, total };
}

export function createInvoice(db, session, input) {
  ensureInvoices(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const customerName = String(body.customerName || "").trim();
  if (!customerName || customerName.length > 120) return fail(400, "Enter a customer.");
  const issueDate = parseDate(body.issueDate);
  const dueDate = parseDate(body.dueDate);
  if (!issueDate || !dueDate) return fail(400, "Enter the issue date and the due date.");
  if (dueDate < issueDate) return fail(400, "The due date cannot be before the issue date.");
  const memo = String(body.memo || "").trim();
  if (memo.length > 200) return fail(400, "Keep the memo to 200 characters.");
  const parsed = parseLines(body);
  if (parsed.error) return parsed;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(
      "SELECT number FROM invoices WHERE firm_id = ? AND client_id = ?",
    ).all(session.firm_id, session.selected_client_id);
    const max = existing.reduce((highest, row) => Math.max(highest, Number(String(row.number).slice(4)) || 0), 0);
    const number = `INV-${String(max + 1).padStart(4, "0")}`;
    db.prepare(
      `INSERT INTO invoices (
        id, firm_id, client_id, number, customer_name, issue_date, due_date, memo, status, total_cents, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(id, session.firm_id, session.selected_client_id, number, customerName, issueDate, dueDate, memo, parsed.total, session.user_id, now);
    const insertLine = db.prepare(
      "INSERT INTO invoice_lines (id, firm_id, client_id, invoice_id, description, amount_cents, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    parsed.lines.forEach((line, position) => {
      insertLine.run(randomUUID(), session.firm_id, session.selected_client_id, id, line.description, line.amount, position);
    });
    audit(db, session, "invoice.created", id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const stored = loadInvoice(db, session, id);
  return { status: 201, payload: { invoice: invoiceJson(stored.invoice, stored.lines, stored.payments, todayISO()) } };
}

export function sendInvoice(db, session, id) {
  ensureInvoices(db);
  const loaded = loadInvoice(db, session, id);
  if (!loaded) return fail(404, "Invoice not found.");
  if (loaded.invoice.status !== "draft") return fail(400, "Only a draft can be sent.");
  const receivable = accountId(db, session, "1100");
  const income = accountId(db, session, "4000");
  if (!receivable || !income) return fail(400, "This client's chart is missing receivable or income.");
  const posted = postLines(db, session, loaded.invoice.issue_date, `Invoice ${loaded.invoice.number}`, [
    { accountId: receivable, debit: asCents(loaded.invoice.total_cents), credit: 0 },
    { accountId: income, debit: 0, credit: asCents(loaded.invoice.total_cents) },
  ]);
  if (posted.error) return posted;
  db.prepare(
    "UPDATE invoices SET status = 'sent', sent_entry_id = ? WHERE id = ? AND firm_id = ? AND status = 'draft'",
  ).run(posted.payload.entry.id, loaded.invoice.id, session.firm_id);
  audit(db, session, "invoice.sent", loaded.invoice.id);
  const stored = loadInvoice(db, session, id);
  return { status: 200, payload: { invoice: invoiceJson(stored.invoice, stored.lines, stored.payments, todayISO()), entry: posted.payload.entry } };
}

export function recordPayment(db, session, id, input) {
  ensureInvoices(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const loaded = loadInvoice(db, session, id);
  if (!loaded) return fail(404, "Invoice not found.");
  if (loaded.invoice.status !== "sent" && loaded.invoice.status !== "partial") {
    return fail(400, "Record a payment on a sent invoice.");
  }
  const paidOn = parseDate(body.paidOn);
  if (!paidOn) return fail(400, "Enter the payment date.");
  if (paidOn < loaded.invoice.issue_date) return fail(400, "The payment cannot be before the invoice date.");
  let amount = 0;
  try {
    amount = parseCents(body.amount);
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  if (amount <= 0) return fail(400, "Enter an amount.");
  const paidCents = loaded.payments.reduce((sum, payment) => addCents(sum, asCents(payment.amount_cents)), 0);
  const balance = asCents(loaded.invoice.total_cents) - paidCents;
  if (amount > balance) return fail(400, "That payment is more than the balance.");
  const cash = accountId(db, session, "1000");
  const receivable = accountId(db, session, "1100");
  if (!cash || !receivable) return fail(400, "This client's chart is missing cash or receivable.");
  const posted = postLines(db, session, paidOn, `Payment on ${loaded.invoice.number}`, [
    { accountId: cash, debit: amount, credit: 0 },
    { accountId: receivable, debit: 0, credit: amount },
  ]);
  if (posted.error) return posted;
  const now = new Date().toISOString();
  const paymentId = randomUUID();
  const nextPaid = addCents(paidCents, amount);
  const status = nextPaid === asCents(loaded.invoice.total_cents) ? "paid" : "partial";
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO invoice_payments (
        id, firm_id, client_id, invoice_id, amount_cents, paid_on, journal_entry_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(paymentId, session.firm_id, session.selected_client_id, loaded.invoice.id, amount, paidOn, posted.payload.entry.id, session.user_id, now);
    db.prepare(
      "UPDATE invoices SET status = ? WHERE id = ? AND firm_id = ?",
    ).run(status, loaded.invoice.id, session.firm_id);
    audit(db, session, "invoice.payment_recorded", loaded.invoice.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const stored = loadInvoice(db, session, id);
  return { status: 201, payload: { invoice: invoiceJson(stored.invoice, stored.lines, stored.payments, todayISO()), entry: posted.payload.entry } };
}

export function voidInvoice(db, session, id) {
  ensureInvoices(db);
  const loaded = loadInvoice(db, session, id);
  if (!loaded) return fail(404, "Invoice not found.");
  if (!loaded.invoice.sent_entry_id || loaded.invoice.status === "draft" || loaded.invoice.status === "void") {
    return fail(400, "Void a sent invoice. A draft has no journal to reverse.");
  }
  const paidCents = loaded.payments.reduce((sum, payment) => addCents(sum, asCents(payment.amount_cents)), 0);
  const total = asCents(loaded.invoice.total_cents);
  const remaining = total - paidCents;
  const cash = accountId(db, session, "1000");
  const receivable = accountId(db, session, "1100");
  const income = accountId(db, session, "4000");
  if (!cash || !receivable || !income) return fail(400, "This client's chart is missing cash, receivable, or income.");
  const latestPayment = loaded.payments.reduce((latest, payment) => payment.paid_on > latest ? payment.paid_on : latest, loaded.invoice.issue_date);
  const entryDate = [todayISO(), loaded.invoice.issue_date, latestPayment].sort().at(-1);
  const lines = [{ accountId: income, debit: total, credit: 0 }];
  if (paidCents > 0) lines.push({ accountId: cash, debit: 0, credit: paidCents });
  if (remaining > 0) lines.push({ accountId: receivable, debit: 0, credit: remaining });
  const posted = postLines(db, session, entryDate, `Void ${loaded.invoice.number}`, lines);
  if (posted.error) return posted;
  db.prepare(
    "UPDATE invoices SET status = 'void', void_entry_id = ? WHERE id = ? AND firm_id = ? AND status != 'void'",
  ).run(posted.payload.entry.id, loaded.invoice.id, session.firm_id);
  audit(db, session, "invoice.voided", loaded.invoice.id);
  const stored = loadInvoice(db, session, id);
  return { status: 200, payload: { invoice: invoiceJson(stored.invoice, stored.lines, stored.payments, todayISO()), entry: posted.payload.entry } };
}

export function discardInvoice(db, session, id) {
  ensureInvoices(db);
  const loaded = loadInvoice(db, session, id);
  if (!loaded) return fail(404, "Invoice not found.");
  if (loaded.invoice.status !== "draft") return fail(400, "Only a draft can be discarded.");
  db.exec("BEGIN");
  try {
    audit(db, session, "invoice.discarded", loaded.invoice.id);
    db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ? AND firm_id = ?").run(loaded.invoice.id, session.firm_id);
    db.prepare("DELETE FROM invoices WHERE id = ? AND firm_id = ? AND status = 'draft'").run(loaded.invoice.id, session.firm_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { status: 200, payload: { ok: true } };
}
