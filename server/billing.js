// Firm fee billing. These invoices are what the firm charges a client.
// They do not post to the client's ledger and they do not take a card payment.
import { randomUUID } from "node:crypto";
import { lookupClient, scopeSql } from "./access.js";
import { parseCents } from "../shared/money.js";
import { canApproveBills } from "./permissions.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firm_engagements (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fixed', 'hourly', 'recurring')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER,
  interval_days INTEGER NOT NULL DEFAULT 0,
  next_on TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS firm_invoices (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  engagement_id TEXT,
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'partial', 'paid', 'void')),
  issue_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, number)
);
CREATE TABLE IF NOT EXISTS firm_invoice_lines (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  invoice_id TEXT NOT NULL REFERENCES firm_invoices(id),
  description TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  time_entry_id TEXT
);
CREATE TABLE IF NOT EXISTS firm_payments (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  invoice_id TEXT NOT NULL REFERENCES firm_invoices(id),
  amount_cents INTEGER NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS firm_credits (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  invoice_id TEXT NOT NULL REFERENCES firm_invoices(id),
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
`;

const METHODS = new Set(["recorded", "check", "other"]);

function fail(status, error) {
  return { status, error };
}

export function ensureBilling(db) {
  db.exec(SCHEMA);
  const time = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'time_entries'").get();
  if (!time) return;
  const columns = new Set(db.prepare("PRAGMA table_info(time_entries)").all().map((column) => column.name));
  if (!columns.has("billable")) db.exec("ALTER TABLE time_entries ADD COLUMN billable INTEGER NOT NULL DEFAULT 1");
  if (!columns.has("firm_invoice_id")) db.exec("ALTER TABLE time_entries ADD COLUMN firm_invoice_id TEXT");
  if (!columns.has("engagement_id")) db.exec("ALTER TABLE time_entries ADD COLUMN engagement_id TEXT");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS firm_invoices_one_issue
     ON firm_invoices (firm_id, engagement_id, issue_on)
     WHERE engagement_id IS NOT NULL AND status != 'void'`,
  );
}

function actor(db, session) {
  if (!session?.user_id || !session.firm_id || session.portal) return null;
  return db.prepare("SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function auditBill(db, session, action, clientId, entityId, detail = "") {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, ?, ?, 'firm_invoice', ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityId, new Date().toISOString(), String(detail || "").slice(0, 500));
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function day(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fail(400, `Enter ${label}.`);
  return { day: text };
}

function money(value, label) {
  try {
    return { cents: parseCents(String(value)) };
  } catch (error) {
    return fail(error.status || 400, error.message || `Enter ${label}.`);
  }
}

function clientFor(db, session, clientId) {
  const row = lookupClient(db, session, clientId);
  if (!row) return null;
  return db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(row.id, session.firm_id);
}

function nextNumber(db, firmId) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM firm_invoices WHERE firm_id = ?").get(firmId);
  return `FB-${1001 + Number(count.count)}`;
}

function totals(db, invoiceId, firmId) {
  const billed = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM firm_invoice_lines WHERE invoice_id = ? AND firm_id = ?",
  ).get(invoiceId, firmId);
  const paid = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM firm_payments WHERE invoice_id = ? AND firm_id = ?",
  ).get(invoiceId, firmId);
  const credits = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM firm_credits WHERE invoice_id = ? AND firm_id = ?",
  ).get(invoiceId, firmId);
  const balance = Number(billed.cents) - Number(paid.cents) - Number(credits.cents);
  return { billedCents: Number(billed.cents), paidCents: Number(paid.cents), creditCents: Number(credits.cents), balanceCents: balance };
}

