import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";

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

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-"));
  const dbPath = path.join(dir, "test.sqlite");
  const running = await start(dbPath, 0);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base, dbPath);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

async function signIn(jar, base, account) {
  const response = await jar.fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const body = await response.json();
  return { response, body };
}

async function sendJson(jar, base, method, pathname, payload) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test("firm seats gate invites, and a firm payment leaves the client trial balance alone", async () => {
  await withServer(async (base, dbPath) => {
    const unsigned = await fetch(`${base}/api/subscription`);
    assert.equal(unsigned.status, 401);

    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.body.subscription.planName, "Practice");
    assert.equal(signedIn.body.subscription.seatsUsed, 4);
    assert.equal(signedIn.body.subscription.seatLimit, 5);
    assert.equal(signedIn.body.members.length, signedIn.body.subscription.seatsUsed);
    assert.equal(JSON.stringify(signedIn.body).toLowerCase().includes("compliance"), false);
    assert.equal(JSON.stringify(signedIn.body).includes("Professional plan"), false);

    const opened = await sendJson(olivia, base, "GET", "/api/subscription");
    assert.equal(opened.response.status, 200);
    assert.deepEqual(opened.body.billing, []);
    assert.equal(opened.body.subscription.seatsUsed, 4);

    const drafted = await sendJson(olivia, base, "POST", "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2026-05-12",
      dueDate: "2026-06-11",
      lines: [{ description: "Design work", amount: "200.00" }],
    });
    assert.equal(drafted.response.status, 201);
    const sent = await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/send`);
    assert.equal(sent.response.status, 200);
    assert.equal(sent.body.invoice.status, "sent");
    const before = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const beforeDebits = before.trialBalance.debitsCents;
    assert.ok(beforeDebits > 0);
    const dbBefore = new DatabaseSync(dbPath);
    const journalsBefore = Number(dbBefore.prepare("SELECT COUNT(*) AS count FROM journal_entries").get().count);
    const paymentsBefore = Number(dbBefore.prepare("SELECT COUNT(*) AS count FROM invoice_payments").get().count);
    dbBefore.close();

    const haven = signedIn.body.clients.find((client) => client.name === "Haven Coffee Roasters");
    const switched = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
    assert.equal(switched.response.status, 200);
    const havenBooks = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(havenBooks.trialBalance.debitsCents, 0);

    const billed = await sendJson(olivia, base, "POST", "/api/subscription/payments", {
      amount: "40.00",
      memo: "Ledgerly practice plan",
      clientId: haven.id,
    });
    assert.equal(billed.response.status, 201);
    assert.equal(billed.body.billing.length, 1);
    assert.equal(billed.body.billing[0].amount, "$40.00");
    assert.equal(billed.body.billing[0].memo, "Ledgerly practice plan");
    assert.equal(billed.body.billing[0].actorName, "Olivia Martin");
    assert.equal(JSON.stringify(billed.body).toLowerCase().includes("compliance"), false);
    assert.equal(billed.body.subscription.seatsUsed, 4);

    const numbered = await sendJson(olivia, base, "POST", "/api/subscription/payments", { amount: 40, memo: "Again" });
    assert.equal(numbered.response.status, 400);
    const havenAfter = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(havenAfter.trialBalance.debitsCents, 0);
    assert.equal(havenAfter.entries.length, 0);

    const back = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: signedIn.body.client.id });
    assert.equal(back.response.status, 200);
    const after = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(after.trialBalance.debitsCents, beforeDebits);
    assert.equal(after.trialBalance.foots, true);
    const invoices = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(invoices.invoices[0].status, "sent");
    assert.notEqual(invoices.invoices[0].status, "paid");

    const db = new DatabaseSync(dbPath);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM journal_entries").get().count), journalsBefore);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM invoice_payments").get().count), paymentsBefore);
    const billedAudit = db.prepare("SELECT client_id FROM audit_events WHERE action = 'subscription.billed'").all();
    assert.equal(billedAudit.length, 1);
    assert.equal(billedAudit[0].client_id, null);
    db.close();

    const invited = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Sam Rivera",
      email: "sam.rivera@northstarcreative.co",
      role: "staff",
      password: "ledgerly-rivera",
    });
    assert.equal(invited.response.status, 201);
    assert.equal(invited.body.subscription.seatsUsed, 5);
    assert.equal(invited.body.members.length, 5);

    const staff = cookieJar();
    const staffSignIn = await signIn(staff, base, { email: "sam.rivera@northstarcreative.co", password: "ledgerly-rivera" });
    assert.equal(staffSignIn.response.status, 200);
    const staffSeats = await sendJson(staff, base, "PATCH", "/api/subscription", { seatLimit: 4 });
    assert.equal(staffSeats.response.status, 403);
    const staffPay = await sendJson(staff, base, "POST", "/api/subscription/payments", { amount: "10.00", memo: "Staff try" });
    assert.equal(staffPay.response.status, 403);

    const tightened = await sendJson(olivia, base, "PATCH", "/api/subscription", { seatLimit: 5 });
    assert.equal(tightened.response.status, 200);
    assert.equal(tightened.body.subscription.seatLimit, 5);
    assert.equal(tightened.body.subscription.seatsOpen, 0);
    const blocked = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Alex Kim",
      email: "alex@northstarcreative.co",
      role: "staff",
      password: "ledgerly-alex",
    });
    assert.equal(blocked.response.status, 409);
    assert.match(blocked.body.error, /open seats/i);
    const still = await (await olivia.fetch(`${base}/api/session`)).json();
    assert.equal(still.members.some((member) => member.email === "alex@northstarcreative.co"), false);
    assert.equal(still.subscription.seatsUsed, 5);

    const openedUp = await sendJson(olivia, base, "PATCH", "/api/subscription", { seatLimit: 6 });
    assert.equal(openedUp.response.status, 200);
    const allowed = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Alex Kim",
      email: "alex@northstarcreative.co",
      role: "manager",
      password: "ledgerly-alex",
    });
    assert.equal(allowed.response.status, 201);
    assert.equal(allowed.body.subscription.seatsUsed, 6);
    const alex = cookieJar();
    const alexSignIn = await signIn(alex, base, { email: "alex@northstarcreative.co", password: "ledgerly-alex" });
    assert.equal(alexSignIn.response.status, 200);
    assert.equal(alexSignIn.body.subscription.seatsUsed, 6);

    const tooSmall = await sendJson(olivia, base, "PATCH", "/api/subscription", { seatLimit: 5 });
    assert.equal(tooSmall.response.status, 400);
    const kept = await (await olivia.fetch(`${base}/api/subscription`)).json();
    assert.equal(kept.subscription.seatLimit, 6);

    const afterSeats = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(afterSeats.trialBalance.debitsCents, beforeDebits);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const harborPlan = await (await harbor.fetch(`${base}/api/subscription`)).json();
    assert.equal(harborPlan.subscription.seatsUsed, 1);
    assert.equal(harborPlan.billing.length, 0);
    assert.equal(JSON.stringify(harborPlan).includes("Ledgerly practice plan"), false);

    const client = cookieJar();
    await signIn(client, base, firms.northstar.portal);
    for (const [pathname, method, payload] of [
      ["/api/subscription", "GET", undefined],
      ["/api/subscription", "PATCH", { seatLimit: 9 }],
      ["/api/subscription/payments", "POST", { amount: "40.00", memo: "Portal" }],
    ]) {
      const response = await client.fetch(`${base}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      assert.equal(response.status, 404, `${method} ${pathname}`);
    }
  });
});

test("the firm plan stays off client transactions and off the ledger", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const subscription = readFileSync(new URL("./subscription.js", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../src/Subscription.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /Professional plan · 8 seats/);
  assert.match(shell, /SubscriptionSetting/);
  assert.match(screen, /Record firm payment/);
  assert.match(screen, /does not mark a client invoice paid/);
  assert.doesNotMatch(`${subscription}\n${screen}`, /compliance/i);
  assert.doesNotMatch(subscription, /postJournalEntry/);
  assert.doesNotMatch(subscription, /invoice_payments/);
});
