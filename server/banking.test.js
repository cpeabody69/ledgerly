import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { matchesPeriod, reconciliationMath, summarize } from "../shared/activity.js";

const fixtureCsv = readFileSync(new URL("./fixtures/activity.csv", import.meta.url), "utf8");

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-bank-"));
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
  return response.json();
}

async function selectClient(jar, base, clientId) {
  const response = await jar.fetch(`${base}/api/session`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId }),
  });
  assert.equal(response.status, 200);
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

test("period counts follow stored activity and a reconciliation must foot", () => {
  const rows = [
    { postedOn: "2026-05-12", status: "categorized", amountCents: 50000 },
    { postedOn: "2026-05-18", status: "categorized", amountCents: -4250 },
    { postedOn: "2026-04-03", status: "for_review", amountCents: -1500 },
  ];
  const may = rows.filter((row) => matchesPeriod(row.postedOn, "May 1 – May 31"));
  const april = rows.filter((row) => matchesPeriod(row.postedOn, "Apr 1 – Apr 30"));
  assert.deepEqual(summarize(may), { all: 2, forReview: 0, categorized: 2, excluded: 0 });
  assert.deepEqual(summarize(april), { all: 1, forReview: 1, categorized: 0, excluded: 0 });
  assert.deepEqual(summarize([]), { all: 0, forReview: 0, categorized: 0, excluded: 0 });
  assert.equal(matchesPeriod("2026-04-03", "Apr 1 – Apr 30"), true);
  const open = reconciliationMath(0, 10000, [50000, -4250]);
  assert.notEqual(open.differenceCents, 0);
  const closed = reconciliationMath(0, 45750, [50000, -4250]);
  assert.equal(closed.differenceCents, 0);
  assert.equal(closed.computedEndingCents, 45750);
});

