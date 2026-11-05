import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { resetRateLimits } from "./auth.js";
import { redact, signStripePayload, verifyStripeSignature } from "./stripe.js";

const SECRET = "sk_test_ledgerlygate";
const WEBHOOK = "whsec_ledgerlygate";

function cookieJar() {
  const cookies = new Map();
  return {
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookies.size) headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      const response = await fetch(url, { ...options, headers });
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      for (const line of setCookies) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1);
        if (/Max-Age=0/i.test(line)) cookies.delete(key);
        else cookies.set(key, value);
      }
      return response;
    },
  };
}

async function withServer(fn, options = {}) {
  resetRateLimits();
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-stripe-"));
  const dbPath = path.join(dir, "test.sqlite");
  const running = await start(dbPath, 0, options);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base, dbPath);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

async function post(jar, base, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

function linkToken(linkPath, base) {
  return new URL(linkPath, base).searchParams.get("token");
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unexpected table ${name}`);
  return name;
}

function clientBookCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const counts = {};
  for (const table of tables) {
    if (table.name === "audit_events") continue;
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all();
    if (!columns.some((column) => column.name === "client_id")) continue;
    const rows = db.prepare(
      `SELECT client_id, COUNT(*) AS count FROM ${quoteIdent(table.name)} WHERE client_id IS NOT NULL GROUP BY client_id`,
    ).all();
    counts[table.name] = Object.fromEntries(rows.map((row) => [row.client_id, Number(row.count)]));
  }
  db.close();
  return counts;
}

function saveEnv(keys) {
  const previous = {};
  for (const key of keys) previous[key] = process.env[key];
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

function useTestStripe() {
  process.env.STRIPE_SECRET_KEY = SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK;
  process.env.STRIPE_PRICE_PRACTICE = "price_practice_test";
  process.env.STRIPE_PRICE_FIRM = "price_firm_test";
}

function clearStripe() {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_PRACTICE;
  delete process.env.STRIPE_PRICE_FIRM;
}

async function registerFirm(base) {
  const jar = cookieJar();
  const registered = await post(jar, base, "/api/register", {
    name: "Ava Quinn",
    email: "ava@pine-ledger.example",
    password: "ledgerly-ava-1",
    confirmPassword: "ledgerly-ava-1",
    acceptTerms: true,
    acceptPrivacy: true,
    accountType: "firm",
  });
  assert.equal(registered.response.status, 201);
  const mailbox = await jar.fetch(`${base}/api/dev/mailbox?email=ava@pine-ledger.example`);
  const messages = await mailbox.json();
  const token = linkToken(messages.messages.at(-1).linkPath, base);
  const verified = await post(jar, base, "/api/email-verification", { token });
  assert.equal(verified.response.status, 200);
  const created = await post(jar, base, "/api/onboarding/firm", {
    firmName: "Pine Ledger",
    businessType: "cpa_firm",
    country: "US",
    timeZone: "America/Chicago",
    accountingMethod: "cash",
    fiscalYearStart: 7,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.subscription.status, "incomplete");
  assert.equal(created.body.subscription.billingExempt, false);
  assert.equal(created.body.subscription.allowsWork, false);
  assert.equal(created.body.subscription.seatsUsed, 1);
  return { jar, firmId: created.body.firm.id };
}

function stripeDouble() {
  const calls = [];
  let checkout = null;
  const impl = async (request) => {
    calls.push(request);
    if (request.method === "POST" && request.path === "/checkout/sessions") {
      checkout = request.params;
      return { id: "cs_test_gate", url: "https://checkout.stripe.com/c/pay/cs_test_gate" };
    }
    if (request.method === "GET" && request.path === "/checkout/sessions/cs_test_gate") {
      return {
        id: "cs_test_gate",
        payment_status: "paid",
        customer: "cus_test_gate",
        subscription: "sub_test_gate",
        client_reference_id: checkout.client_reference_id,
        metadata: {
          firm_id: checkout["metadata[firm_id]"],
          plan_id: checkout["metadata[plan_id]"],
          seat_count: checkout["metadata[seat_count]"],
        },
      };
    }
    if (request.method === "GET" && request.path === "/subscriptions/sub_test_gate") {
      return {
        id: "sub_test_gate",
        object: "subscription",
        customer: "cus_test_gate",
        status: "active",
        metadata: { firm_id: checkout["metadata[firm_id]"], plan_id: "practice" },
        items: { data: [{ id: "si_test_gate", quantity: 3, price: { id: "price_practice_test" } }] },
      };
    }
    if (request.method === "POST" && request.path === "/subscriptions/sub_test_gate") {
      return {
        id: "sub_test_gate",
        object: "subscription",
        customer: "cus_test_gate",
        status: "active",
        metadata: { firm_id: checkout["metadata[firm_id]"], plan_id: "practice" },
        items: { data: [{ id: "si_test_gate", quantity: Number(request.params["items[0][quantity]"]), price: { id: "price_practice_test" } }] },
      };
    }
    throw new Error(`Unexpected Stripe call ${request.method} ${request.path}`);
  };
  return { impl, calls, checkout: () => checkout };
}

async function sendWebhook(base, event) {
  const raw = JSON.stringify(event);
  const signed = signStripePayload(raw, WEBHOOK);
  const response = await fetch(`${base}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signed.header },
    body: raw,
  });
  const body = await response.json();
  return { response, body, raw };
}

