import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { firms } from "./accounts.js";
import { CHART } from "./chart.js";
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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-clients-"));
  const running = await start(path.join(dir, "test.sqlite"), 0);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base);
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
  return response.json();
}

async function postJson(jar, base, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("adding a client creates empty books, review counts drop, and another firm cannot see it", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.firm.name, "Northstar");
    assert.equal(signedIn.clients.length, 4);

    const before = await (await olivia.fetch(`${base}/api/clients`)).json();
    assert.equal(before.counts.active, 4);
    assert.equal(before.counts.readyToReview, 0);
    assert.equal(before.counts.openRequests, 0);
    assert.equal(before.counts.uncategorized, 0);
    assert.equal(before.clients.length, signedIn.clients.length);
    assert.deepEqual(before.clients.map((client) => client.id), signedIn.clients.map((client) => client.id));
    assert.equal(JSON.stringify(before).includes("$84.2k"), false);
    assert.equal(JSON.stringify(before).includes("84.2k"), false);

    const created = await postJson(olivia, base, "/api/clients", {
      name: "Pine Street Studio",
      legalName: "Pine Street Studio LLC",
      industry: "Design",
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.client.name, "Pine Street Studio");
    assert.equal(created.body.session.clients.length, 5);
    assert.equal(created.body.session.clients.some((client) => client.id === created.body.client.id), true);
    assert.equal(created.body.session.clients.some((client) => client.name === "Cedar & Pine Goods"), false);

    const refreshed = await (await olivia.fetch(`${base}/api/session`)).json();
    assert.equal(refreshed.clients.some((client) => client.name === "Pine Street Studio"), true);
    assert.equal(refreshed.client.name, "Northstar Creative");

    const switched = await olivia.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: created.body.client.id }),
    });
    assert.equal(switched.status, 200);
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(ledger.client.name, "Pine Street Studio");
    assert.equal(ledger.entries.length, 0);
    assert.equal(ledger.accounts.length, CHART.length);
    assert.equal(ledger.foots, true);
    assert.equal(ledger.cards.assetsCents, 0);
    const activity = await (await olivia.fetch(`${base}/api/transactions`)).json();
    assert.equal(activity.transactions.length, 0);

    const harbor = cookieJar();
    const other = await signIn(harbor, base, firms.harbor.owner);
    assert.equal(other.firm.name, "Harbor Street Advisors");
    assert.equal(other.clients.some((client) => client.name === "Pine Street Studio"), false);
    const hiddenList = await (await harbor.fetch(`${base}/api/clients`)).json();
    assert.equal(JSON.stringify(hiddenList).includes("Pine Street"), false);
    assert.equal(hiddenList.counts.active, 2);
    const hidden = await harbor.fetch(`${base}/api/clients/${created.body.client.id}`);
    assert.equal(hidden.status, 404);
    const hiddenSwitch = await harbor.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: created.body.client.id }),
    });
    assert.equal(hiddenSwitch.status, 404);

    const northstar = signedIn.clients.find((client) => client.name === "Northstar Creative");
    await olivia.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: northstar.id }),
    });
    const year = before.period.label.match(/(\d{4})/)[1];
    const books = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const account = (code) => books.accounts.find((row) => row.code === code).id;
    const posted = await postJson(olivia, base, "/api/journal-entries", {
      entryDate: `${year}-05-12`,
      memo: "May service income",
      lines: [
        { accountId: account("1000"), debit: "500.00", credit: "" },
        { accountId: account("4000"), debit: "", credit: "500.00" },
      ],
    });
    assert.equal(posted.response.status, 201);
    const firm = await (await olivia.fetch(`${base}/api/clients`)).json();
    const row = firm.clients.find((client) => client.name === "Northstar Creative");
    const statement = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(row.revenue, statement.profitAndLoss.income);
    assert.equal(row.netIncome, statement.profitAndLoss.netIncome);
    assert.equal(row.revenueCents, 50000);
    assert.equal(row.booksUpdated, `May 12, ${year}`);
    const pine = firm.clients.find((client) => client.name === "Pine Street Studio");
    assert.equal(pine.revenue, "$0.00");
    assert.equal(pine.netIncome, "$0.00");
    assert.equal(pine.booksUpdated, "");

    const accountCreated = await postJson(olivia, base, "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    const bankAccountId = accountCreated.body.accounts[0].id;
    const line = await postJson(olivia, base, "/api/transactions", {
      bankAccountId,
      postedOn: `${year}-05-20`,
      description: "Uncoded studio deposit",
      amount: "80.00",
    });
    assert.equal(line.response.status, 201);
    assert.equal(line.body.transaction.status, "for_review");
    const waiting = await (await olivia.fetch(`${base}/api/clients`)).json();
    const waitingRow = waiting.clients.find((client) => client.id === northstar.id);
    assert.equal(waitingRow.uncategorized, 1);
    assert.equal(waiting.counts.uncategorized, 1);
    assert.equal(waiting.counts.readyToReview >= 1, true);

    const revenue = line.body.accounts.find((item) => item.code === "4000");
    const categorized = await postJson(olivia, base, `/api/transactions/${line.body.transaction.id}/categorize`, { accountId: revenue.id });
    assert.equal(categorized.response.status, 200);
    const after = await (await olivia.fetch(`${base}/api/clients`)).json();
    const afterRow = after.clients.find((client) => client.id === northstar.id);
    assert.equal(afterRow.uncategorized, 0);
    assert.equal(after.counts.uncategorized, 0);
    assert.ok(after.counts.uncategorized < waiting.counts.uncategorized);
  });
});

test("the clients screen does not keep the published firm counts", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const clients = readFileSync(new URL("../src/Clients.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /\$84\.2k/);
  assert.doesNotMatch(shell, /Client onboarding opened/);
  assert.doesNotMatch(shell, /May bank statements/);
  assert.doesNotMatch(clients, /\$84\.2k/);
  assert.doesNotMatch(clients, /onboarding opened/);
  assert.doesNotMatch(clients, /<b>18<\/b>/);
  assert.match(clients, /Search clients/);
  assert.match(clients, /Add client/);
});
