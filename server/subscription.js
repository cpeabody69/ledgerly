import { randomUUID } from "node:crypto";
import { formatMoney, parseCents } from "../shared/money.js";
import { canManageFirm } from "./permissions.js";
import {
  LIVE_STRIPE_KEY,
  MISSING_STRIPE_KEYS,
  publicStripe,
  redact,
  stripeRequest,
  stripeSetup,
  verifyStripeSignature,
} from "./stripe.js";

const PLAN_NAME = "Practice";
const DEFAULT_SEAT_LIMIT = 5;
const MAX_SEAT_LIMIT = 100;
const STATUSES = new Set(["incomplete", "active", "past_due", "canceled"]);

const PLANS = {
  practice: { id: "practice", name: "Practice" },
  firm: { id: "firm", name: "Firm" },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firm_subscriptions (
  firm_id TEXT PRIMARY KEY REFERENCES firms(id),
  plan_name TEXT NOT NULL,
  seat_limit INTEGER NOT NULL CHECK (seat_limit >= 1),
  status TEXT NOT NULL DEFAULT 'incomplete',
  billing_exempt INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
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

const NEW_WORK = [
  [/^\/api\/clients$/, "POST"],
  [/^\/api\/journal-entries$/, "POST"],
  [/^\/api\/invoices$/, "POST"],
  [/^\/api\/invoices\/[^/]+\/send$/, "POST"],
  [/^\/api\/expenses$/, "POST"],
  [/^\/api\/payables\/bills$/, "POST"],
  [/^\/api\/payables\/bills\/[^/]+\/post$/, "POST"],
  [/^\/api\/members$/, "POST"],
  [/^\/api\/clients\/[^/]+\/invitations$/, "POST"],
  [/^\/api\/time\/invoice$/, "POST"],
];

function fail(status, error) {
  return { status, error };
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function addColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function audit(db, session, action, entityId) {
  if (!session?.firm_id || !session?.user_id) return;
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'firm_subscription', ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, entityId, new Date().toISOString());
}

export function ensureSubscription(db) {
  db.exec(SCHEMA);
  addColumn(db, "firm_subscriptions", "status", "TEXT NOT NULL DEFAULT 'incomplete'");
  addColumn(db, "firm_subscriptions", "billing_exempt", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "firm_subscriptions", "stripe_customer_id", "TEXT");
  addColumn(db, "firm_subscriptions", "stripe_subscription_id", "TEXT");
  addColumn(db, "firm_subscriptions", "stripe_price_id", "TEXT");
  const firms = db.prepare("SELECT id, created_via FROM firms").all();
  const lookup = db.prepare("SELECT billing_exempt, stripe_customer_id FROM firm_subscriptions WHERE firm_id = ?");
  const insert = db.prepare(
    `INSERT INTO firm_subscriptions (
      firm_id, plan_name, seat_limit, status, billing_exempt, stripe_customer_id, stripe_subscription_id, stripe_price_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  );
  const keepSample = db.prepare(
    `UPDATE firm_subscriptions
     SET billing_exempt = 1, status = 'active',
         plan_name = CASE WHEN plan_name IN ('', 'None') THEN 'Practice' ELSE plan_name END,
         updated_at = ?
     WHERE firm_id = ? AND billing_exempt = 0 AND (stripe_customer_id IS NULL OR stripe_customer_id = '')`,
  );
  const now = new Date().toISOString();
  for (const firm of firms) {
    const exempt = firm.created_via !== "registration";
    const row = lookup.get(firm.id);
    if (!row) {
      if (exempt) insert.run(firm.id, PLAN_NAME, DEFAULT_SEAT_LIMIT, "active", 1, now);
      else insert.run(firm.id, "None", 1, "incomplete", 0, now);
    } else if (exempt && Number(row.billing_exempt) !== 1 && !row.stripe_customer_id) {
      keepSample.run(now, firm.id);
    }
  }
}

function ownerRole(db, session) {
  return db.prepare("SELECT role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function seatsUsed(db, firmId) {
  return asCents(
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE firm_id = ? AND status != 'deactivated'").get(firmId).count,
  );
}

export function subscriptionSummary(db, firmId) {
  ensureSubscription(db);
  const row = db.prepare(
    `SELECT plan_name, seat_limit, status, billing_exempt, stripe_customer_id, stripe_subscription_id
     FROM firm_subscriptions WHERE firm_id = ?`,
  ).get(firmId);
  const used = seatsUsed(db, firmId);
  const seatLimit = Number(row.seat_limit);
  const billingExempt = Number(row.billing_exempt) === 1;
  const status = STATUSES.has(row.status) ? row.status : "incomplete";
  return {
    planName: row.plan_name,
    seatLimit,
    seatsUsed: used,
    seatsOpen: Math.max(0, seatLimit - used),
    status,
    billingExempt,
    allowsWork: billingExempt || status === "active",
    hasStripeSubscription: Boolean(row.stripe_subscription_id),
  };
}

export function subscriptionBlocksWork(db, firmId) {
  const summary = subscriptionSummary(db, firmId);
  if (summary.allowsWork) return "";
  if (summary.status === "past_due") {
    return "This firm's Avenue subscription is past due. Books stay readable. New clients, journal entries, invoices, bills, and invites stay blocked until it is paid.";
  }
  if (summary.status === "canceled") {
    return "This firm's Avenue subscription is canceled. Books stay readable. New clients, journal entries, invoices, bills, and invites stay blocked until a plan is active.";
  }
  return "Choose an Avenue plan and seat count before creating new work.";
}

export function subscriptionWriteError(db, session, method, pathname) {
  if (!session?.firm_id || session.portal) return "";
  if (!NEW_WORK.some(([pattern, verb]) => verb === method && pattern.test(pathname))) return "";
  return subscriptionBlocksWork(db, session.firm_id);
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
  const setup = stripeSetup();
  return {
    status: 200,
    payload: {
      subscription: subscriptionSummary(db, session.firm_id),
      billing: billingRows(db, session.firm_id),
      stripe: publicStripe(setup),
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
  if (!actor || !canManageFirm(actor.role)) return fail(403, "Only an owner or administrator can change seats.");
  const summary = subscriptionSummary(db, session.firm_id);
  if (!summary.billingExempt) {
    return fail(409, "Seat count follows the Stripe test subscription.");
  }
  const seatLimit = parseSeatLimit(input?.seatLimit ?? input?.seatCount);
  if (seatLimit === null || seatLimit < 1 || seatLimit > MAX_SEAT_LIMIT) {
    return fail(400, "Enter a whole number of seats.");
  }
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
  if (!actor || !canManageFirm(actor.role)) return fail(403, "Only an owner or administrator can record a firm payment.");
  const summary = subscriptionSummary(db, session.firm_id);
  if (!summary.billingExempt) {
    return fail(409, "This firm pays through Stripe test checkout. That checkout does not post to a client's books.");
  }
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
    if (summary.billingExempt) return fail(409, "No open seats. Raise the seat count on Settings to invite someone.");
    return fail(409, "No open seats. Upgrade the subscription before inviting someone.");
  }
  return null;
}

function stripeFailure(error) {
  return fail(502, redact(error?.message || "Stripe could not complete that request."));
}

function keysProblem(setup) {
  if (setup.live) return fail(403, LIVE_STRIPE_KEY);
  if (!setup.configured) return fail(503, setup.notice || MISSING_STRIPE_KEYS);
  return null;
}

async function callStripe(stripeRequestImpl, request) {
  if (stripeRequestImpl) return stripeRequestImpl(request);
  const setup = stripeSetup();
  return stripeRequest({
    secretKey: setup.secretKey,
    method: request.method,
    path: request.path,
    params: request.params,
  });
}

function planNameFor(setup, priceId, planId) {
  if (priceId && priceId === setup.prices.practice) return "Practice";
  if (priceId && priceId === setup.prices.firm) return "Firm";
  return PLANS[planId]?.name || "";
}

function priceIdOf(item) {
  if (!item) return "";
  if (typeof item.price === "string") return item.price;
  return item.price?.id || "";
}

function firmIdForStripe(db, { firmId, customerId, subscriptionId }) {
  if (firmId) {
    const firm = db.prepare("SELECT id FROM firms WHERE id = ?").get(firmId);
    if (firm) return firm.id;
  }
  if (subscriptionId) {
    const row = db.prepare("SELECT firm_id FROM firm_subscriptions WHERE stripe_subscription_id = ?").get(subscriptionId);
    if (row) return row.firm_id;
  }
  if (customerId) {
    const row = db.prepare("SELECT firm_id FROM firm_subscriptions WHERE stripe_customer_id = ?").get(customerId);
    if (row) return row.firm_id;
  }
  return "";
}

export function mapStripeStatus(status) {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid" || status === "paused") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  if (status === "incomplete") return "incomplete";
  return "";
}

export function applyFirmSubscription(db, input) {
  ensureSubscription(db);
  const firmId = firmIdForStripe(db, input);
  if (!firmId) return { ok: false };
  const current = db.prepare("SELECT * FROM firm_subscriptions WHERE firm_id = ?").get(firmId);
  if (!current) return { ok: false };
  const seatLimit = Number.isInteger(input.seatLimit) && input.seatLimit >= 1 && input.seatLimit <= MAX_SEAT_LIMIT
    ? input.seatLimit
    : Number(current.seat_limit);
  const status = STATUSES.has(input.status) ? input.status : current.status;
  const planName = input.planName || current.plan_name;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE firm_subscriptions
     SET plan_name = ?, seat_limit = ?, status = ?, stripe_customer_id = ?, stripe_subscription_id = ?, stripe_price_id = ?, updated_at = ?
     WHERE firm_id = ?`,
  ).run(
    planName,
    seatLimit,
    status,
    input.customerId || current.stripe_customer_id,
    input.subscriptionId || current.stripe_subscription_id,
    input.priceId || current.stripe_price_id,
    now,
    firmId,
  );
  const owner = db.prepare("SELECT id FROM users WHERE firm_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(firmId);
  if (owner) audit(db, { firm_id: firmId, user_id: owner.id }, "subscription.stripe", firmId);
  return { ok: true, firmId };
}

function idOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id || "";
}

function applyStripeObject(db, object, fallbackStatus) {
  const setup = stripeSetup();
  const item = object.items?.data?.[0];
  const quantity = Number(item?.quantity);
  const priceId = priceIdOf(item);
  const planId = object.metadata?.plan_id || "";
  const status = mapStripeStatus(object.status) || fallbackStatus;
  if (!status) return { ok: false };
  return applyFirmSubscription(db, {
    firmId: object.metadata?.firm_id || "",
    customerId: idOf(object.customer),
    subscriptionId: object.object === "subscription" ? object.id : idOf(object.subscription),
    priceId,
    status,
    seatLimit: Number.isInteger(quantity) ? quantity : undefined,
    planName: planNameFor(setup, priceId, planId),
  });
}

export function applyStripeEvent(db, event) {
  const type = event?.type;
  const object = event?.data?.object;
  if (!type || !object) return { status: 400, error: "Stripe event is not valid." };
  if (type === "checkout.session.completed") {
    const paid = object.payment_status === "paid" || object.payment_status === "no_payment_required";
    const seatCount = Number(object.metadata?.seat_count);
    const applied = applyFirmSubscription(db, {
      firmId: object.metadata?.firm_id || object.client_reference_id,
      customerId: idOf(object.customer),
      subscriptionId: idOf(object.subscription),
      status: paid ? "active" : "incomplete",
      seatLimit: Number.isInteger(seatCount) ? seatCount : undefined,
      planName: planNameFor(stripeSetup(), "", object.metadata?.plan_id),
    });
    if (!applied.ok) return { status: 200, payload: { received: true, ignored: true } };
    return { status: 200, payload: { received: true, status: paid ? "active" : "incomplete" } };
  }
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    const applied = applyStripeObject(db, object);
    if (!applied.ok) return { status: 200, payload: { received: true, ignored: true } };
    return { status: 200, payload: { received: true, status: mapStripeStatus(object.status) } };
  }
  if (type === "customer.subscription.deleted") {
    const applied = applyStripeObject(db, { ...object, status: "canceled" }, "canceled");
    if (!applied.ok) return { status: 200, payload: { received: true, ignored: true } };
    return { status: 200, payload: { received: true, status: "canceled" } };
  }
  if (type === "invoice.payment_failed" || type === "invoice.paid") {
    const status = type === "invoice.paid" ? "active" : "past_due";
    const applied = applyFirmSubscription(db, {
      firmId: object.metadata?.firm_id || "",
      customerId: idOf(object.customer),
      subscriptionId: idOf(object.subscription),
      status,
    });
    if (!applied.ok) return { status: 200, payload: { received: true, ignored: true } };
    return { status: 200, payload: { received: true, status } };
  }
  return { status: 200, payload: { received: true, ignored: true } };
}

export function handleStripeWebhook(db, rawBody, signature) {
  const setup = stripeSetup();
  if (!setup.webhookSecret) return fail(503, MISSING_STRIPE_KEYS);
  const verified = verifyStripeSignature(rawBody, signature, setup.webhookSecret);
  if (!verified.ok) return fail(400, verified.error);
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return fail(400, "Stripe event must be JSON.");
  }
  return applyStripeEvent(db, event);
}