function presentInvoice(db, session, invoice) {
  const client = db.prepare("SELECT name FROM clients WHERE id = ? AND firm_id = ?").get(invoice.client_id, session.firm_id);
  const lines = db.prepare(
    "SELECT id, description, service, amount_cents, time_entry_id FROM firm_invoice_lines WHERE invoice_id = ? AND firm_id = ? ORDER BY description",
  ).all(invoice.id, session.firm_id);
  const moneyTotals = totals(db, invoice.id, session.firm_id);
  return {
    id: invoice.id,
    clientId: invoice.client_id,
    clientName: client?.name || "",
    engagementId: invoice.engagement_id || "",
    number: invoice.number,
    status: invoice.status,
    issueOn: invoice.issue_on,
    dueOn: invoice.due_on,
    memo: invoice.memo,
    approvedBy: invoice.approved_by || "",
    lines: lines.map((line) => {
      const time = line.time_entry_id
        ? db.prepare("SELECT invoice_id FROM time_entries WHERE id = ? AND firm_id = ?").get(line.time_entry_id, session.firm_id)
        : null;
      return {
        id: line.id,
        description: line.description,
        service: line.service,
        amountCents: Number(line.amount_cents),
        timeEntryId: line.time_entry_id || "",
        alreadyOnClientInvoice: Boolean(time?.invoice_id),
      };
    }),
    ...moneyTotals,
    postsToClientLedger: false,
    collectsCard: false,
    clientLedgerWarning: lines.some((line) => line.time_entry_id && db.prepare(
      "SELECT invoice_id FROM time_entries WHERE id = ? AND firm_id = ?",
    ).get(line.time_entry_id, session.firm_id)?.invoice_id)
      ? "Some of this time is already on a client-ledger invoice. This firm fee does not post to those books."
      : "",
  };
}

function loadInvoice(db, session, id) {
  const invoice = db.prepare("SELECT * FROM firm_invoices WHERE id = ? AND firm_id = ?").get(id, session.firm_id);
  if (!invoice || !clientFor(db, session, invoice.client_id)) return null;
  return invoice;
}

function refreshStatus(db, invoice) {
  if (invoice.status === "draft" || invoice.status === "void") return invoice.status;
  const balance = totals(db, invoice.id, invoice.firm_id).balanceCents;
  const status = balance <= 0 ? "paid" : totals(db, invoice.id, invoice.firm_id).paidCents + totals(db, invoice.id, invoice.firm_id).creditCents > 0 ? "partial" : "approved";
  db.prepare("UPDATE firm_invoices SET status = ? WHERE id = ? AND firm_id = ?").run(status, invoice.id, invoice.firm_id);
  return status;
}

export function billingBoard(db, session) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  generateRecurring(db, session);
  const extra = scopeSql(db, session, "firm_invoices.client_id");
  const invoices = db.prepare(
    `SELECT * FROM firm_invoices WHERE firm_id = ? ${extra.sql} ORDER BY issue_on, number`,
  ).all(session.firm_id, ...extra.params).filter((row) => clientFor(db, session, row.client_id));
  const engagements = db.prepare(
    `SELECT firm_engagements.*, clients.name AS client_name
     FROM firm_engagements
     JOIN clients ON clients.id = firm_engagements.client_id AND clients.firm_id = firm_engagements.firm_id
     WHERE firm_engagements.firm_id = ?
     ORDER BY clients.name, firm_engagements.name`,
  ).all(session.firm_id).filter((row) => clientFor(db, session, row.client_id));
  return {
    status: 200,
    payload: {
      payments: {
        enabled: false,
        processor: "none",
        note: "Stripe Connect is not enabled. Record a payment here. No card number is stored. This is separate from Avenue subscription billing.",
      },
      engagements: engagements.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
        name: row.name,
        kind: row.kind,
        amountCents: Number(row.amount_cents),
        costCents: row.cost_cents == null ? null : Number(row.cost_cents),
        intervalDays: Number(row.interval_days),
        nextOn: row.next_on,
        status: row.status,
      })),
      invoices: invoices.map((row) => presentInvoice(db, session, row)),
      aging: agingReport(db, session, invoices),
    },
  };
}

function agingReport(db, session, invoices) {
  const today = todayIso();
  const buckets = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
  for (const invoice of invoices) {
    if (!["approved", "partial"].includes(invoice.status)) continue;
    const balance = totals(db, invoice.id, session.firm_id).balanceCents;
    if (balance <= 0) continue;
    const due = invoice.due_on;
    if (due >= today) buckets.current += balance;
    else {
      const late = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
      if (late <= 30) buckets.days30 += balance;
      else if (late <= 60) buckets.days60 += balance;
      else if (late <= 90) buckets.days90 += balance;
      else buckets.over90 += balance;
    }
  }
  return buckets;
}

