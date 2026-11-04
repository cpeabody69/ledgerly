import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { loadPlaidEnv } from "./plaid.js";

const ENV_KEYS = ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"];
const ACCESS_TOKEN = "access-sandbox-secret-token";

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-plaid-"));
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
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body, text };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("a sandbox sync does not duplicate, post, or cross a firm", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  for (const key of ENV_KEYS) delete process.env[key];
  const envDir = await mkdtemp(path.join(tmpdir(), "ledgerly-plaid-env-"));
  const envFile = path.join(envDir, ".env");
  writeFileSync(envFile, "PLAID_CLIENT_ID=from-file\nPLAID_SECRET=from-file-secret\nPLAID_ENV=sandbox\nPLAID_WEBHOOK=https://nope.example\nOTHER=1\n");
  delete process.env.PLAID_WEBHOOK;
  delete process.env.OTHER;
  loadPlaidEnv(envFile);
  assert.equal(process.env.PLAID_CLIENT_ID, "from-file");
  assert.equal(process.env.PLAID_SECRET, "from-file-secret");
  assert.equal(process.env.PLAID_ENV, "sandbox");
  assert.equal(process.env.PLAID_WEBHOOK, undefined);
  assert.equal(process.env.OTHER, undefined);
  for (const key of ENV_KEYS) delete process.env[key];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("production.plaid.com") || target.includes("development.plaid.com")) {
      throw new Error(`refused non-sandbox host ${target}`);
    }
    if (!target.startsWith("https://sandbox.plaid.com/")) return originalFetch(url, options);
    const body = JSON.parse(options.body || "{}");
    calls.push({ url: target, body });
    if (target.endsWith("/link/token/create")) {
      return jsonResponse({ link_token: "link-sandbox-token", expiration: "2026-11-04T20:00:00Z" });
    }
    if (target.endsWith("/item/public_token/exchange")) {
      return jsonResponse({ access_token: ACCESS_TOKEN, item_id: "item-sandbox-1" });
    }
    if (target.endsWith("/accounts/get")) {
      return jsonResponse({
        accounts: [
          { account_id: "acc-checking", name: "Plaid Checking", mask: "0000", type: "depository", balances: { current: 110, available: 100 } },
          { account_id: "acc-credit", name: "Plaid Credit Card", mask: "3333", type: "credit", balances: { current: 410, available: null } },
        ],
        item: { item_id: "item-sandbox-1", institution_id: "ins_109508" },
      });
    }
    if (target.endsWith("/institutions/get_by_id")) {
      return jsonResponse({ institution: { institution_id: "ins_109508", name: "First Platypus Bank" } });
    }
    if (target.endsWith("/transactions/sync")) {
      calls.syncs = (calls.syncs || 0) + 1;
      const added = [
        { transaction_id: "txn-coffee", account_id: "acc-checking", amount: 6.33, date: "2026-05-12", name: "Starbucks", merchant_name: "Starbucks", pending: false },
        { transaction_id: "txn-coffee", account_id: "acc-checking", amount: 6.33, date: "2026-05-12", name: "Starbucks", merchant_name: "Starbucks", pending: false },
        { transaction_id: "txn-deposit", account_id: "acc-checking", amount: -25, date: "2026-05-13", name: "Client deposit", merchant_name: "Northstar Client", pending: false },
        { transaction_id: "txn-pending", account_id: "acc-checking", amount: 4, date: "2026-05-14", name: "Pending hold", pending: true },
        { transaction_id: "txn-bad-date", account_id: "acc-checking", amount: 9, date: "05/12/2026", name: "Bad date", pending: false },
      ];
      if (calls.syncs > 1) {
        added.push({
          transaction_id: "txn-deposit-posted",
          pending_transaction_id: "txn-deposit",
          account_id: "acc-checking",
          amount: -30,
          date: "2026-05-15",
          name: "Client deposit",
          merchant_name: "Brightline Labs",
          pending: false,
        });
      }
      return jsonResponse({ added, modified: [], removed: [], next_cursor: `cursor-${calls.syncs}`, has_more: false });
    }
    return jsonResponse({ error_message: "unexpected sandbox path" });
  };

  const seen = [];
  try {
    await withServer(async (base, dbPath) => {
      const olivia = cookieJar();
      const signedIn = await signIn(olivia, base, firms.northstar.owner);
      assert.equal(signedIn.response.status, 200);
      const unsigned = await fetch(`${base}/api/plaid`);
      assert.equal(unsigned.status, 401);

      const closed = await sendJson(olivia, base, "GET", "/api/plaid");
      seen.push(closed.text);
      assert.equal(closed.response.status, 200);
      assert.equal(closed.body.configured, false);
      assert.equal(closed.body.env, null);
      assert.match(closed.body.notice, /sandbox credentials are not configured/i);
      assert.deepEqual(closed.body.connections, []);
      const refused = await sendJson(olivia, base, "POST", "/api/plaid/link-token");
      seen.push(refused.text);
      assert.equal(refused.response.status, 400);
      assert.equal(calls.length, 0);

      process.env.PLAID_CLIENT_ID = "sandbox-client";
      process.env.PLAID_SECRET = "sandbox-secret-value";
      process.env.PLAID_ENV = "production";
      const production = await sendJson(olivia, base, "GET", "/api/plaid");
      seen.push(production.text);
      assert.equal(production.body.configured, false);
      assert.match(production.body.notice, /limited to the sandbox/i);
      const productionToken = await sendJson(olivia, base, "POST", "/api/plaid/link-token");
      assert.equal(productionToken.response.status, 400);
      assert.equal(calls.length, 0);

      process.env.PLAID_ENV = "sandbox";
      const linked = await sendJson(olivia, base, "POST", "/api/plaid/link-token");
      seen.push(linked.text);
      assert.equal(linked.response.status, 200);
      assert.equal(linked.body.linkToken, "link-sandbox-token");
      const linkCall = calls.find((call) => call.url.endsWith("/link/token/create"));
      assert.equal(linkCall.body.client_id, "sandbox-client");
      assert.equal(linkCall.body.secret, "sandbox-secret-value");
      assert.equal(linkCall.body.redirect_uri, undefined);
      assert.equal(linkCall.body.webhook, undefined);
      assert.deepEqual(linkCall.body.products, ["transactions"]);
      assert.equal(linked.text.includes("sandbox-secret-value"), false);

      const connected = await sendJson(olivia, base, "POST", "/api/plaid/exchange", { publicToken: "public-sandbox-token" });
      seen.push(connected.text);
      assert.equal(connected.response.status, 200);
      assert.equal(connected.body.configured, true);
      assert.equal(connected.body.env, "sandbox");
      assert.equal(connected.body.connections.length, 1);
      assert.equal(connected.body.connections[0].institutionName, "First Platypus Bank");
      assert.equal(connected.body.connections[0].status, "connected");
      assert.equal(connected.body.connections[0].accounts.length, 2);
      const checking = connected.body.connections[0].accounts.find((account) => account.name === "Plaid Checking");
      const credit = connected.body.connections[0].accounts.find((account) => account.name === "Plaid Credit Card");
      assert.equal(checking.balanceCents, 11000);
      assert.equal(checking.balance, "$110.00");
      assert.equal(credit.balanceCents, 41000);
      assert.equal(credit.kind, "card");

      const lines = await (await olivia.fetch(`${base}/api/transactions`)).json();
      seen.push(JSON.stringify(lines));
      assert.equal(lines.transactions.length, 2);
      assert.equal(lines.transactions.every((row) => row.source === "plaid" && row.status === "for_review" && !row.journalEntryId), true);
      const coffee = lines.transactions.find((row) => row.description === "Starbucks");
      const deposit = lines.transactions.find((row) => row.description === "Client deposit");
      assert.equal(coffee.postedOn, "2026-05-12");
      assert.equal(coffee.merchantName, "Starbucks");
      assert.equal(coffee.amountCents, -633);
      assert.equal(coffee.suggestion.code, "6400");
      assert.equal(coffee.suggestion.name, "Office expenses");
      assert.equal(coffee.category, "");
      assert.equal(deposit.postedOn, "2026-05-13");
      assert.equal(deposit.merchantName, "Northstar Client");
      assert.equal(deposit.amountCents, 2500);
      assert.equal(deposit.suggestion.code, "4000");
      assert.equal(deposit.journalEntryId, null);
      assert.equal(connected.body.connections[0].history[0].imported, 2);
      assert.equal(connected.body.connections[0].history[0].status, "ok");
      const beforeLedger = await (await olivia.fetch(`${base}/api/ledger`)).json();
      assert.equal(beforeLedger.entries.length, 0);
      assert.equal(beforeLedger.trialBalance.debitsCents, 0);
      assert.equal(beforeLedger.trialBalance.debitsCents, beforeLedger.trialBalance.creditsCents);
      assert.equal(beforeLedger.foots, true);

      const again = await sendJson(olivia, base, "POST", "/api/plaid/sync", { connectionId: connected.body.connections[0].id });
      seen.push(again.text);
      assert.equal(again.response.status, 200);
      assert.equal(again.body.imported, 0);
      assert.equal(again.body.connections[0].history[0].imported, 0);
      assert.equal(again.body.connections[0].status, "connected");
      const afterSecond = await (await olivia.fetch(`${base}/api/transactions`)).json();
      assert.equal(afterSecond.transactions.length, 2);
      const refreshedDeposit = afterSecond.transactions.find((row) => row.id === deposit.id);
      assert.equal(refreshedDeposit.amountCents, 3000);
      assert.equal(refreshedDeposit.postedOn, "2026-05-15");
      assert.equal(refreshedDeposit.merchantName, "Brightline Labs");
      assert.equal(refreshedDeposit.status, "for_review");
      assert.equal(refreshedDeposit.journalEntryId, null);
      const stillEmpty = await (await olivia.fetch(`${base}/api/ledger`)).json();
      assert.equal(stillEmpty.entries.length, 0);
      assert.equal(stillEmpty.foots, true);

      const expense = lines.accounts.find((account) => account.code === "6400");
      const categorized = await sendJson(olivia, base, "POST", `/api/transactions/${coffee.id}/categorize`, { accountId: expense.id });
      assert.equal(categorized.response.status, 200);
      assert.equal(categorized.body.transaction.status, "categorized");
      assert.equal(categorized.body.transaction.suggestion, null);
      assert.ok(categorized.body.transaction.journalEntryId);
      assert.equal(categorized.body.entry.debitCents, categorized.body.entry.creditCents);
      assert.equal(categorized.body.entry.debitCents, 633);
      const posted = await (await olivia.fetch(`${base}/api/ledger`)).json();
      assert.equal(posted.entries.length, 1);
      assert.equal(posted.foots, true);
      assert.equal(posted.trialBalance.debitsCents, posted.trialBalance.creditsCents);
      assert.equal(posted.trialBalance.debitsCents, 633);
      const reconciled = await sendJson(olivia, base, "POST", "/api/reconciliations", {
        bankAccountId: coffee.bankAccountId,
        statementDate: "2026-05-31",
        statementEnding: "-6.33",
        transactionIds: [coffee.id],
      });
      assert.equal(reconciled.response.status, 201);
      assert.equal(reconciled.body.reconciliation.status, "complete");
      const footed = await (await olivia.fetch(`${base}/api/ledger`)).json();
      assert.equal(footed.entries.length, 1);
      assert.equal(footed.foots, true);
      assert.equal(footed.trialBalance.debitsCents, 633);
      const waiting = posted && (await (await olivia.fetch(`${base}/api/transactions`)).json()).transactions.find((row) => row.id === deposit.id);
      assert.equal(waiting.status, "for_review");
      assert.equal(waiting.journalEntryId, null);

      const third = await sendJson(olivia, base, "POST", "/api/plaid/sync", { connectionId: connected.body.connections[0].id });
      assert.equal(third.response.status, 200);
      assert.equal(third.body.imported, 0);
      const afterThird = await (await olivia.fetch(`${base}/api/ledger`)).json();
      assert.equal(afterThird.entries.length, 1);
      const stillTwo = await (await olivia.fetch(`${base}/api/transactions`)).json();
      assert.equal(stillTwo.transactions.length, 2);

      const db = new DatabaseSync(dbPath);
      const stored = db.prepare("SELECT access_token FROM plaid_items").all();
      assert.equal(stored.length, 1);
      assert.equal(stored[0].access_token, ACCESS_TOKEN);
      assert.equal(seen.join("\n").includes(ACCESS_TOKEN), false);
      assert.equal(seen.join("\n").includes("sandbox-secret-value"), false);
      db.close();

      const haven = signedIn.body.clients.find((client) => client.name === "Haven Coffee Roasters");
      const switched = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
      assert.equal(switched.response.status, 200);
      const otherClient = await (await olivia.fetch(`${base}/api/plaid`)).json();
      assert.deepEqual(otherClient.connections, []);
      const otherSync = await sendJson(olivia, base, "POST", "/api/plaid/sync", { connectionId: connected.body.connections[0].id });
      assert.equal(otherSync.response.status, 404);
      await sendJson(olivia, base, "PATCH", "/api/session", { clientId: signedIn.body.client.id });

      const harbor = cookieJar();
      await signIn(harbor, base, firms.harbor.owner);
      const hidden = await sendJson(harbor, base, "GET", "/api/plaid");
      assert.deepEqual(hidden.body.connections, []);
      assert.equal(hidden.text.includes("First Platypus Bank"), false);
      assert.equal(hidden.text.includes(ACCESS_TOKEN), false);
      const hiddenSync = await sendJson(harbor, base, "POST", "/api/plaid/sync", { connectionId: connected.body.connections[0].id });
      assert.equal(hiddenSync.response.status, 404);

      const syncCallsBefore = calls.filter((call) => call.url.endsWith("/transactions/sync")).length;
      const disconnected = await sendJson(olivia, base, "POST", "/api/plaid/disconnect", { connectionId: connected.body.connections[0].id });
      assert.equal(disconnected.response.status, 200);
      assert.equal(disconnected.body.connections[0].status, "disconnected");
      const stopped = await sendJson(olivia, base, "POST", "/api/plaid/sync", { connectionId: connected.body.connections[0].id });
      assert.equal(stopped.response.status, 400);
      assert.equal(calls.filter((call) => call.url.endsWith("/transactions/sync")).length, syncCallsBefore);
      const kept = await (await olivia.fetch(`${base}/api/transactions`)).json();
      assert.equal(kept.transactions.length, 2);

      const client = cookieJar();
      await signIn(client, base, firms.northstar.portal);
      for (const [pathname, method, payload] of [
        ["/api/plaid", "GET", undefined],
        ["/api/plaid/link-token", "POST", undefined],
        ["/api/plaid/exchange", "POST", { publicToken: "public-sandbox-token" }],
        ["/api/plaid/sync", "POST", { connectionId: connected.body.connections[0].id }],
      ]) {
        const response = await client.fetch(`${base}${pathname}`, {
          method,
          headers: { "content-type": "application/json" },
          body: payload ? JSON.stringify(payload) : undefined,
        });
        assert.equal(response.status, 404, `${method} ${pathname}`);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PLAID_WEBHOOK;
    delete process.env.OTHER;
    await rm(envDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("sandbox copy stays on the banking screen and off the ledger poster", () => {
  const banking = readFileSync(new URL("../src/Banking.jsx", import.meta.url), "utf8");
  const transactions = readFileSync(new URL("../src/Transactions.jsx", import.meta.url), "utf8");
  const plaid = readFileSync(new URL("./plaid.js", import.meta.url), "utf8");
  assert.match(banking, /Sandbox credentials are not configured/);
  assert.match(banking, /Connect Bank Account/);
  assert.match(banking, /Sync history/);
  assert.match(transactions, /Approve category/);
  assert.match(transactions, /Suggested from the chart/);
  assert.match(banking, /setError\(plaid\?\.notice \|\| "Sandbox credentials are not configured\."\)/);
  assert.match(banking, /disabled=\{pending \|\| !plaid\} onClick=\{connectSandbox\}/);
  assert.doesNotMatch(banking, /disabled=\{!plaid\?\.configured/);
  assert.doesNotMatch(plaid, /PLAID_REDIRECT_URI|PLAID_WEBHOOK/);
  assert.match(banking, /Not a live bank connection/);
  assert.doesNotMatch(plaid, /postJournalEntry/);
  assert.doesNotMatch(plaid, /production\.plaid\.com/);
  assert.match(plaid, /https:\/\/sandbox\.plaid\.com/);
});
