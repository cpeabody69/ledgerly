// Public Avenue Pro demo. Each visitor gets a copy of a fictional firm in a
// database directory that is not the practice database. Sessions expire and the
// copy is deleted. The known demo password is replaced before a visitor enters.
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDocumentRequest } from "./documents.js";
import { updateCloseStatus } from "./close.js";
import { DEMO_OWNER, ensureDemo } from "./demo.js";
import { hashPassword, openDatabase, openFirmSession } from "./db.js";
import { ensureCharts, postJournalEntry } from "./ledger.js";
import { saveTaxProfile } from "./tax-intel.js";
import { readWork } from "./work.js";

const PUBLIC_COOKIE = "ledgerly_public_demo";
const FIRM_NAME = "Avenue Pro Demo (fictional)";
const NOTICE = "Avenue Pro is in development. This temporary firm is fictional, expires on its own, and is not a customer record.";

const BLOCKED = new Set([
  "POST /api/documents",
  "POST /api/plaid/link-token",
  "POST /api/plaid/exchange",
  "POST /api/plaid/sync",
  "POST /api/plaid/disconnect",
  "POST /api/quickbooks/connect",
  "POST /api/quickbooks/disconnect",
  "POST /api/quickbooks/sync",
  "POST /api/quickbooks/authority",
  "POST /api/subscription/checkout",
  "POST /api/subscription/checkout/confirm",
  "POST /api/subscription/plan",
  "POST /api/subscription/cancel",
  "POST /api/onboarding/firm",
  "POST /api/onboarding/enter",
  "POST /api/onboarding/workspace",
  "POST /api/onboarding/templates",
  "POST /api/members",
  "POST /api/portal/files",
  "POST /api/assistant",
  "POST /api/demo/reset",
  "POST /api/demo/checks",
]);

const FEATURES = new Set([
  "session",
  "tour",
  "dashboard",
  "clients",
  "transactions",
  "statements",
  "close",
  "tax",
  "invoices",
  "portal",
  "queue",
  "reset",
  "beta",
  "personal-demo",
]);

const EXTRAS = [
  ["Maple Hearth Bakery (fictional)", "MH", "Restaurant", "business", "Sole proprietorship"],
  ["Linden Law Office (fictional)", "LL", "Legal services", "business", "Partnership"],
  ["Cedar Clinic (fictional)", "CC", "Medical practice", "business", "LLC"],
  ["River Grant Fund (fictional)", "RG", "Nonprofit", "business", "Nonprofit"],
  ["Hilltop Orchard (fictional)", "HO", "Farm", "business", "Sole proprietorship"],
  ["Bloom Room Salon (fictional)", "BR", "Personal care", "business", "LLC"],
  ["Red Route Trucking (fictional)", "RR", "Transportation", "business", "LLC"],
  ["Keystone Rentals (fictional)", "KR", "Property management", "business", "LLC"],
  ["June Harper (fictional)", "JH", "Tutoring", "individual", ""],
  ["Little Lantern Daycare (fictional)", "LD", "Child care", "business", "LLC"],
  ["Page & Binding Books (fictional)", "PB", "Bookstore", "business", "Sole proprietorship"],
  ["Iron Hour Gym (fictional)", "IG", "Fitness", "business", "LLC"],
  ["Copper Kettle Brewery (fictional)", "CK", "Beverage", "business", "LLC"],
  ["Frame North Photography (fictional)", "FN", "Photography", "business", "Sole proprietorship"],
  ["Clear Window Cleaning (fictional)", "CW", "Cleaning", "business", "Sole proprietorship"],
  ["Green Mile Landscaping (fictional)", "GM", "Landscaping", "business", "Partnership"],
  ["Harborlight Dental (fictional)", "HD", "Dental", "business", "S corporation"],
  ["Axle & Elm Auto (fictional)", "AE", "Auto repair", "business", "LLC"],
  ["Petal Street Florist (fictional)", "PF", "Florist", "business", "Sole proprietorship"],
  ["Evan Moss (fictional)", "EM", "Consulting", "individual", ""],
  ["Kind Paws Veterinary (fictional)", "KP", "Veterinary", "business", "LLC"],
  ["North Mill Fabrication (fictional)", "NM", "Manufacturing", "business", "C corporation"],
];