function subscriptionEvent(firmId, status) {
  return {
    id: `evt_${status}`,
    type: status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated",
    data: {
      object: {
        id: "sub_test_gate",
        object: "subscription",
        customer: "cus_test_gate",
        status: status === "canceled" ? "canceled" : status,
        metadata: { firm_id: firmId, plan_id: "practice" },
        items: { data: [{ id: "si_test_gate", quantity: 3, price: { id: "price_practice_test" } }] },
      },
    },
  };
}

test("stripe signatures reject a mismatch and a stale timestamp", () => {
  const raw = JSON.stringify({ id: "evt_unit" });
  const signed = signStripePayload(raw, "whsec_unit", 1_700_000_000);
  assert.equal(verifyStripeSignature(raw, signed.header, "whsec_unit", 1_700_000_000 * 1000).ok, true);
  assert.equal(verifyStripeSignature(raw, "t=1700000000,v1=deadbeef", "whsec_unit", 1_700_000_000 * 1000).ok, false);
  assert.equal(verifyStripeSignature(raw, signed.header, "whsec_unit", (1_700_000_000 + 1000) * 1000).ok, false);
  assert.equal(redact("Invalid API Key provided: sk_test_abc1234567"), "Invalid API Key provided: [redacted]");
});

test("a new firm stays closed until Stripe test checkout, and sample firms stay open", async () => {
  const restore = saveEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRACTICE", "STRIPE_PRICE_FIRM"]);
  clearStripe();
  const stripe = stripeDouble();
  try {
    await withServer(async (base, dbPath) => {
      const northstar = cookieJar();
      const signedIn = await post(northstar, base, "/api/session", firms.northstar.owner);
      assert.equal(signedIn.response.status, 200);
      assert.equal(signedIn.body.subscription.billingExempt, true);
      assert.equal(signedIn.body.subscription.allowsWork, true);
      const beforeBooks = clientBookCounts(dbPath);
      const ledger = await (await northstar.fetch(`${base}/api/ledger`)).json();
      const cash = ledger.accounts.find((account) => account.code === "1000").id;
      const revenue = ledger.accounts.find((account) => account.code === "4000").id;
      const posted = await post(northstar, base, "/api/journal-entries", {
        entryDate: "2026-11-03",
        memo: "Sample firm still posts",
        lines: [
          { accountId: cash, debit: "10.00", credit: "" },
          { accountId: revenue, debit: "", credit: "10.00" },
        ],
      });
      assert.equal(posted.response.status, 201);

      const { jar, firmId } = await registerFirm(base);
      const gated = await (await jar.fetch(`${base}/api/subscription`)).json();
      assert.equal(gated.subscription.allowsWork, false);
      assert.equal(gated.stripe.configured, false);
      assert.match(gated.stripe.notice, /not configured/i);
      assert.equal(JSON.stringify(gated).includes(SECRET), false);

      const blockedClient = await post(jar, base, "/api/clients", {
        name: "Northwind Supply",
        legalName: "Northwind Supply LLC",
        industry: "Wholesale",
        businessType: "LLC",
        accountingMethod: "cash",
        fiscalYearStart: "July",
      });
      assert.equal(blockedClient.response.status, 403);
      assert.match(blockedClient.body.error, /plan/i);
      const blockedEnter = await post(jar, base, "/api/onboarding/enter", {});
      assert.equal(blockedEnter.response.status, 403);

      const missing = await post(jar, base, "/api/subscription/checkout", { planId: "practice", seatCount: 3 });
      assert.equal(missing.response.status, 503);
      assert.match(missing.body.error, /not configured/i);
      assert.equal(JSON.stringify(missing.body).includes("sk_"), false);
      assert.equal(stripe.calls.length, 0);

      process.env.STRIPE_SECRET_KEY = "sk_live_not_for_ledgerly";
      process.env.STRIPE_PRICE_PRACTICE = "price_practice_test";
      process.env.STRIPE_PRICE_FIRM = "price_firm_test";
      const live = await post(jar, base, "/api/subscription/checkout", { planId: "practice", seatCount: 3 });
      assert.equal(live.response.status, 403);
      assert.match(live.body.error, /live key/i);
      assert.equal(JSON.stringify(live.body).includes("sk_live_"), false);
      assert.equal(stripe.calls.length, 0);

      useTestStripe();
      const checkout = await post(jar, base, "/api/subscription/checkout", { planId: "practice", seatCount: 3 });
      assert.equal(checkout.response.status, 201);
      assert.equal(checkout.body.url, "https://checkout.stripe.com/c/pay/cs_test_gate");
      assert.equal(JSON.stringify(checkout.body).includes(SECRET), false);
      assert.equal(stripe.checkout()["line_items[0][price]"], "price_practice_test");
      assert.equal(stripe.checkout()["line_items[0][quantity]"], "3");
      assert.equal(stripe.checkout().mode, "subscription");
      assert.match(stripe.checkout().success_url, /\{CHECKOUT_SESSION_ID\}/);
      assert.equal(JSON.stringify(stripe.calls).includes(SECRET), false);

      const confirmed = await post(jar, base, "/api/subscription/checkout/confirm", { sessionId: "cs_test_gate" });
      assert.equal(confirmed.response.status, 200);
      assert.equal(confirmed.body.subscription.status, "active");
      assert.equal(confirmed.body.subscription.planName, "Practice");
      assert.equal(confirmed.body.subscription.seatLimit, 3);
      assert.equal(confirmed.body.subscription.allowsWork, true);
      assert.equal(confirmed.body.subscription.billingExempt, false);
      assert.equal(JSON.stringify(confirmed.body).includes("cus_test_gate"), false);

      const client = await post(jar, base, "/api/clients", {
        name: "Northwind Supply",
        legalName: "Northwind Supply LLC",
        industry: "Wholesale",
        businessType: "LLC",
        accountingMethod: "cash",
        fiscalYearStart: "July",
      });
      assert.equal(client.response.status, 201);
      const entered = await post(jar, base, "/api/onboarding/enter", {});
      assert.equal(entered.response.status, 200);
      assert.equal(entered.body.subscription.seatsUsed, 1);

      const invited = await post(jar, base, `/api/clients/${client.body.client.id}/invitations`, {
        name: "Quinn Hart",
        email: "quinn@northwind.example",
      });
      assert.equal(invited.response.status, 201);
      const mailbox = await jar.fetch(`${base}/api/dev/mailbox?email=quinn@northwind.example`);
      const messages = await mailbox.json();
      const accepted = await post(cookieJar(), base, "/api/invitations/accept", {
        token: linkToken(messages.messages.at(-1).linkPath, base),
        name: "Quinn Hart",
        password: "ledgerly-quinn",
        confirmPassword: "ledgerly-quinn",
      });
      assert.equal(accepted.response.status, 200);
      assert.equal(accepted.body.portal, true);
      const afterPortal = await (await jar.fetch(`${base}/api/session`)).json();
      assert.equal(afterPortal.subscription.seatsUsed, 1);
      assert.equal(afterPortal.members.length, 1);

      const first = await post(jar, base, "/api/members", {
        name: "Sam Rivera",
        email: "sam@pine-ledger.example",
        role: "staff",
        password: "ledgerly-sam-1",
      });
      assert.equal(first.response.status, 201);
      const second = await post(jar, base, "/api/members", {
        name: "Riley Chen",
        email: "riley@pine-ledger.example",
        role: "staff",
        password: "ledgerly-riley-1",
      });
      assert.equal(second.response.status, 201);
      assert.equal(second.body.subscription.seatsUsed, 3);
      const third = await post(jar, base, "/api/members", {
        name: "Alex Kim",
        email: "alex@pine-ledger.example",
        role: "staff",
        password: "ledgerly-alex-1",
      });
      assert.equal(third.response.status, 409);
      assert.match(third.body.error, /open seats|upgrade/i);

      const upgraded = await post(jar, base, "/api/subscription/seats", { seatCount: 4 });
      assert.equal(upgraded.response.status, 200);
      assert.equal(upgraded.body.subscription.seatLimit, 4);
      const fourth = await post(jar, base, "/api/members", {
        name: "Alex Kim",
        email: "alex@pine-ledger.example",
        role: "staff",
        password: "ledgerly-alex-1",
      });
      assert.equal(fourth.response.status, 201);

      const pastDue = await sendWebhook(base, subscriptionEvent(firmId, "past_due"));
      assert.equal(pastDue.response.status, 200);
      assert.equal(pastDue.body.status, "past_due");
      const readable = await jar.fetch(`${base}/api/ledger`);
      assert.equal(readable.status, 200);
      const journalBlocked = await post(jar, base, "/api/journal-entries", {});
      assert.equal(journalBlocked.response.status, 403);
      assert.match(journalBlocked.body.error, /past due/i);
      const invoiceBlocked = await post(jar, base, "/api/invoices", {});
      assert.equal(invoiceBlocked.response.status, 403);
      const billBlocked = await post(jar, base, "/api/payables/bills", {});
      assert.equal(billBlocked.response.status, 403);
      const expenseBlocked = await post(jar, base, "/api/expenses", {});
      assert.equal(expenseBlocked.response.status, 403);
      const inviteBlocked = await post(jar, base, "/api/members", {
        name: "Pat Lee",
        email: "pat@pine-ledger.example",
        role: "staff",
        password: "ledgerly-pat-11",
      });
      assert.equal(inviteBlocked.response.status, 403);

      const forged = await fetch(`${base}/api/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=nope" },
        body: JSON.stringify(subscriptionEvent(firmId, "active")),
      });
      assert.equal(forged.status, 400);
      const stillDue = await (await jar.fetch(`${base}/api/subscription`)).json();
      assert.equal(stillDue.subscription.status, "past_due");

      const active = await sendWebhook(base, subscriptionEvent(firmId, "active"));
      assert.equal(active.response.status, 200);
      const openLedger = await (await jar.fetch(`${base}/api/ledger`)).json();
      const postedWork = await post(jar, base, "/api/journal-entries", {
        entryDate: "2026-11-03",
        memo: "Active subscription posts",
        lines: [
          { accountId: openLedger.accounts.find((account) => account.code === "1000").id, debit: "15.00", credit: "" },
          { accountId: openLedger.accounts.find((account) => account.code === "4000").id, debit: "", credit: "15.00" },
        ],
      });
      assert.equal(postedWork.response.status, 201);

      const canceled = await sendWebhook(base, subscriptionEvent(firmId, "canceled"));
      assert.equal(canceled.body.status, "canceled");
      const clientBlocked = await post(jar, base, "/api/clients", {
        name: "Second Client",
        businessType: "LLC",
        accountingMethod: "cash",
        fiscalYearStart: "July",
      });
      assert.equal(clientBlocked.response.status, 403);
      assert.match(clientBlocked.body.error, /canceled/i);
      const stillReadable = await jar.fetch(`${base}/api/ledger`);
      assert.equal(stillReadable.status, 200);

      const northstarAgain = await post(northstar, base, "/api/journal-entries", {
        entryDate: "2026-11-04",
        memo: "Sample firm still posts after the gate",
        lines: [
          { accountId: cash, debit: "5.00", credit: "" },
          { accountId: revenue, debit: "", credit: "5.00" },
        ],
      });
      assert.equal(northstarAgain.response.status, 201);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare(
        "SELECT firm_id, stripe_customer_id, stripe_subscription_id, status, billing_exempt FROM firm_subscriptions WHERE firm_id = ?",
      ).get(firmId);
      assert.equal(row.stripe_customer_id, "cus_test_gate");
      assert.equal(row.stripe_subscription_id, "sub_test_gate");
      assert.equal(row.status, "canceled");
      assert.equal(Number(row.billing_exempt), 0);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      for (const table of tables) {
        if (table.name === "firm_subscriptions") continue;
        const names = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all().map((column) => column.name);
        assert.equal(names.some((name) => name.startsWith("stripe_")), false, table.name);
      }
      const northstarFirm = db.prepare("SELECT id FROM firms WHERE name = 'Northstar'").get();
      const sample = db.prepare("SELECT billing_exempt, stripe_customer_id FROM firm_subscriptions WHERE firm_id = ?").get(northstarFirm.id);
      assert.equal(Number(sample.billing_exempt), 1);
      assert.equal(sample.stripe_customer_id, null);
      db.close();

      const afterBooks = clientBookCounts(dbPath);
      for (const [table, rows] of Object.entries(beforeBooks)) {
        for (const [clientId, count] of Object.entries(rows)) {
          if (table === "journal_entries" || table === "journal_lines") continue;
          assert.equal(afterBooks[table]?.[clientId], count, `${table} ${clientId}`);
        }
      }
    }, { stripeRequest: stripe.impl });
  } finally {
    restore();
  }
});
