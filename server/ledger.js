import { randomUUID } from "node:crypto";
import { CHART, CHART_TEMPLATE, CASH_RULE, TEMPLATE_NOTE } from "./chart.js";
import { addCents, formatMoney, parseCents } from "../shared/money.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const TYPE_LABEL = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  expense: "Expense",
};

const MARK = {
  asset: "blue",
  liability: "amber",
  equity: "purple",
  income: "green",
  expense: "coral",
};

const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS client_books (
  client_id TEXT PRIMARY KEY REFERENCES clients(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  accounting_basis TEXT NOT NULL CHECK (accounting_basis IN ('accrual', 'cash')),
  fiscal_year_start_month INTEGER NOT NULL CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  chart_template TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  detail_type TEXT NOT NULL,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  cash INTEGER NOT NULL CHECK (cash IN (0, 1)),
  template TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL,
  reference TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, reference)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  debit_cents INTEGER NOT NULL CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL CHECK (credit_cents >= 0),
  position INTEGER NOT NULL,
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE INDEX IF NOT EXISTS journal_entries_by_client ON journal_entries (firm_id, client_id, entry_date);
CREATE INDEX IF NOT EXISTS journal_lines_by_client ON journal_lines (firm_id, client_id, account_id);

CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ROLLBACK, 'Posted journal entries cannot be changed.');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ROLLBACK, 'Posted journal entries cannot be deleted.');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_update
BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ROLLBACK, 'Posted journal lines cannot be changed.');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete
BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ROLLBACK, 'Posted journal lines cannot be deleted.');
END;
`;

function asCents(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw Object.assign(new Error("That amount is too large."), { status: 400 });
    }
    return Number(value);
  }
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number)) throw Object.assign(new Error("That amount is too large."), { status: 400 });
  return number;
}

function moneyOrDash(cents) {
  return cents ? formatMoney(cents) : "—";
}

function formatEntryDate(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return value;
  return `${name} ${Number(day)}, ${year}`;
}

function parseEntryDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function fail(status, error) {
  return { status, error };
}

function booksPolicy(db, firmId) {
  let firm = null;
  try {
    firm = db.prepare("SELECT accounting_method, fiscal_year_start FROM firms WHERE id = ?").get(firmId);
  } catch {
    firm = null;
  }
  const basis = firm?.accounting_method === "cash" || firm?.accounting_method === "accrual" ? firm.accounting_method : "accrual";
  const month = Number(firm?.fiscal_year_start);
  return { basis, month: month >= 1 && month <= 12 ? month : 1 };
}

export function ensureCharts(db) {
  db.exec(LEDGER_SCHEMA);
  const clients = db.prepare("SELECT id, firm_id FROM clients").all();
  const existing = new Set(db.prepare("SELECT client_id FROM client_books").all().map((row) => row.client_id));
  const now = new Date().toISOString();
  const insertBooks = db.prepare(
    "INSERT INTO client_books (client_id, firm_id, accounting_basis, fiscal_year_start_month, chart_template, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertAccount = db.prepare(
    `INSERT INTO accounts (
      id, firm_id, client_id, code, name, type, detail_type, normal_balance, cash, template, position, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const client of clients) {
    if (existing.has(client.id)) continue;
    db.exec("BEGIN");
    try {
      const policy = booksPolicy(db, client.firm_id);
      insertBooks.run(client.id, client.firm_id, policy.basis, policy.month, CHART_TEMPLATE, now);
      CHART.forEach((account, position) => {
        insertAccount.run(
          randomUUID(),
          client.firm_id,
          client.id,
          account.code,
          account.name,
          account.type,
          account.detailType,
          account.normalBalance,
          account.cash,
          CHART_TEMPLATE,
          position,
          now,
        );
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function entryJson(header, lines) {
  let debitCents = 0;
  let creditCents = 0;
  const jsonLines = lines.map((line) => {
    const debit = asCents(line.debit_cents);
    const credit = asCents(line.credit_cents);
    debitCents = addCents(debitCents, debit);
    creditCents = addCents(creditCents, credit);
    return {
      id: line.id,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      debit: moneyOrDash(debit),
      credit: moneyOrDash(credit),
      debitCents: debit,
      creditCents: credit,
      position: line.position,
    };
  });
  return {
    id: header.id,
    reference: header.reference,
    entryDate: header.entry_date,
    entryDateLabel: formatEntryDate(header.entry_date),
    memo: header.memo,
    postedAt: header.posted_at,
    postedBy: header.posted_by,
    debitTotal: formatMoney(debitCents),
    creditTotal: formatMoney(creditCents),
    debitCents,
    creditCents,
    lines: jsonLines,
  };
}

export function ledgerSnapshot(db, session) {
  const client = db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  if (!client) {
    const error = new Error("Client not found.");
    error.status = 404;
    throw error;
  }
  const books = db.prepare("SELECT * FROM client_books WHERE client_id = ? AND firm_id = ?").get(client.id, session.firm_id);
  const accounts = db.prepare(
    "SELECT * FROM accounts WHERE firm_id = ? AND client_id = ? ORDER BY position, code",
  ).all(session.firm_id, client.id);
  const lines = db.prepare(
    `SELECT journal_lines.id, journal_lines.entry_id, journal_lines.account_id, journal_lines.debit_cents,
            journal_lines.credit_cents, journal_lines.position,
            journal_entries.entry_date, journal_entries.memo, journal_entries.reference, journal_entries.posted_at,
            journal_entries.created_by, users.name AS posted_by,
            accounts.code AS account_code, accounts.name AS account_name, accounts.normal_balance, accounts.position AS account_position
     FROM journal_lines
     JOIN journal_entries ON journal_entries.id = journal_lines.entry_id
       AND journal_entries.firm_id = journal_lines.firm_id
       AND journal_entries.client_id = journal_lines.client_id
     JOIN accounts ON accounts.id = journal_lines.account_id
       AND accounts.firm_id = journal_lines.firm_id
       AND accounts.client_id = journal_lines.client_id
     JOIN users ON users.id = journal_entries.created_by AND users.firm_id = journal_entries.firm_id
     WHERE journal_lines.firm_id = ? AND journal_lines.client_id = ?
     ORDER BY accounts.position, journal_entries.entry_date, journal_entries.reference, journal_lines.position`,
  ).all(session.firm_id, client.id);

  const totals = new Map(accounts.map((account) => [account.id, { debit: 0, credit: 0, last: null }]));
  const running = new Map();
  const activity = [];
  const entryMap = new Map();

  for (const line of lines) {
    const debit = asCents(line.debit_cents);
    const credit = asCents(line.credit_cents);
    const bucket = totals.get(line.account_id);
    bucket.debit = addCents(bucket.debit, debit);
    bucket.credit = addCents(bucket.credit, credit);
    if (!bucket.last || line.entry_date > bucket.last) bucket.last = line.entry_date;
    const delta = line.normal_balance === "debit" ? debit - credit : credit - debit;
    const next = addCents(running.get(line.account_id) || 0, delta);
    running.set(line.account_id, next);
    activity.push({
      id: line.id,
      entryId: line.entry_id,
      reference: line.reference,
      entryDate: line.entry_date,
      entryDateLabel: formatEntryDate(line.entry_date),
      memo: line.memo,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      debit: moneyOrDash(debit),
      credit: moneyOrDash(credit),
      debitCents: debit,
      creditCents: credit,
      balance: formatMoney(next),
      balanceCents: next,
      postedAt: line.posted_at,
      postedBy: line.posted_by,
    });

    let entry = entryMap.get(line.entry_id);
    if (!entry) {
      entry = {
        id: line.entry_id,
        entry_date: line.entry_date,
        memo: line.memo,
        reference: line.reference,
        posted_at: line.posted_at,
        posted_by: line.posted_by,
        lines: [],
      };
      entryMap.set(line.entry_id, entry);
    }
    entry.lines.push({
      id: line.id,
      account_id: line.account_id,
      account_code: line.account_code,
      account_name: line.account_name,
      debit_cents: debit,
      credit_cents: credit,
      position: line.position,
    });
  }

  let assetsCents = 0;
  let liabilitiesCents = 0;
  let equityCents = 0;
  let debitsCents = 0;
  let creditsCents = 0;
  const accountJson = [];
  const trialRows = [];

  for (const account of accounts) {
    const bucket = totals.get(account.id);
    const signed = account.normal_balance === "debit" ? bucket.debit - bucket.credit : bucket.credit - bucket.debit;
    if (account.type === "asset") assetsCents = addCents(assetsCents, bucket.debit - bucket.credit);
    else if (account.type === "liability") liabilitiesCents = addCents(liabilitiesCents, bucket.credit - bucket.debit);
    else equityCents = addCents(equityCents, bucket.credit - bucket.debit);

    let netDebit = 0;
    let netCredit = 0;
    if (bucket.debit > bucket.credit) netDebit = bucket.debit - bucket.credit;
    else if (bucket.credit > bucket.debit) netCredit = bucket.credit - bucket.debit;
    debitsCents = addCents(debitsCents, netDebit);
    creditsCents = addCents(creditsCents, netCredit);

    accountJson.push({
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      typeLabel: TYPE_LABEL[account.type],
      detailType: account.detail_type,
      normalBalance: account.normal_balance,
      cash: account.cash === 1,
      balance: formatMoney(signed),
      balanceCents: signed,
      debitCents: bucket.debit,
      creditCents: bucket.credit,
      lastActivity: formatEntryDate(bucket.last),
      lastActivityDate: bucket.last,
      mark: MARK[account.type],
    });
    trialRows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      typeLabel: TYPE_LABEL[account.type],
      debit: moneyOrDash(netDebit),
      credit: moneyOrDash(netCredit),
      debitCents: netDebit,
      creditCents: netCredit,
    });
  }

  const entries = [...entryMap.values()]
    .map((entry) => {
      entry.lines.sort((left, right) => left.position - right.position);
      return entryJson(entry, entry.lines);
    })
    .sort((left, right) => {
      if (left.entryDate !== right.entryDate) return left.entryDate < right.entryDate ? 1 : -1;
      return left.reference < right.reference ? 1 : -1;
    });

  const quiet = entries.length === 0;
  const foots = assetsCents === addCents(liabilitiesCents, equityCents) && debitsCents === creditsCents;
  const month = books ? MONTHS[(books.fiscal_year_start_month || 1) - 1] : "January";

  return {
    client: { id: client.id, name: client.name },
    policy: {
      basis: books?.accounting_basis || "accrual",
      fiscalYearStartMonth: books?.fiscal_year_start_month || 1,
      fiscalYearStart: month,
      template: books?.chart_template || CHART_TEMPLATE,
      templateNote: TEMPLATE_NOTE,
      cashRule: CASH_RULE,
    },
    accounts: accountJson,
    cards: {
      assets: formatMoney(assetsCents),
      liabilities: formatMoney(liabilitiesCents),
      equity: formatMoney(equityCents),
      assetsCents,
      liabilitiesCents,
      equityCents,
      assetsNote: quiet ? "No journal entries yet" : "From the trial balance",
      liabilitiesNote: quiet ? "No journal entries yet" : "From the trial balance",
      equityNote: quiet ? "No journal entries yet" : "Includes income and expenses",
    },
    trialBalance: {
      rows: trialRows,
      debitTotal: formatMoney(debitsCents),
      creditTotal: formatMoney(creditsCents),
      debitsCents,
      creditsCents,
      foots,
    },
    entries,
    activity,
    foots,
  };
}

export function readLedger(db, session, requestedClientId) {
  if (requestedClientId && requestedClientId !== session.selected_client_id) return fail(404, "Client not found.");
  try {
    return { status: 200, payload: ledgerSnapshot(db, session) };
  } catch (error) {
    if (error.status) return fail(error.status, error.message);
    throw error;
  }
}

export function getJournalEntry(db, session, entryId) {
  const header = db.prepare(
    `SELECT journal_entries.id, journal_entries.entry_date, journal_entries.memo, journal_entries.reference,
            journal_entries.posted_at, users.name AS posted_by
     FROM journal_entries
     JOIN users ON users.id = journal_entries.created_by AND users.firm_id = journal_entries.firm_id
     WHERE journal_entries.id = ? AND journal_entries.firm_id = ? AND journal_entries.client_id = ?`,
  ).get(entryId, session.firm_id, session.selected_client_id);
  if (!header) return fail(404, "Journal entry not found.");
  const lines = db.prepare(
    `SELECT journal_lines.id, journal_lines.account_id, journal_lines.debit_cents, journal_lines.credit_cents,
            journal_lines.position, accounts.code AS account_code, accounts.name AS account_name
     FROM journal_lines
     JOIN accounts ON accounts.id = journal_lines.account_id
     WHERE journal_lines.entry_id = ? AND journal_lines.firm_id = ? AND journal_lines.client_id = ?
     ORDER BY journal_lines.position`,
  ).all(header.id, session.firm_id, session.selected_client_id);
  return { status: 200, entry: entryJson(header, lines) };
}

export function postJournalEntry(db, session, input) {
  const body = input || {};
  if (Object.prototype.hasOwnProperty.call(body, "clientId") && body.clientId !== session.selected_client_id) {
    return fail(404, "Client not found.");
  }
  const entryDate = parseEntryDate(body.entryDate);
  if (!entryDate) return fail(400, "Enter a date as YYYY-MM-DD.");
  const memo = typeof body.memo === "string" ? body.memo.trim() : "";
  if (!memo) return fail(400, "Enter a memo.");
  if (memo.length > 200) return fail(400, "Keep the memo to 200 characters.");
  if (!Array.isArray(body.lines) || body.lines.length < 2 || body.lines.length > 40) {
    return fail(400, "A journal entry needs between 2 and 40 lines.");
  }

  let debitTotal = 0;
  let creditTotal = 0;
  const parsed = [];
  for (const line of body.lines) {
    if (!line || typeof line !== "object" || Array.isArray(line)) return fail(400, "Each line needs an account and an amount.");
    let debit = 0;
    let credit = 0;
    try {
      debit = parseCents(line.debit, { blank: true });
      credit = parseCents(line.credit, { blank: true });
      debitTotal = addCents(debitTotal, debit);
      creditTotal = addCents(creditTotal, credit);
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    if ((debit > 0) === (credit > 0)) {
      return fail(400, "Each line needs an amount on either the debit or the credit side.");
    }
    if (typeof line.accountId !== "string" || !line.accountId) return fail(400, "Choose an account for each line.");
    parsed.push({ accountId: line.accountId, debit, credit });
  }
  if (debitTotal !== creditTotal || debitTotal === 0) return fail(400, "Debits and credits must be equal.");

  const allowed = new Set(
    db.prepare("SELECT id FROM accounts WHERE firm_id = ? AND client_id = ?").all(session.firm_id, session.selected_client_id).map((row) => row.id),
  );
  for (const line of parsed) {
    if (!allowed.has(line.accountId)) return fail(400, "Choose an account from this client's chart.");
  }

  const now = new Date().toISOString();
  const entryId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM journal_entries WHERE firm_id = ? AND client_id = ?",
    ).get(session.firm_id, session.selected_client_id).count;
    const reference = `JE-${String(asCents(count) + 1).padStart(5, "0")}`;
    db.prepare(
      `INSERT INTO journal_entries (
        id, firm_id, client_id, created_by, entry_date, memo, reference, posted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(entryId, session.firm_id, session.selected_client_id, session.user_id, entryDate, memo, reference, now, now);
    const insertLine = db.prepare(
      `INSERT INTO journal_lines (
        id, firm_id, client_id, entry_id, account_id, debit_cents, credit_cents, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    parsed.forEach((line, position) => {
      insertLine.run(randomUUID(), session.firm_id, session.selected_client_id, entryId, line.accountId, line.debit, line.credit, position);
    });
    const sums = db.prepare(
      `SELECT COALESCE(SUM(debit_cents), 0) AS debit_cents, COALESCE(SUM(credit_cents), 0) AS credit_cents
       FROM journal_lines WHERE entry_id = ? AND firm_id = ? AND client_id = ?`,
    ).get(entryId, session.firm_id, session.selected_client_id);
    if (asCents(sums.debit_cents) !== asCents(sums.credit_cents) || asCents(sums.debit_cents) !== debitTotal) {
      throw Object.assign(new Error("Debits and credits must be equal."), { status: 400 });
    }
    db.prepare(
      "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, 'journal.posted', ?, 'journal_entry', ?, ?)",
    ).run(randomUUID(), session.firm_id, session.user_id, session.selected_client_id, entryId, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error.status) return fail(error.status, error.message);
    throw error;
  }

  return {
    status: 201,
    payload: {
      entry: getJournalEntry(db, session, entryId).entry,
      ledger: ledgerSnapshot(db, session),
    },
  };
}