function day(offset) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayNumber = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayNumber}`;
}

function quoteName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Unexpected table.");
  return name;
}

function must(result, label) {
  if (!result || result.error || result.status >= 400) {
    throw new Error(`${label}: ${result?.error || `status ${result?.status || "unknown"}`}`);
  }
  return result;
}

function deleteFirms(db, ids) {
  if (!ids.length) return;
  for (const name of ["journal_entries_no_update", "journal_entries_no_delete", "journal_lines_no_update", "journal_lines_no_delete"]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
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
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the one to surface.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  ensureCharts(db);
  const guard = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'journal_entries_no_delete'").get();
  if (!guard) throw new Error("Journal delete protection was not restored.");
}

function postBalanced(db, session, entryDate, memo, lines) {
  const accountId = (code) => {
    const row = db.prepare(
      "SELECT id FROM accounts WHERE firm_id = ? AND client_id = ? AND code = ?",
    ).get(session.firm_id, session.selected_client_id, code);
    if (!row) throw new Error(`Account ${code} is missing.`);
    return row.id;
  };
  must(postJournalEntry(db, session, {
    entryDate,
    memo,
    lines: lines.map((line) => ({
      accountId: accountId(line.code),
      debit: line.debit || "",
      credit: line.credit || "",
    })),
  }), memo);
}

function money(cents) {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function buildTemplate(file) {
  const db = openDatabase(file);
  try {
    ensureDemo(db);
    const practice = db.prepare("SELECT id FROM firms WHERE demo = 0").all().map((row) => row.id);
    deleteFirms(db, practice);
    const firm = db.prepare("SELECT id FROM firms WHERE demo = 1").get();
    if (!firm) throw new Error("The fictional demo firm was not created.");
    db.prepare("UPDATE firms SET name = ? WHERE id = ?").run(FIRM_NAME, firm.id);
    db.prepare("UPDATE users SET password_hash = ? WHERE firm_id = ?").run(hashPassword(randomBytes(24).toString("hex")), firm.id);
    const owner = db.prepare("SELECT id FROM users WHERE firm_id = ? AND role = 'owner'").get(firm.id);
    const now = new Date().toISOString();
    const insertUser = db.prepare(
      "INSERT INTO users (id, firm_id, email, name, role, password_hash, invited_by, created_at) VALUES (?, ?, ?, ?, 'accountant', ?, ?, ?)",
    );
    insertUser.run(randomUUID(), firm.id, "riley.cole@avenue-pro-demo.example", "Riley Cole", hashPassword(randomBytes(24).toString("hex")), owner.id, now);
    insertUser.run(randomUUID(), firm.id, "jordan.blake@avenue-pro-demo.example", "Jordan Blake", hashPassword(randomBytes(24).toString("hex")), owner.id, now);
    const insertClient = db.prepare(
      "INSERT INTO clients (id, firm_id, name, legal_name, initials, industry, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    EXTRAS.forEach((spec, index) => {
      insertClient.run(randomUUID(), firm.id, spec[0], spec[0], spec[1], spec[2], index + 3, now);
    });
    ensureCharts(db);
    const session = { firm_id: firm.id, user_id: owner.id, selected_client_id: "" };
    EXTRAS.forEach((spec, index) => {
      const client = db.prepare("SELECT id FROM clients WHERE firm_id = ? AND name = ?").get(firm.id, spec[0]);
      session.selected_client_id = client.id;
      const opening = 500000 + index * 10000;
      const income = 40000 + index * 1500;
      postBalanced(db, session, day(-40), `Fictional opening balance for ${spec[0]}`, [
        { code: "1000", debit: money(opening) },
        { code: "3000", credit: money(opening) },
      ]);
      postBalanced(db, session, day(-12), `Fictional service income for ${spec[0]}`, [
        { code: "1000", debit: money(income) },
        { code: "4000", credit: money(income) },
      ]);
      db.prepare(
        "UPDATE clients SET client_kind = ?, business_type = ?, services = ?, contact_name = ? WHERE id = ? AND firm_id = ?",
      ).run(spec[3], spec[4], JSON.stringify(["bookkeeping"]), "Fictional contact", client.id, firm.id);
    });
    const bakery = db.prepare("SELECT id FROM clients WHERE firm_id = ? AND name = ?").get(firm.id, EXTRAS[0][0]);
    session.selected_client_id = bakery.id;
    must(createDocumentRequest(db, session, {
      clientId: bakery.id,
      title: "Fictional monthly statement",
      dueOn: day(14),
    }), "bakery request");
    must(updateCloseStatus(db, session, bakery.id, { period: "2026-10", status: "under_review" }), "bakery close");
    const studio = db.prepare("SELECT id FROM clients WHERE firm_id = ? AND name = ?").get(firm.id, "Northwind Studio (fictional)");
    session.selected_client_id = studio.id;
    must(updateCloseStatus(db, session, studio.id, { period: "2026-10", status: "in_progress" }), "studio close");
    must(saveTaxProfile(db, session, studio.id, {
      year: 2026,
      entityType: "sole_proprietor",
      filingStatus: "single",
      otherWages: "0.00",
    }), "studio tax");
    const mill = db.prepare("SELECT id FROM clients WHERE firm_id = ? AND name = ?").get(firm.id, "North Mill Fabrication (fictional)");
    session.selected_client_id = mill.id;
    must(saveTaxProfile(db, session, mill.id, {
      year: 2026,
      entityType: "corporation",
      filingStatus: "unset",
    }), "corporation tax");
    const portalClient = studio.id;
    db.prepare(
      "INSERT INTO client_users (id, firm_id, client_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      firm.id,
      portalClient,
      "casey.brooks@avenue-pro-demo.example",
      "Casey Brooks",
      hashPassword(randomBytes(24).toString("hex")),
      now,
    );
    db.exec("CREATE TABLE IF NOT EXISTS public_demo_marker (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO public_demo_marker (id) VALUES ('1')").run();
    must(readWork(db, session), "work queue");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function openRegistry(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      feature TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (feature, day)
    );
    CREATE TABLE IF NOT EXISTS interest (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL DEFAULT ''
    );
  `);
  const columns = db.prepare("PRAGMA table_info(interest)").all().map((column) => column.name);
  if (!columns.includes("acknowledged_at")) {
    db.exec("ALTER TABLE interest ADD COLUMN acknowledged_at TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

function mintPortal(db, expiresAt) {
  const user = db.prepare("SELECT id, firm_id, client_id FROM client_users LIMIT 1").get();
  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO client_sessions (id, token, firm_id, client_user_id, client_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), token, user.firm_id, user.id, user.client_id, now, expiresAt);
  return token;
}

export function publicDemoMutationError(db, method, pathname) {
  const key = `${method} ${pathname}`;
  if (BLOCKED.has(key)) {
    return "Demo mode does not upload files, connect a bank, take a payment, send email, or use a production integration.";
  }
  if (method === "POST" && pathname === "/api/journal-entries") {
    const count = Number(db.prepare("SELECT COUNT(*) AS count FROM journal_entries").get().count);
    if (count >= 800) return "This demo has reached its journal limit. Reset the demo to continue.";
  }
  if (method === "POST" && pathname === "/api/clients") {
    const count = Number(db.prepare("SELECT COUNT(*) AS count FROM clients").get().count);
    if (count >= 25) return "This demo firm already has its 25 fictional clients.";
  }
  return "";
}

export function createPublicDemo(options = {}) {
  const dir = options.dir;
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : 2 * 60 * 60 * 1000;
  const maxLive = Number.isInteger(options.maxLive) ? options.maxLive : 12;
  const templatePath = path.join(dir, "template.sqlite");
  const registryPath = path.join(dir, "registry.sqlite");
  const openDbs = new Map();
  let registry = null;
  let building = null;

  function registryDb() {
    if (!registry) {
      mkdirSync(dir, { recursive: true });
      registry = openRegistry(registryPath);
    }
    return registry;
  }

  function ensureTemplate() {
    if (building) return building;
    mkdirSync(dir, { recursive: true });
    building = Promise.resolve().then(() => {
      try {
        if (!readyTemplate()) {
          rmSync(templatePath, { force: true });
          rmSync(`${templatePath}-wal`, { force: true });
          rmSync(`${templatePath}-shm`, { force: true });
          buildTemplate(templatePath);
        }
      } catch (error) {
        building = null;
        throw error;
      }
    });
    return building;
  }

  function readyTemplate() {
    try {
      const probe = new DatabaseSync(templatePath, { readOnly: true });
      const firm = probe.prepare("SELECT name FROM firms WHERE demo = 1").get();
      probe.close();
      return firm?.name === FIRM_NAME;
    } catch {
      return false;
    }
  }

  function cache(token, db) {
    openDbs.set(token, db);
  }

  function dropFile(filePath) {
    const tokens = registryDb().prepare("SELECT token FROM tokens WHERE file_path = ?").all(filePath);
    const handles = new Set();
    for (const row of tokens) {
      const cached = openDbs.get(row.token);
      if (cached) handles.add(cached);
      openDbs.delete(row.token);
    }
    for (const handle of handles) handle.close();
    registryDb().prepare("DELETE FROM tokens WHERE file_path = ?").run(filePath);
    rmSync(filePath, { force: true });
    rmSync(`${filePath}-wal`, { force: true });
    rmSync(`${filePath}-shm`, { force: true });
  }

  function sweep() {
    const now = new Date().toISOString();
    const expired = registryDb().prepare("SELECT DISTINCT file_path FROM tokens WHERE expires_at <= ?").all(now);
    for (const row of expired) dropFile(row.file_path);
  }

  function remember(filePath, ownerToken, portalToken, expiresAt) {
    const insert = registryDb().prepare(
      "INSERT INTO tokens (token, file_path, kind, expires_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(ownerToken, filePath, "owner", expiresAt);
    insert.run(portalToken, filePath, "portal", expiresAt);
  }

  async function enter() {
    sweep();
    const live = Number(registryDb().prepare(
      "SELECT COUNT(*) AS count FROM tokens WHERE kind = 'owner' AND expires_at > ?",
    ).get(new Date().toISOString()).count);
    if (live >= maxLive) {
      return { status: 429, error: "The demo is full right now. Try again after a session expires." };
    }
    await ensureTemplate();
    const filePath = path.join(dir, `${randomUUID()}.sqlite`);
    copyFileSync(templatePath, filePath);
    const db = openDatabase(filePath);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const owner = db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get();
    const client = db.prepare("SELECT id FROM clients WHERE firm_id = ? ORDER BY position LIMIT 1").get(owner.firm_id);
    const opened = openFirmSession(db, owner, client.id);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(expiresAt, opened.token);
    const portalToken = mintPortal(db, expiresAt);
    remember(filePath, opened.token, portalToken, expiresAt);
    cache(opened.token, db);
    cache(portalToken, db);
    recordEvent("session");
    return { status: 200, token: opened.token, payload: opened.payload };
  }

  function open(token) {
    sweep();
    const row = registryDb().prepare(
      "SELECT file_path, expires_at FROM tokens WHERE token = ? AND expires_at > ?",
    ).get(token, new Date().toISOString());
    if (!row) return null;
    const cached = openDbs.get(token);
    if (cached) return { db: cached, ttlMs };
    const db = openDatabase(row.file_path);
    const siblings = registryDb().prepare("SELECT token FROM tokens WHERE file_path = ?").all(row.file_path);
    for (const sibling of siblings) cache(sibling.token, db);
    return { db, ttlMs };
  }

  function kindToken(token, kind) {
    const row = registryDb().prepare("SELECT file_path FROM tokens WHERE token = ?").get(token);
    if (!row) return "";
    const next = registryDb().prepare(
      "SELECT token FROM tokens WHERE file_path = ? AND kind = ? AND expires_at > ?",
    ).get(row.file_path, kind, new Date().toISOString());
    return next?.token || "";
  }

  function recordEvent(feature) {
    if (!FEATURES.has(feature)) return { status: 400, error: "That demo event is not recorded." };
    const dayKey = new Date().toISOString().slice(0, 10);
    registryDb().prepare(
      `INSERT INTO events (feature, day, count) VALUES (?, ?, 1)
       ON CONFLICT (feature, day) DO UPDATE SET count = count + 1`,
    ).run(feature, dayKey);
    return { status: 200, payload: { ok: true } };
  }

  function saveInterest(input) {
    const body = input || {};
    const kind = String(body.kind || "").trim();
    if (kind !== "beta" && kind !== "personal") return { status: 400, error: "Choose beta or a personal demo." };
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const note = String(body.note || "").trim();
    if (!name || name.length > 80) return { status: 400, error: "Enter a name." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return { status: 400, error: "Enter an email." };
    if (note.length > 500) return { status: 400, error: "Keep the note under 500 characters." };
    if (body.acknowledged !== true) return { status: 400, error: "Acknowledge the privacy notice before saving." };
    const acknowledgedAt = new Date().toISOString();
    registryDb().prepare(
      "INSERT INTO interest (id, kind, name, email, note, created_at, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), kind, name, email, note, acknowledgedAt, acknowledgedAt);
    return {
      status: 200,
      payload: { ok: true, message: "Saved for review on this demo server only. Nothing was emailed, and no account or payment was created." },
    };
  }

  async function reset(token) {
    const row = registryDb().prepare("SELECT file_path FROM tokens WHERE token = ? AND expires_at > ?").get(token, new Date().toISOString());
    if (!row) return { status: 401, error: "This demo session expired." };
    dropFile(row.file_path);
    recordEvent("reset");
    return enter();
  }

  function close() {
    for (const handle of new Set(openDbs.values())) handle.close();
    openDbs.clear();
    if (registry) {
      registry.close();
      registry = null;
    }
  }

  return {
    cookieName: PUBLIC_COOKIE,
    notice: NOTICE,
    ttlMs,
    enter,
    open,
    reset,
    kindToken,
    recordEvent,
    saveInterest,
    sweep,
    close,
  };
}

export { FIRM_NAME, NOTICE, PUBLIC_COOKIE };