export function saveEngagement(db, session, input) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const body = input || {};
  const client = clientFor(db, session, body.clientId || session.selected_client_id);
  if (!client) return fail(404, "Client not found.");
  const name = String(body.name || "").trim();
  const kind = String(body.kind || "");
  if (name.length < 3 || name.length > 80) return fail(400, "Enter an engagement name.");
  if (!["fixed", "hourly", "recurring"].includes(kind)) return fail(400, "Choose fixed, hourly, or recurring.");
  const amount = kind === "hourly" ? { cents: 0 } : money(body.amount, "the fee");
  if (amount.error) return amount;
  if (kind !== "hourly" && amount.cents <= 0) return fail(400, "Enter a fee greater than 0.");
  let cost = null;
  if (body.costAmount) {
    const parsed = money(body.costAmount, "the cost");
    if (parsed.error) return parsed;
    cost = parsed.cents;
  }
  const interval = kind === "recurring" ? Number(body.intervalDays || 30) : 0;
  if (kind === "recurring" && (!Number.isInteger(interval) || interval < 1 || interval > 365)) {
    return fail(400, "Enter a recurring interval from 1 to 365 days.");
  }
  const next = kind === "recurring" ? day(body.nextOn || todayIso(), "the next invoice date") : { day: "" };
  if (next.error) return next;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO firm_engagements (
      id, firm_id, client_id, name, kind, amount_cents, cost_cents, interval_days, next_on, status, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, session.firm_id, client.id, name, kind, amount.cents, cost, interval, next.day, user.id, new Date().toISOString());
  auditBill(db, session, "billing.engagement_saved", client.id, id, name);
  return billingBoard(db, session);
}