function manager(db, session) {
  if (!session?.firm_id || session.portal) return fail(401, "Sign in required.");
  const actor = ownerRole(db, session);
  if (!actor || !canManageFirm(actor.role)) return fail(403, "Only an owner or administrator can change the subscription.");
  return null;
}

export async function startCheckout(db, session, input, { origin, stripeRequest: stripeRequestImpl } = {}) {
  const denied = manager(db, session);
  if (denied) return denied;
  const summary = subscriptionSummary(db, session.firm_id);
  if (summary.billingExempt) return fail(409, "This sample firm stays usable without a Stripe subscription.");
  if (summary.status === "active" && summary.hasStripeSubscription) {
    return fail(409, "This firm already has a test subscription. Change the seat count to upgrade it.");
  }
  if (summary.status === "past_due") {
    return fail(409, "This subscription is past due. Pay the open test invoice before starting another checkout.");
  }
  const setup = stripeSetup();
  const missing = keysProblem(setup);
  if (missing) return missing;
  const plan = PLANS[String(input?.planId || "")];
  if (!plan) return fail(400, "Choose a plan.");
  const price = setup.prices[plan.id];
  if (!price) return fail(503, MISSING_STRIPE_KEYS);
  const seatCount = parseSeatLimit(input?.seatCount);
  if (seatCount === null || seatCount < 1 || seatCount > MAX_SEAT_LIMIT) return fail(400, "Enter a whole number of seats.");
  if (seatCount < summary.seatsUsed) return fail(400, "Seats cannot be fewer than the people who can already sign in.");
  const user = db.prepare("SELECT email FROM users WHERE id = ?").get(session.user_id);
  const params = {
    mode: "subscription",
    success_url: `${origin}/subscribe/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/onboarding`,
    client_reference_id: session.firm_id,
    "line_items[0][price]": price,
    "line_items[0][quantity]": String(seatCount),
    "metadata[firm_id]": session.firm_id,
    "metadata[plan_id]": plan.id,
    "metadata[seat_count]": String(seatCount),
    "subscription_data[metadata][firm_id]": session.firm_id,
    "subscription_data[metadata][plan_id]": plan.id,
    "subscription_data[metadata][seat_count]": String(seatCount),
  };
  if (summary.hasStripeSubscription) {
    const row = db.prepare("SELECT stripe_customer_id FROM firm_subscriptions WHERE firm_id = ?").get(session.firm_id);
    if (row?.stripe_customer_id) params.customer = row.stripe_customer_id;
  }
  if (!params.customer) params.customer_email = user?.email || "";
  let created;
  try {
    created = await callStripe(stripeRequestImpl, { method: "POST", path: "/checkout/sessions", params });
  } catch (error) {
    return stripeFailure(error);
  }
  if (!created?.url || !created.id) return fail(502, "Stripe did not return a test checkout link.");
  audit(db, session, "subscription.checkout", session.firm_id);
  return { status: 201, payload: { url: created.url, sessionId: created.id } };
}

