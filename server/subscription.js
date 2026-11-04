import { randomUUID } from "node:crypto";
import { formatMoney, parseCents } from "../shared/money.js";

const PLAN_NAME = "Practice";
const DEFAULT_SEAT_LIMIT = 5;
const MAX_SEAT_LIMIT = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firm_subscriptions (
  firm_id TEXT PRIMARY KEY REFERENCES firms(id),
  plan_name TEXT NOT NULL,
  seat_limit INTEGER NOT NULL CHECK (seat_limit >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS firm_billing_events (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  memo TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS firm_billing_by_firm ON firm_billing_events (firm_id, created_at);
`;

function fail(status, error) {
  return { status, error };
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function audit(db, session, action, entityId) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'firm_subscription', ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, entityId, new Date().toISOString());
}

export function ensureSubscription(db) {
  db.exec(SCHEMA);
  const missing = db.prepare(
    `SELECT firms.id
     FROM firms
     LEFT JOIN firm_subscriptions ON firm_subscriptions.firm_id = firms.id
     WHERE firm_subscriptions.firm_id IS NULL`,
  ).all();
  const insert = db.prepare(
    "INSERT INTO firm_subscriptions (firm_id, plan_name, seat_limit, updated_at) VALUES (?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const firm of missing) insert.run(firm.id, PLAN_NAME, DEFAULT_SEAT_LIMIT, now);
}

function ownerRole(db, session) {
  return db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

export function subscriptionSummary(db, firmId) {
  ensureSubscription(db);
  const row = db.prepare("SELECT plan_name, seat_limit FROM firm_subscriptions WHERE firm_id = ?").get(firmId);
  const seatsUsed = asCents(db.prepare("SELECT COUNT(*) AS count FROM users WHERE firm_id = ?").get(firmId).count);
  const seatLimit = Number(row.seat_limit);
  return {
    planName: row.plan_name,
    seatLimit,
    seatsUsed,
    seatsOpen: Math.max(0, seatLimit - seatsUsed),
  };
}

function billingRows(db, firmId) {
  return db.prepare(
    `SELECT firm_billing_events.id, firm_billing_events.amount_cents, firm_billing_events.memo,
            firm_billing_events.created_at, users.name AS actor_name
     FROM firm_billing_events
     JOIN users ON users.id = firm_billing_events.actor_user_id AND users.firm_id = firm_billing_events.firm_id
     WHERE firm_billing_events.firm_id = ?
     ORDER BY firm_billing_events.created_at DESC, firm_billing_events.id DESC`,
  ).all(firmId).map((row) => ({
    id: row.id,
    amount: formatMoney(asCents(row.amount_cents)),
    memo: row.memo,
    actorName: row.actor_name,
    createdAt: row.created_at,
  }));
}

export function readSubscription(db, session) {
  return {
    status: 200,
    payload: {
      subscription: subscriptionSummary(db, session.firm_id),
      billing: billingRows(db, session.firm_id),
    },
  };
}

function parseSeatLimit(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function updateSeats(db, session, input) {
  ensureSubscription(db);
  const actor = ownerRole(db, session);
  if (!actor || actor.role !== "owner") return fail(403, "Only an owner can change seats.");
  const seatLimit = parseSeatLimit(input?.seatLimit);
  if (seatLimit === null || seatLimit < 1 || seatLimit > MAX_SEAT_LIMIT) {
    return fail(400, "Enter a whole number of seats.");
  }
  const summary = subscriptionSummary(db, session.firm_id);
  if (seatLimit < summary.seatsUsed) {
    return fail(400, "Seats cannot be fewer than the people who can already sign in.");
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE firm_subscriptions SET seat_limit = ?, updated_at = ? WHERE firm_id = ?").run(seatLimit, now, session.firm_id);
  audit(db, session, "subscription.seats", session.firm_id);
  return readSubscription(db, session);
}

export function recordFirmPayment(db, session, input) {
  ensureSubscription(db);
  const actor = ownerRole(db, session);
  if (!actor || actor.role !== "owner") return fail(403, "Only an owner can record a firm payment.");
  let amountCents = 0;
  try {
    amountCents = parseCents(input?.amount);
  } catch (error) {
    return fail(error.status || 400, error.message);
  }
  if (amountCents <= 0) return fail(400, "Enter an amount.");
  const memo = String(input?.memo || "").trim();
  if (!memo || memo.length > 120) return fail(400, "Enter a short memo for this firm payment.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO firm_billing_events (id, firm_id, amount_cents, memo, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, amountCents, memo, session.user_id, now);
  audit(db, session, "subscription.billed", id);
  const result = readSubscription(db, session);
  result.status = 201;
  return result;
}

export function openSeatError(db, firmId) {
  const summary = subscriptionSummary(db, firmId);
  if (summary.seatsUsed >= summary.seatLimit) {
    return fail(409, "No open seats. Raise the seat count on Settings to invite someone.");
  }
  return null;
}
