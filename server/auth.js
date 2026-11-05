import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./db.js";
import { canInviteClient, canManageFirm, ROLE_LABEL } from "./permissions.js";
import { subscriptionBlocksWork, subscriptionSummary } from "./subscription.js";
import { ensureTime } from "./time.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const FIRM_BUSINESS_TYPES = [
  ["cpa_firm", "CPA firm"],
  ["bookkeeping", "Bookkeeping practice"],
  ["tax", "Tax practice"],
  ["advisory", "Advisory firm"],
  ["other", "Other"],
];

export const COUNTRIES = [
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
  ["IE", "Ireland"],
];

export const TIME_ZONES = [
  ["America/New_York", "Eastern Time"],
  ["America/Chicago", "Central Time"],
  ["America/Denver", "Mountain Time"],
  ["America/Phoenix", "Arizona Time"],
  ["America/Los_Angeles", "Pacific Time"],
  ["America/Anchorage", "Alaska Time"],
  ["Pacific/Honolulu", "Hawaii Time"],
  ["America/Toronto", "Toronto"],
  ["Europe/London", "London"],
  ["Australia/Sydney", "Sydney"],
  ["UTC", "UTC"],
];

export const ACCOUNTING_METHODS = [
  ["accrual", "Accrual"],
  ["cash", "Cash"],
];

export const FISCAL_MONTHS = [
  [1, "January"],
  [2, "February"],
  [3, "March"],
  [4, "April"],
  [5, "May"],
  [6, "June"],
  [7, "July"],
  [8, "August"],
  [9, "September"],
  [10, "October"],
  [11, "November"],
  [12, "December"],
];

const STEPS = [
  { id: "firm_profile", label: "Complete the firm profile", optional: false },
  { id: "first_client", label: "Add the first client", optional: true },
  { id: "chart", label: "Configure the chart of accounts", optional: true },
  { id: "sandbox_bank", label: "Connect a sandbox bank account", optional: true },
  { id: "sample_document", label: "Upload a sample document", optional: true },
  { id: "work_queue", label: "Review the Work Queue", optional: true },
  { id: "reports", label: "Explore financial reports", optional: true },
];

const VIEW_STEPS = new Set(["chart", "work_queue", "reports"]);

const buckets = new Map();

export function resetRateLimits() {
  buckets.clear();
}