export async function confirmCheckout(db, session, input, { stripeRequest: stripeRequestImpl } = {}) {
  const denied = manager(db, session);
  if (denied) return denied;
  const sessionId = String(input?.sessionId || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return fail(400, "That checkout session is not valid.");
  const setup = stripeSetup();
  const missing = keysProblem(setup);
  if (missing) return missing;
  let checkout;
  try {
    checkout = await callStripe(stripeRequestImpl, { method: "GET", path: `/checkout/sessions/${encodeURIComponent(sessionId)}` });
  } catch (error) {
    return stripeFailure(error);
  }
  const firmId = checkout?.metadata?.firm_id || checkout?.client_reference_id;
  if (firmId !== session.firm_id) return fail(404, "That checkout session is not for this firm.");
  const subscriptionId = idOf(checkout.subscription);
  const customerId = idOf(checkout.customer);
  let stripeSub = null;
  if (subscriptionId) {
    try {
      stripeSub = await callStripe(stripeRequestImpl, { method: "GET", path: `/subscriptions/${encodeURIComponent(subscriptionId)}` });
    } catch (error) {
      return stripeFailure(error);
    }
  }
  if (stripeSub) {
    stripeSub.metadata = { firm_id: firmId, ...(stripeSub.metadata || {}) };
    if (!stripeSub.customer && customerId) stripeSub.customer = customerId;
    applyStripeObject(db, stripeSub);
  } else {
    const seatCount = Number(checkout.metadata?.seat_count);
    const paid = checkout.payment_status === "paid" || checkout.payment_status === "no_payment_required";
    applyFirmSubscription(db, {
      firmId,
      customerId,
      subscriptionId,
      status: paid ? "active" : "incomplete",
      seatLimit: Number.isInteger(seatCount) ? seatCount : undefined,
      planName: planNameFor(setup, "", checkout.metadata?.plan_id),
    });
  }
  return readSubscription(db, session);
}

export async function refreshStripeSubscription(db, session, { stripeRequest: stripeRequestImpl } = {}) {
  const denied = manager(db, session);
  if (denied) return denied;
  const summary = subscriptionSummary(db, session.firm_id);
  if (summary.billingExempt) return readSubscription(db, session);
  const row = db.prepare("SELECT stripe_subscription_id FROM firm_subscriptions WHERE firm_id = ?").get(session.firm_id);
  if (!row?.stripe_subscription_id) return fail(409, "Choose a plan before refreshing the subscription.");
  const setup = stripeSetup();
  const missing = keysProblem(setup);
  if (missing) return missing;
  let stripeSub;
  try {
    stripeSub = await callStripe(stripeRequestImpl, {
      method: "GET",
      path: `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
    });
  } catch (error) {
    return stripeFailure(error);
  }
  applyStripeObject(db, stripeSub);
  return readSubscription(db, session);
}

export async function updateStripeSeats(db, session, input, { stripeRequest: stripeRequestImpl } = {}) {
  const denied = manager(db, session);
  if (denied) return denied;
  const summary = subscriptionSummary(db, session.firm_id);
  if (summary.billingExempt) return updateSeats(db, session, input);
  if (summary.status !== "active" || !summary.hasStripeSubscription) {
    return fail(409, "An active test subscription is required before changing seats.");
  }
  const seatCount = parseSeatLimit(input?.seatCount ?? input?.seatLimit);
  if (seatCount === null || seatCount < 1 || seatCount > MAX_SEAT_LIMIT) return fail(400, "Enter a whole number of seats.");
  if (seatCount < summary.seatsUsed) return fail(400, "Seats cannot be fewer than the people who can already sign in.");
  const setup = stripeSetup();
  const missing = keysProblem(setup);
  if (missing) return missing;
  const row = db.prepare("SELECT stripe_subscription_id FROM firm_subscriptions WHERE firm_id = ?").get(session.firm_id);
  let stripeSub;
  try {
    stripeSub = await callStripe(stripeRequestImpl, {
      method: "GET",
      path: `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
    });
    const item = stripeSub?.items?.data?.[0];
    if (!item?.id) return fail(502, "Stripe did not return a subscription item.");
    stripeSub = await callStripe(stripeRequestImpl, {
      method: "POST",
      path: `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
      params: {
        "items[0][id]": item.id,
        "items[0][quantity]": String(seatCount),
        proration_behavior: "create_prorations",
      },
    });
  } catch (error) {
    return stripeFailure(error);
  }
  applyStripeObject(db, stripeSub);
  audit(db, session, "subscription.seats", session.firm_id);
  return readSubscription(db, session);
}

export async function openStripeInvoice(db, session, { stripeRequest: stripeRequestImpl } = {}) {
  const denied = manager(db, session);
  if (denied) return denied;
  const summary = subscriptionSummary(db, session.firm_id);
  if (summary.billingExempt) return fail(409, "This sample firm stays usable without a Stripe subscription.");
  const row = db.prepare("SELECT stripe_customer_id FROM firm_subscriptions WHERE firm_id = ?").get(session.firm_id);
  if (!row?.stripe_customer_id) return fail(409, "Choose a plan before opening a test invoice.");
  const setup = stripeSetup();
  const missing = keysProblem(setup);
  if (missing) return missing;
  let list;
  try {
    list = await callStripe(stripeRequestImpl, {
      method: "GET",
      path: "/invoices",
      params: { customer: row.stripe_customer_id, status: "open", limit: "1" },
    });
  } catch (error) {
    return stripeFailure(error);
  }
  const invoice = list?.data?.[0];
  if (!invoice?.hosted_invoice_url) return fail(404, "Stripe has no open test invoice for this firm.");
  return { status: 200, payload: { url: invoice.hosted_invoice_url } };
}
