import { randomUUID } from "node:crypto";
import { addCents, formatMoney, parseCents } from "../shared/money.js";
import { createInvoice, discardInvoice } from "./invoices.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  hourly_rate_cents INTEGER NOT NULL CHECK (hourly_rate_cents > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  work_id TEXT NOT NULL REFERENCES work_items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  worked_on TEXT NOT NULL,
  hours_hundredths INTEGER NOT NULL CHECK (hours_hundredths > 0),
  note TEXT NOT NULL,
  invoice_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS time_entries_by_firm ON time_entries (firm_id, client_id, worked_on);
CREATE INDEX IF NOT EXISTS work_items_by_client ON work_items (firm_id, client_id, name);
`;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const TITLES = { owner: "Owner", manager: "Manager", staff: "Staff" };

function fail(status, error) {
  return { status, error };
}

function audit(db, session, action, entityType, entityId, clientId = null) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityType, entityId, new Date().toISOString());
}

export function ensureTime(db) {
  db.exec(SCHEMA);
  const missing = db.prepare(
    `SELECT users.id, users.firm_id, users.role, users.created_at
     FROM users
     LEFT JOIN staff ON staff.user_id = users.id
     WHERE staff.id IS NULL`,
  ).all();
  const insert = db.prepare(
    "INSERT INTO staff (id, firm_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const user of missing) {
    insert.run(randomUUID(), user.firm_id, user.id, TITLES[user.role] || "Staff", user.created_at);
  }
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

function parseHours(value) {
  if (typeof value !== "string") return fail(400, "Enter hours as text, such as 1.50.");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return fail(400, "Enter hours with at most two decimal places.");
  const hundredths = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(hundredths) || hundredths <= 0 || hundredths > 2400) {
    return fail(400, "Enter hours greater than 0 and at most 24.");
  }
  return { hundredths };
}

function formatHours(hundredths) {
  const whole = Math.trunc(hundredths / 100);
  const frac = String(hundredths % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

function billCents(rateCents, hundredths) {
  return Math.round((rateCents * hundredths) / 100);
}

function centsText(cents) {
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

function viewer(db, session) {
  const user = db.prepare(
    "SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?",
  ).get(session.user_id, session.firm_id);
  if (!user) return null;
  return { ...user, firmWide: user.role === "owner" || user.role === "manager" };
}

function clientInFirm(db, session, clientId) {
  return db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
}

const ENTRY_SQL = `
  SELECT time_entries.*,
         clients.name AS client_name,
         work_items.name AS work_name,
         work_items.hourly_rate_cents,
         users.name AS person_name,
         invoices.number AS invoice_number,
         invoices.status AS invoice_status
  FROM time_entries
  JOIN clients ON clients.id = time_entries.client_id AND clients.firm_id = time_entries.firm_id
  JOIN work_items ON work_items.id = time_entries.work_id AND work_items.firm_id = time_entries.firm_id
  JOIN users ON users.id = time_entries.user_id AND users.firm_id = time_entries.firm_id
  LEFT JOIN invoices ON invoices.id = time_entries.invoice_id AND invoices.firm_id = time_entries.firm_id
