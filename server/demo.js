import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword, openDatabase, signIn } from "./db.js";
import { ensureCharts, postJournalEntry } from "./ledger.js";
import { createInvoice, recordPayment as recordInvoicePayment, sendInvoice } from "./invoices.js";
import { approveBill, createBill, createVendor, postBill, recordPayment as recordBillPayment, submitBill } from "./payables.js";
import { createExpense } from "./expenses.js";
import { addStatementLine, categorizeTransaction, completeReconciliation, createBankAccount } from "./banking.js";
import { createDocumentRequest, storeDocument } from "./documents.js";
import { readWork } from "./work.js";
import { loadStatement } from "./statements.js";

export const DEMO_OWNER = {
  email: "avery@ledgerly-demo.example",
  password: "ledgerly-demo",
  name: "Avery Quinn",
};

const DEMO_FIRM = "Ledgerly Demo (fictional)";

const NOTICE = "These businesses are fictional. Passing these checks is not a certification or an audit opinion.";

const SCENARIOS = [
  {
    key: "studio",
    name: "Northwind Studio (fictional)",
    legalName: "Northwind Studio (fictional)",
    initials: "NS",
    industry: "Design services",
    model: "Service studio",
    summary: "Bills fictional clients for design work and pays fictional vendors.",
    customers: ["Fictional Oak & Co", "Fictional Pine Press", "Fictional Cedar Weekly", "Fictional Birch Museum"],
    vendors: ["Fictional Paper Lane", "Fictional North Lamp Power"],
    expenseAccount: "6400",
    expenseVendor: "Fictional desk supply",
    billAccounts: ["6200", "6300", "6100", "6500"],
    counterSale: false,
  },
  {
    key: "retail",
    name: "Market Lane Goods (fictional)",
    legalName: "Market Lane Goods (fictional)",
    initials: "ML",
    industry: "Retail",
    model: "Retail shop",
    summary: "Sells fictional goods at the counter and on invoices, and records sales tax.",
    customers: ["Fictional weekend market", "Fictional hotel gift shop", "Fictional school store", "Fictional corner booth"],
    vendors: ["Fictional Millwork Supply", "Fictional Crate Freight"],
    expenseAccount: "6700",
    expenseVendor: "Fictional shop utilities",
    billAccounts: ["5000", "6400", "6100", "6200"],
    counterSale: true,
  },
  {
    key: "field",
    name: "Fieldline Repairs (fictional)",
    legalName: "Fieldline Repairs (fictional)",
    initials: "FR",
    industry: "Repair contractor",
    model: "Repair contractor",
    summary: "Bills fictional jobs, pays fictional crews, and finances equipment with a note.",
    customers: ["Fictional Harbor House", "Fictional school annex", "Fictional loft stairs", "Fictional dock office"],
    vendors: ["Fictional Subcontractor Crew", "Fictional Tool Library"],
    expenseAccount: "6600",
    expenseVendor: "Fictional job insurance",
    billAccounts: ["6000", "1500", "6500", "6400"],
    counterSale: false,
  },
];

function day(offset) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayNumber = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayNumber}`;
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function signedText(cents) {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const text = `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

function must(result, label) {
  if (!result || result.error || result.status >= 400) {
    throw new Error(`${label}: ${result?.error || `status ${result?.status || "unknown"}`}`);
  }
  return result;
}

