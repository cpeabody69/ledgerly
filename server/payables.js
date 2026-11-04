import { randomUUID } from "node:crypto";
import { addCents, formatMoney, parseCents } from "../shared/money.js";
import { postJournalEntry } from "./ledger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ap_vendors (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',
  default_account_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ap_vendors_by_client ON ap_vendors (firm_id, client_id, name);

CREATE TABLE IF NOT EXISTS ap_bills (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  vendor_id TEXT NOT NULL REFERENCES ap_vendors(id),
  invoice_number TEXT NOT NULL,
  bill_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'posted', 'void')),
  document_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  journal_entry_id TEXT,
  void_entry_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ap_bills_by_client ON ap_bills (firm_id, client_id, bill_date);
CREATE INDEX IF NOT EXISTS ap_bills_by_vendor ON ap_bills (firm_id, vendor_id);

CREATE TABLE IF NOT EXISTS ap_bill_lines (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  bill_id TEXT NOT NULL REFERENCES ap_bills(id),
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
  CHECK (amount_cents + tax_cents > 0)
);

CREATE INDEX IF NOT EXISTS ap_bill_lines_by_bill ON ap_bill_lines (firm_id, bill_id, position);
`;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUS_LABEL = {
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  posted: "Posted",
  void: "Void",
};

function fail(status, error, payload) {
  return payload ? { status, error, payload } : { status, error };
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function audit(db, session, action, entityType, entityId) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, session.selected_client_id, entityType, entityId, new Date().toISOString());
}

export function ensurePayables(db) {
  db.exec(SCHEMA);
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

function cleanText(value, max, label, { required = false } = {}) {
  const text = String(value || "").trim();
  if (required && !text) return { error: `Enter ${label}.` };
  if (text.length > max) return { error: `Keep ${label} to ${max} characters.` };
  return { text };
}

function parseEmail(value) {
  const email = String(value || "").trim();
  if (!email) return { text: "" };
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email." };
  return { text: email };
}

function parsePhone(value) {
  const phone = String(value || "").trim();
  if (!phone) return { text: "" };
  if (phone.length > 40 || !/^[0-9+().\-\s]+$/.test(phone)) return { error: "Enter a phone number." };
  return { text: phone };
}

function accountChoices(db, session) {
  return db.prepare(
    `SELECT id, code, name, type FROM accounts
     WHERE firm_id = ? AND client_id = ? AND type IN ('expense', 'asset') AND code != '2000'
     ORDER BY code`,
  ).all(session.firm_id, session.selected_client_id);
}

function payableAccount(db, session) {
  return db.prepare(
    "SELECT id, code, name FROM accounts WHERE firm_id = ? AND client_id = ? AND code = '2000'",
  ).get(session.firm_id, session.selected_client_id);
}

function loadVendors(db, session) {
  return db.prepare(
    `SELECT ap_vendors.*, accounts.code AS default_account_code, accounts.name AS default_account_name
     FROM ap_vendors
     LEFT JOIN accounts ON accounts.id = ap_vendors.default_account_id
       AND accounts.firm_id = ap_vendors.firm_id
       AND accounts.client_id = ap_vendors.client_id
     WHERE ap_vendors.firm_id = ? AND ap_vendors.client_id = ?
     ORDER BY ap_vendors.name, ap_vendors.created_at`,
  ).all(session.firm_id, session.selected_client_id);
}

function loadBills(db, session) {
  return db.prepare(
    `SELECT ap_bills.*, ap_vendors.name AS vendor_name, client_files.name AS document_name,
            journal_entries.reference AS journal_reference
     FROM ap_bills
     JOIN ap_vendors ON ap_vendors.id = ap_bills.vendor_id
       AND ap_vendors.firm_id = ap_bills.firm_id
       AND ap_vendors.client_id = ap_bills.client_id
     LEFT JOIN client_files ON client_files.id = ap_bills.document_id
       AND client_files.firm_id = ap_bills.firm_id
       AND client_files.client_id = ap_bills.client_id
     LEFT JOIN journal_entries ON journal_entries.id = ap_bills.journal_entry_id
       AND journal_entries.firm_id = ap_bills.firm_id
       AND journal_entries.client_id = ap_bills.client_id
     WHERE ap_bills.firm_id = ? AND ap_bills.client_id = ?
     ORDER BY ap_bills.bill_date DESC, ap_bills.created_at DESC`,
  ).all(session.firm_id, session.selected_client_id);
}

function loadLines(db, session, billIds) {
  if (!billIds.length) return [];
  const marks = billIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT ap_bill_lines.*, accounts.code AS account_code, accounts.name AS account_name, accounts.type AS account_type
     FROM ap_bill_lines
     JOIN accounts ON accounts.id = ap_bill_lines.account_id
       AND accounts.firm_id = ap_bill_lines.firm_id
       AND accounts.client_id = ap_bill_lines.client_id
     WHERE ap_bill_lines.firm_id = ? AND ap_bill_lines.client_id = ? AND ap_bill_lines.bill_id IN (${marks})
     ORDER BY ap_bill_lines.position`,
  ).all(session.firm_id, session.selected_client_id, ...billIds);
}

