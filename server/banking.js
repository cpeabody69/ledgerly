import { randomUUID } from "node:crypto";
import { parseCents } from "../shared/money.js";
import { reconciliationMath } from "../shared/activity.js";
import { postJournalEntry } from "./ledger.js";
import { filesForTransactions } from "./documents.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bank', 'card')),
  ledger_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  statement_date TEXT NOT NULL,
  statement_ending_cents INTEGER NOT NULL,
  beginning_cents INTEGER NOT NULL,
  cleared_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete')),
  completed_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  posted_on TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  status TEXT NOT NULL CHECK (status IN ('for_review', 'categorized', 'excluded')),
  category_account_id TEXT REFERENCES accounts(id),
  note TEXT NOT NULL DEFAULT '',
  journal_entry_id TEXT REFERENCES journal_entries(id),
  cleared_reconciliation_id TEXT REFERENCES reconciliations(id),
  source TEXT NOT NULL CHECK (source IN ('csv', 'manual', 'plaid')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transaction_journals (
  transaction_id TEXT NOT NULL REFERENCES bank_transactions(id),
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (transaction_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_lines (
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  transaction_id TEXT NOT NULL REFERENCES bank_transactions(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (reconciliation_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS bank_transactions_by_client ON bank_transactions (firm_id, client_id, posted_on);
CREATE INDEX IF NOT EXISTS bank_accounts_by_client ON bank_accounts (firm_id, client_id);
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
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number)) throw Object.assign(new Error("That amount is too large."), { status: 400 });
  return number;
}

function centsToAmount(cents) {
  const absolute = Math.abs(cents);
  return `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function formatEntryDate(value) {
  const [year, month, day] = value.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function wrongClient(input, session) {
  return input && Object.prototype.hasOwnProperty.call(input, "clientId") && input.clientId !== session.selected_client_id;
}

function parseSignedCents(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("Enter an amount as text, such as -42.50 or 500.00."), { status: 400 });
  }
  let text = value.trim().replace(/[$,]/g, "");
  if (text.startsWith("(") && text.endsWith(")")) text = `-${text.slice(1, -1).trim()}`;
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  const cents = parseCents(text);
  if (cents === 0) throw Object.assign(new Error("Enter an amount other than zero."), { status: 400 });
  return negative ? -cents : cents;
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function statusLabel(status) {
  if (status === "for_review") return "For review";
  if (status === "categorized") return "Categorized";
  return "Excluded";
}

function audit(db, session, action, { clientId, entityType, entityId }) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityType, entityId, new Date().toISOString());
}

export function ensureBanking(db) {
  db.exec(SCHEMA);
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bank_transactions'").get();
  if (!existing?.sql?.includes("'plaid'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE bank_transactions_next (
          id TEXT PRIMARY KEY,
          firm_id TEXT NOT NULL REFERENCES firms(id),
          client_id TEXT NOT NULL REFERENCES clients(id),
          bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
          posted_on TEXT NOT NULL,
          description TEXT NOT NULL,
          amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
          status TEXT NOT NULL CHECK (status IN ('for_review', 'categorized', 'excluded')),
          category_account_id TEXT REFERENCES accounts(id),
          note TEXT NOT NULL DEFAULT '',
          journal_entry_id TEXT REFERENCES journal_entries(id),
          cleared_reconciliation_id TEXT REFERENCES reconciliations(id),
          source TEXT NOT NULL CHECK (source IN ('csv', 'manual', 'plaid')),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL
        )
      `);
      db.exec("INSERT INTO bank_transactions_next SELECT * FROM bank_transactions");
      db.exec("DROP TABLE bank_transactions");
      db.exec("ALTER TABLE bank_transactions_next RENAME TO bank_transactions");
      db.exec("CREATE INDEX IF NOT EXISTS bank_transactions_by_client ON bank_transactions (firm_id, client_id, posted_on)");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

function accountFor(db, session, bankAccountId) {
  return db.prepare(
    "SELECT * FROM bank_accounts WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(bankAccountId, session.firm_id, session.selected_client_id);
}

function offsetAccount(db, session, bankAccount) {
  return db.prepare(
    "SELECT id, code, name FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, bankAccount.ledger_code);
}

function transactionRows(db, session) {
  return db.prepare(
    `SELECT bank_transactions.*, bank_accounts.name AS account_name, bank_accounts.kind AS account_kind,
            accounts.code AS category_code, accounts.name AS category_name,
            journal_entries.reference AS journal_reference
     FROM bank_transactions
     JOIN bank_accounts ON bank_accounts.id = bank_transactions.bank_account_id
       AND bank_accounts.firm_id = bank_transactions.firm_id
       AND bank_accounts.client_id = bank_transactions.client_id
     LEFT JOIN accounts ON accounts.id = bank_transactions.category_account_id
     LEFT JOIN journal_entries ON journal_entries.id = bank_transactions.journal_entry_id
     WHERE bank_transactions.firm_id = ? AND bank_transactions.client_id = ?
     ORDER BY bank_transactions.posted_on DESC, bank_transactions.created_at DESC`,
  ).all(session.firm_id, session.selected_client_id);
}

function transactionJson(row, attachments = []) {
  const amountCents = asCents(row.amount_cents);
  return {
    id: row.id,
    postedOn: row.posted_on,
    postedOnLabel: formatEntryDate(row.posted_on),
    description: row.description,
    amountCents,
    type: amountCents < 0 ? "expense" : "income",
    status: row.status,
    statusLabel: statusLabel(row.status),
    category: row.category_name ? `${row.category_code} ${row.category_name}` : "",
    categoryAccountId: row.category_account_id,
    accountName: row.account_name,
    accountKind: row.account_kind,
    bankAccountId: row.bank_account_id,
    note: row.note,
    journalEntryId: row.journal_entry_id,
    journalReference: row.journal_reference,
    cleared: Boolean(row.cleared_reconciliation_id),
    source: row.source,
    attachments,
  };
}

function mapTransactions(db, session) {
  const files = filesForTransactions(db, session);
  return transactionRows(db, session).map((row) => transactionJson(row, files.get(row.id) || []));
}

function chartJson(db, session) {
  return db.prepare(
    "SELECT id, code, name, type FROM accounts WHERE firm_id = ? AND client_id = ? ORDER BY position, code",
  ).all(session.firm_id, session.selected_client_id).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
  }));
}

function bankAccountJson(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: row.kind === "card" ? "Card" : "Bank",
    ledgerCode: row.ledger_code,
    connected: false,
  };
}

export function listTransactions(db, session, { clientId, month } = {}) {
  if (clientId && clientId !== session.selected_client_id) return fail(404, "Client not found.");
  let rows = mapTransactions(db, session);
  if (month) {
    const monthNumber = Number(month);
    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return fail(400, "Choose a month from 1 to 12.");
    rows = rows.filter((row) => Number(row.postedOn.slice(5, 7)) === monthNumber);
  }
  return {
    status: 200,
    payload: {
      client: { id: session.selected_client_id },
      bankAccounts: db.prepare(
        "SELECT * FROM bank_accounts WHERE firm_id = ? AND client_id = ? ORDER BY created_at, name",
      ).all(session.firm_id, session.selected_client_id).map(bankAccountJson),
      accounts: chartJson(db, session),
      transactions: rows,
    },
  };
}

export function listBanking(db, session, clientId) {
  if (clientId && clientId !== session.selected_client_id) return fail(404, "Client not found.");
  const accounts = db.prepare(
    "SELECT * FROM bank_accounts WHERE firm_id = ? AND client_id = ? ORDER BY created_at, name",
  ).all(session.firm_id, session.selected_client_id).map(bankAccountJson);
  const reconciliations = db.prepare(
    `SELECT reconciliations.*, bank_accounts.name AS account_name
     FROM reconciliations
     JOIN bank_accounts ON bank_accounts.id = reconciliations.bank_account_id
     WHERE reconciliations.firm_id = ? AND reconciliations.client_id = ?
     ORDER BY reconciliations.statement_date DESC, reconciliations.completed_at DESC`,
  ).all(session.firm_id, session.selected_client_id).map((row) => ({
    id: row.id,
    bankAccountId: row.bank_account_id,
    accountName: row.account_name,
    statementDate: row.statement_date,
    statementDateLabel: formatEntryDate(row.statement_date),
    statementEndingCents: asCents(row.statement_ending_cents),
    beginningCents: asCents(row.beginning_cents),
    clearedCents: asCents(row.cleared_cents),
    status: row.status,
  }));
  return {
    status: 200,
    payload: {
      client: { id: session.selected_client_id },
      accounts,
      lines: mapTransactions(db, session),
      reconciliations,
    },
  };
}

export function createBankAccount(db, session, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const kind = body.kind === "card" ? "card" : body.kind === "bank" ? "bank" : "";
  if (!name || name.length > 80) return fail(400, "Enter an account name.");
  if (!kind) return fail(400, "Choose a bank account or a card.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO bank_accounts (id, firm_id, client_id, name, kind, ledger_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, session.firm_id, session.selected_client_id, name, kind, kind === "card" ? "2100" : "1000", now);
  audit(db, session, "bank_account.created", { clientId: session.selected_client_id, entityType: "bank_account", entityId: id });
  return { status: 201, payload: listBanking(db, session).payload };
}

export function addStatementLine(db, session, { bankAccountId, postedOn, description, amountCents, source }) {
  const account = accountFor(db, session, bankAccountId);
  if (!account) return fail(400, "Choose an account from this client's Banking screen.");
  const date = parseDate(postedOn);
  if (!date) return fail(400, "Enter a date as YYYY-MM-DD.");
  const text = typeof description === "string" ? description.trim() : "";
  if (!text || text.length > 120) return fail(400, "Enter a description.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bank_transactions (
      id, firm_id, client_id, bank_account_id, posted_on, description, amount_cents, status,
      category_account_id, note, journal_entry_id, cleared_reconciliation_id, source, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'for_review', NULL, '', NULL, NULL, ?, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, account.id, date, text, amountCents, source, session.user_id, now);
  return { id };
}

export function createTransaction(db, session, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  let amountCents;
  try {
    amountCents = parseSignedCents(body.amount);
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  const inserted = addStatementLine(db, session, {
    bankAccountId: body.bankAccountId,
    postedOn: body.postedOn,
    description: body.description,
    amountCents,
    source: "manual",
  });
  if (inserted.error) return inserted;
  audit(db, session, "transaction.created", { clientId: session.selected_client_id, entityType: "bank_transaction", entityId: inserted.id });
  const payload = listTransactions(db, session).payload;
  payload.transaction = payload.transactions.find((row) => row.id === inserted.id);
  return { status: 201, payload };
}

export function importTransactions(db, session, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  const account = accountFor(db, session, body.bankAccountId);
  if (!account) return fail(400, "Choose an account from this client's Banking screen.");
  if (typeof body.csv !== "string" || !body.csv.trim()) return fail(400, "Choose a CSV file.");
  const lines = body.csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return fail(400, "The CSV needs a header and at least one row.");
  if (lines.length > 501) return fail(400, "Import 500 rows or fewer.");
  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const dateIndex = header.indexOf("date");
  const descriptionIndex = header.indexOf("description");
  const amountIndex = header.indexOf("amount");
  if (dateIndex < 0 || descriptionIndex < 0 || amountIndex < 0) {
    return fail(400, "The CSV header must include date, description, and amount.");
  }
  const parsed = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    let amountCents;
    try {
      amountCents = parseSignedCents(cells[amountIndex] || "");
    } catch (error) {
      return fail(error.status || 400, `Could not read an amount on “${line.slice(0, 80)}”. ${error.message}`);
    }
    const postedOn = parseDate(cells[dateIndex] || "");
    if (!postedOn) return fail(400, `Enter dates as YYYY-MM-DD. “${cells[dateIndex] || ""}” is not a date.`);
    const description = cells[descriptionIndex] || "";
    if (!description.trim()) return fail(400, "Each row needs a description.");
    parsed.push({ postedOn, description, amountCents });
  }
  const ids = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of parsed) {
      const inserted = addStatementLine(db, session, { bankAccountId: account.id, source: "csv", ...row });
      if (inserted.error) throw Object.assign(new Error(inserted.error), { status: inserted.status });
      ids.push(inserted.id);
    }
    audit(db, session, "transactions.imported", { clientId: session.selected_client_id, entityType: "bank_account", entityId: account.id });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error.status) return fail(error.status, error.message);
    throw error;
  }
  const payload = listTransactions(db, session).payload;
  payload.imported = ids.length;
  return { status: 201, payload };
}