export function allowAttempt(key, limit, windowMs, now = Date.now()) {
  const recent = (buckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

function addColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function usersNeedRebuild(sql) {
  if (!sql.includes("'bookkeeper'")) return true;
  if (!sql.includes("email_verified_at")) return true;
  return /firm_id TEXT NOT NULL/i.test(sql);
}

function rebuildUsers(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || "";
  if (!usersNeedRebuild(sql)) return;
  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  const verified = columns.has("email_verified_at") ? "email_verified_at" : "NULL";
  const terms = columns.has("terms_accepted_at") ? "terms_accepted_at" : "NULL";
  const privacy = columns.has("privacy_accepted_at") ? "privacy_accepted_at" : "NULL";
  const status = columns.has("status") ? "CASE WHEN status IS NULL OR status = '' THEN 'active' ELSE status END" : "'active'";
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE users_next (
        id TEXT PRIMARY KEY,
        firm_id TEXT REFERENCES firms(id),
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'manager', 'accountant', 'staff', 'bookkeeper', 'readonly')),
        password_hash TEXT NOT NULL,
        invited_by TEXT,
        created_at TEXT NOT NULL,
        email_verified_at TEXT,
        terms_accepted_at TEXT,
        privacy_accepted_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_verification', 'pending_onboarding', 'active', 'deactivated'))
      );
      INSERT INTO users_next (
        id, firm_id, email, name, role, password_hash, invited_by, created_at,
        email_verified_at, terms_accepted_at, privacy_accepted_at, status
      )
      SELECT id, firm_id, email, name, role, password_hash, invited_by, created_at,
        ${verified}, ${terms}, ${privacy}, ${status}
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_next RENAME TO users;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function ensureAuth(db) {
  rebuildUsers(db);
  addColumn(db, "firms", "business_type", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "firms", "country", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "firms", "time_zone", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "firms", "accounting_method", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "firms", "fiscal_year_start", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "firms", "created_via", "TEXT NOT NULL DEFAULT 'seed'");
  addColumn(db, "client_users", "status", "TEXT NOT NULL DEFAULT 'active'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      firm_id TEXT NOT NULL REFERENCES firms(id),
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      UNIQUE (user_id, firm_id)
    );
    CREATE TABLE IF NOT EXISTS portal_memberships (
      id TEXT PRIMARY KEY,
      client_user_id TEXT NOT NULL REFERENCES client_users(id),
      firm_id TEXT NOT NULL REFERENCES firms(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      UNIQUE (client_user_id, firm_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
      user_id TEXT,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_invitations (
      id TEXT PRIMARY KEY,
      firm_id TEXT NOT NULL REFERENCES firms(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dev_messages (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      link_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_events (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      user_id TEXT,
      firm_id TEXT,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS onboarding_steps (
      firm_id TEXT NOT NULL REFERENCES firms(id),
      step TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'skipped')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (firm_id, step)
    );
  `);
}

export function backfillAccess(db) {
  const users = db.prepare("SELECT id, firm_id, role, created_at FROM users WHERE firm_id IS NOT NULL").all();
  const insertMember = db.prepare(
    "INSERT INTO memberships (id, user_id, firm_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
  );
  for (const user of users) {
    const existing = db.prepare("SELECT id FROM memberships WHERE user_id = ? AND firm_id = ?").get(user.id, user.firm_id);
    if (!existing) insertMember.run(randomUUID(), user.id, user.firm_id, user.role, user.created_at);
  }
  db.prepare(
    `UPDATE users SET email_verified_at = created_at
     WHERE status = 'active' AND firm_id IS NOT NULL AND email_verified_at IS NULL`,
  ).run();
  const portals = db.prepare("SELECT id, firm_id, client_id, created_at FROM client_users").all();
  const insertPortal = db.prepare(
    "INSERT INTO portal_memberships (id, client_user_id, firm_id, client_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
  );
  for (const portal of portals) {
    const existing = db.prepare(
      "SELECT id FROM portal_memberships WHERE client_user_id = ? AND firm_id = ? AND client_id = ?",
    ).get(portal.id, portal.firm_id, portal.client_id);
    if (!existing) insertPortal.run(randomUUID(), portal.id, portal.firm_id, portal.client_id, portal.created_at);
  }
}

export function grantMembership(db, userId, firmId, role) {
  const existing = db.prepare("SELECT id FROM memberships WHERE user_id = ? AND firm_id = ?").get(userId, firmId);
  if (existing) {
    db.prepare("UPDATE memberships SET role = ?, status = 'active' WHERE id = ?").run(role, existing.id);
    return;
  }
  db.prepare(
    "INSERT INTO memberships (id, user_id, firm_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
  ).run(randomUUID(), userId, firmId, role, new Date().toISOString());
}

function authEvent(db, { email, userId = null, firmId = null, action }) {
  db.prepare(
    "INSERT INTO auth_events (id, email, user_id, firm_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), String(email || "").toLowerCase(), userId, firmId, action, new Date().toISOString());
}

function firmAudit(db, session, action, { clientId = null, entityType = null, entityId = null } = {}) {
  if (!session?.firm_id || !session?.user_id) return;
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, clientId, entityType, entityId, new Date().toISOString());
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function countOf(row) {
  return Number(row?.count || 0);
}

function emailOf(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function cleanName(value, max = 120) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > max) return "";
  return name;
}

function passwordProblem(password, confirmPassword) {
  const value = String(password || "");
  if (value.length < 8 || value.length > 200) return "Use a password of at least 8 characters.";
  if (value !== String(confirmPassword || "")) return "Passwords do not match.";
  return "";
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function tokensMatch(storedHash, token) {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(String(storedHash || ""), "hex");
  return expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual);
}

function storeMessage(db, { email, purpose, subject, body, linkPath }) {
  db.prepare(
    "INSERT INTO dev_messages (id, to_email, purpose, subject, body, link_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), email, purpose, subject, body, linkPath, new Date().toISOString());
}

function issueAuthToken(db, { purpose, userId, email, ttlMs, path }) {
  db.prepare("DELETE FROM auth_tokens WHERE purpose = ? AND email = ? AND used_at IS NULL").run(purpose, email);
  const token = newToken();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    "INSERT INTO auth_tokens (id, purpose, user_id, email, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
  ).run(randomUUID(), purpose, userId, email, hashToken(token), expires, new Date().toISOString());
  return { token, linkPath: `${path}?token=${encodeURIComponent(token)}` };
}

function readAuthToken(db, purpose, token) {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = db.prepare("SELECT * FROM auth_tokens WHERE purpose = ? AND token_hash = ?").get(purpose, hashToken(token));
  if (!row || !tokensMatch(row.token_hash, token)) return null;
  return row;
}

function lookupOptions(pairs) {
  return Object.fromEntries(pairs);
}

function devMailboxOn(req, options) {
  if (options?.devMailbox === false) return false;
  if (process.env.LEDGERLY_DEV_MAILBOX === "0") return false;
  if (process.env.NODE_ENV === "production" && process.env.LEDGERLY_DEV_MAILBOX !== "1") return false;
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function authConfig(req, options) {
  return {
    product: "Ledgerly",
    emailDelivery: "not_configured",
    devMailbox: devMailboxOn(req, options),
    businessTypes: FIRM_BUSINESS_TYPES.map(([id, label]) => ({ id, label })),
    countries: COUNTRIES.map(([id, label]) => ({ id, label })),
    timeZones: TIME_ZONES.map(([id, label]) => ({ id, label })),
    accountingMethods: ACCOUNTING_METHODS.map(([id, label]) => ({ id, label })),
    fiscalYearMonths: FISCAL_MONTHS.map(([id, label]) => ({ id, label })),
  };
}

function autoDone(db, firmId, stepId) {
  if (!firmId) return false;
  if (stepId === "firm_profile") {
    const firm = db.prepare(
      "SELECT business_type, country, time_zone, accounting_method, fiscal_year_start FROM firms WHERE id = ?",
    ).get(firmId);
    return Boolean(
      firm
      && lookupOptions(FIRM_BUSINESS_TYPES)[firm.business_type]
      && lookupOptions(COUNTRIES)[firm.country]
      && lookupOptions(TIME_ZONES)[firm.time_zone]
      && lookupOptions(ACCOUNTING_METHODS)[firm.accounting_method]
      && Number(firm.fiscal_year_start) >= 1
      && Number(firm.fiscal_year_start) <= 12,
    );
  }
  if (stepId === "first_client") {
    return countOf(db.prepare("SELECT COUNT(*) AS count FROM clients WHERE firm_id = ?").get(firmId)) > 0;
  }
  if (stepId === "sandbox_bank" && tableExists(db, "plaid_items")) {
    return countOf(db.prepare("SELECT COUNT(*) AS count FROM plaid_items WHERE firm_id = ?").get(firmId)) > 0;
  }
  if (stepId === "sample_document" && tableExists(db, "client_files")) {
    return countOf(db.prepare("SELECT COUNT(*) AS count FROM client_files WHERE firm_id = ?").get(firmId)) > 0;
  }
  return false;
}

export function checklistFor(db, firmId, { force = false } = {}) {
  if (!firmId && !force) return null;
  if (firmId && !force) {
    const firm = db.prepare("SELECT created_via FROM firms WHERE id = ?").get(firmId);
    if (!firm || firm.created_via !== "registration") return null;
  }
  const steps = STEPS.map((step) => {
    const stored = firmId
      ? db.prepare("SELECT status FROM onboarding_steps WHERE firm_id = ? AND step = ?").get(firmId, step.id)
      : null;
    let status = "pending";
    if (autoDone(db, firmId, step.id)) status = "complete";
    else if (stored?.status === "complete" || stored?.status === "skipped" || stored?.status === "pending") status = stored.status;
    return { id: step.id, label: step.label, optional: step.optional, status };
  });
  return { steps };
}

export function noteOnboarding(db, session, step) {
  if (!session?.firm_id || session.portal || !VIEW_STEPS.has(step)) return;
  const firm = db.prepare("SELECT created_via FROM firms WHERE id = ?").get(session.firm_id);
  if (!firm || firm.created_via !== "registration") return;
  db.prepare(
    `INSERT INTO onboarding_steps (firm_id, step, status, updated_at) VALUES (?, ?, 'complete', ?)
     ON CONFLICT(firm_id, step) DO UPDATE SET status = 'complete', updated_at = excluded.updated_at`,
  ).run(session.firm_id, step, new Date().toISOString());
}

function userJson(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role] || row.role,
  };
}

export function onboardingPayload(db, session) {
  const user = db.prepare("SELECT id, email, name, role, firm_id, status FROM users WHERE id = ?").get(session.user_id);
  const firmRow = user?.firm_id
    ? db.prepare(
      "SELECT id, name, business_type, country, time_zone, accounting_method, fiscal_year_start, created_via, demo FROM firms WHERE id = ?",
    ).get(user.firm_id)
    : null;
  const clients = firmRow
    ? db.prepare("SELECT id, name, legal_name, initials, industry FROM clients WHERE firm_id = ? ORDER BY position, name").all(firmRow.id)
    : [];
  return {
    onboarding: true,
    user: userJson(user),
    firm: firmRow
      ? {
        id: firmRow.id,
        name: firmRow.name,
        businessType: firmRow.business_type,
        country: firmRow.country,
        timeZone: firmRow.time_zone,
        accountingMethod: firmRow.accounting_method,
        fiscalYearStart: Number(firmRow.fiscal_year_start) || null,
        demo: Number(firmRow.demo) === 1,
      }
      : null,
    clients: clients.map((client) => ({
      id: client.id,
      name: client.name,
      legalName: client.legal_name,
      initials: client.initials,
      industry: client.industry,
    })),
    client: null,
    subscription: firmRow ? subscriptionSummary(db, firmRow.id) : null,
    checklist: checklistFor(db, firmRow?.id || null, { force: true }),
  };
}

export function loadOnboardingSession(db, token) {
  if (!token || !tableExists(db, "onboarding_sessions")) return null;
  const row = db.prepare(
    "SELECT id, token, user_id, expires_at FROM onboarding_sessions WHERE token = ? AND expires_at > ?",
  ).get(token, new Date().toISOString());
  if (!row) return null;
  const user = db.prepare("SELECT id, firm_id, status FROM users WHERE id = ?").get(row.user_id);
  if (!user || user.status === "deactivated" || user.status === "pending_verification") return null;
  return {
    id: row.id,
    token: row.token,
    user_id: user.id,
    firm_id: user.firm_id,
    onboarding: true,
    selected_client_id: null,
    expires_at: row.expires_at,
  };
}

export function beginOnboardingSession(db, user) {
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * DAY);
  const session = {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    user_id: user.id,
    firm_id: user.firm_id || null,
    onboarding: true,
  };
  db.prepare("DELETE FROM onboarding_sessions WHERE user_id = ?").run(user.id);
  db.prepare(
    "INSERT INTO onboarding_sessions (id, token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(session.id, session.token, user.id, now.toISOString(), expires.toISOString());
  authEvent(db, { email: user.email, userId: user.id, firmId: user.firm_id, action: "onboarding.started" });
  return { token: session.token, payload: onboardingPayload(db, session) };
}

function duplicateAccount(db, email) {
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return true;
  if (db.prepare("SELECT id FROM client_users WHERE email = ?").get(email)) return true;
  return false;
}

export function registerFirm(db, input, { devMailbox }) {
  const body = input || {};
  if (body.accountType === "client" || body.accountType === "portal") {
    return { status: 400, error: "Client portal accounts are created from a firm invitation." };
  }
  const name = cleanName(body.name);
  if (!name) return { status: 400, error: "Enter your full name." };
  const email = emailOf(body.email);
  if (!email) return { status: 400, error: "Enter a work email." };
  const passwordError = passwordProblem(body.password, body.confirmPassword);
  if (passwordError) return { status: 400, error: passwordError };
  if (body.acceptTerms !== true) return { status: 400, error: "Accept the Terms to create an account." };
  if (body.acceptPrivacy !== true) return { status: 400, error: "Accept the Privacy notice to create an account." };
  if (duplicateAccount(db, email)) return { status: 409, error: "An account with that email already exists." };
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO users (
        id, firm_id, email, name, role, password_hash, invited_by, created_at,
        email_verified_at, terms_accepted_at, privacy_accepted_at, status
      ) VALUES (?, NULL, ?, ?, 'owner', ?, NULL, ?, NULL, ?, ?, 'pending_verification')`,
    ).run(id, email, name, hashPassword(body.password), now, now, now);
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) return { status: 409, error: "An account with that email already exists." };
    throw error;
  }
  const issued = issueAuthToken(db, { purpose: "verify_email", userId: id, email, ttlMs: DAY, path: "/verify-email" });
  if (devMailbox) {
    storeMessage(db, {
      email,
      purpose: "verify_email",
      subject: "Verify your Ledgerly email",
      body: "Use the verification link to finish creating the firm. Email delivery is not configured, so this copy is stored only in the local development mailbox.",
      linkPath: issued.linkPath,
    });
  }
  authEvent(db, { email, userId: id, action: "register.requested" });
  return {
    status: 201,
    payload: {
      ok: true,
      email,
      devMailbox: Boolean(devMailbox),
      message: devMailbox
        ? "Check your email for a verification link. Email delivery is not configured, so this local build stores the link in the development mailbox."
        : "Check your email for a verification link.",
    },
  };
}

export function verifyEmail(db, input) {
  const row = readAuthToken(db, "verify_email", String(input?.token || ""));
  if (!row) return { status: 400, error: "This verification link is not valid." };
  if (row.used_at) return { status: 400, error: "This verification link was already used." };
  if (row.expires_at <= new Date().toISOString()) return { status: 400, error: "This verification link has expired." };
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND email = ?").get(row.user_id, row.email);
  if (!user || user.status === "deactivated") return { status: 400, error: "This verification link is not valid." };
  const now = new Date().toISOString();
  db.prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id);
  if (user.status === "pending_verification") {
    const nextStatus = user.firm_id ? "active" : "pending_onboarding";
    db.prepare("UPDATE users SET email_verified_at = ?, status = ? WHERE id = ?").run(now, nextStatus, user.id);
  }
  authEvent(db, { email: user.email, userId: user.id, firmId: user.firm_id, action: "email.verified" });
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (fresh.firm_id && db.prepare("SELECT id FROM clients WHERE firm_id = ? LIMIT 1").get(fresh.firm_id)) {
    return { status: 200, payload: { verified: true, needsSignIn: true } };
  }
  const session = beginOnboardingSession(db, fresh);
  return { status: 200, token: session.token, payload: session.payload };
}

export function resendVerification(db, input, { devMailbox }) {
  const email = emailOf(input?.email);
  const message = devMailbox
    ? "If that account is waiting for verification, a new link is in the development mailbox."
    : "If that account is waiting for verification, a new link was created.";
  if (!email) return { status: 200, payload: { ok: true, message } };
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (user && user.status === "pending_verification") {
    const issued = issueAuthToken(db, { purpose: "verify_email", userId: user.id, email, ttlMs: DAY, path: "/verify-email" });
    if (devMailbox) {
      storeMessage(db, {
        email,
        purpose: "verify_email",
        subject: "Verify your Ledgerly email",
        body: "Use the verification link to finish creating the firm. Email delivery is not configured, so this copy is stored only in the local development mailbox.",
        linkPath: issued.linkPath,
      });
    }
    authEvent(db, { email, userId: user.id, action: "email.verification.resent" });
  }
  return { status: 200, payload: { ok: true, message } };
}

export function requestPasswordReset(db, input, { devMailbox }) {
  const email = emailOf(input?.email);
  const message = "If an account exists for that email, a reset link was created. Email delivery is not configured.";
  if (!email) return { status: 200, payload: { ok: true, message } };
  const user = db.prepare("SELECT id, email, status FROM users WHERE email = ?").get(email);
  const portal = db.prepare("SELECT id, email, status FROM client_users WHERE email = ?").get(email);
  const account = user || portal;
  if (account && account.status !== "deactivated") {
    const issued = issueAuthToken(db, {
      purpose: "password_reset",
      userId: user ? user.id : null,
      email,
      ttlMs: HOUR,
      path: "/reset-password",
    });
    if (!user && portal) {
      db.prepare("UPDATE auth_tokens SET user_id = NULL WHERE token_hash = ?").run(hashToken(issued.token));
    }
    if (devMailbox) {
      storeMessage(db, {
        email,
        purpose: "password_reset",
        subject: "Reset your Ledgerly password",
        body: "Use the reset link to choose a new password. The link expires in one hour. Email delivery is not configured, so this copy is stored only in the local development mailbox.",
        linkPath: issued.linkPath,
      });
    }
    authEvent(db, { email, userId: user?.id || null, action: "password.reset.requested" });
  }
  return { status: 200, payload: { ok: true, message, devMailbox: Boolean(devMailbox) } };
}

export function confirmPasswordReset(db, input) {
  const passwordError = passwordProblem(input?.password, input?.confirmPassword);
  if (passwordError) return { status: 400, error: passwordError };
  const row = readAuthToken(db, "password_reset", String(input?.token || ""));
  if (!row) return { status: 400, error: "This reset link is not valid." };
  if (row.used_at) return { status: 400, error: "This reset link was already used." };
  if (row.expires_at <= new Date().toISOString()) return { status: 400, error: "This reset link has expired." };
  const now = new Date().toISOString();
  const hash = hashPassword(input.password);
  const user = db.prepare("SELECT id, firm_id FROM users WHERE email = ?").get(row.email);
  const portal = db.prepare("SELECT id, firm_id FROM client_users WHERE email = ?").get(row.email);
  if (!user && !portal) return { status: 400, error: "This reset link is not valid." };
  db.prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id);
  if (user) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM onboarding_sessions WHERE user_id = ?").run(user.id);
  }
  if (portal) {
    db.prepare("UPDATE client_users SET password_hash = ? WHERE id = ?").run(hash, portal.id);
    db.prepare("DELETE FROM client_sessions WHERE client_user_id = ?").run(portal.id);
  }
  authEvent(db, { email: row.email, userId: user?.id || null, firmId: user?.firm_id || portal?.firm_id || null, action: "password.reset.completed" });
  return { status: 200, payload: { ok: true, message: "Password updated. Sign in with the new password." } };
}

export function saveFirmProfile(db, session, input) {
  if (!session?.onboarding) return { status: 403, error: "Finish email verification before creating the firm." };
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user || user.status === "pending_verification" || user.status === "deactivated") {
    return { status: 403, error: "Confirm your email before creating the firm." };
  }
  if (user.firm_id) return { status: 409, error: "The firm profile is already saved." };
  const body = input || {};
  const name = cleanName(body.firmName || body.name, 80);
  if (!name) return { status: 400, error: "Enter the firm name." };
  if (!lookupOptions(FIRM_BUSINESS_TYPES)[body.businessType]) return { status: 400, error: "Choose a business type." };
  if (!lookupOptions(COUNTRIES)[body.country]) return { status: 400, error: "Choose a country." };
  if (!lookupOptions(TIME_ZONES)[body.timeZone]) return { status: 400, error: "Choose a time zone." };
  if (!lookupOptions(ACCOUNTING_METHODS)[body.accountingMethod]) return { status: 400, error: "Choose an accounting method." };
  const fiscal = Number(body.fiscalYearStart);
  if (!Number.isInteger(fiscal) || fiscal < 1 || fiscal > 12) return { status: 400, error: "Choose the fiscal year start." };
  const now = new Date().toISOString();
  const firmId = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO firms (
        id, name, created_at, business_type, country, time_zone, accounting_method, fiscal_year_start, created_via
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registration')`,
    ).run(firmId, name, now, body.businessType, body.country, body.timeZone, body.accountingMethod, fiscal);
    db.prepare("UPDATE users SET firm_id = ?, role = 'owner', status = 'active' WHERE id = ?").run(firmId, user.id);
    grantMembership(db, user.id, firmId, "owner");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  ensureTime(db);
  const next = { ...session, firm_id: firmId, user_id: user.id, onboarding: true };
  firmAudit(db, next, "organization.created", { entityType: "firm", entityId: firmId });
  authEvent(db, { email: user.email, userId: user.id, firmId, action: "organization.created" });
  return { status: 201, payload: onboardingPayload(db, next) };
}