test("import, categorize, and reconcile a fixture without showing it to another client", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.client.name, "Northstar Creative");
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");

    const empty = await (await olivia.fetch(`${base}/api/transactions`)).json();
    assert.equal(empty.transactions.length, 0);
    const emptyText = JSON.stringify(empty);
    for (const banned of ["8,420", "8420", "Mercury", "Amex", "Chase", "248"]) {
      assert.equal(emptyText.includes(banned), false, banned);
    }
    assert.equal(empty.bankAccounts.length, 0);

    const account = await postJson(olivia, base, "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    assert.equal(account.response.status, 201);
    assert.equal(account.body.accounts[0].connected, false);
    assert.equal(account.body.accounts[0].name, "Operating checking");
    const bankAccountId = account.body.accounts[0].id;

    const imported = await postJson(olivia, base, "/api/transactions/import", { bankAccountId, csv: fixtureCsv });
    assert.equal(imported.response.status, 201);
    assert.equal(imported.body.imported, 3);
    assert.equal(imported.body.transactions.length, 3);
    assert.equal(imported.body.transactions.every((row) => row.status === "for_review" && !row.journalEntryId), true);

    const april = await (await olivia.fetch(`${base}/api/transactions?month=4`)).json();
    assert.equal(april.transactions.length, 1);
    assert.equal(april.transactions[0].description, "April paper order");
    const may = await (await olivia.fetch(`${base}/api/transactions?month=5`)).json();
    assert.equal(may.transactions.length, 2);
    assert.equal(may.transactions.some((row) => row.description === "April paper order"), false);
    const havenApril = await (await olivia.fetch(`${base}/api/transactions?month=4`)).json();
    assert.equal(havenApril.transactions.length, 1);

    const deposit = imported.body.transactions.find((row) => row.description === "Northwind studio deposit");
    const expense = imported.body.transactions.find((row) => row.description === "Paper and ink");
    const aprilRow = imported.body.transactions.find((row) => row.description === "April paper order");
    const revenue = imported.body.accounts.find((row) => row.code === "4000");
    const office = imported.body.accounts.find((row) => row.code === "6400");

    const categorizedExpense = await postJson(olivia, base, `/api/transactions/${expense.id}/categorize`, { accountId: office.id });
    assert.equal(categorizedExpense.response.status, 200);
    assert.equal(categorizedExpense.body.transaction.status, "categorized");
    assert.equal(categorizedExpense.body.transaction.journalReference, categorizedExpense.body.entry.reference);
    assert.equal(categorizedExpense.body.entry.debitCents, categorizedExpense.body.entry.creditCents);
    assert.equal(categorizedExpense.body.entry.debitCents, 4250);

    const categorizedDeposit = await postJson(olivia, base, `/api/transactions/${deposit.id}/categorize`, { accountId: revenue.id });
    assert.equal(categorizedDeposit.response.status, 200);
    assert.equal(categorizedDeposit.body.transaction.status, "categorized");
    assert.equal(categorizedDeposit.body.entry.debitCents, categorizedDeposit.body.entry.creditCents);
    assert.equal(categorizedDeposit.body.entry.debitCents, 50000);

    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(ledger.foots, true);
    assert.equal(ledger.trialBalance.debitsCents, ledger.trialBalance.creditsCents);
    assert.equal(ledger.entries.length, 2);
    const cash = ledger.trialBalance.rows.find((row) => row.code === "1000");
    assert.equal(cash.debitCents - cash.creditCents, 45750);

    const wrong = await postJson(olivia, base, "/api/reconciliations", {
      bankAccountId,
      statementDate: "2026-05-31",
      statementEnding: "100.00",
      transactionIds: [deposit.id, expense.id],
    });
    assert.equal(wrong.response.status, 400);
    assert.match(wrong.body.error, /not zero/i);
    assert.notEqual(wrong.body.differenceCents, 0);
    const notCleared = await (await olivia.fetch(`${base}/api/transactions`)).json();
    assert.equal(notCleared.transactions.every((row) => row.cleared === false), true);
    assert.equal((await (await olivia.fetch(`${base}/api/banking`)).json()).reconciliations.length, 0);

    const beforeRows = notCleared.transactions.map((row) => ({
      id: row.id,
      description: row.description,
      amountCents: row.amountCents,
      journalEntryId: row.journalEntryId,
    }));
    const reconciled = await postJson(olivia, base, "/api/reconciliations", {
      bankAccountId,
      statementDate: "2026-05-31",
      statementEnding: "457.50",
      transactionIds: [deposit.id, expense.id],
    });
    assert.equal(reconciled.response.status, 201);
    assert.equal(reconciled.body.reconciliation.status, "complete");
    const after = await (await olivia.fetch(`${base}/api/transactions`)).json();
    for (const before of beforeRows) {
      const row = after.transactions.find((item) => item.id === before.id);
      assert.equal(row.description, before.description);
      assert.equal(row.amountCents, before.amountCents);
      assert.equal(row.journalEntryId, before.journalEntryId);
    }
    assert.equal(after.transactions.find((row) => row.id === deposit.id).cleared, true);
    assert.equal(after.transactions.find((row) => row.id === expense.id).cleared, true);
    assert.equal(after.transactions.find((row) => row.id === aprilRow.id).cleared, false);
    assert.equal(after.transactions.length, 3);

    const excluded = await postJson(olivia, base, `/api/transactions/${aprilRow.id}/exclude`, { note: "Owner paid it" });
    assert.equal(excluded.response.status, 200);
    assert.equal(excluded.body.transaction.status, "excluded");
    assert.equal(excluded.body.entry.debitCents, excluded.body.entry.creditCents);
    const afterExclude = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(afterExclude.foots, true);
    assert.equal(afterExclude.entries.length, 3);

    const reloaded = await (await olivia.fetch(`${base}/api/transactions`)).json();
    assert.deepEqual(reloaded.transactions.map((row) => row.id).sort(), after.transactions.map((row) => row.id).sort());
    assert.equal(reloaded.transactions.find((row) => row.id === expense.id).status, "categorized");
    assert.equal(reloaded.transactions.find((row) => row.id === aprilRow.id).status, "excluded");
    assert.deepEqual(summarize(reloaded.transactions.filter((row) => matchesPeriod(row.postedOn, "May 1 – May 31"))), {
      all: 2,
      forReview: 0,
      categorized: 2,
      excluded: 0,
    });

    await selectClient(olivia, base, haven.id);
    const other = await (await olivia.fetch(`${base}/api/transactions`)).json();
    assert.equal(other.transactions.length, 0);
    assert.equal(other.bankAccounts.length, 0);
    assert.equal(JSON.stringify(other).includes("Paper and ink"), false);
    assert.equal((await (await olivia.fetch(`${base}/api/transactions?month=4`)).json()).transactions.length, 0);
    const hidden = await olivia.fetch(`${base}/api/transactions/${expense.id}/categorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: office.id }),
    });
    assert.equal(hidden.status, 404);
    const otherBooks = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(otherBooks.entries.length, 0);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const foreign = await jordan.fetch(`${base}/api/transactions`);
    const foreignBody = await foreign.json();
    assert.equal(foreignBody.transactions.length, 0);
    assert.equal(JSON.stringify(foreignBody).includes("Northwind"), false);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const journal = db.prepare("SELECT memo FROM journal_entries WHERE id = ?").get(categorizedExpense.body.entry.id);
    assert.equal(journal.memo, "Paper and ink");
    db.close();
    const writable = new DatabaseSync(dbPath);
    assert.throws(() => writable.prepare("UPDATE journal_entries SET memo = 'changed' WHERE id = ?").run(categorizedExpense.body.entry.id));
    writable.close();
  });
});

test("bulk exclude posts a journal for every selected line", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const account = await postJson(olivia, base, "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    const imported = await postJson(olivia, base, "/api/transactions/import", { bankAccountId: account.body.accounts[0].id, csv: fixtureCsv });
    const ids = imported.body.transactions.filter((row) => row.postedOn.startsWith("2026-05")).map((row) => row.id);
    const missing = await postJson(olivia, base, "/api/transactions/bulk", { action: "categorize", ids });
    assert.equal(missing.response.status, 400);
    const untouched = await (await olivia.fetch(`${base}/api/transactions`)).json();
    assert.equal(untouched.transactions.every((row) => row.status === "for_review" && !row.journalEntryId), true);

    const bulk = await postJson(olivia, base, "/api/transactions/bulk", { action: "exclude", ids });
    assert.equal(bulk.response.status, 200);
    assert.equal(bulk.body.entries.length, 2);
    assert.equal(bulk.body.entries.every((entry) => entry.debitCents === entry.creditCents && entry.debitCents > 0), true);
    const updated = bulk.body.transactions.filter((row) => ids.includes(row.id));
    assert.equal(updated.length, 2);
    assert.equal(updated.every((row) => row.status === "excluded" && row.journalEntryId), true);
    assert.deepEqual(summarize(bulk.body.transactions.filter((row) => matchesPeriod(row.postedOn, "May 1 – May 31"))), {
      all: 2,
      forReview: 0,
      categorized: 0,
      excluded: 2,
    });
  });
});

test("transactions and banking screens do not keep the published bank feed", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const transactions = readFileSync(new URL("../src/Transactions.jsx", import.meta.url), "utf8");
  const banking = readFileSync(new URL("../src/Banking.jsx", import.meta.url), "utf8");
  assert.match(shell, /\$84,240\.00/);
  assert.match(shell, /\$128,430\.62/);
  assert.match(shell, /Stripe Payments/);
  assert.doesNotMatch(transactions, /Mercury|American Express|Chase|8,420/);
  assert.doesNotMatch(banking, /Mercury|American Express|Chase|connected feed/);
  assert.match(banking, /Not a live bank connection/);
});