function loadTransaction(db, session, transactionId) {
  return db.prepare(
    `SELECT bank_transactions.*, bank_accounts.ledger_code
     FROM bank_transactions
     JOIN bank_accounts ON bank_accounts.id = bank_transactions.bank_account_id
       AND bank_accounts.firm_id = bank_transactions.firm_id
     WHERE bank_transactions.id = ? AND bank_transactions.firm_id = ? AND bank_transactions.client_id = ?`,
  ).get(transactionId, session.firm_id, session.selected_client_id);
}

function codingLines(offsetAccountId, categoryAccountId, amountCents) {
  const amount = centsToAmount(amountCents);
  if (amountCents > 0) {
    return [
      { accountId: offsetAccountId, debit: amount, credit: "" },
      { accountId: categoryAccountId, debit: "", credit: amount },
    ];
  }
  return [
    { accountId: categoryAccountId, debit: amount, credit: "" },
    { accountId: offsetAccountId, debit: "", credit: amount },
  ];
}

function postCoding(db, session, transaction, categoryAccountId, memo, status, note = "") {
  const offset = db.prepare(
    "SELECT id FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, transaction.ledger_code);
  if (!offset) return fail(400, "This client's chart has no offset account for that bank account.");
  if (categoryAccountId === offset.id) return fail(400, "Choose an account other than the bank account's own ledger account.");
  const category = db.prepare(
    "SELECT id, code, name FROM accounts WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(categoryAccountId, session.firm_id, session.selected_client_id);
  if (!category) return fail(400, "Choose an account from this client's chart.");
  const amountCents = asCents(transaction.amount_cents);
  let lines = codingLines(offset.id, category.id, amountCents);
  if (transaction.journal_entry_id) {
    const previous = db.prepare(
      `SELECT account_id, debit_cents, credit_cents FROM journal_lines
       WHERE entry_id = ? AND firm_id = ? AND client_id = ? ORDER BY position`,
    ).all(transaction.journal_entry_id, session.firm_id, session.selected_client_id);
    const reversal = previous.map((line) => {
      const debit = asCents(line.debit_cents);
      const credit = asCents(line.credit_cents);
      return {
        accountId: line.account_id,
        debit: credit ? centsToAmount(credit) : "",
        credit: debit ? centsToAmount(debit) : "",
      };
    });
    lines = [...reversal, ...lines];
  }
  const posted = postJournalEntry(db, session, {
    entryDate: transaction.posted_on,
    memo: memo.slice(0, 200),
    lines,
  });
  if (posted.error) return posted;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE bank_transactions
     SET category_account_id = ?, journal_entry_id = ?, note = ?, status = ?
     WHERE id = ? AND firm_id = ? AND client_id = ?`,
  ).run(category.id, posted.payload.entry.id, note.slice(0, 200), status, transaction.id, session.firm_id, session.selected_client_id);
  db.prepare(
    "INSERT INTO transaction_journals (transaction_id, journal_entry_id, firm_id, client_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(transaction.id, posted.payload.entry.id, session.firm_id, session.selected_client_id, now);
  return { entry: posted.payload.entry, category };
}

export function categorizeTransaction(db, session, transactionId, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  const transaction = loadTransaction(db, session, transactionId);
  if (!transaction) return fail(404, "Transaction not found.");
  if (transaction.cleared_reconciliation_id) return fail(400, "This statement line is cleared. Its history stays as posted.");
  if (typeof body.accountId !== "string" || !body.accountId) return fail(400, "Choose an account.");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const memo = note ? `${transaction.description}. ${note}` : transaction.description;
  const posted = postCoding(db, session, transaction, body.accountId, memo, "categorized", note);
  if (posted.error) return posted;
  audit(db, session, "transaction.categorized", { clientId: session.selected_client_id, entityType: "bank_transaction", entityId: transaction.id });
  const payload = listTransactions(db, session).payload;
  payload.transaction = payload.transactions.find((row) => row.id === transaction.id);
  payload.entry = posted.entry;
  return { status: 200, payload };
}

export function excludeTransaction(db, session, transactionId, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  const transaction = loadTransaction(db, session, transactionId);
  if (!transaction) return fail(404, "Transaction not found.");
  if (transaction.cleared_reconciliation_id) return fail(400, "This statement line is cleared. Its history stays as posted.");
  const code = asCents(transaction.amount_cents) < 0 ? "3100" : "3000";
  const category = db.prepare(
    "SELECT id FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, code);
  if (!category) return fail(400, "This client's chart has no owner's equity account for an exclusion.");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const memo = note ? `Excluded: ${transaction.description}. ${note}` : `Excluded: ${transaction.description}`;
  const posted = postCoding(db, session, transaction, category.id, memo, "excluded", note);
  if (posted.error) return posted;
  audit(db, session, "transaction.excluded", { clientId: session.selected_client_id, entityType: "bank_transaction", entityId: transaction.id });
  const payload = listTransactions(db, session).payload;
  payload.transaction = payload.transactions.find((row) => row.id === transaction.id);
  payload.entry = posted.entry;
  return { status: 200, payload };
}

export function bulkTransactions(db, session, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 40) return fail(400, "Select at least one transaction.");
  if (body.action !== "categorize" && body.action !== "exclude") return fail(400, "Choose categorize or exclude.");
  const results = [];
  for (const id of body.ids) {
    const result = body.action === "categorize"
      ? categorizeTransaction(db, session, id, { accountId: body.accountId, note: body.note })
      : excludeTransaction(db, session, id, { note: body.note });
    if (result.error) return result;
    results.push(result.payload.entry);
  }
  const payload = listTransactions(db, session).payload;
  payload.entries = results;
  return { status: 200, payload };
}

export function completeReconciliation(db, session, input) {
  const body = input || {};
  if (wrongClient(body, session)) return fail(404, "Client not found.");
  const account = accountFor(db, session, body.bankAccountId);
  if (!account) return fail(404, "Account not found.");
  const statementDate = parseDate(body.statementDate);
  if (!statementDate) return fail(400, "Enter a statement date as YYYY-MM-DD.");
  let statementEndingCents;
  try {
    const endingText = typeof body.statementEnding === "string" ? body.statementEnding.trim() : "";
    statementEndingCents = endingText === "0" || endingText === "0.00" || endingText === "$0.00" ? 0 : parseSignedCents(endingText);
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  if (!Array.isArray(body.transactionIds)) return fail(400, "Choose the statement lines that cleared.");
  const uniqueIds = [...new Set(body.transactionIds)];
  const lines = [];
  for (const id of uniqueIds) {
    const row = db.prepare(
      `SELECT id, amount_cents, description, journal_entry_id, cleared_reconciliation_id, bank_account_id
       FROM bank_transactions WHERE id = ? AND firm_id = ? AND client_id = ?`,
    ).get(id, session.firm_id, session.selected_client_id);
    if (!row || row.bank_account_id !== account.id) return fail(404, "Transaction not found.");
    if (row.cleared_reconciliation_id) return fail(400, "A cleared line stays cleared. Pick only open lines.");
    lines.push(row);
  }
  const prior = db.prepare(
    `SELECT statement_ending_cents FROM reconciliations
     WHERE firm_id = ? AND client_id = ? AND bank_account_id = ? AND status = 'complete'
     ORDER BY statement_date DESC, completed_at DESC LIMIT 1`,
  ).get(session.firm_id, session.selected_client_id, account.id);
  const beginningCents = prior ? asCents(prior.statement_ending_cents) : 0;
  let math;
  try {
    math = reconciliationMath(beginningCents, statementEndingCents, lines.map((line) => asCents(line.amount_cents)));
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  if (math.differenceCents !== 0) {
    return {
      status: 400,
      error: "The difference is not zero, so this reconciliation is not complete.",
      payload: { ...math, beginningCents, statementEndingCents, complete: false },
    };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const before = lines.map((line) => ({ ...line }));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO reconciliations (
        id, firm_id, client_id, bank_account_id, statement_date, statement_ending_cents, beginning_cents,
        cleared_cents, status, completed_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)`,
    ).run(id, session.firm_id, session.selected_client_id, account.id, statementDate, statementEndingCents, beginningCents, math.clearedCents, now, session.user_id, now);
    const insertLine = db.prepare(
      "INSERT INTO reconciliation_lines (reconciliation_id, transaction_id, firm_id, client_id, amount_cents) VALUES (?, ?, ?, ?, ?)",
    );
    const mark = db.prepare(
      "UPDATE bank_transactions SET cleared_reconciliation_id = ? WHERE id = ? AND firm_id = ? AND client_id = ?",
    );
    for (const line of lines) {
      insertLine.run(id, line.id, session.firm_id, session.selected_client_id, asCents(line.amount_cents));
      mark.run(id, line.id, session.firm_id, session.selected_client_id);
    }
    for (const line of before) {
      const after = db.prepare(
        "SELECT description, amount_cents, journal_entry_id FROM bank_transactions WHERE id = ? AND firm_id = ? AND client_id = ?",
      ).get(line.id, session.firm_id, session.selected_client_id);
      if (after.description !== line.description || asCents(after.amount_cents) !== asCents(line.amount_cents) || after.journal_entry_id !== line.journal_entry_id) {
        throw Object.assign(new Error("Reconciliation must not change statement history."), { status: 500 });
      }
    }
    audit(db, session, "reconciliation.completed", { clientId: session.selected_client_id, entityType: "reconciliation", entityId: id });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error.status) return fail(error.status, error.message);
    throw error;
  }
  const payload = listBanking(db, session).payload;
  payload.reconciliation = payload.reconciliations.find((row) => row.id === id);
  return { status: 201, payload };
}