function ensureDemoTables(db) {
  const columns = db.prepare("PRAGMA table_info(firms)").all();
  if (!columns.some((column) => column.name === "demo")) {
    db.exec("ALTER TABLE firms ADD COLUMN demo INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS demo_scenarios (
      client_id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL,
      scenario_key TEXT NOT NULL,
      model TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS demo_bank_keys (
      firm_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      bank_transaction_id TEXT NOT NULL,
      PRIMARY KEY (firm_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS demo_check_runs (
      id TEXT PRIMARY KEY,
      passed INTEGER NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_reviews (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL REFERENCES firms(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      party TEXT NOT NULL DEFAULT '',
      document_date TEXT NOT NULL DEFAULT '',
      amount TEXT NOT NULL DEFAULT '',
      confidence REAL,
      label TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'corrected')),
      reviewed_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (firm_id, file_id)
    );
  `);
}

function demoFirm(db) {
  ensureDemoTables(db);
  return db.prepare("SELECT id, name FROM firms WHERE demo = 1 ORDER BY created_at LIMIT 1").get() || null;
}

function accountId(db, session, code) {
  const row = db.prepare(
    "SELECT id FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
  ).get(session.firm_id, session.selected_client_id, code);
  if (!row) throw new Error(`Account ${code} is missing.`);
  return row.id;
}

function post(db, session, entryDate, memo, lines) {
  must(postJournalEntry(db, session, {
    entryDate,
    memo,
    lines: lines.map((line) => ({
      accountId: accountId(db, session, line.code),
      debit: line.debit || "",
      credit: line.credit || "",
    })),
  }), memo);
}

function statementLines(key) {
  return [
    {
      externalId: `${key}-rent`,
      postedOn: day(-18),
      description: `Fictional ${key} rent draft`,
      amountCents: -125000,
      categorize: "6100",
      clear: true,
    },
    {
      externalId: `${key}-review`,
      postedOn: day(-1),
      description: `Fictional ${key} deposit for review`,
      amountCents: 48000,
      categorize: "",
      clear: false,
    },
  ];
}

export function syncDemoStatement(db, session, bankAccountId, lines) {
  ensureDemoTables(db);
  let inserted = 0;
  const stored = [];
  for (const line of lines) {
    const known = db.prepare(
      "SELECT bank_transaction_id FROM demo_bank_keys WHERE firm_id = ? AND external_id = ?",
    ).get(session.firm_id, line.externalId);
    if (known) {
      stored.push({ ...line, id: known.bank_transaction_id });
      continue;
    }
    const row = addStatementLine(db, session, {
      bankAccountId,
      postedOn: line.postedOn,
      description: line.description,
      amountCents: line.amountCents,
      source: "manual",
    });
    if (row.error) throw new Error(row.error);
    db.prepare(
      "INSERT INTO demo_bank_keys (firm_id, external_id, bank_transaction_id) VALUES (?, ?, ?)",
    ).run(session.firm_id, line.externalId, row.id);
    inserted += 1;
    stored.push({ ...line, id: row.id });
  }
  return { inserted, lines: stored };
}

function textFile(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function seedBooks(db, session, spec) {
  post(db, session, day(-70), "Fictional opening capital", [
    { code: "1000", debit: "20000.00" },
    { code: "3000", credit: "20000.00" },
  ]);
  post(db, session, day(-70), "Fictional equipment note", [
    { code: "1500", debit: "5000.00" },
    { code: "2500", credit: "5000.00" },
  ]);
  post(db, session, day(-40), "Fictional depreciation", [
    { code: "6800", debit: "200.00" },
    { code: "1510", credit: "200.00" },
  ]);
  post(db, session, day(-30), "Fictional owner draw", [
    { code: "3100", debit: "500.00" },
    { code: "1000", credit: "500.00" },
  ]);
  post(db, session, day(-30), "Fictional prepaid insurance", [
    { code: "1200", debit: "200.00" },
    { code: "1000", credit: "200.00" },
  ]);
  if (spec.counterSale) {
    post(db, session, day(-9), "Fictional counter sale", [
      { code: "1000", debit: "525.00" },
      { code: "4100", credit: "500.00" },
      { code: "2200", credit: "25.00" },
    ]);
  }

  const invoices = [
    { customer: spec.customers[0], memo: "Fictional paid invoice", issue: day(-50), due: day(-20), amount: "800.00", payment: { date: day(-18), amount: "800.00" } },
    { customer: spec.customers[1], memo: "Fictional partial invoice", issue: day(-24), due: day(12), amount: "500.00", payment: { date: day(-2), amount: "200.00" } },
    { customer: spec.customers[2], memo: "Fictional overdue invoice", issue: day(-40), due: day(-8), amount: "360.00" },
    { customer: spec.customers[3], memo: "Fictional unpaid invoice", issue: day(-3), due: day(21), amount: "640.00" },
  ];
  for (const invoice of invoices) {
    const created = must(createInvoice(db, session, {
      customerName: invoice.customer,
      issueDate: invoice.issue,
      dueDate: invoice.due,
      memo: invoice.memo,
      lines: [{ description: invoice.memo, amount: invoice.amount }],
    }), invoice.memo);
    const sent = must(sendInvoice(db, session, created.payload.invoice.id), invoice.memo);
    if (invoice.payment) {
      must(recordInvoicePayment(db, session, sent.payload.invoice.id, {
        paidOn: invoice.payment.date,
        amount: invoice.payment.amount,
      }), invoice.memo);
    }
  }

  const vendorIds = spec.vendors.map((name) => must(createVendor(db, session, {
    name,
    notes: "Fictional vendor. No tax identifier is stored.",
  }), name).payload.vendor.id);
  const bills = [
    { number: `${spec.key}-paid`, vendor: vendorIds[0], account: spec.billAccounts[0], amount: "220.00", billDate: day(-32), dueDate: day(-4), payment: { date: day(-3), amount: "220.00", reference: "paid" } },
    { number: `${spec.key}-partial`, vendor: vendorIds[0], account: spec.billAccounts[1], amount: "400.00", billDate: day(-20), dueDate: day(15), payment: { date: day(-1), amount: "100.00", reference: "partial" } },
    { number: `${spec.key}-overdue`, vendor: vendorIds[1], account: spec.billAccounts[2], amount: "310.00", billDate: day(-45), dueDate: day(-10) },
    { number: `${spec.key}-unpaid`, vendor: vendorIds[1], account: spec.billAccounts[3], amount: "150.00", billDate: day(-6), dueDate: day(18) },
    { number: `${spec.key}-approval`, vendor: vendorIds[0], account: spec.billAccounts[0], amount: "90.00", billDate: day(-2), dueDate: day(20), approvalOnly: true },
  ];
  for (const bill of bills) {
    const created = must(createBill(db, session, {
      vendorId: bill.vendor,
      invoiceNumber: bill.number,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      notes: "Fictional bill. No tax identifier is stored.",
      lines: [{ description: bill.number, accountId: accountId(db, session, bill.account), amount: bill.amount, tax: "0.00" }],
    }), bill.number);
    must(submitBill(db, session, created.payload.bill.id), bill.number);
    if (bill.approvalOnly) continue;
    must(approveBill(db, session, created.payload.bill.id), bill.number);
    must(postBill(db, session, created.payload.bill.id, { total: bill.amount }), bill.number);
    if (bill.payment) {
      must(recordBillPayment(db, session, created.payload.bill.id, {
        paidOn: bill.payment.date,
        amount: bill.payment.amount,
        reference: bill.payment.reference,
        accountId: accountId(db, session, "1000"),
      }), bill.number);
    }
  }

  must(createExpense(db, session, {
    vendor: spec.expenseVendor,
    spentOn: day(-12),
    kind: "paid",
    amount: "42.00",
    accountCode: spec.expenseAccount,
  }), spec.expenseVendor);

  must(createBankAccount(db, session, { name: "Fictional operating account", kind: "bank" }), "bank");
  const bank = db.prepare(
    "SELECT id FROM bank_accounts WHERE firm_id = ? AND client_id = ? AND name = ?",
  ).get(session.firm_id, session.selected_client_id, "Fictional operating account");
  const synced = syncDemoStatement(db, session, bank.id, statementLines(spec.key));
  for (const line of synced.lines) {
    if (!line.categorize) continue;
    must(categorizeTransaction(db, session, line.id, { accountId: accountId(db, session, line.categorize) }), line.description);
  }
  const cleared = synced.lines.filter((line) => line.clear);
  const ending = cleared.reduce((sum, line) => sum + line.amountCents, 0);
  must(completeReconciliation(db, session, {
    bankAccountId: bank.id,
    statementDate: day(0),
    statementEnding: signedText(ending),
    transactionIds: cleared.map((line) => line.id),
  }), "reconciliation");

  must(createDocumentRequest(db, session, {
    clientId: session.selected_client_id,
    title: "Fictional prior-year statement",
    dueOn: day(14),
  }), "open request");
  const completed = must(createDocumentRequest(db, session, {
    clientId: session.selected_client_id,
    title: "Fictional engagement letter",
    dueOn: day(-2),
  }), "completed request");
  must(storeDocument(db, session, {
    clientId: session.selected_client_id,
    requestId: completed.payload.request.id,
    name: `${spec.key}-engagement.txt`,
    mediaType: "text/plain",
    category: "Other",
    contentBase64: textFile("Fictional engagement letter\n"),
  }), "engagement");
  const receipt = must(storeDocument(db, session, {
    clientId: session.selected_client_id,
    name: `${spec.key}-receipt.txt`,
    mediaType: "text/plain",
    category: "Receipt",
    contentBase64: textFile("Fictional receipt\nVendor: Paper Lane Supply\n2026-04-02\n18.00\n"),
  }), "receipt");
  must(storeDocument(db, session, {
    clientId: session.selected_client_id,
    name: `${spec.key}-statement.txt`,
    mediaType: "text/plain",
    category: "Bank statement",
    contentBase64: textFile("Fictional bank statement\n"),
  }), "statement");
  db.prepare(
    `INSERT INTO document_reviews (
      id, firm_id, client_id, file_id, file_name, kind, party, document_date, amount, confidence, label, source, status, reviewed_by, created_at
    ) VALUES (?, ?, ?, ?, ?, 'receipt', 'Paper Lane Supply', '2026-04-02', '18.00', 0.5, 'AI-generated', 'rules', 'accepted', ?, ?)`,
  ).run(
    randomUUID(),
    session.firm_id,
    session.selected_client_id,
    receipt.payload.file.id,
    receipt.payload.file.name,
    session.user_id,
    new Date().toISOString(),
  );
}

function seedDemo(db) {
  ensureDemoTables(db);
  if (demoFirm(db)) return demoFirm(db);
  const now = new Date().toISOString();
  const firmId = randomUUID();
  const userId = randomUUID();
  db.prepare("INSERT INTO firms (id, name, created_at, demo) VALUES (?, ?, ?, 1)").run(firmId, DEMO_FIRM, now);
  db.prepare(
    "INSERT INTO users (id, firm_id, email, name, role, password_hash, invited_by, created_at) VALUES (?, ?, ?, ?, 'owner', ?, NULL, ?)",
  ).run(userId, firmId, DEMO_OWNER.email, DEMO_OWNER.name, hashPassword(DEMO_OWNER.password), now);
  const session = { firm_id: firmId, user_id: userId, selected_client_id: "" };
  SCENARIOS.forEach((spec, index) => {
    const clientId = randomUUID();
    db.prepare(
      "INSERT INTO clients (id, firm_id, name, legal_name, initials, industry, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(clientId, firmId, spec.name, spec.legalName, spec.initials, spec.industry, index, now);
    db.prepare(
      "INSERT INTO demo_scenarios (client_id, firm_id, scenario_key, model, summary) VALUES (?, ?, ?, ?, ?)",
    ).run(clientId, firmId, spec.key, spec.model, spec.summary);
  });
  ensureCharts(db);
  for (const spec of SCENARIOS) {
    const client = db.prepare(
      "SELECT id FROM clients WHERE firm_id = ? AND name = ?",
    ).get(firmId, spec.name);
    session.selected_client_id = client.id;
    seedBooks(db, session, spec);
  }
  const first = db.prepare("SELECT id FROM clients WHERE firm_id = ? ORDER BY position LIMIT 1").get(firmId);
  session.selected_client_id = first.id;
  must(readWork(db, session), "work queue");
  return demoFirm(db);
}

export function ensureDemo(db) {
  ensureDemoTables(db);
  if (!demoFirm(db)) seedDemo(db);
  return demoFirm(db);
}

function wipeDemo(db) {
  ensureDemoTables(db);
  const firms = db.prepare("SELECT id FROM firms WHERE demo = 1").all();
  if (!firms.length) return;
  const ids = firms.map((firm) => firm.id);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const name of ["journal_entries_no_update", "journal_entries_no_delete", "journal_lines_no_update", "journal_lines_no_delete"]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  let failure = null;
  try {
    for (const table of tables) {
      if (table.name === "firms") continue;
      const columns = db.prepare(`PRAGMA table_info(${quoteName(table.name)})`).all();
      if (!columns.some((column) => column.name === "firm_id")) continue;
      db.prepare(`DELETE FROM ${quoteName(table.name)} WHERE firm_id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
    }
    db.prepare(`DELETE FROM firms WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
    db.exec("COMMIT");
  } catch (error) {
    failure = error;
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      failure = new Error(`${error.message} (rollback: ${rollbackError.message})`);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    ensureCharts(db);
  }
  const guard = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'journal_entries_no_delete'").get();
  if (!guard) throw new Error("Journal delete protection was not restored.");
  if (failure) throw failure;
}

function quoteName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Unexpected table.");
  return name;
}

function assetBalance(db, firmId, clientId, code) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(journal_lines.debit_cents), 0) AS debit_cents, COALESCE(SUM(journal_lines.credit_cents), 0) AS credit_cents
     FROM journal_lines
     JOIN accounts ON accounts.id = journal_lines.account_id AND accounts.firm_id = journal_lines.firm_id
     WHERE journal_lines.firm_id = ? AND journal_lines.client_id = ? AND accounts.code = ?`,
  ).get(firmId, clientId, code);
  return asCents(row.debit_cents) - asCents(row.credit_cents);
}

function liabilityBalance(db, firmId, clientId, code) {
  return -assetBalance(db, firmId, clientId, code);
}

function openInvoiceCents(db, firmId, clientId) {
  const rows = db.prepare(
    `SELECT invoices.total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM invoice_payments WHERE invoice_id = invoices.id AND firm_id = invoices.firm_id), 0) AS paid_cents
     FROM invoices
     WHERE firm_id = ? AND client_id = ? AND status IN ('sent', 'partial')`,
  ).all(firmId, clientId);
  return rows.reduce((sum, row) => sum + (asCents(row.total_cents) - asCents(row.paid_cents)), 0);
}

function openBillCents(db, firmId, clientId) {
  const rows = db.prepare(
    `SELECT ap_bills.total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM ap_payments WHERE bill_id = ap_bills.id AND firm_id = ap_bills.firm_id AND status = 'recorded'), 0) AS paid_cents
     FROM ap_bills
     WHERE firm_id = ? AND client_id = ? AND status = 'posted'`,
  ).all(firmId, clientId);
  return rows.reduce((sum, row) => sum + (asCents(row.total_cents) - asCents(row.paid_cents)), 0);
}

function ownerSession(db, firm) {
  const user = db.prepare("SELECT id FROM users WHERE firm_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(firm.id);
  const client = db.prepare("SELECT id FROM clients WHERE firm_id = ? ORDER BY position LIMIT 1").get(firm.id);
  return { firm_id: firm.id, user_id: user.id, selected_client_id: client.id };
}

function invariantChecks(db) {
  const firm = demoFirm(db);
  const clients = db.prepare("SELECT id, name FROM clients WHERE firm_id = ? ORDER BY position").all(firm.id);
  const journals = db.prepare(
    `SELECT journal_entries.id, COALESCE(SUM(journal_lines.debit_cents), 0) AS debit_cents, COALESCE(SUM(journal_lines.credit_cents), 0) AS credit_cents
     FROM journal_entries
     LEFT JOIN journal_lines ON journal_lines.entry_id = journal_entries.id AND journal_lines.firm_id = journal_entries.firm_id
     WHERE journal_entries.firm_id = ?
     GROUP BY journal_entries.id`,
  ).all(firm.id);
  const unbalanced = journals.filter((row) => asCents(row.debit_cents) !== asCents(row.credit_cents));
  const balanceNotes = [];
  const receivableNotes = [];
  const payableNotes = [];
  for (const client of clients) {
    const statement = loadStatement(db, firm.id, client.id, { period: "Year to date", basis: "accrual" });
    if (!statement?.statement.balanceSheet.balances) balanceNotes.push(client.name);
    const receivable = assetBalance(db, firm.id, client.id, "1100");
    const invoices = openInvoiceCents(db, firm.id, client.id);
    if (receivable !== invoices) receivableNotes.push(client.name);
    const payable = liabilityBalance(db, firm.id, client.id, "2000");
    const bills = openBillCents(db, firm.id, client.id);
    if (payable !== bills) payableNotes.push(client.name);
  }
  return [
    { name: "Every posted journal balances", passed: journals.length > 0 && unbalanced.length === 0, detail: unbalanced.length ? `${unbalanced.length} journal${unbalanced.length === 1 ? "" : "s"} do not balance.` : `${journals.length} journals balance.` },
    { name: "Assets equal liabilities plus equity", passed: balanceNotes.length === 0 && clients.length > 0, detail: balanceNotes.length ? balanceNotes.join(", ") : "The year-to-date balance sheet balances for each fictional business." },
    { name: "Receivable matches open invoices", passed: receivableNotes.length === 0 && clients.length > 0, detail: receivableNotes.length ? receivableNotes.join(", ") : "Accounts receivable matches the open invoices." },
    { name: "Payable matches open bills", passed: payableNotes.length === 0 && clients.length > 0, detail: payableNotes.length ? payableNotes.join(", ") : "Accounts payable matches the open posted bills." },
  ];
}

function behaviorChecks() {
  const dir = mkdtempSync(path.join(tmpdir(), "ledgerly-demo-"));
  const scratch = openDatabase(path.join(dir, "demo.sqlite"));
  try {
    const firm = ensureDemo(scratch);
    const session = ownerSession(scratch, firm);
    const invoice = scratch.prepare(
      "SELECT id, client_id, total_cents FROM invoices WHERE firm_id = ? AND memo = ? AND status = 'sent' ORDER BY id LIMIT 1",
    ).get(firm.id, "Fictional unpaid invoice");
    session.selected_client_id = invoice.client_id;
    const beforeReceivable = assetBalance(scratch, firm.id, invoice.client_id, "1100");
    const beforeCash = assetBalance(scratch, firm.id, invoice.client_id, "1000");
    const beforeOpen = openInvoiceCents(scratch, firm.id, invoice.client_id);
    must(recordInvoicePayment(scratch, session, invoice.id, { paidOn: day(0), amount: "20.00" }), "check payment");
    const paymentMoved = assetBalance(scratch, firm.id, invoice.client_id, "1100") === beforeReceivable - 2000
      && assetBalance(scratch, firm.id, invoice.client_id, "1000") === beforeCash + 2000
      && openInvoiceCents(scratch, firm.id, invoice.client_id) === beforeOpen - 2000;

    const beforeIncome = loadStatement(scratch, firm.id, session.selected_client_id, { period: "Year to date", basis: "accrual" }).statement.profitAndLoss.netIncomeCents;
    post(scratch, session, day(0), "Fictional check entry", [
      { code: "1000", debit: "10.00" },
      { code: "4000", credit: "10.00" },
    ]);
    const afterIncome = loadStatement(scratch, firm.id, session.selected_client_id, { period: "Year to date", basis: "accrual" }).statement.profitAndLoss.netIncomeCents;

    const bank = scratch.prepare(
      "SELECT id FROM bank_accounts WHERE firm_id = ? AND client_id = ? LIMIT 1",
    ).get(firm.id, session.selected_client_id);
    const scenario = scratch.prepare("SELECT scenario_key FROM demo_scenarios WHERE client_id = ?").get(session.selected_client_id);
    const beforeLines = asCents(scratch.prepare(
      "SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ?",
    ).get(firm.id, session.selected_client_id).count);
    const synced = syncDemoStatement(scratch, session, bank.id, statementLines(scenario.scenario_key));
    const afterLines = asCents(scratch.prepare(
      "SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ?",
    ).get(firm.id, session.selected_client_id).count);

    const beforeTasks = asCents(scratch.prepare("SELECT COUNT(*) AS count FROM work_tasks WHERE firm_id = ?").get(firm.id).count);
    must(readWork(scratch, session), "second work read");
    const afterTasks = asCents(scratch.prepare("SELECT COUNT(*) AS count FROM work_tasks WHERE firm_id = ?").get(firm.id).count);
    const duplicates = scratch.prepare(
      `SELECT source_type, source_id, COUNT(*) AS count
       FROM work_tasks WHERE firm_id = ? AND source_type != ''
       GROUP BY source_type, source_id HAVING COUNT(*) > 1`,
    ).all(firm.id);

    return [
      { name: "A payment reduces the right balance", passed: paymentMoved, detail: paymentMoved ? "A 20.00 payment reduced receivable and the open invoice, and increased cash." : "The payment did not move receivable, cash, and the invoice by the same amount." },
      { name: "A second bank sync does not duplicate", passed: synced.inserted === 0 && afterLines === beforeLines && beforeLines > 0, detail: synced.inserted === 0 ? "The second sync added no lines." : `The second sync added ${synced.inserted} lines.` },
      { name: "Reports change after a post", passed: afterIncome === beforeIncome + 1000, detail: afterIncome === beforeIncome + 1000 ? "Year-to-date net income increased by 10.00 after the post." : "The report did not change by the posted amount." },
      { name: "A repeated source does not add a second task", passed: beforeTasks > 0 && afterTasks === beforeTasks && duplicates.length === 0, detail: duplicates.length ? "A source has more than one task." : "Reading the queue again left the task count unchanged." },
    ];
  } finally {
    scratch.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function storeRun(db, checks) {
  const passed = checks.length > 0 && checks.every((check) => check.passed);
  const failed = checks.filter((check) => !check.passed).length;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO demo_check_runs (id, passed, summary, detail, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, passed ? 1 : 0, passed ? `${checks.length} checks passed` : `${failed} ${failed === 1 ? "check" : "checks"} failed`, JSON.stringify(checks), now);
  return id;
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function countOf(row) {
  return asCents(row?.count);
}

function scenarioSnapshot(db, firmId, row) {
  const today = day(0);
  const invoices = db.prepare("SELECT status, due_date, total_cents FROM invoices WHERE firm_id = ? AND client_id = ?").all(firmId, row.id);
  const bills = db.prepare("SELECT id, status, due_date, total_cents FROM ap_bills WHERE firm_id = ? AND client_id = ?").all(firmId, row.id);
  const billPayments = db.prepare(
    `SELECT bill_id, COALESCE(SUM(amount_cents), 0) AS paid_cents
     FROM ap_payments WHERE firm_id = ? AND client_id = ? AND status = 'recorded' GROUP BY bill_id`,
  ).all(firmId, row.id);
  const paidByBill = new Map(billPayments.map((payment) => [payment.bill_id, asCents(payment.paid_cents)]));
  const invoiceStates = { paid: 0, unpaid: 0, overdue: 0, partial: 0 };
  for (const invoice of invoices) {
    if (invoice.status === "paid") invoiceStates.paid += 1;
    if (invoice.status === "partial") invoiceStates.partial += 1;
    if (invoice.status === "sent" && invoice.due_date >= today) invoiceStates.unpaid += 1;
    if ((invoice.status === "sent" || invoice.status === "partial") && invoice.due_date < today) invoiceStates.overdue += 1;
  }
  const billStates = { paid: 0, unpaid: 0, overdue: 0, partial: 0, awaitingApproval: 0 };
  for (const bill of bills) {
    const open = asCents(bill.total_cents) - (paidByBill.get(bill.id) || 0);
    if (bill.status === "awaiting_approval") billStates.awaitingApproval += 1;
    if (bill.status === "posted" && open === 0) billStates.paid += 1;
    if (bill.status === "posted" && open > 0 && open < asCents(bill.total_cents)) billStates.partial += 1;
    if (bill.status === "posted" && open === asCents(bill.total_cents) && bill.due_date >= today) billStates.unpaid += 1;
    if (bill.status === "posted" && open > 0 && bill.due_date < today) billStates.overdue += 1;
  }
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    model: row.model,
    summary: row.summary,
    fictional: true,
    customers: countOf(db.prepare("SELECT COUNT(DISTINCT customer_name) AS count FROM invoices WHERE firm_id = ? AND client_id = ?").get(firmId, row.id)),
    vendors: countOf(db.prepare("SELECT COUNT(*) AS count FROM ap_vendors WHERE firm_id = ? AND client_id = ?").get(firmId, row.id)),
    invoices: invoices.length,
    bills: bills.length,
    expenses: countOf(db.prepare("SELECT COUNT(*) AS count FROM expenses WHERE firm_id = ? AND client_id = ?").get(firmId, row.id)),
    bankLines: countOf(db.prepare("SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ?").get(firmId, row.id)),
    reconciled: countOf(db.prepare("SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ? AND cleared_reconciliation_id IS NOT NULL").get(firmId, row.id)),
    unreconciled: countOf(db.prepare("SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ? AND cleared_reconciliation_id IS NULL").get(firmId, row.id)),
    documents: countOf(db.prepare("SELECT COUNT(*) AS count FROM client_files WHERE firm_id = ? AND client_id = ? AND status = 'stored'").get(firmId, row.id)),
    needsReview: countOf(db.prepare(
      `SELECT COUNT(*) AS count FROM client_files
       WHERE firm_id = ? AND client_id = ? AND status = 'stored'
         AND id NOT IN (SELECT file_id FROM document_reviews WHERE firm_id = ? AND client_id = ?)`,
    ).get(firmId, row.id, firmId, row.id)),
    openRequests: countOf(db.prepare("SELECT COUNT(*) AS count FROM document_requests WHERE firm_id = ? AND client_id = ? AND status = 'open'").get(firmId, row.id)),
    invoiceStates,
    billStates,
    receivableCents: assetBalance(db, firmId, row.id, "1100"),
    payableCents: liabilityBalance(db, firmId, row.id, "2000"),
    covered: coveredAccounts(db, firmId, row.id),
  };
}

function coveredAccounts(db, firmId, clientId) {
  const rows = db.prepare(
    `SELECT accounts.type, accounts.code,
            COALESCE(SUM(journal_lines.debit_cents), 0) AS debit_cents,
            COALESCE(SUM(journal_lines.credit_cents), 0) AS credit_cents
     FROM journal_lines
     JOIN accounts ON accounts.id = journal_lines.account_id AND accounts.firm_id = journal_lines.firm_id
     WHERE journal_lines.firm_id = ? AND journal_lines.client_id = ?
     GROUP BY accounts.id`,
  ).all(firmId, clientId);
  const covered = new Set();
  for (const row of rows) {
    if (asCents(row.debit_cents) === asCents(row.credit_cents)) continue;
    covered.add(row.type);
    if (row.code === "1100") covered.add("receivable");
    if (row.code === "2000") covered.add("payable");
  }
  return [...covered].sort();
}

function latestRun(db) {
  ensureDemoTables(db);
  const row = db.prepare("SELECT * FROM demo_check_runs ORDER BY created_at DESC, id DESC LIMIT 1").get();
  if (!row) return null;
  return {
    id: row.id,
    passed: row.passed === 1,
    result: row.passed === 1 ? "pass" : "fail",
    summary: row.summary,
    createdAt: row.created_at,
    createdAtLabel: formatWhen(row.created_at),
    checks: JSON.parse(row.detail),
  };
}

export function readDemo(db) {
  ensureDemo(db);
  const firm = demoFirm(db);
  const rows = db.prepare(
    `SELECT clients.id, clients.name, clients.industry, demo_scenarios.model, demo_scenarios.summary
     FROM clients
     JOIN demo_scenarios ON demo_scenarios.client_id = clients.id AND demo_scenarios.firm_id = clients.firm_id
     WHERE clients.firm_id = ?
     ORDER BY clients.position, clients.name`,
  ).all(firm.id);
  const scenarios = rows.map((row) => scenarioSnapshot(db, firm.id, row));
  const tasks = db.prepare(
    "SELECT source_type, source_id FROM work_tasks WHERE firm_id = ? AND source_type != ''",
  ).all(firm.id);
  const seen = new Set();
  let duplicates = 0;
  const sources = { uncategorized_group: 0, bill: 0, invoice: 0, document_request: 0 };
  for (const task of tasks) {
    const key = `${task.source_type}:${task.source_id}`;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
    if (Object.prototype.hasOwnProperty.call(sources, task.source_type)) sources[task.source_type] += 1;
  }
  return {
    status: 200,
    payload: {
      fictional: true,
      notice: NOTICE,
      firmName: firm.name,
      scenarioCount: scenarios.length,
      scenarios,
      sources,
      duplicateSources: duplicates,
      liveBank: false,
      signIn: { email: DEMO_OWNER.email, password: DEMO_OWNER.password, name: DEMO_OWNER.name },
      lastResult: latestRun(db),
    },
  };
}

export function resetDemo(db, session) {
  ensureDemoTables(db);
  const callerWasDemo = Boolean(session && demoFirm(db) && session.firm_id === demoFirm(db).id);
  wipeDemo(db);
  seedDemo(db);
  const replacement = callerWasDemo ? signIn(db, DEMO_OWNER.email, DEMO_OWNER.password) : null;
  return {
    status: 200,
    token: replacement?.token || "",
    payload: { ...readDemo(db).payload, session: replacement?.payload || null },
  };
}

export function runDemoChecks(db) {
  ensureDemo(db);
  let checks = [];
  try {
    checks = [...invariantChecks(db), ...behaviorChecks()];
  } catch (error) {
    checks.push({ name: "Checks finished", passed: false, detail: error.message });
  }
  storeRun(db, checks);
  return { status: 200, payload: readDemo(db).payload };
}