function lineJson(row) {
  const amountCents = asCents(row.amount_cents);
  const taxCents = asCents(row.tax_cents);
  return {
    id: row.id,
    description: row.description,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    amountCents,
    taxCents,
    amount: formatMoney(amountCents),
    tax: formatMoney(taxCents),
    lineTotal: formatMoney(addCents(amountCents, taxCents)),
  };
}

function billJson(row, lines) {
  const totalCents = asCents(row.total_cents);
  const taxCents = asCents(row.tax_cents);
  return {
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    invoiceNumber: row.invoice_number,
    billDate: row.bill_date,
    billDateLabel: formatDate(row.bill_date),
    dueDate: row.due_date,
    dueDateLabel: formatDate(row.due_date),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    documentId: row.document_id,
    documentName: row.document_name || "",
    notes: row.notes,
    totalCents,
    taxCents,
    total: formatMoney(totalCents),
    tax: formatMoney(taxCents),
    journalEntryId: row.journal_entry_id,
    journalReference: row.journal_reference || "",
    voidEntryId: row.void_entry_id,
    lines: lines.map(lineJson),
  };
}

function vendorJson(row, bills) {
  const posted = bills.filter((bill) => bill.vendorId === row.id && bill.status === "posted");
  const outstandingCents = posted.reduce((sum, bill) => addCents(sum, bill.totalCents), 0);
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    address: row.address,
    email: row.email,
    phone: row.phone,
    terms: row.terms,
    defaultAccountId: row.default_account_id,
    defaultAccountCode: row.default_account_code || "",
    defaultAccountName: row.default_account_name || "",
    notes: row.notes,
    outstandingCents,
    outstanding: formatMoney(outstandingCents),
    invoiceHistory: bills.filter((bill) => bill.vendorId === row.id).map((bill) => ({
      id: bill.id,
      invoiceNumber: bill.invoiceNumber,
      billDate: bill.billDate,
      billDateLabel: bill.billDateLabel,
      dueDate: bill.dueDate,
      status: bill.status,
      statusLabel: bill.statusLabel,
      total: bill.total,
      totalCents: bill.totalCents,
    })),
    payments: [],
  };
}

function moneyBucket(rows) {
  const cents = rows.reduce((sum, bill) => addCents(sum, bill.totalCents), 0);
  return { count: rows.length, cents, amount: formatMoney(cents) };
}

function dashboardFor(bills, today) {
  const weekEnd = addDays(today, 6);
  const posted = bills.filter((bill) => bill.status === "posted");
  return {
    asOf: today,
    outstanding: moneyBucket(posted),
    dueThisWeek: moneyBucket(posted.filter((bill) => bill.dueDate >= today && bill.dueDate <= weekEnd)),
    overdue: moneyBucket(posted.filter((bill) => bill.dueDate < today)),
    awaitingApproval: moneyBucket(bills.filter((bill) => bill.status === "awaiting_approval")),
  };
}

function books(db, session) {
  const accounts = accountChoices(db, session);
  const vendors = loadVendors(db, session);
  const billRows = loadBills(db, session);
  const lines = loadLines(db, session, billRows.map((row) => row.id));
  const byBill = new Map();
  for (const line of lines) {
    const list = byBill.get(line.bill_id) || [];
    list.push(line);
    byBill.set(line.bill_id, list);
  }
  const bills = billRows.map((row) => billJson(row, byBill.get(row.id) || []));
  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
    })),
    bills,
    vendors: vendors.map((row) => vendorJson(row, bills)),
    dashboard: dashboardFor(bills, todayIso()),
  };
}

