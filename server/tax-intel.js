// Books-to-tax planning for a sole proprietor. Estimates are not returns.
import { randomUUID } from "node:crypto";
import { lookupClient, scopeSql } from "./access.js";
import { depreciationScenario, planSoleProp, projectAnnual, retirementScenario, splitQuarters } from "./tax-calc.js";
import { RULES_VERSION, RULES_YEAR } from "./tax-rules.js";
import { canApproveBills } from "./permissions.js";
import { authorityFor } from "./quickbooks/mirror.js";
import { parseCents } from "../shared/money.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tax_profiles (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_year INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  filing_status TEXT NOT NULL,
  other_wages_cents INTEGER,
  social_security_wages_cents INTEGER,
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_profiles_year ON tax_profiles (firm_id, client_id, tax_year);
CREATE TABLE IF NOT EXISTS tax_account_maps (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_year INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  line_key TEXT NOT NULL,
  deductible_bps INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_account_maps_account ON tax_account_maps (firm_id, client_id, tax_year, account_id);
CREATE TABLE IF NOT EXISTS tax_external_maps (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  line_key TEXT NOT NULL,
  deductible_bps INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (firm_id, client_id, tax_year, source_key)
);
CREATE TABLE IF NOT EXISTS tax_adjustments (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_year INTEGER NOT NULL,
  label TEXT NOT NULL,
  book_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tax_payments (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_year INTEGER NOT NULL,
  quarter INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_on TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tax_reviews (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_year INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_reviews_year ON tax_reviews (firm_id, client_id, tax_year);
CREATE TABLE IF NOT EXISTS tax_flag_reviews (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_year INTEGER NOT NULL,
  transaction_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_by TEXT NOT NULL REFERENCES users(id),
  reviewed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_flag_reviews_line ON tax_flag_reviews (firm_id, client_id, tax_year, transaction_id);
`;

const LINES = {
  gross_receipts: ["Gross receipts", "income"],
  returns: ["Returns and allowances", "income"],
  other_income: ["Other income", "income"],
  cogs: ["Cost of goods sold", "expense"],
  advertising: ["Advertising", "expense"],
  car: ["Car and truck", "expense"],
  commissions: ["Commissions", "expense"],
  contract_labor: ["Contract labor", "expense"],
  depreciation: ["Depreciation", "expense"],
  employee_benefit: ["Employee benefit programs", "expense"],
  insurance: ["Insurance", "expense"],
  interest: ["Interest", "expense"],
  legal: ["Legal and professional", "expense"],
  office: ["Office expense", "expense"],
  pension: ["Pension and profit-sharing", "expense"],
  rent: ["Rent", "expense"],
  repairs: ["Repairs", "expense"],
  supplies: ["Supplies", "expense"],
  taxes_licenses: ["Taxes and licenses", "expense"],
  travel: ["Travel", "expense"],
  meals: ["Meals", "expense"],
  utilities: ["Utilities", "expense"],
  wages: ["Wages", "expense"],
  other: ["Other expenses", "expense"],
  nondeductible: ["Nondeductible", "excluded"],
  owner_draw: ["Owner draw", "excluded"],
  balance_sheet: ["Balance sheet", "excluded"],
};

const BY_CODE = {
  4000: ["gross_receipts", 10000],
  4100: ["other_income", 10000],
  5000: ["cogs", 10000],
  6000: ["wages", 10000],
  6100: ["rent", 10000],
  6200: ["other", 10000],
  6300: ["advertising", 10000],
  6400: ["office", 10000],
  6500: ["legal", 10000],
  6600: ["insurance", 10000],
  6700: ["utilities", 10000],
  6800: ["depreciation", 10000],
  6900: ["other", 10000],
  3100: ["owner_draw", 0],
};

const ENTITIES = ["unknown", "sole_proprietor", "corporation", "partnership"];
const FILING = ["unset", "single", "married_joint", "married_separate", "head"];
const NONDEDUCTIBLE = /\b(penalty|penalties|fine|fines|political|entertainment|commute|commuting)\b/i;
const MEALS = /\b(meal|meals|restaurant|dining)\b/i;

function fail(status, error) {
  return { status, error };
}

export function ensureTaxIntel(db) {
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

function dayOfYear(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

function daysInYear(year) {
  return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
}

function monthEnd(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

function parseYear(value) {
  const year = Number(value || RULES_YEAR);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return year;
}

function actor(db, session) {
  if (!session?.user_id || !session.firm_id || session.portal) return null;
  return db.prepare("SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function clientFor(db, session, clientId) {
  const row = lookupClient(db, session, clientId);
  if (!row) return null;
  return db.prepare("SELECT id, name, status FROM clients WHERE id = ? AND firm_id = ?").get(row.id, session.firm_id);
}

function visibleClients(db, session) {
  const extra = scopeSql(db, session, "clients.id");
  return db.prepare(
    `SELECT id, name, status FROM clients
     WHERE firm_id = ? AND status != 'archived' ${extra.sql}
     ORDER BY position, name`,
  ).all(session.firm_id, ...extra.params);
}

function auditTax(db, session, action, clientId, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at, detail
    ) VALUES (?, ?, ?, ?, ?, 'tax_plan', ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityId, new Date().toISOString(), String(detail || "").slice(0, 500));
}

function defaultMap(account) {
  const known = BY_CODE[account.code];
  if (known) return { lineKey: known[0], deductibleBps: known[1], needsReview: false, source: "suggested" };
  if (account.type === "income") return { lineKey: "other_income", deductibleBps: 10000, needsReview: true, source: "suggested" };
  if (account.type === "expense") return { lineKey: "other", deductibleBps: 10000, needsReview: true, source: "suggested" };
  return { lineKey: "balance_sheet", deductibleBps: 0, needsReview: false, source: "suggested" };
}

function storedMaps(db, session, clientId, year) {
  const rows = db.prepare(
    "SELECT account_id, line_key, deductible_bps, reason, updated_at FROM tax_account_maps WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).all(session.firm_id, clientId, year);
  return new Map(rows.map((row) => [row.account_id, row]));
}

function activity(db, session, clientId, start, end) {
  return db.prepare(
    `SELECT accounts.id, accounts.code, accounts.name, accounts.type,
            COALESCE(SUM(CASE WHEN journal_entries.id IS NOT NULL THEN journal_lines.debit_cents ELSE 0 END), 0) AS debit_cents,
            COALESCE(SUM(CASE WHEN journal_entries.id IS NOT NULL THEN journal_lines.credit_cents ELSE 0 END), 0) AS credit_cents
     FROM accounts
     LEFT JOIN journal_lines ON journal_lines.account_id = accounts.id
       AND journal_lines.firm_id = accounts.firm_id
       AND journal_lines.client_id = accounts.client_id
     LEFT JOIN journal_entries ON journal_entries.id = journal_lines.entry_id
       AND journal_entries.firm_id = journal_lines.firm_id
       AND journal_entries.entry_date >= ? AND journal_entries.entry_date <= ?
     WHERE accounts.firm_id = ? AND accounts.client_id = ?
     GROUP BY accounts.id
     ORDER BY accounts.code`,
  ).all(start, end, session.firm_id, clientId);
}

function signedBook(row) {
  const debit = Number(row.debit_cents);
  const credit = Number(row.credit_cents);
  if (row.type === "income") return credit - debit;
  if (row.type === "expense") return debit - credit;
  return 0;
}

function externalMaps(db, session, clientId, year) {
  const rows = db.prepare(
    "SELECT source_key, line_key, deductible_bps, reason FROM tax_external_maps WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).all(session.firm_id, clientId, year);
  return new Map(rows.map((row) => [row.source_key, row]));
}

function finishBooks(db, session, client, year, bookIncome, bookExpense, taxIncome, taxDeduction, mappings, extra = {}) {
  const adjustments = db.prepare(
    "SELECT id, label, book_cents, tax_cents, reason, status FROM tax_adjustments WHERE firm_id = ? AND client_id = ? AND tax_year = ? ORDER BY created_at",
  ).all(session.firm_id, client.id, year);
  const accepted = adjustments.filter((row) => row.status === "accepted").reduce((sum, row) => sum + (Number(row.book_cents) - Number(row.tax_cents)), 0);
  return {
    bookIncome,
    bookExpense,
    bookNet: bookIncome - bookExpense,
    taxIncome,
    taxDeduction,
    taxProfit: taxIncome - taxDeduction + accepted,
    mappings,
    adjustments: adjustments.map((row) => ({
      id: row.id,
      label: row.label,
      bookCents: Number(row.book_cents),
      taxCents: Number(row.tax_cents),
      reason: row.reason,
      status: row.status,
    })),
    ...extra,
  };
}

function taxFromLine(lineKey, book, bps) {
  const kind = LINES[lineKey]?.[1] || "excluded";
  if (kind === "income") return lineKey === "returns" ? -Math.round((book * bps) / 10000) : Math.round((book * bps) / 10000);
  if (kind === "expense") return Math.round((book * bps) / 10000);
  return 0;
}

function classifyLedger(db, session, client, year, start, end) {
  const overrides = storedMaps(db, session, client.id, year);
  const rows = activity(db, session, client.id, start, end);
  let bookIncome = 0;
  let bookExpense = 0;
  let taxIncome = 0;
  let taxDeduction = 0;
  const mappings = [];
  for (const row of rows) {
    const book = signedBook(row);
    const movement = Number(row.debit_cents) - Number(row.credit_cents);
    if (row.type === "income") bookIncome += book;
    if (row.type === "expense") bookExpense += book;
    const stored = overrides.get(row.id);
    const base = defaultMap(row);
    const lineKey = stored?.line_key || base.lineKey;
    const bps = stored ? Number(stored.deductible_bps) : base.deductibleBps;
    const tax = taxFromLine(lineKey, book, bps);
    if (row.type === "income") taxIncome += tax;
    if (row.type === "expense") taxDeduction += tax;
    if (book !== 0 || stored || (row.code === "3100" && movement !== 0)) {
      mappings.push({
        accountId: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        lineKey,
        lineLabel: LINES[lineKey]?.[0] || lineKey,
        bookCents: row.type === "income" || row.type === "expense" ? book : movement,
        taxCents: row.type === "income" || row.type === "expense" ? tax : 0,
        deductibleBps: bps,
        source: stored ? "accountant" : base.source,
        needsReview: stored ? false : base.needsReview,
        reason: stored?.reason || "",
      });
    }
  }
  return finishBooks(db, session, client, year, bookIncome, bookExpense, taxIncome, taxDeduction, mappings, {
    booksSource: "avenue",
    conflictCount: 0,
    sourceNote: "Amounts come from posted Avenue journal entries.",
  });
}

function classifyMirror(db, session, client, year, start, end) {
  const overrides = externalMaps(db, session, client.id, year);
  const records = db.prepare(
    `SELECT entity_type, qbo_id, txn_date, amount_cents, display_name, status
     FROM quickbooks_records
     WHERE firm_id = ? AND client_id = ?
       AND entity_type IN ('Invoice', 'Bill', 'Purchase', 'JournalEntry')
     ORDER BY txn_date, entity_type, qbo_id`,
  ).all(session.firm_id, client.id);
  let bookIncome = 0;
  let bookExpense = 0;
  let taxIncome = 0;
  let taxDeduction = 0;
  const mappings = [];
  let conflictCount = 0;
  for (const row of records) {
    if (row.txn_date < start || row.txn_date > end) continue;
    if (row.status === "conflict") conflictCount += 1;
    const amount = Number(row.amount_cents || 0);
    if (!amount) continue;
    const key = `qbo:${row.entity_type}:${row.qbo_id}`;
    const stored = overrides.get(key);
    const suggested = row.entity_type === "Invoice" ? "gross_receipts" : "other";
    const lineKey = stored?.line_key || suggested;
    const bps = stored ? Number(stored.deductible_bps) : 10000;
    const kind = LINES[lineKey]?.[1] || "excluded";
    const tax = taxFromLine(lineKey, amount, bps);
    const countsInBooks = Boolean(stored) || row.entity_type !== "JournalEntry";
    if (countsInBooks && kind === "income") {
      bookIncome += amount;
      taxIncome += tax;
    }
    if (countsInBooks && kind === "expense") {
      bookExpense += amount;
      taxDeduction += tax;
    }
    mappings.push({
      accountId: key,
      code: "QBO",
      name: row.display_name || `${row.entity_type} ${row.qbo_id}`,
      type: kind === "income" ? "income" : kind === "expense" ? "expense" : "journal",
      lineKey,
      lineLabel: LINES[lineKey]?.[0] || lineKey,
      bookCents: amount,
      taxCents: countsInBooks ? tax : 0,
      deductibleBps: bps,
      source: stored ? "accountant" : "suggested",
      needsReview: !stored,
      reason: stored?.reason || (row.status === "conflict" ? "This sandbox record changed and is waiting for a decision." : ""),
    });
  }
  return finishBooks(db, session, client, year, bookIncome, bookExpense, taxIncome, taxDeduction, mappings, {
    booksSource: "quickbooks",
    conflictCount,
    sourceNote: "Amounts come from the QuickBooks sandbox mirror. They are not posted to the Avenue ledger.",
  });
}

function classify(db, session, client, year, start, end) {
  const source = authorityFor(db, session.firm_id, client.id);
  return source === "quickbooks"
    ? classifyMirror(db, session, client, year, start, end)
    : classifyLedger(db, session, client, year, start, end);
}

function flagsFor(db, session, clientId, year) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const reviewed = new Set(db.prepare(
    "SELECT transaction_id FROM tax_flag_reviews WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).all(session.firm_id, clientId, year).map((row) => row.transaction_id));
  const rows = db.prepare(
    `SELECT id, posted_on, description, amount_cents, status FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND posted_on >= ? AND posted_on <= ? AND status != 'excluded'
     ORDER BY posted_on, description`,
  ).all(session.firm_id, clientId, start, end);
  return rows.flatMap((row) => {
    const reasons = [];
    if (NONDEDUCTIBLE.test(row.description || "")) reasons.push("The description may be nondeductible.");
    if (MEALS.test(row.description || "")) reasons.push("The description may be a meal, which is often only partly deductible.");
    if (!reasons.length || reviewed.has(row.id)) return [];
    return [{
      transactionId: row.id,
      postedOn: row.posted_on,
      description: row.description,
      amountCents: Number(row.amount_cents),
      reasons,
    }];
  });
}

function unclosedMonths(db, session, clientId, year, today) {
  const months = [];
  for (let month = 1; month <= 12; month += 1) {
    const period = `${year}-${String(month).padStart(2, "0")}`;
    if (monthEnd(period) >= today) continue;
    const row = db.prepare(
      "SELECT status FROM period_locks WHERE firm_id = ? AND client_id = ? AND period = ?",
    ).get(session.firm_id, clientId, period);
    if (row?.status !== "closed") months.push(period);
  }
  return months;
}

function blockersFor(db, session, client, year, books, flags, today) {
  const profile = db.prepare(
    "SELECT * FROM tax_profiles WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).get(session.firm_id, client.id, year);
  const blockers = [];
  if (!profile || profile.entity_type === "unknown") blockers.push({ key: "entity", detail: "Choose the tax entity." });
  if (profile?.entity_type === "sole_proprietor" && !["single", "married_joint", "married_separate", "head"].includes(profile.filing_status)) {
    blockers.push({ key: "filing", detail: "Choose a filing status." });
  }
  if (profile?.entity_type === "sole_proprietor" && profile.other_wages_cents == null) {
    blockers.push({ key: "wages", detail: "Enter other wages, or enter 0 when there are none." });
  }
  const uncategorized = db.prepare(
    `SELECT COUNT(*) AS count FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND status = 'for_review' AND posted_on >= ? AND posted_on <= ?`,
  ).get(session.firm_id, client.id, `${year}-01-01`, `${year}-12-31`);
  if (Number(uncategorized.count) > 0) blockers.push({ key: "uncategorized", detail: `${uncategorized.count} lines in this year are still for review.` });
  const documents = db.prepare(
    "SELECT COUNT(*) AS count FROM document_requests WHERE firm_id = ? AND client_id = ? AND status = 'open'",
  ).get(session.firm_id, client.id);
  if (Number(documents.count) > 0) blockers.push({ key: "documents", detail: `${documents.count} document requests are still open.` });
  const months = unclosedMonths(db, session, client.id, year, today);
  if (months.length) blockers.push({ key: "close", detail: `These months are not closed: ${months.join(", ")}.` });
  const openAdjustments = books.adjustments.filter((row) => row.status === "open");
  if (openAdjustments.length) blockers.push({ key: "adjustments", detail: `${openAdjustments.length} book-to-tax adjustments are still open.` });
  if (flags.length) blockers.push({ key: "flags", detail: `${flags.length} transactions still need a tax-treatment review.` });
  if (books.mappings.some((row) => row.needsReview)) blockers.push({ key: "mappings", detail: "An account still needs an accountant to confirm its tax category." });
  if (books.conflictCount) blockers.push({ key: "qb_conflict", detail: `${books.conflictCount} QuickBooks sandbox ${books.conflictCount === 1 ? "record is" : "records are"} waiting for a decision.` });
  return blockers;
}

function paymentsFor(db, session, clientId, year) {
  return db.prepare(
    "SELECT id, quarter, amount_cents, paid_on FROM tax_payments WHERE firm_id = ? AND client_id = ? AND tax_year = ? ORDER BY quarter, paid_on",
  ).all(session.firm_id, clientId, year).map((row) => ({
    id: row.id,
    quarter: Number(row.quarter),
    amountCents: Number(row.amount_cents),
    paidOn: row.paid_on,
  }));
}

function rangeFor(year, today) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  if (today < start) return { start, end: start, asOf: start, started: false };
  if (today > end) return { start, end, asOf: end, started: true };
  return { start, end: today, asOf: today, started: true };
}

function priorSame(asOf) {
  const year = Number(asOf.slice(0, 4)) - 1;
  const month = Number(asOf.slice(5, 7));
  const day = Number(asOf.slice(8, 10));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${asOf.slice(5, 7)}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

function buildPlan(profile, projectedProfit) {
  if (!profile) return planSoleProp({ entityType: "unknown" });
  return planSoleProp({
    taxYear: Number(profile.tax_year),
    entityType: profile.entity_type,
    filingStatus: profile.filing_status === "unset" ? "" : profile.filing_status,
    scheduleCProfitCents: projectedProfit,
    otherWagesCents: profile.other_wages_cents == null ? null : Number(profile.other_wages_cents),
    socialSecurityWagesCents: profile.social_security_wages_cents == null ? null : Number(profile.social_security_wages_cents),
  });
}

function withPayments(plan, payments, year) {
  if (plan.status !== "calculated") return { ...plan, paidCents: payments.reduce((sum, row) => sum + row.amountCents, 0), remainingCents: null, quarters: [] };
  const shares = splitQuarters(plan.totalCents);
  const quarters = [1, 2, 3, 4].map((quarter, index) => {
    const paid = payments.filter((row) => row.quarter === quarter).reduce((sum, row) => sum + row.amountCents, 0);
    return {
      quarter,
      dueOn: quarter === 4 ? `${year + 1}-01-15` : `${year}-${["04", "06", "09"][index]}-15`,
      amountCents: shares[index],
      paidCents: paid,
    };
  });
  const paidCents = payments.reduce((sum, row) => sum + row.amountCents, 0);
  return { ...plan, paidCents, remainingCents: Math.max(0, plan.totalCents - paidCents), quarters };
}

function snapshot(db, session, client, year, today = todayIso()) {
  const profile = db.prepare(
    "SELECT * FROM tax_profiles WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).get(session.firm_id, client.id, year);
  const current = rangeFor(year, today);
  const books = classify(db, session, client, year, current.start, current.end);
  const priorStart = `${year - 1}-01-01`;
  const prior = classify(db, session, client, year - 1, priorStart, `${year - 1}-12-31`);
  const priorPeriod = classify(db, session, client, year - 1, priorStart, priorSame(current.asOf));
  const projection = current.started
    ? projectAnnual(books.taxProfit, current.asOf === `${year}-12-31` ? daysInYear(year) : dayOfYear(current.asOf), daysInYear(year))
    : { method: "not_started", projectedCents: null };
  const projectedProfit = projection.projectedCents == null ? 0 : projection.projectedCents;
  const flags = flagsFor(db, session, client.id, year);
  const blockers = blockersFor(db, session, client, year, books, flags, today);
  const review = db.prepare(
    "SELECT status, note, reviewed_at FROM tax_reviews WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).get(session.firm_id, client.id, year);
  const eligible = blockers.length === 0;
  const status = profile?.entity_type === "corporation" || profile?.entity_type === "partnership"
    ? "unsupported"
    : review?.status === "ready" && eligible
      ? "ready"
      : profile
        ? "in_progress"
        : "not_started";
  const plan = withPayments(buildPlan(profile, projectedProfit), paymentsFor(db, session, client.id, year), year);
  if (projection.method === "annualized") {
    plan.assumptions = [...(plan.assumptions || []), "The annual figure multiplies year-to-date tax profit by the days in the year and divides by the days elapsed."];
  }
  return {
    clientId: client.id,
    clientName: client.name,
    taxYear: year,
    asOf: current.asOf,
    status,
    statusLabel: { not_started: "Not started", in_progress: "In progress", ready: "Ready", unsupported: "Unsupported" }[status],
    eligible,
    filesReturn: false,
    transmits: false,
    booksSource: books.booksSource,
    rulesVersion: year === RULES_YEAR ? RULES_VERSION : "",
    sourceNote: books.sourceNote,
    profile: profile ? {
      entityType: profile.entity_type,
      filingStatus: profile.filing_status,
      otherWagesCents: profile.other_wages_cents == null ? null : Number(profile.other_wages_cents),
      socialSecurityWagesCents: profile.social_security_wages_cents == null ? null : Number(profile.social_security_wages_cents),
    } : null,
    yearToDate: { incomeCents: books.bookIncome, expenseCents: books.bookExpense, netCents: books.bookNet, taxProfitCents: books.taxProfit },
    projection,
    history: {
      priorYearNetCents: prior.bookNet,
      priorSamePeriodNetCents: priorPeriod.bookNet,
      currentPeriodNetCents: books.bookNet,
      changeCents: books.bookNet - priorPeriod.bookNet,
    },
    estimate: plan,
    mappings: books.mappings,
    adjustments: books.adjustments,
    flags,
    blockers,
    unclosedMonths: unclosedMonths(db, session, client.id, year, today),
    lines: Object.entries(LINES).map(([key, [label, kind]]) => ({ key, label, kind })),
    note: "This planner does not prepare or transmit a return.",
  };
}

export function taxBoard(db, session, query = {}) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const year = parseYear(query.year);
  if (!year) return fail(400, "Enter a tax year.");
  const today = todayIso();
  const rows = visibleClients(db, session).map((client) => {
    const view = snapshot(db, session, client, year, today);
    return {
      id: client.id,
      name: client.name,
      status: view.status,
      statusLabel: view.statusLabel,
      entityType: view.profile?.entityType || "unknown",
      booksSource: view.booksSource,
      rulesVersion: view.rulesVersion,
      outstanding: view.blockers.length,
      eligible: view.eligible,
    };
  });
  return {
    status: 200,
    payload: {
      year,
      counts: {
        clients: rows.length,
        profiled: rows.filter((row) => row.entityType !== "unknown").length,
        ready: rows.filter((row) => row.status === "ready").length,
        notReady: rows.filter((row) => row.status !== "ready").length,
        unsupported: rows.filter((row) => row.status === "unsupported").length,
        outstanding: rows.reduce((sum, row) => sum + row.outstanding, 0),
      },
      clients: rows,
      rulesVersion: year === RULES_YEAR ? RULES_VERSION : "",
      note: "Planning estimates are not returns and are not transmitted.",
    },
  };
}

export function readTaxIntel(db, session, clientId, yearValue) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const year = parseYear(yearValue);
  if (!year) return fail(400, "Enter a tax year.");
  syncTaxIssues(db, session, year, client.id);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

function moneyField(value, label, { allowBlank = false } = {}) {
  if (value == null || value === "") return allowBlank ? { cents: null } : fail(400, `Enter ${label}.`);
  try {
    return { cents: parseCents(String(value)) };
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
}

export function saveTaxProfile(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can set the tax profile.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const entityType = String(body.entityType || "").trim();
  if (!ENTITIES.includes(entityType) || entityType === "unknown") return fail(400, "Choose sole proprietor, corporation, or partnership.");
  const filingStatus = String(body.filingStatus || "unset").trim();
  if (!FILING.includes(filingStatus)) return fail(400, "Choose a filing status.");
  const wages = moneyField(body.otherWages, "other wages", { allowBlank: true });
  if (wages.error) return wages;
  const social = moneyField(body.socialSecurityWages, "Social Security wages", { allowBlank: true });
  if (social.error) return social;
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT id FROM tax_profiles WHERE firm_id = ? AND client_id = ? AND tax_year = ?",
  ).get(session.firm_id, client.id, year);
  if (existing) {
    db.prepare(
      `UPDATE tax_profiles
       SET entity_type = ?, filing_status = ?, other_wages_cents = ?, social_security_wages_cents = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND firm_id = ?`,
    ).run(entityType, filingStatus, wages.cents, social.cents, user.id, now, existing.id, session.firm_id);
  } else {
    db.prepare(
      `INSERT INTO tax_profiles (
        id, firm_id, client_id, tax_year, entity_type, filing_status, other_wages_cents, social_security_wages_cents, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), session.firm_id, client.id, year, entityType, filingStatus, wages.cents, social.cents, user.id, now, now);
  }
  auditTax(db, session, "tax.profile_saved", client.id, client.id, `Saved the ${year} profile as ${entityType}.`);
  syncTaxIssues(db, session, year, client.id);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

export function saveTaxMapping(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can override a tax category.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const lineKey = String(body.lineKey || "").trim();
  if (!LINES[lineKey]) return fail(400, "Choose a tax category.");
  const account = db.prepare(
    "SELECT id FROM accounts WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(body.accountId, session.firm_id, client.id);
  const externalKey = String(body.accountId || "");
  const external = externalKey.match(/^qbo:(Invoice|Bill|Purchase|JournalEntry):([A-Za-z0-9._-]{1,40})$/);
  if (!account && !(external && authorityFor(db, session.firm_id, client.id) === "quickbooks")) return fail(404, "Account not found.");
  const percent = Number(body.deductiblePercent);
  if (![0, 50, 100].includes(percent)) return fail(400, "Choose 0, 50, or 100 percent.");
  const reason = String(body.reason || "").trim();
  if (reason.length < 8 || reason.length > 500) return fail(400, "Enter a reason for the tax category.");
  const now = new Date().toISOString();
  if (account) {
    db.prepare(
      `INSERT INTO tax_account_maps (
        id, firm_id, client_id, tax_year, account_id, line_key, deductible_bps, reason, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(firm_id, client_id, tax_year, account_id)
      DO UPDATE SET line_key = excluded.line_key, deductible_bps = excluded.deductible_bps, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(randomUUID(), session.firm_id, client.id, year, account.id, lineKey, percent * 100, reason, user.id, now);
  } else {
    const stored = db.prepare(
      "SELECT qbo_id FROM quickbooks_records WHERE firm_id = ? AND client_id = ? AND entity_type = ? AND qbo_id = ?",
    ).get(session.firm_id, client.id, external[1], external[2]);
    if (!stored) return fail(404, "QuickBooks record not found.");
    db.prepare(
      `INSERT INTO tax_external_maps (
        id, firm_id, client_id, tax_year, source_key, line_key, deductible_bps, reason, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(firm_id, client_id, tax_year, source_key)
      DO UPDATE SET line_key = excluded.line_key, deductible_bps = excluded.deductible_bps, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(randomUUID(), session.firm_id, client.id, year, externalKey, lineKey, percent * 100, reason, user.id, now);
  }
  auditTax(db, session, "tax.mapping_override", client.id, account?.id || externalKey, reason);
  syncTaxIssues(db, session, year, client.id);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

export function saveTaxAdjustment(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can record a book-to-tax adjustment.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const label = String(body.label || "").trim();
  if (label.length < 3 || label.length > 80) return fail(400, "Enter an adjustment label.");
  const book = moneyField(body.bookAmount, "the book amount");
  if (book.error) return book;
  const tax = moneyField(body.taxAmount, "the tax amount");
  if (tax.error) return tax;
  const reason = String(body.reason || "").trim();
  if (reason.length < 8 || reason.length > 500) return fail(400, "Enter a reason for the adjustment.");
  const status = body.status === "accepted" ? "accepted" : "open";
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tax_adjustments (
      id, firm_id, client_id, tax_year, label, book_cents, tax_cents, reason, status, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, client.id, year, label, book.cents, tax.cents, reason, status, user.id, new Date().toISOString());
  auditTax(db, session, "tax.adjustment", client.id, id, reason);
  syncTaxIssues(db, session, year, client.id);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

export function saveTaxPayment(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const quarter = Number(body.quarter);
  if (![1, 2, 3, 4].includes(quarter)) return fail(400, "Choose a quarter from 1 to 4.");
  const amount = moneyField(body.amount, "the payment");
  if (amount.error) return amount;
  if (amount.cents <= 0) return fail(400, "Enter a payment greater than 0.");
  const paidOn = String(body.paidOn || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return fail(400, "Enter the payment date.");
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tax_payments (
      id, firm_id, client_id, tax_year, quarter, amount_cents, paid_on, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, client.id, year, quarter, amount.cents, paidOn, user.id, new Date().toISOString());
  auditTax(db, session, "tax.payment_recorded", client.id, id, `Recorded a quarter ${quarter} payment for ${year}.`);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

export function reviewTaxFlag(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can review a tax flag.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const reason = String(body.reason || "").trim();
  if (reason.length < 8 || reason.length > 500) return fail(400, "Enter a reason for the tax treatment.");
  const transaction = db.prepare(
    "SELECT id FROM bank_transactions WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(body.transactionId, session.firm_id, client.id);
  if (!transaction) return fail(404, "Transaction not found.");
  db.prepare(
    `INSERT INTO tax_flag_reviews (
      id, firm_id, client_id, tax_year, transaction_id, reason, reviewed_by, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(firm_id, client_id, tax_year, transaction_id)
    DO UPDATE SET reason = excluded.reason, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
  ).run(randomUUID(), session.firm_id, client.id, year, transaction.id, reason, user.id, new Date().toISOString());
  auditTax(db, session, "tax.flag_reviewed", client.id, transaction.id, reason);
  syncTaxIssues(db, session, year, client.id);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

export function runTaxScenario(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const view = snapshot(db, session, client, year);
  if (view.profile?.entityType !== "sole_proprietor") {
    return fail(400, "Scenarios are available for a sole proprietor only.");
  }
  const income = moneyField(body.incomeChange || "0.00", "the income change");
  if (income.error) return income;
  const expense = moneyField(body.expenseChange || "0.00", "the expense change");
  if (expense.error) return expense;
  const retirement = moneyField(body.retirementAmount || "0.00", "the retirement amount");
  if (retirement.error) return retirement;
  const depreciation = moneyField(body.depreciationAmount || "0.00", "the depreciation amount");
  if (depreciation.error) return depreciation;
  const kind = body.retirementKind === "sep" ? "sep" : "ira";
  const baseProfit = view.projection.projectedCents == null ? view.yearToDate.taxProfitCents : view.projection.projectedCents;
  const depreciationPlan = depreciationScenario(depreciation.cents);
  const profit = baseProfit + income.cents - expense.cents - depreciationPlan.allowedCents;
  const retirementPlan = retirementScenario(Math.max(0, profit), view.profile.filingStatus, kind, retirement.cents, view.profile.socialSecurityWagesCents || view.profile.otherWagesCents || 0);
  const scenario = planSoleProp({
    taxYear: year,
    entityType: "sole_proprietor",
    filingStatus: view.profile.filingStatus,
    scheduleCProfitCents: profit,
    otherWagesCents: view.profile.otherWagesCents,
    socialSecurityWagesCents: view.profile.socialSecurityWagesCents,
    retirementDeductionCents: retirementPlan.allowedCents,
  });
  scenario.assumptions = [...(scenario.assumptions || []), retirementPlan.note, depreciationPlan.note];
  return { status: 200, payload: { base: view.estimate, scenario, retirement: retirementPlan, depreciation: depreciationPlan, filesReturn: false } };
}

export function markTaxReady(db, session, clientId, input) {
  ensureTaxIntel(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, "Only an owner, administrator, manager, or accountant can mark a client tax-ready.");
  const client = clientFor(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const body = input || {};
  const year = parseYear(body.year);
  if (!year) return fail(400, "Enter a tax year.");
  const note = String(body.note || "").trim();
  if (note.length < 8 || note.length > 500) return fail(400, "Enter a review note.");
  const view = snapshot(db, session, client, year);
  if (!view.eligible) return fail(400, "Resolve the open tax items before marking the client ready.");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tax_reviews (id, firm_id, client_id, tax_year, status, note, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, 'ready', ?, ?, ?)
     ON CONFLICT(firm_id, client_id, tax_year)
     DO UPDATE SET status = 'ready', note = excluded.note, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
  ).run(randomUUID(), session.firm_id, client.id, year, note, user.id, now);
  auditTax(db, session, "tax.ready", client.id, client.id, note);
  return { status: 200, payload: snapshot(db, session, client, year) };
}

function trialBalance(db, session, clientId, asOf) {
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
  ).all(session.firm_id, clientId, asOf);
  const debits = lines.reduce((sum, line) => sum + Number(line.debit_cents), 0);
  const credits = lines.reduce((sum, line) => sum + Number(line.credit_cents), 0);
  return { debits, credits, foots: debits === credits, lines };
}

export function taxWorkpaperFile(db, session, clientId, query, kind) {
  const result = readTaxIntel(db, session, clientId, query.year);
  if (result.error) return result;
  const view = result.payload;
  const trial = trialBalance(db, session, view.clientId, view.asOf);
  const bridge = view.yearToDate.taxProfitCents - view.yearToDate.netCents;
  const rows = [
    ["section", "label", "book_cents", "tax_cents"],
    ["source", view.booksSource, view.rulesVersion, ""],
    ["year_to_date", "income", view.yearToDate.incomeCents, ""],
    ["year_to_date", "expenses", view.yearToDate.expenseCents, ""],
    ["year_to_date", "book_net", view.yearToDate.netCents, ""],
    ["reconciliation", "tax_profit", view.yearToDate.netCents, view.yearToDate.taxProfitCents],
    ["reconciliation", "book_to_tax", bridge, bridge],
    ...view.mappings.map((row) => ["mapping", `${row.code} ${row.name} ${row.lineKey}`, row.bookCents, row.taxCents]),
    ...view.adjustments.map((row) => ["adjustment", row.label, row.bookCents, row.taxCents]),
    ...trial.lines.map((row) => ["trial_balance", `${row.code} ${row.name}`, Number(row.debit_cents), Number(row.credit_cents)]),
    ["trial_balance", "totals", trial.debits, trial.credits],
  ];
  if (kind === "csv") {
    return {
      status: 200,
      body: `${rows.map((line) => line.map(csvCell).join(",")).join("\n")}\n`,
      contentType: "text/csv; charset=utf-8",
      filename: `avenue-tax-workpaper-${view.taxYear}.csv`,
    };
  }
  const text = [
    `${view.clientName} ${view.taxYear} tax workpaper`,
    "This workpaper is not a return and it is not transmitted.",
    `Books source ${view.booksSource}. Rules ${view.rulesVersion || "none"}.`,
    view.sourceNote,
    `Book net cents ${view.yearToDate.netCents}`,
    `Tax profit cents ${view.yearToDate.taxProfitCents}`,
    `Trial balance debits ${trial.debits} credits ${trial.credits}`,
    view.estimate.status === "calculated" ? `Estimated total cents ${view.estimate.totalCents}` : `Estimate ${view.estimate.status}`,
  ];
  return { status: 200, body: pdfDocument(text), contentType: "application/pdf", filename: `avenue-tax-workpaper-${view.taxYear}.pdf` };
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
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
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return body;
}

function taskSourceId(clientId, year, key) {
  return `${clientId}:${year}:${key}`;
}

function writeTaxTask(db, session, client, year, key, title, detail) {
  const sourceId = taskSourceId(client.id, year, key);
  const existing = db.prepare(
    "SELECT * FROM work_tasks WHERE firm_id = ? AND source_type = 'tax_issue' AND source_id = ?",
  ).get(session.firm_id, sourceId);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === "completed") {
      db.prepare(
        `UPDATE work_tasks SET status = 'open', stage = 'ready', detail = ?, completed_by_user_id = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ? AND firm_id = ?`,
      ).run(detail, now, existing.id, session.firm_id);
      db.prepare(
        `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
         VALUES (?, ?, ?, ?, 'reopen', 'The tax item is open again.', ?)`,
      ).run(randomUUID(), session.firm_id, existing.id, session.user_id, now);
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
      ) VALUES (?, ?, ?, ?, ?, '', 'tax', 'open', 'normal', NULL, ?, 'tax_issue', ?, NULL, NULL, ?, ?, ?, 'ready', '', NULL, NULL)`,
    ).run(id, session.firm_id, client.id, title, detail, `${year + 1}-04-15`, sourceId, session.user_id, now, now);
    db.prepare(
      `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
       VALUES (?, ?, ?, ?, 'create', ?, ?)`,
    ).run(randomUUID(), session.firm_id, id, session.user_id, title, now);
  } catch (error) {
    if (!String(error.message || error).includes("UNIQUE")) throw error;
  }
}

function finishTaxTask(db, session, taskId) {
  const now = new Date().toISOString();
  const changed = db.prepare(
    `UPDATE work_tasks SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND status != 'completed'`,
  ).run(session.user_id, now, now, taskId, session.firm_id);
  if (!changed.changes) return;
  db.prepare(
    `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'The tax item is resolved.', ?)`,
  ).run(randomUUID(), session.firm_id, taskId, session.user_id, now);
}

export function syncTaxIssues(db, session, yearValue = 0, onlyClientId = "") {
  if (!session?.firm_id || !session.user_id || session.portal) return;
  ensureTaxIntel(db);
  const year = yearValue || Number(todayIso().slice(0, 4));
  const extra = scopeSql(db, session, "tax_profiles.client_id");
  const profiles = db.prepare(
    `SELECT client_id FROM tax_profiles WHERE firm_id = ? AND tax_year = ? ${extra.sql}`,
  ).all(session.firm_id, year, ...extra.params).filter((row) => !onlyClientId || row.client_id === onlyClientId);
  const openIds = new Set();
  for (const profile of profiles) {
    const client = db.prepare("SELECT id, name, status FROM clients WHERE id = ? AND firm_id = ?").get(profile.client_id, session.firm_id);
    if (!client || client.status === "archived") continue;
    const view = snapshot(db, session, client, year);
    for (const blocker of view.blockers) {
      const sourceId = taskSourceId(client.id, year, blocker.key);
      openIds.add(sourceId);
      writeTaxTask(db, session, client, year, blocker.key, `Tax follow-up for ${client.name}`, blocker.detail);
    }
  }
  const taskScope = scopeSql(db, session, "work_tasks.client_id");
  const openTasks = db.prepare(
    `SELECT id, source_id, client_id FROM work_tasks
     WHERE firm_id = ? AND source_type = 'tax_issue' AND status != 'completed' AND source_id LIKE ?
     ${taskScope.sql}`,
  ).all(session.firm_id, `%:${year}:%`, ...taskScope.params);
  for (const task of openTasks) {
    if (onlyClientId && task.client_id !== onlyClientId) continue;
    if (!openIds.has(task.source_id)) finishTaxTask(db, session, task.id);
  }
}