function insertInvoice(db, session, user, client, engagement, issueOn, dueOn, memo, lines) {
  const id = randomUUID();
  const number = nextNumber(db, session.firm_id);
  db.prepare(
    `INSERT INTO firm_invoices (
      id, firm_id, client_id, engagement_id, number, status, issue_on, due_on, memo, created_by, approved_by, created_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, ?)`,
  ).run(id, session.firm_id, client.id, engagement?.id || null, number, issueOn, dueOn, memo, user.id, new Date().toISOString());
  for (const line of lines) {
    db.prepare(
      `INSERT INTO firm_invoice_lines (
        id, firm_id, invoice_id, description, service, amount_cents, time_entry_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), session.firm_id, id, line.description, line.service || "", line.amountCents, line.timeEntryId || null);
    if (line.timeEntryId) {
      db.prepare(
        `UPDATE time_entries
         SET firm_invoice_id = ?, engagement_id = COALESCE(engagement_id, ?)
         WHERE id = ? AND firm_id = ? AND firm_invoice_id IS NULL`,
      ).run(id, engagement?.id || null, line.timeEntryId, session.firm_id);
    }
  }
  auditBill(db, session, "billing.invoice_drafted", client.id, id, number);
  return id;
}

export function draftFirmInvoice(db, session, input) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const body = input || {};
  const client = clientFor(db, session, body.clientId || session.selected_client_id);
  if (!client) return fail(404, "Client not found.");
  const issue = day(body.issueOn, "the invoice date");
  if (issue.error) return issue;
  const due = day(body.dueOn, "the due date");
  if (due.error) return due;
  let lines = [];
  let engagement = null;
  const entryIds = Array.isArray(body.entryIds) ? body.entryIds.filter(Boolean) : [];
  if (entryIds.length) {
    if (body.engagementId) {
      engagement = db.prepare(
        "SELECT * FROM firm_engagements WHERE id = ? AND firm_id = ? AND client_id = ?",
      ).get(body.engagementId, session.firm_id, client.id);
      if (!engagement) return fail(404, "Engagement not found.");
      if (engagement.kind !== "hourly") return fail(400, "Bill hours only on an hourly engagement.");
    }
    for (const entryId of entryIds) {
      const entry = db.prepare(
        `SELECT time_entries.*, work_items.name AS work_name, work_items.hourly_rate_cents
         FROM time_entries
         JOIN work_items ON work_items.id = time_entries.work_id AND work_items.firm_id = time_entries.firm_id
         WHERE time_entries.id = ? AND time_entries.firm_id = ? AND time_entries.client_id = ?`,
      ).get(entryId, session.firm_id, client.id);
      if (!entry) return fail(404, "Time entry not found.");
      if (Number(entry.billable) === 0) return fail(400, "That time is nonbillable.");
      if (entry.firm_invoice_id) return fail(400, "That time is already on a firm invoice.");
      if (entry.invoice_id) return fail(400, "That time is already on a client invoice.");
      if (entry.engagement_id && engagement && entry.engagement_id !== engagement.id) {
        return fail(400, "That time is assigned to another engagement.");
      }
      if (entry.engagement_id && !engagement) {
        engagement = db.prepare(
          "SELECT * FROM firm_engagements WHERE id = ? AND firm_id = ? AND client_id = ?",
        ).get(entry.engagement_id, session.firm_id, client.id);
        if (!engagement || engagement.kind !== "hourly") return fail(400, "That time is assigned to a fixed or recurring engagement.");
      }
      const amount = Math.round(Number(entry.hourly_rate_cents) * Number(entry.hours_hundredths) / 100);
      lines.push({
        description: `${entry.work_name} · ${entry.worked_on}`,
        service: entry.work_name,
        amountCents: amount,
        timeEntryId: entry.id,
      });
    }
  } else if (body.engagementId) {
    engagement = db.prepare(
      "SELECT * FROM firm_engagements WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).get(body.engagementId, session.firm_id, client.id);
    if (!engagement || engagement.kind === "hourly") return fail(400, "Choose a fixed or recurring engagement.");
    lines = [{ description: engagement.name, service: engagement.name, amountCents: Number(engagement.amount_cents) }];
  } else return fail(400, "Choose an engagement or billable time.");
  const id = insertInvoice(db, session, user, client, engagement, issue.day, due.day, String(body.memo || "").slice(0, 200), lines);
  const invoice = loadInvoice(db, session, id);
  return { status: 201, payload: { invoice: presentInvoice(db, session, invoice) } };
}

function issueExists(db, firmId, engagementId, issueOn) {
  return db.prepare(
    "SELECT id FROM firm_invoices WHERE firm_id = ? AND engagement_id = ? AND issue_on = ? AND status != 'void'",
  ).get(firmId, engagementId, issueOn);
}

function advanceEngagement(db, session, user, engagement, today) {
  const interval = Number(engagement.interval_days);
  if (!Number.isInteger(interval) || interval < 1) return 0;
  let cursor = engagement.next_on;
  const started = cursor;
  let created = 0;
  for (let step = 0; cursor && cursor <= today && step < 24; step += 1) {
    if (!issueExists(db, session.firm_id, engagement.id, cursor)) {
      try {
        insertInvoice(
          db,
          session,
          user,
          { id: engagement.client_id },
          engagement,
          cursor,
          addDays(cursor, 14),
          "Recurring engagement",
          [{ description: engagement.name, service: engagement.name, amountCents: Number(engagement.amount_cents) }],
        );
        created += 1;
      } catch (error) {
        if (!String(error.message || error).includes("UNIQUE") || !issueExists(db, session.firm_id, engagement.id, cursor)) throw error;
      }
    }
    cursor = addDays(cursor, interval);
  }
  if (cursor !== started) {
    db.prepare(
      "UPDATE firm_engagements SET next_on = ? WHERE id = ? AND firm_id = ? AND next_on = ?",
    ).run(cursor, engagement.id, session.firm_id, started);
  }
  return created;
}

export function generateRecurring(db, session) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const today = todayIso();
  const due = db.prepare(
    `SELECT * FROM firm_engagements
     WHERE firm_id = ? AND kind = 'recurring' AND status = 'active' AND next_on != '' AND next_on <= ?`,
  ).all(session.firm_id, today);
  let created = 0;
  for (const engagement of due) {
    if (!clientFor(db, session, engagement.client_id)) continue;
    created += advanceEngagement(db, session, user, engagement, today);
  }
  return { status: 200, payload: { created } };
}

export function runRecurringBilling(db) {
  ensureBilling(db);
  const today = todayIso();
  const due = db.prepare(
    `SELECT * FROM firm_engagements
     WHERE kind = 'recurring' AND status = 'active' AND next_on != '' AND next_on <= ?`,
  ).all(today);
  let created = 0;
  for (const engagement of due) {
    created += advanceEngagement(
      db,
      { firm_id: engagement.firm_id, user_id: engagement.created_by },
      { id: engagement.created_by },
      engagement,
      today,
    );
  }
  return created;
}

export function approveFirmInvoice(db, session, id) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can approve a firm invoice.");
  const invoice = loadInvoice(db, session, id);
  if (!invoice) return fail(404, "Invoice not found.");
  if (invoice.status !== "draft") return fail(400, "Only a draft can be approved.");
  db.prepare(
    "UPDATE firm_invoices SET status = 'approved', approved_by = ? WHERE id = ? AND firm_id = ?",
  ).run(user.id, invoice.id, session.firm_id);
  auditBill(db, session, "billing.invoice_approved", invoice.client_id, invoice.id, invoice.number);
  return { status: 200, payload: { invoice: presentInvoice(db, session, { ...invoice, status: "approved", approved_by: user.id }) } };
}

export function recordFeePayment(db, session, id, input) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const invoice = loadInvoice(db, session, id);
  if (!invoice) return fail(404, "Invoice not found.");
  if (!["approved", "partial"].includes(invoice.status)) return fail(400, "Approve the invoice before recording a payment.");
  const body = input || {};
  const amount = money(body.amount, "the payment");
  if (amount.error) return amount;
  if (amount.cents <= 0) return fail(400, "Enter a payment greater than 0.");
  const balance = totals(db, invoice.id, session.firm_id).balanceCents;
  if (amount.cents > balance) return fail(400, "That payment is larger than the balance.");
  const method = String(body.method || "recorded");
  if (!METHODS.has(method)) return fail(400, "Record the payment as recorded, check, or other.");
  if (/\d{12,}/.test(String(body.note || "") + method)) return fail(400, "Do not store a card number.");
  const paidOn = day(body.paidOn, "the payment date");
  if (paidOn.error) return paidOn;
  db.prepare(
    `INSERT INTO firm_payments (id, firm_id, invoice_id, amount_cents, paid_on, method, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, invoice.id, amount.cents, paidOn.day, method, user.id, new Date().toISOString());
  refreshStatus(db, invoice);
  auditBill(db, session, "billing.payment_recorded", invoice.client_id, invoice.id, method);
  const updated = loadInvoice(db, session, invoice.id);
  return { status: 200, payload: { invoice: presentInvoice(db, session, updated) } };
}

export function addFirmCredit(db, session, id, input) {
  ensureBilling(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can add a credit.");
  const invoice = loadInvoice(db, session, id);
  if (!invoice) return fail(404, "Invoice not found.");
  if (invoice.status === "void" || invoice.status === "draft") return fail(400, "Approve the invoice before adding a credit.");
  const body = input || {};
  const amount = money(body.amount, "the credit");
  if (amount.error) return amount;
  if (amount.cents <= 0) return fail(400, "Enter a credit greater than 0.");
  const balance = totals(db, invoice.id, session.firm_id).balanceCents;
  if (amount.cents > balance) return fail(400, "That credit is larger than the balance.");
  const reason = String(body.reason || "").trim();
  if (reason.length < 8) return fail(400, "Enter a reason for the credit.");
  db.prepare(
    `INSERT INTO firm_credits (id, firm_id, invoice_id, amount_cents, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, invoice.id, amount.cents, reason, user.id, new Date().toISOString());
  refreshStatus(db, invoice);
  auditBill(db, session, "billing.credit_added", invoice.client_id, invoice.id, reason);
  const updated = loadInvoice(db, session, invoice.id);
  return { status: 200, payload: { invoice: presentInvoice(db, session, updated) } };
}

export function billingReports(db, session) {
  const board = billingBoard(db, session);
  if (board.error) return board;
  const invoices = board.payload.invoices.filter((invoice) => invoice.status !== "void" && invoice.status !== "draft");
  const byClient = new Map();
  const byService = new Map();
  for (const invoice of invoices) {
    const client = byClient.get(invoice.clientId) || { clientId: invoice.clientId, name: invoice.clientName, billedCents: 0, paidCents: 0, openCents: 0 };
    client.billedCents += invoice.billedCents;
    client.paidCents += invoice.paidCents;
    client.openCents += Math.max(0, invoice.balanceCents);
    byClient.set(invoice.clientId, client);
    for (const line of invoice.lines) {
      const service = byService.get(line.service || line.description) || { service: line.service || line.description, billedCents: 0 };
      service.billedCents += line.amountCents;
      byService.set(service.service, service);
    }
  }
  const engagements = board.payload.engagements.map((engagement) => {
    const hours = db.prepare(
      "SELECT COALESCE(SUM(hours_hundredths), 0) AS hours FROM time_entries WHERE firm_id = ? AND engagement_id = ?",
    ).get(session.firm_id, engagement.id);
    const billed = invoices.filter((invoice) => invoice.engagementId === engagement.id).reduce((sum, invoice) => sum + invoice.billedCents, 0);
    const cost = engagement.costCents == null ? null : Math.round(engagement.costCents * Number(hours.hours) / 100);
    return {
      engagementId: engagement.id,
      name: engagement.name,
      billedCents: billed,
      hoursHundredths: Number(hours.hours),
      costCents: cost,
      profitCents: cost == null ? null : billed - cost,
      note: cost == null
        ? "No cost rate is set, so profit is not calculated. Hours are only the time assigned to this engagement."
        : "Profit is this engagement's approved fees minus its assigned hours times its cost rate.",
    };
  });
  return {
    status: 200,
    payload: {
      byClient: [...byClient.values()],
      byService: [...byService.values()],
      profitability: engagements,
      postsToClientLedger: false,
    },
  };
}

export function openFirmInvoiceCount(db, session) {
  ensureBilling(db);
  const extra = scopeSql(db, session, "firm_invoices.client_id");
  const rows = db.prepare(
    `SELECT id, client_id, status FROM firm_invoices
     WHERE firm_id = ? AND status IN ('approved', 'partial') ${extra.sql}`,
  ).all(session.firm_id, ...extra.params);
  return rows.filter((row) => clientFor(db, session, row.client_id)).length;
}

export function syncFirmInvoices(db, session) {
  if (!session?.firm_id || !session.user_id || session.portal) return;
  ensureBilling(db);
  const today = todayIso();
  const extra = scopeSql(db, session, "firm_invoices.client_id");
  const open = db.prepare(
    `SELECT id, client_id, number, due_on, status FROM firm_invoices
     WHERE firm_id = ? AND status IN ('approved', 'partial') AND due_on < ? ${extra.sql}`,
  ).all(session.firm_id, today, ...extra.params);
  const openIds = new Set();
  for (const invoice of open) {
    if (!clientFor(db, session, invoice.client_id)) continue;
    openIds.add(invoice.id);
    const existing = db.prepare(
      "SELECT id, status FROM work_tasks WHERE firm_id = ? AND source_type = 'firm_invoice' AND source_id = ?",
    ).get(session.firm_id, invoice.id);
    if (existing) {
      if (existing.status === "completed") {
        db.prepare(
          `UPDATE work_tasks SET status = 'open', completed_by_user_id = NULL, completed_at = NULL, updated_at = ?
           WHERE id = ? AND firm_id = ?`,
        ).run(new Date().toISOString(), existing.id, session.firm_id);
      }
      continue;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO work_tasks (
        id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
        source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at,
        stage, recurrence, blocked_by_task_id, schedule_id
      ) VALUES (?, ?, ?, ?, ?, '', 'billing', 'open', 'normal', NULL, ?, 'firm_invoice', ?, NULL, NULL, ?, ?, ?, 'ready', '', NULL, NULL)`,
    ).run(
      id,
      session.firm_id,
      invoice.client_id,
      `Firm invoice ${invoice.number} is past due`,
      `The balance is still open. Due ${invoice.due_on}. This does not post to the client ledger.`,
      invoice.due_on,
      invoice.id,
      session.user_id,
      now,
      now,
    );
  }
  const tasks = db.prepare(
    "SELECT id, source_id, client_id FROM work_tasks WHERE firm_id = ? AND source_type = 'firm_invoice' AND status != 'completed'",
  ).all(session.firm_id);
  for (const task of tasks) {
    if (openIds.has(task.source_id)) continue;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_tasks SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND firm_id = ? AND status != 'completed'`,
    ).run(session.user_id, now, now, task.id, session.firm_id);
  }
}