export function readPayables(db, session, clientId) {
  ensurePayables(db);
  if (clientId && clientId !== session.selected_client_id) return fail(404, "Client not found.");
  return {
    status: 200,
    payload: {
      client: { id: session.selected_client_id },
      ...books(db, session),
    },
  };
}

function vendorInput(db, session, body) {
  const name = cleanText(body.name, 120, "a vendor name", { required: true });
  if (name.error) return fail(400, name.error);
  const contact = cleanText(body.contactName, 120, "the contact name");
  if (contact.error) return fail(400, contact.error);
  const address = cleanText(body.address, 300, "the address");
  if (address.error) return fail(400, address.error);
  const email = parseEmail(body.email);
  if (email.error) return fail(400, email.error);
  const phone = parsePhone(body.phone);
  if (phone.error) return fail(400, phone.error);
  const terms = cleanText(body.terms, 40, "the terms");
  if (terms.error) return fail(400, terms.error);
  const notes = cleanText(body.notes, 2000, "the notes");
  if (notes.error) return fail(400, notes.error);
  let defaultAccountId = null;
  if (body.defaultAccountId) {
    const account = accountChoices(db, session).find((row) => row.id === body.defaultAccountId);
    if (!account) return fail(400, "Choose a default expense or asset account from this client's chart.");
    defaultAccountId = account.id;
  }
  return {
    value: {
      name: name.text,
      contactName: contact.text,
      address: address.text,
      email: email.text,
      phone: phone.text,
      terms: terms.text,
      defaultAccountId,
      notes: notes.text,
    },
  };
}

