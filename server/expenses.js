import { randomUUID } from "node:crypto";
import { formatMoney, parseCents } from "../shared/money.js";
import { postJournalEntry } from "./ledger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  vendor TEXT NOT NULL,
  spent_on TEXT NOT NULL,
  due_on TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  account_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bill', 'paid')),
  document_id TEXT,
  journal_entry_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS expenses_by_client ON expenses (firm_id, client_id, spent_on);
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
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, session.selected_client_id, entityId, new Date().toISOString());
}

export function ensureExpenses(db) {
  const columns = db.prepare("PRAGMA table_info(firms)").all();
  if (!columns.some((column) => column.name === "require_receipt")) {
    db.exec("ALTER TABLE firms ADD COLUMN require_receipt INTEGER NOT NULL DEFAULT 0");
  }
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

function centsText(cents) {
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

function sameClient(session, body) {
  if (body && Object.prototype.hasOwnProperty.call(body, "clientId") && body.clientId !== session.selected_client_id) {
    return fail(404, "Client not found.");
  }
  return null;
}

function receiptRequired(db, session) {
  const firm = db.prepare("SELECT require_receipt FROM firms WHERE id = ?").get(session.firm_id);
  return firm?.require_receipt === 1;
}

function expenseJson(row) {
  const amountCents = asCents(row.amount_cents);
  return {
    id: row.id,
    vendor: row.vendor,
    spentOn: row.spent_on,
    spentOnLabel: formatDate(row.spent_on),
    dueOn: row.due_on,
    dueOnLabel: row.due_on ? formatDate(row.due_on) : "",
    amount: formatMoney(amountCents),
    amountCents,
    accountCode: row.account_code,
    accountName: row.account_name,
    kind: row.kind,
    kindLabel: row.kind === "bill" ? "Bill" : "Paid",
    documentId: row.document_id,
    receiptName: row.receipt_name || "",
    journalEntryId: row.journal_entry_id,
    reference: row.reference,
  };
}

function loadExpenses(db, session) {
  return db.prepare(
    `SELECT expenses.*, accounts.name AS account_name, client_files.name AS receipt_name, journal_entries.reference
     FROM expenses
     JOIN accounts ON accounts.firm_id = expenses.firm_id
       AND accounts.client_id = expenses.client_id
       AND accounts.code = expenses.account_code
     JOIN journal_entries ON journal_entries.id = expenses.journal_entry_id
       AND journal_entries.firm_id = expenses.firm_id
       AND journal_entries.client_id = expenses.client_id
     LEFT JOIN client_files ON client_files.id = expenses.document_id
       AND client_files.firm_id = expenses.firm_id
       AND client_files.client_id = expenses.client_id
     WHERE expenses.firm_id = ? AND expenses.client_id = ?
     ORDER BY expenses.spent_on DESC, expenses.created_at DESC`,
  ).all(session.firm_id, session.selected_client_id);
}

export function listExpenses(db, session) {
  ensureExpenses(db);
  const rows = loadExpenses(db, session);
  const accounts = db.prepare(
    "SELECT code, name FROM accounts WHERE firm_id = ? AND client_id = ? AND type = 'expense' ORDER BY code",
  ).all(session.firm_id, session.selected_client_id);
  const expenses = rows.map(expenseJson);
  const billCents = expenses.filter((expense) => expense.kind === "bill").reduce((sum, expense) => sum + expense.amountCents, 0);
  const paidCents = expenses.filter((expense) => expense.kind === "paid").reduce((sum, expense) => sum + expense.amountCents, 0);
  return {
    status: 200,
    payload: {
      client: { id: session.selected_client_id },
      requireReceipt: receiptRequired(db, session),
      accounts: accounts.map((account) => ({ code: account.code, name: account.name })),
      expenses,
      totals: {
        billCents,
        paidCents,
        bills: formatMoney(billCents),
        paid: formatMoney(paidCents),
        count: expenses.length,
      },
    },
  };
}

export function createExpense(db, session, input) {
  ensureExpenses(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const vendor = String(body.vendor || "").trim();
  if (!vendor || vendor.length > 120) return fail(400, "Enter a vendor.");
  const spentOn = parseDate(body.spentOn);
  if (!spentOn) return fail(400, "Enter the date.");
  const kind = body.kind === "paid" ? "paid" : body.kind === "bill" ? "bill" : "";
  if (!kind) return fail(400, "Choose a bill or a paid expense.");
  const dueOn = kind === "bill" ? parseDate(body.dueOn) : null;
  if (kind === "bill" && !dueOn) return fail(400, "Enter the due date.");
  if (dueOn && dueOn < spentOn) return fail(400, "The due date cannot be before the bill date.");
  let amount = 0;
  try {
    amount = parseCents(body.amount);
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  if (amount <= 0) return fail(400, "Enter an amount.");
  const accountCode = String(body.accountCode || "").trim();
  const account = db.prepare(
    "SELECT id, code, name, type FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, accountCode);
  if (!account || account.type !== "expense") return fail(400, "Choose an expense account.");
  const offsetCode = kind === "bill" ? "2000" : "1000";
  const offset = db.prepare(
    "SELECT id FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, offsetCode);
  if (!offset) return fail(400, kind === "bill" ? "This client's chart is missing accounts payable." : "This client's chart is missing cash.");
  const documentId = body.documentId ? String(body.documentId) : "";
  if (receiptRequired(db, session) && !documentId) {
    return fail(400, "Attach a receipt before posting this expense.");
  }
  let receiptName = "";
  if (documentId) {
    const file = db.prepare(
      "SELECT id, name FROM client_files WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).get(documentId, session.firm_id, session.selected_client_id);
    if (!file) return fail(404, "Receipt not found.");
    receiptName = file.name;
  }
  const posted = postJournalEntry(db, session, {
    entryDate: spentOn,
    memo: vendor,
    lines: [
      { accountId: account.id, debit: centsText(amount), credit: "" },
      { accountId: offset.id, debit: "", credit: centsText(amount) },
    ],
  });
  if (posted.error) return posted;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO expenses (
        id, firm_id, client_id, vendor, spent_on, due_on, amount_cents, account_code, kind, document_id, journal_entry_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      session.firm_id,
      session.selected_client_id,
      vendor,
      spentOn,
      dueOn,
      amount,
      account.code,
      kind,
      documentId || null,
      posted.payload.entry.id,
      session.user_id,
      now,
    );
    audit(db, session, "expense.posted", id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const stored = loadExpenses(db, session).find((row) => row.id === id);
  return {
    status: 201,
    payload: {
      expense: expenseJson(stored),
      entry: posted.payload.entry,
      receiptName,
    },
  };
}

export function updateReceiptSetting(db, session, input) {
  ensureExpenses(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!user || user.role !== "owner") return fail(403, "Only an owner can change this setting.");
  if (typeof input?.requireReceipt !== "boolean") return fail(400, "Choose whether a receipt is required.");
  db.prepare("UPDATE firms SET require_receipt = ? WHERE id = ?").run(input.requireReceipt ? 1 : 0, session.firm_id);
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, 'firm.receipt_setting', NULL, 'firm', ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, session.firm_id, new Date().toISOString());
  const firm = db.prepare("SELECT id, name, require_receipt, demo FROM firms WHERE id = ?").get(session.firm_id);
  return {
    status: 200,
    payload: {
      firm: {
        id: firm.id,
        name: firm.name,
        requireReceipt: firm.require_receipt === 1,
        demo: Number(firm.demo) === 1,
      },
    },
  };
}