`;

function entryJson(row) {
  const hundredths = Number(row.hours_hundredths);
  const rateCents = Number(row.hourly_rate_cents);
  const amountCents = billCents(rateCents, hundredths);
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    workId: row.work_id,
    workName: row.work_name,
    userId: row.user_id,
    personName: row.person_name,
    workedOn: row.worked_on,
    workedOnLabel: formatDate(row.worked_on),
    hours: formatHours(hundredths),
    hoursHundredths: hundredths,
    rate: formatMoney(rateCents),
    rateCents,
    amount: formatMoney(amountCents),
    amountCents,
    note: row.note,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number || "",
    invoiceStatus: row.invoice_status || "",
    billed: Boolean(row.invoice_id),
  };
}

function loadEntry(db, session, id, actor) {
  const row = db.prepare(`${ENTRY_SQL} WHERE time_entries.id = ? AND time_entries.firm_id = ?`).get(id, session.firm_id);
  if (!row) return null;
  if (!actor.firmWide && row.user_id !== actor.id) return null;
  return row;
}

export function listTime(db, session) {
  ensureTime(db);
  const actor = viewer(db, session);
  if (!actor) return fail(401, "Sign in required.");
  const staff = db.prepare(
    `SELECT staff.id, staff.user_id, staff.title, users.name, users.email, users.role
     FROM staff
     JOIN users ON users.id = staff.user_id AND users.firm_id = staff.firm_id
     WHERE staff.firm_id = ?
     ORDER BY users.name`,
  ).all(session.firm_id);
  const work = db.prepare(
    `SELECT work_items.*, clients.name AS client_name
     FROM work_items
     JOIN clients ON clients.id = work_items.client_id AND clients.firm_id = work_items.firm_id
     WHERE work_items.firm_id = ?
     ORDER BY clients.name, work_items.name`,
  ).all(session.firm_id);
  const rows = db.prepare(
    `${ENTRY_SQL}
     WHERE time_entries.firm_id = ?
       AND (? = 1 OR time_entries.user_id = ?)
     ORDER BY time_entries.worked_on DESC, users.name, time_entries.created_at DESC`,
  ).all(session.firm_id, actor.firmWide ? 1 : 0, actor.id);
  const entries = rows.map(entryJson);
  const byClient = [];
  for (const entry of entries) {
    let group = byClient.find((item) => item.clientId === entry.clientId);
    if (!group) {
      group = {
        clientId: entry.clientId,
        clientName: entry.clientName,
        hoursHundredths: 0,
        amountCents: 0,
        people: [],
        entryCount: 0,
      };
      byClient.push(group);
    }
    group.hoursHundredths += entry.hoursHundredths;
    group.amountCents = addCents(group.amountCents, entry.amountCents);
    group.entryCount += 1;
    if (!group.people.includes(entry.personName)) group.people.push(entry.personName);
  }
  return {
    status: 200,
    payload: {
      viewer: { id: actor.id, name: actor.name, role: actor.role, firmWide: actor.firmWide },
      staff: staff.map((person) => ({
        id: person.id,
        userId: person.user_id,
        name: person.name,
        email: person.email,
        role: person.role,
        title: person.title,
      })),
      work: work.map((item) => ({
        id: item.id,
        clientId: item.client_id,
        clientName: item.client_name,
        name: item.name,
        hourlyRate: formatMoney(Number(item.hourly_rate_cents)),
        hourlyRateCents: Number(item.hourly_rate_cents),
      })),
      entries,
      byClient: byClient.map((group) => ({
        ...group,
        hours: formatHours(group.hoursHundredths),
        amount: formatMoney(group.amountCents),
      })),
    },
  };
}

export function readTimeEntry(db, session, id) {
  ensureTime(db);
  const actor = viewer(db, session);
  if (!actor) return fail(401, "Sign in required.");
  const row = loadEntry(db, session, id, actor);
  if (!row) return fail(404, "Time entry not found.");
  return { status: 200, payload: { entry: entryJson(row) } };
}

export function createWork(db, session, input) {
  ensureTime(db);
  const body = input || {};
  const client = clientInFirm(db, session, body.clientId);
  if (!client) return fail(404, "Client not found.");
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return fail(400, "Enter a name for the work.");
  let rate = 0;
  try {
    rate = parseCents(body.hourlyRate);
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  if (rate <= 0) return fail(400, "Enter an hourly rate.");
  const duplicate = db.prepare(
    "SELECT id FROM work_items WHERE firm_id = ? AND client_id = ? AND lower(name) = lower(?)",
  ).get(session.firm_id, client.id, name);
  if (duplicate) return fail(409, "That work already exists for this client.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO work_items (id, firm_id, client_id, name, hourly_rate_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, session.firm_id, client.id, name, rate, session.user_id, now);
  audit(db, session, "work.created", "work_item", id, client.id);
  return {
    status: 201,
    payload: {
      work: {
        id,
        clientId: client.id,
        clientName: client.name,
        name,
        hourlyRate: formatMoney(rate),
        hourlyRateCents: rate,
      },
    },
  };
}

export function createTimeEntry(db, session, input) {
  ensureTime(db);
  const actor = viewer(db, session);
  if (!actor) return fail(401, "Sign in required.");
  const body = input || {};
  const client = clientInFirm(db, session, body.clientId);
  if (!client) return fail(404, "Client not found.");
  const work = db.prepare(
    "SELECT * FROM work_items WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(body.workId, session.firm_id, client.id);
  if (!work) return fail(404, "Work not found.");
  const workedOn = parseDate(body.workedOn);
  if (!workedOn) return fail(400, "Enter the date.");
  const hours = parseHours(body.hours);
  if (hours.error) return hours;
  const note = String(body.note || "").trim();
  if (note.length > 200) return fail(400, "Keep the note to 200 characters.");
  const staff = db.prepare("SELECT id FROM staff WHERE user_id = ? AND firm_id = ?").get(actor.id, session.firm_id);
  if (!staff) return fail(400, "This user has no staff record.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO time_entries (
      id, firm_id, client_id, work_id, user_id, staff_id, worked_on, hours_hundredths, note, invoice_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, session.firm_id, client.id, work.id, actor.id, staff.id, workedOn, hours.hundredths, note, now);
  audit(db, session, "time.logged", "time_entry", id, client.id);
  const row = loadEntry(db, session, id, actor);
  return { status: 201, payload: { entry: entryJson(row) } };
}

export function invoiceTime(db, session, input) {
  ensureTime(db);
  const actor = viewer(db, session);
  if (!actor) return fail(401, "Sign in required.");
  const body = input || {};
  if (!Array.isArray(body.entryIds) || body.entryIds.length < 1 || body.entryIds.length > 20) {
    return fail(400, "Select at least one time entry.");
  }
  const ids = [...new Set(body.entryIds.map((id) => String(id || "")))];
  const rows = [];
  for (const id of ids) {
    const row = loadEntry(db, session, id, actor);
    if (!row) return fail(404, "Time entry not found.");
    if (row.invoice_id) return fail(400, "That time is already on an invoice.");
    rows.push(row);
  }
  const clientId = rows[0].client_id;
  if (rows.some((row) => row.client_id !== clientId)) return fail(400, "Choose time for one client.");
  if (clientId !== session.selected_client_id) return fail(400, "Open that client before creating the invoice.");
  const lines = rows.map((row) => {
    const amount = billCents(Number(row.hourly_rate_cents), Number(row.hours_hundredths));
    const description = `${row.work_name} · ${row.person_name} · ${formatHours(Number(row.hours_hundredths))} hours`;
    return { description: description.slice(0, 120), amount: centsText(amount), amountCents: amount };
  });
  const client = clientInFirm(db, session, clientId);
  const created = createInvoice(db, session, {
    customerName: client.name,
    issueDate: body.issueDate,
    dueDate: body.dueDate,
    memo: "Time",
    lines: lines.map((line) => ({ description: line.description, amount: line.amount })),
  });
  if (created.error) return created;
  const invoiceId = created.payload.invoice.id;
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(
      "UPDATE time_entries SET invoice_id = ? WHERE id = ? AND firm_id = ? AND invoice_id IS NULL",
    );
    for (const row of rows) {
      const result = update.run(invoiceId, row.id, session.firm_id);
      if (Number(result.changes) !== 1) throw new Error("already billed");
    }
    audit(db, session, "time.invoiced", "invoice", invoiceId, clientId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    discardInvoice(db, session, invoiceId);
    if (error.message === "already billed") return fail(409, "That time is already on an invoice.");
    throw error;
  }
  const entries = rows.map((row) => entryJson({ ...row, invoice_id: invoiceId, invoice_number: created.payload.invoice.number, invoice_status: "draft" }));
  const amountCents = lines.reduce((sum, line) => addCents(sum, line.amountCents), 0);
  return {
    status: 201,
    payload: {
      invoice: created.payload.invoice,
      entries,
      amountCents,
    },
  };
}

export function releaseInvoicedTime(db, session, invoiceId) {
  ensureTime(db);
  db.prepare(
    "UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ? AND firm_id = ?",
  ).run(invoiceId, session.firm_id);
}