export function createVendor(db, session, input) {
  ensurePayables(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const parsed = vendorInput(db, session, body);
  if (parsed.error) return parsed;
  const id = randomUUID();
  const now = new Date().toISOString();
  const vendor = parsed.value;
  db.prepare(
    `INSERT INTO ap_vendors (
      id, firm_id, client_id, name, contact_name, address, email, phone, terms, default_account_id, notes, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session.firm_id,
    session.selected_client_id,
    vendor.name,
    vendor.contactName,
    vendor.address,
    vendor.email,
    vendor.phone,
    vendor.terms,
    vendor.defaultAccountId,
    vendor.notes,
    session.user_id,
    now,
    now,
  );
  audit(db, session, "vendor.created", "ap_vendor", id);
  const stored = books(db, session).vendors.find((row) => row.id === id);
  return { status: 201, payload: { vendor: stored } };
}

export function updateVendor(db, session, vendorId, input) {
  ensurePayables(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const existing = db.prepare(
    "SELECT id FROM ap_vendors WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(vendorId, session.firm_id, session.selected_client_id);
  if (!existing) return fail(404, "Vendor not found.");
  const parsed = vendorInput(db, session, body);
  if (parsed.error) return parsed;
  const vendor = parsed.value;
  db.prepare(
    `UPDATE ap_vendors
     SET name = ?, contact_name = ?, address = ?, email = ?, phone = ?, terms = ?, default_account_id = ?, notes = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ?`,
  ).run(
    vendor.name,
    vendor.contactName,
    vendor.address,
    vendor.email,
    vendor.phone,
    vendor.terms,
    vendor.defaultAccountId,
    vendor.notes,
    new Date().toISOString(),
    vendorId,
    session.firm_id,
    session.selected_client_id,
  );
  audit(db, session, "vendor.updated", "ap_vendor", vendorId);
  const stored = books(db, session).vendors.find((row) => row.id === vendorId);
  return { status: 200, payload: { vendor: stored } };
}

function parseLines(db, session, body) {
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 39) {
    return fail(400, "Add between 1 and 39 lines.");
  }
  const allowed = new Map(accountChoices(db, session).map((account) => [account.id, account]));
  const lines = [];
  let totalCents = 0;
  let taxCents = 0;
  for (const raw of body.lines) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "Each line needs an account and an amount.");
    const description = cleanText(raw.description, 200, "a line description", { required: true });
    if (description.error) return fail(400, description.error);
    const account = allowed.get(raw.accountId);
    if (!account) return fail(400, "Choose an expense or asset account from this client's chart.");
    let amount = 0;
    let tax = 0;
    try {
      amount = parseCents(raw.amount, { blank: true });
      tax = parseCents(raw.tax, { blank: true });
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    if (amount < 0 || tax < 0 || amount + tax <= 0) return fail(400, "Enter an amount on each line.");
    totalCents = addCents(totalCents, addCents(amount, tax));
    taxCents = addCents(taxCents, tax);
    lines.push({ description: description.text, accountId: account.id, amountCents: amount, taxCents: tax });
  }
  if (totalCents <= 0) return fail(400, "Enter an amount.");
  if (Object.prototype.hasOwnProperty.call(body, "total") && body.total !== "" && body.total != null) {
    let stated = 0;
    try {
      stated = parseCents(String(body.total));
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    if (stated !== totalCents) return fail(400, "Debits and credits must be equal.");
  }
  return { lines, totalCents, taxCents };
}

function documentIdFor(db, session, body) {
  const documentId = body.documentId ? String(body.documentId) : "";
  if (!documentId) return { id: null };
  const file = db.prepare(
    "SELECT id FROM client_files WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(documentId, session.firm_id, session.selected_client_id);
  if (!file) return fail(404, "File not found.");
  return { id: file.id };
}

function billHeader(db, session, body) {
  const vendor = db.prepare(
    "SELECT id, name FROM ap_vendors WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(body.vendorId, session.firm_id, session.selected_client_id);
  if (!vendor) return fail(400, "Choose a vendor.");
  const invoiceNumber = cleanText(body.invoiceNumber, 40, "an invoice number", { required: true });
  if (invoiceNumber.error) return fail(400, invoiceNumber.error);
  const billDate = parseDate(body.billDate);
  if (!billDate) return fail(400, "Enter the bill date.");
  const dueDate = parseDate(body.dueDate);
  if (!dueDate) return fail(400, "Enter the due date.");
  if (dueDate < billDate) return fail(400, "The due date cannot be before the bill date.");
  const notes = cleanText(body.notes, 2000, "the notes");
  if (notes.error) return fail(400, notes.error);
  const parsedLines = parseLines(db, session, body);
  if (parsedLines.error) return parsedLines;
  const document = documentIdFor(db, session, body);
  if (document.error) return document;
  return {
    vendor,
    invoiceNumber: invoiceNumber.text,
    billDate,
    dueDate,
    notes: notes.text,
    documentId: document.id,
    ...parsedLines,
  };
}

function findDuplicate(db, session, header, exceptId = "") {
  return db.prepare(
    `SELECT ap_bills.id, ap_bills.invoice_number, ap_vendors.name AS vendor_name
     FROM ap_bills
     JOIN ap_vendors ON ap_vendors.id = ap_bills.vendor_id AND ap_vendors.firm_id = ap_bills.firm_id
     WHERE ap_bills.firm_id = ? AND ap_bills.client_id = ? AND ap_bills.vendor_id = ?
       AND lower(ap_bills.invoice_number) = lower(?)
       AND ap_bills.bill_date = ? AND ap_bills.total_cents = ? AND ap_bills.status != 'void' AND ap_bills.id != ?`,
  ).get(
    session.firm_id,
    session.selected_client_id,
    header.vendor.id,
    header.invoiceNumber,
    header.billDate,
    header.totalCents,
    exceptId,
  );
}

function duplicateResult(row) {
  return fail(409, "A bill from this vendor with the same invoice number, amount, and date is already on file.", {
    duplicate: { id: row.id, invoiceNumber: row.invoice_number, vendorName: row.vendor_name },
  });
}

function insertLines(db, session, billId, lines) {
  const insert = db.prepare(
    `INSERT INTO ap_bill_lines (
      id, firm_id, client_id, bill_id, position, description, account_id, amount_cents, tax_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((line, position) => {
    insert.run(randomUUID(), session.firm_id, session.selected_client_id, billId, position, line.description, line.accountId, line.amountCents, line.taxCents);
  });
}

function storedBill(db, session, id) {
  return books(db, session).bills.find((bill) => bill.id === id) || null;
}

export function createBill(db, session, input) {
  ensurePayables(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const header = billHeader(db, session, body);
  if (header.error) return header;
  if (body.confirmDuplicate !== true) {
    const duplicate = findDuplicate(db, session, header);
    if (duplicate) return duplicateResult(duplicate);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO ap_bills (
        id, firm_id, client_id, vendor_id, invoice_number, bill_date, due_date, status, document_id, notes,
        total_cents, tax_cents, journal_entry_id, void_entry_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      id,
      session.firm_id,
      session.selected_client_id,
      header.vendor.id,
      header.invoiceNumber,
      header.billDate,
      header.dueDate,
      header.documentId,
      header.notes,
      header.totalCents,
      header.taxCents,
      session.user_id,
      now,
      now,
    );
    insertLines(db, session, id, header.lines);
    audit(db, session, "bill.saved", "ap_bill", id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { status: 201, payload: { bill: storedBill(db, session, id) } };
}

function loadOwnedBill(db, session, billId) {
  return db.prepare(
    "SELECT * FROM ap_bills WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(billId, session.firm_id, session.selected_client_id);
}

export function updateBill(db, session, billId, input) {
  ensurePayables(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const existing = loadOwnedBill(db, session, billId);
  if (!existing) return fail(404, "Bill not found.");
  if (existing.status !== "draft" && existing.status !== "awaiting_approval") {
    return fail(400, "A posted bill cannot be edited. Void it to reverse the journal.");
  }
  const header = billHeader(db, session, body);
  if (header.error) return header;
  if (body.confirmDuplicate !== true) {
    const duplicate = findDuplicate(db, session, header, billId);
    if (duplicate) return duplicateResult(duplicate);
  }
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE ap_bills
       SET vendor_id = ?, invoice_number = ?, bill_date = ?, due_date = ?, document_id = ?, notes = ?,
           total_cents = ?, tax_cents = ?, updated_at = ?
       WHERE id = ? AND firm_id = ? AND client_id = ? AND status IN ('draft', 'awaiting_approval')`,
    ).run(
      header.vendor.id,
      header.invoiceNumber,
      header.billDate,
      header.dueDate,
      header.documentId,
      header.notes,
      header.totalCents,
      header.taxCents,
      new Date().toISOString(),
      billId,
      session.firm_id,
      session.selected_client_id,
    );
    db.prepare("DELETE FROM ap_bill_lines WHERE bill_id = ? AND firm_id = ? AND client_id = ?").run(billId, session.firm_id, session.selected_client_id);
    insertLines(db, session, billId, header.lines);
    audit(db, session, "bill.saved", "ap_bill", billId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { status: 200, payload: { bill: storedBill(db, session, billId) } };
}

export function submitBill(db, session, billId) {
  ensurePayables(db);
  const existing = loadOwnedBill(db, session, billId);
  if (!existing) return fail(404, "Bill not found.");
  if (existing.status !== "draft") return fail(400, "Only a draft can be submitted for approval.");
  db.prepare(
    "UPDATE ap_bills SET status = 'awaiting_approval', updated_at = ? WHERE id = ? AND firm_id = ? AND client_id = ? AND status = 'draft'",
  ).run(new Date().toISOString(), billId, session.firm_id, session.selected_client_id);
  audit(db, session, "bill.submitted", "ap_bill", billId);
  return { status: 200, payload: { bill: storedBill(db, session, billId) } };
}

function postingLines(db, session, billId, totalCents) {
  const payable = payableAccount(db, session);
  if (!payable) return fail(400, "This client's chart is missing accounts payable.");
  const rows = db.prepare(
    `SELECT account_id, amount_cents, tax_cents FROM ap_bill_lines
     WHERE bill_id = ? AND firm_id = ? AND client_id = ? ORDER BY position`,
  ).all(billId, session.firm_id, session.selected_client_id);
  if (!rows.length) return fail(400, "Add a line before posting.");
  let debitTotal = 0;
  const lines = [];
  for (const row of rows) {
    const cents = addCents(asCents(row.amount_cents), asCents(row.tax_cents));
    if (cents <= 0) return fail(400, "Enter an amount on each line.");
    debitTotal = addCents(debitTotal, cents);
    lines.push({ accountId: row.account_id, debit: centsText(cents), credit: "" });
  }
  if (debitTotal !== totalCents || debitTotal <= 0) return fail(400, "Debits and credits must be equal.");
  lines.push({ accountId: payable.id, debit: "", credit: centsText(totalCents) });
  const creditTotal = totalCents;
  if (debitTotal !== creditTotal) return fail(400, "Debits and credits must be equal.");
  return { lines };
}

export function postBill(db, session, billId, input) {
  ensurePayables(db);
  const body = input || {};
  const mismatch = sameClient(session, body);
  if (mismatch) return mismatch;
  const existing = loadOwnedBill(db, session, billId);
  if (!existing) return fail(404, "Bill not found.");
  if (existing.status !== "awaiting_approval") return fail(400, "Post a bill that is awaiting approval.");
  const totalCents = asCents(existing.total_cents);
  if (Object.prototype.hasOwnProperty.call(body, "total") && body.total !== "" && body.total != null) {
    let stated = 0;
    try {
      stated = parseCents(String(body.total));
    } catch (error) {
      return fail(error.status || 400, error.message);
    }
    if (stated !== totalCents) return fail(400, "Debits and credits must be equal.");
  }
  const built = postingLines(db, session, billId, totalCents);
  if (built.error) return built;
  const vendor = db.prepare(
    "SELECT name FROM ap_vendors WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(existing.vendor_id, session.firm_id, session.selected_client_id);
  const memo = `${vendor?.name || "Vendor"} ${existing.invoice_number}`.trim().slice(0, 200);
  const posted = postJournalEntry(db, session, {
    entryDate: existing.bill_date,
    memo,
    lines: built.lines,
  });
  if (posted.error) return posted;
  const updated = db.prepare(
    `UPDATE ap_bills SET status = 'posted', journal_entry_id = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ? AND status = 'awaiting_approval'`,
  ).run(posted.payload.entry.id, new Date().toISOString(), billId, session.firm_id, session.selected_client_id);
  if (Number(updated.changes) !== 1) return fail(400, "Post a bill that is awaiting approval.");
  audit(db, session, "bill.posted", "ap_bill", billId);
  return { status: 200, payload: { bill: storedBill(db, session, billId), entry: posted.payload.entry } };
}

export function voidBill(db, session, billId) {
  ensurePayables(db);
  const existing = loadOwnedBill(db, session, billId);
  if (!existing) return fail(404, "Bill not found.");
  if (existing.status === "void") return fail(400, "This bill is already void.");
  let entry = null;
  if (existing.status === "posted") {
    if (!existing.journal_entry_id) return fail(400, "This posted bill has no journal to reverse.");
    const original = db.prepare(
      `SELECT account_id, debit_cents, credit_cents FROM journal_lines
       WHERE entry_id = ? AND firm_id = ? AND client_id = ? ORDER BY position`,
    ).all(existing.journal_entry_id, session.firm_id, session.selected_client_id);
    if (original.length < 2) return fail(400, "This posted bill has no journal to reverse.");
    const reversal = original.map((line) => ({
      accountId: line.account_id,
      debit: asCents(line.credit_cents) ? centsText(asCents(line.credit_cents)) : "",
      credit: asCents(line.debit_cents) ? centsText(asCents(line.debit_cents)) : "",
    }));
    const entryDate = [todayIso(), existing.bill_date].sort().at(-1);
    const posted = postJournalEntry(db, session, {
      entryDate,
      memo: `Void ${existing.invoice_number}`.slice(0, 200),
      lines: reversal,
    });
    if (posted.error) return posted;
    entry = posted.payload.entry;
  }
  const updated = db.prepare(
    `UPDATE ap_bills SET status = 'void', void_entry_id = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ? AND status = ?`,
  ).run(entry?.id || null, new Date().toISOString(), billId, session.firm_id, session.selected_client_id, existing.status);
  if (Number(updated.changes) !== 1) return fail(400, "This bill is already void.");
  audit(db, session, "bill.voided", "ap_bill", billId);
  return { status: 200, payload: { bill: storedBill(db, session, billId), entry } };
}