export function updateOnboardingStep(db, session, input) {
  if (!session?.firm_id || session.portal) return { status: 403, error: "Create the firm profile first." };
  const step = STEPS.find((item) => item.id === String(input?.step || ""));
  if (!step) return { status: 400, error: "Choose a checklist step." };
  const status = String(input?.status || "");
  if (!["pending", "complete", "skipped"].includes(status)) return { status: 400, error: "Choose skip, complete, or resume." };
  if (step.id === "firm_profile") return { status: 400, error: "Save the firm profile to complete this step." };
  if (status === "skipped" && !step.optional) return { status: 400, error: "This step cannot be skipped." };
  db.prepare(
    `INSERT INTO onboarding_steps (firm_id, step, status, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(firm_id, step) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  ).run(session.firm_id, step.id, status, new Date().toISOString());
  firmAudit(db, session, `onboarding.${status}`, { entityType: "onboarding_step", entityId: step.id });
  const payload = session.onboarding ? onboardingPayload(db, session) : null;
  return { status: 200, payload: payload || { checklist: checklistFor(db, session.firm_id) } };
}

export function enterWorkspace(db, session, startFirmSession) {
  if (!session) return { status: 401, error: "Sign in required." };
  if (!session.onboarding) return { status: 200, payload: null };
  if (!session.firm_id) return { status: 400, error: "Create the firm profile first." };
  const blocked = subscriptionBlocksWork(db, session.firm_id);
  if (blocked) return { status: 403, error: blocked };
  const client = db.prepare("SELECT id FROM clients WHERE firm_id = ? ORDER BY position, name LIMIT 1").get(session.firm_id);
  if (!client) return { status: 400, error: "Add a client before opening the workspace. The other steps can wait." };
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!user) return { status: 403, error: "Sign in required." };
  db.prepare("DELETE FROM onboarding_sessions WHERE id = ?").run(session.id);
  const started = startFirmSession(db, user, client.id);
  return { status: 200, token: started.token, payload: started.payload };
}

function invitationStatus(row, now = new Date().toISOString()) {
  if (row.used_at) return "used";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= now) return "expired";
  return "open";
}

function invitationJson(db, row) {
  const client = db.prepare("SELECT name FROM clients WHERE id = ? AND firm_id = ?").get(row.client_id, row.firm_id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    clientId: row.client_id,
    clientName: client?.name || "",
    expiresAt: row.expires_at,
    status: invitationStatus(row),
    createdAt: row.created_at,
  };
}

export function listInvitations(db, session) {
  if (!session?.firm_id || session.portal) return { status: 401, error: "Sign in required." };
  const actor = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!actor || !canInviteClient(actor.role)) return { status: 403, error: "You do not have permission to view client invitations." };
  const rows = db.prepare(
    "SELECT * FROM client_invitations WHERE firm_id = ? ORDER BY created_at DESC",
  ).all(session.firm_id);
  return { status: 200, payload: { invitations: rows.map((row) => invitationJson(db, row)) } };
}

export function createClientInvitation(db, session, clientId, input, { devMailbox }) {
  if (!session?.firm_id || session.portal) return { status: 401, error: "Sign in required." };
  const actor = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!actor || !canInviteClient(actor.role)) {
    return { status: 403, error: "Only an owner, administrator, manager, or accountant can invite a client." };
  }
  const blocked = subscriptionBlocksWork(db, session.firm_id);
  if (blocked) return { status: 403, error: blocked };
  const client = db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
  if (!client) return { status: 404, error: "Client not found." };
  const name = cleanName(input?.name);
  const email = emailOf(input?.email);
  if (!name || !email) return { status: 400, error: "Enter the client contact's name and email." };
  const firmUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (firmUser) return { status: 409, error: "That email already has a firm account." };
  const otherPortal = db.prepare("SELECT id, firm_id, client_id FROM client_users WHERE email = ?").get(email);
  if (otherPortal && (otherPortal.firm_id !== session.firm_id || otherPortal.client_id !== client.id)) {
    return { status: 409, error: "That email is already used for another client portal." };
  }
  const now = new Date();
  const token = newToken();
  const id = randomUUID();
  db.prepare(
    `UPDATE client_invitations SET revoked_at = ?
     WHERE firm_id = ? AND client_id = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL`,
  ).run(now.toISOString(), session.firm_id, client.id, email);
  db.prepare(
    `INSERT INTO client_invitations (
      id, firm_id, client_id, email, name, token_hash, expires_at, used_at, revoked_at, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    session.firm_id,
    client.id,
    email,
    name,
    hashToken(token),
    new Date(now.getTime() + 7 * DAY).toISOString(),
    session.user_id,
    now.toISOString(),
  );
  const linkPath = `/invitation?token=${encodeURIComponent(token)}`;
  if (devMailbox) {
    storeMessage(db, {
      email,
      purpose: "client_invitation",
      subject: `Invitation to ${client.name} on Ledgerly`,
      body: "A firm invited this address to the client portal. The link expires in 7 days and works once. Email delivery is not configured, so this copy is stored only in the local development mailbox.",
      linkPath,
    });
  }
  firmAudit(db, session, "invitation.created", { clientId: client.id, entityType: "client_invitation", entityId: id });
  const row = db.prepare("SELECT * FROM client_invitations WHERE id = ? AND firm_id = ?").get(id, session.firm_id);
  return {
    status: 201,
    payload: {
      invitation: invitationJson(db, row),
      devMailbox: Boolean(devMailbox),
      message: devMailbox
        ? "The invitation is stored in the development mailbox. Email delivery is not configured."
        : "The invitation was created. Email delivery is not configured.",
    },
  };
}

function invitationByToken(db, token) {
  if (!token || token.length < 20) return null;
  const row = db.prepare("SELECT * FROM client_invitations WHERE token_hash = ?").get(hashToken(token));
  if (!row || !tokensMatch(row.token_hash, token)) return null;
  return row;
}

export function previewInvitation(db, input) {
  const row = invitationByToken(db, String(input?.token || ""));
  if (!row) return { status: 400, error: "This invitation is not valid." };
  const status = invitationStatus(row);
  if (status === "used") return { status: 400, error: "This invitation was already used." };
  if (status === "revoked") return { status: 400, error: "This invitation was revoked." };
  if (status === "expired") return { status: 400, error: "This invitation has expired." };
  const firm = db.prepare("SELECT name FROM firms WHERE id = ?").get(row.firm_id);
  const client = db.prepare("SELECT name FROM clients WHERE id = ? AND firm_id = ?").get(row.client_id, row.firm_id);
  return {
    status: 200,
    payload: {
      status,
      email: row.email,
      name: row.name,
      firmName: firm?.name || "",
      clientName: client?.name || "",
      expiresAt: row.expires_at,
    },
  };
}

export function acceptInvitation(db, input, signInPortalAccount) {
  const row = invitationByToken(db, String(input?.token || ""));
  if (!row) return { status: 400, error: "This invitation is not valid." };
  const status = invitationStatus(row);
  if (status === "used") return { status: 400, error: "This invitation was already used." };
  if (status === "revoked") return { status: 400, error: "This invitation was revoked." };
  if (status === "expired") return { status: 400, error: "This invitation has expired." };
  const passwordError = passwordProblem(input?.password, input?.confirmPassword);
  if (passwordError) return { status: 400, error: passwordError };
  if (emailOf(input?.email) && emailOf(input.email) !== row.email) {
    return { status: 400, error: "Use the email address this invitation was sent to." };
  }
  const firmUser = db.prepare("SELECT id FROM users WHERE email = ?").get(row.email);
  if (firmUser) return { status: 409, error: "That email already has a firm account." };
  const existing = db.prepare("SELECT * FROM client_users WHERE email = ?").get(row.email);
  const now = new Date().toISOString();
  let clientUserId = existing?.id || "";
  if (existing) {
    if (!verifyPassword(input.password, existing.password_hash)) return { status: 401, error: "Email or password is incorrect." };
    if (existing.firm_id !== row.firm_id || existing.client_id !== row.client_id) {
      return { status: 409, error: "That email is already used for another client portal." };
    }
    if (existing.status === "deactivated") return { status: 403, error: "This portal access is deactivated." };
  } else {
    const name = cleanName(input?.name) || row.name;
    if (!name) return { status: 400, error: "Enter your name." };
    clientUserId = randomUUID();
    db.prepare(
      "INSERT INTO client_users (id, firm_id, client_id, email, name, password_hash, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
    ).run(clientUserId, row.firm_id, row.client_id, row.email, name, hashPassword(input.password), now);
  }
  const marked = db.prepare(
    "UPDATE client_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
  ).run(now, row.id);
  if (Number(marked.changes) !== 1) return { status: 400, error: "This invitation was already used." };
  const membership = db.prepare(
    "SELECT id FROM portal_memberships WHERE client_user_id = ? AND firm_id = ? AND client_id = ?",
  ).get(clientUserId, row.firm_id, row.client_id);
  if (membership) {
    db.prepare("UPDATE portal_memberships SET status = 'active' WHERE id = ?").run(membership.id);
  } else {
    db.prepare(
      "INSERT INTO portal_memberships (id, client_user_id, firm_id, client_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ).run(randomUUID(), clientUserId, row.firm_id, row.client_id, now);
  }
  authEvent(db, { email: row.email, firmId: row.firm_id, action: "invitation.accepted" });
  firmAudit(db, { firm_id: row.firm_id, user_id: row.created_by }, "invitation.accepted", {
    clientId: row.client_id,
    entityType: "client_invitation",
    entityId: row.id,
  });
  const signedIn = signInPortalAccount(db, row.email, input.password);
  if (!signedIn || signedIn.error) return { status: 500, error: "The invitation was accepted, but the portal session could not start." };
  return { status: 200, token: signedIn.token, payload: signedIn.payload };
}

export function revokeInvitation(db, session, invitationId) {
  if (!session?.firm_id || session.portal) return { status: 401, error: "Sign in required." };
  const actor = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!actor || !canInviteClient(actor.role)) {
    return { status: 403, error: "Only an owner, administrator, manager, or accountant can revoke an invitation." };
  }
  const row = db.prepare("SELECT * FROM client_invitations WHERE id = ? AND firm_id = ?").get(invitationId, session.firm_id);
  if (!row) return { status: 404, error: "Invitation not found." };
  if (!row.used_at && !row.revoked_at) {
    db.prepare("UPDATE client_invitations SET revoked_at = ? WHERE id = ? AND firm_id = ?").run(new Date().toISOString(), row.id, session.firm_id);
    firmAudit(db, session, "invitation.revoked", { clientId: row.client_id, entityType: "client_invitation", entityId: row.id });
  }
  const fresh = db.prepare("SELECT * FROM client_invitations WHERE id = ? AND firm_id = ?").get(row.id, session.firm_id);
  return { status: 200, payload: { invitation: invitationJson(db, fresh) } };
}

export function setPortalAccess(db, session, clientId, input) {
  if (!session?.firm_id || session.portal) return { status: 401, error: "Sign in required." };
  const actor = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!actor || !canInviteClient(actor.role)) {
    return { status: 403, error: "Only an owner, administrator, manager, or accountant can change portal access." };
  }
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
  if (!client) return { status: 404, error: "Client not found." };
  const email = emailOf(input?.email);
  const status = String(input?.status || "");
  if (!email || (status !== "active" && status !== "deactivated")) {
    return { status: 400, error: "Choose the portal email and active or deactivated." };
  }
  const portal = db.prepare("SELECT * FROM client_users WHERE email = ? AND firm_id = ? AND client_id = ?").get(email, session.firm_id, client.id);
  if (!portal) return { status: 404, error: "Portal access not found." };
  db.prepare("UPDATE client_users SET status = ? WHERE id = ? AND firm_id = ?").run(status, portal.id, session.firm_id);
  db.prepare(
    "UPDATE portal_memberships SET status = ? WHERE client_user_id = ? AND firm_id = ? AND client_id = ?",
  ).run(status, portal.id, session.firm_id, client.id);
  if (status === "deactivated") {
    db.prepare("DELETE FROM client_sessions WHERE client_user_id = ? AND firm_id = ?").run(portal.id, session.firm_id);
  }
  firmAudit(db, session, status === "deactivated" ? "portal.deactivated" : "portal.activated", {
    clientId: client.id,
    entityType: "client_user",
    entityId: portal.id,
  });
  return { status: 200, payload: { email, status } };
}

export function listDevMailbox(db, email) {
  const normalized = emailOf(email);
  if (!normalized) return [];
  return db.prepare(
    "SELECT id, to_email, purpose, subject, body, link_path, created_at FROM dev_messages WHERE to_email = ? ORDER BY created_at",
  ).all(normalized).map((row) => ({
    id: row.id,
    to: row.to_email,
    purpose: row.purpose,
    subject: row.subject,
    body: row.body,
    linkPath: row.link_path,
    createdAt: row.created_at,
  }));
}

function limitSpec(options, name, fallbackLimit, fallbackWindow) {
  const custom = options?.rateLimits?.[name];
  if (custom && Number.isInteger(custom.limit) && Number.isInteger(custom.windowMs)) return custom;
  return { limit: fallbackLimit, windowMs: fallbackWindow };
}

export function withinRateLimit(options, req, name, fallbackLimit, fallbackWindow) {
  const spec = limitSpec(options, name, fallbackLimit, fallbackWindow);
  const scope = options?.rateScope || "default";
  const ip = req.socket?.remoteAddress || "unknown";
  return allowAttempt(`${scope}:${name}:${ip}`, spec.limit, spec.windowMs);
}

export async function handleAuthRoutes(req, res, db, ctx) {
  const { pathname } = ctx.url;
  const method = req.method;
  const send = ctx.send;
  const devMailbox = devMailboxOn(req, ctx.options);

  if (method === "GET" && pathname === "/api/auth/config") {
    send(res, 200, authConfig(req, ctx.options));
    return true;
  }

  if (method === "GET" && pathname === "/api/dev/mailbox") {
    if (!devMailbox) {
      send(res, 404, { error: "Not found." });
      return true;
    }
    if (!withinRateLimit(ctx.options, req, "mailbox", 60, 15 * 60 * 1000)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    send(res, 200, { messages: listDevMailbox(db, ctx.url.searchParams.get("email") || "") });
    return true;
  }

  if (method === "POST" && pathname === "/api/register") {
    if (!withinRateLimit(ctx.options, req, "register", 20, HOUR)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    const result = registerFirm(db, await ctx.readBody(req), { devMailbox });
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/email-verification") {
    if (!withinRateLimit(ctx.options, req, "verify", 30, HOUR)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    const result = verifyEmail(db, await ctx.readBody(req));
    const headers = result.token ? { "set-cookie": ctx.setSessionCookie(result.token) } : {};
    send(res, result.status, result.payload || { error: result.error }, headers);
    return true;
  }

  if (method === "POST" && pathname === "/api/email-verification/resend") {
    if (!withinRateLimit(ctx.options, req, "verify", 30, HOUR)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    const result = resendVerification(db, await ctx.readBody(req), { devMailbox });
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/password-reset") {
    if (!withinRateLimit(ctx.options, req, "reset", 10, HOUR)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    const result = requestPasswordReset(db, await ctx.readBody(req), { devMailbox });
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/password-reset/confirm") {
    if (!withinRateLimit(ctx.options, req, "reset", 10, HOUR)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    const result = confirmPasswordReset(db, await ctx.readBody(req));
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/invitations/preview") {
    const result = previewInvitation(db, await ctx.readBody(req));
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/invitations/accept") {
    if (!withinRateLimit(ctx.options, req, "accept", 20, HOUR)) {
      send(res, 429, { error: "Too many attempts. Try again later." });
      return true;
    }
    const result = acceptInvitation(db, await ctx.readBody(req), ctx.signInPortalAccount);
    const headers = result.token ? { "set-cookie": ctx.setSessionCookie(result.token) } : {};
    send(res, result.status, result.payload || { error: result.error }, headers);
    return true;
  }

  const session = ctx.session;
  const firmAuthRoute = pathname.startsWith("/api/onboarding")
    || pathname === "/api/invitations"
    || /^\/api\/clients\/[^/]+\/invitations$/.test(pathname)
    || /^\/api\/invitations\/[^/]+\/revoke$/.test(pathname)
    || /^\/api\/clients\/[^/]+\/portal-access$/.test(pathname);
  if (firmAuthRoute && session?.portal) {
    send(res, 404, { error: "Not found." });
    return true;
  }

  if (method === "GET" && pathname === "/api/onboarding") {
    if (!session || session.portal) {
      send(res, 401, { error: "Sign in required." });
      return true;
    }
    const checklist = session.onboarding ? onboardingPayload(db, session).checklist : checklistFor(db, session.firm_id);
    send(res, 200, { checklist });
    return true;
  }

  if (method === "POST" && pathname === "/api/onboarding/firm") {
    if (!session || session.portal) {
      send(res, 401, { error: "Sign in required." });
      return true;
    }
    const result = saveFirmProfile(db, session, await ctx.readBody(req));
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/onboarding/step") {
    if (!session || session.portal) {
      send(res, 401, { error: "Sign in required." });
      return true;
    }
    const result = updateOnboardingStep(db, session, await ctx.readBody(req));
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  if (method === "POST" && pathname === "/api/onboarding/enter") {
    if (!session || session.portal) {
      send(res, 401, { error: "Sign in required." });
      return true;
    }
    const result = enterWorkspace(db, session, ctx.startFirmSession);
    if (result.error) {
      send(res, result.status, { error: result.error });
      return true;
    }
    const headers = result.token ? { "set-cookie": ctx.setSessionCookie(result.token) } : {};
    const payload = result.payload || ctx.sessionPayload(db, session);
    send(res, result.status, payload, headers);
    return true;
  }

  if (method === "GET" && pathname === "/api/invitations") {
    const result = listInvitations(db, session);
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  const inviteMatch = pathname.match(/^\/api\/clients\/([^/]+)\/invitations$/);
  if (inviteMatch && method === "POST") {
    const result = createClientInvitation(db, session, decodeURIComponent(inviteMatch[1]), await ctx.readBody(req), { devMailbox });
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  const revokeMatch = pathname.match(/^\/api\/invitations\/([^/]+)\/revoke$/);
  if (revokeMatch && method === "POST") {
    const result = revokeInvitation(db, session, decodeURIComponent(revokeMatch[1]));
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  const portalAccess = pathname.match(/^\/api\/clients\/([^/]+)\/portal-access$/);
  if (portalAccess && method === "POST") {
    const result = setPortalAccess(db, session, decodeURIComponent(portalAccess[1]), await ctx.readBody(req));
    send(res, result.status, result.payload || { error: result.error });
    return true;
  }

  return false;
}

export function onboardingPassthrough(method, pathname) {
  if ((method === "GET" || method === "DELETE") && pathname === "/api/session") return true;
  if ((method === "GET" || method === "POST") && pathname === "/api/clients") return true;
  if (method === "POST" && pathname === "/api/documents") return true;
  if (method === "GET" && pathname === "/api/subscription") return true;
  if (method === "POST" && (
    pathname === "/api/subscription/checkout"
    || pathname === "/api/subscription/checkout/confirm"
    || pathname === "/api/subscription/refresh"
    || pathname === "/api/subscription/seats"
    || pathname === "/api/subscription/invoice"
  )) return true;
  return false;
}

export function readonlyWriteError(db, session, method, pathname) {
  if (!session || session.portal || session.onboarding) return "";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "";
  const user = db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!user || user.role !== "readonly") return "";
  if (method === "DELETE" && pathname === "/api/session") return "";
  if (method === "PATCH" && pathname === "/api/session") return "";
  if (method === "POST" && pathname === "/api/onboarding/step") return "";
  return "This role can view records but cannot change them.";
}

export function crossSiteError(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return "";
  const origin = req.headers.origin;
  if (!origin) return "";
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    return "Cross-site request was rejected.";
  }
  if (host !== req.headers.host) return "Cross-site request was rejected.";
  return "";
}

export { canManageFirm };
