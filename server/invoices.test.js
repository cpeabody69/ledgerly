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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-invoices-"));
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

async function postJson(jar, base, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

function account(ledger, code) {
  return ledger.trialBalance.rows.find((row) => row.code === code);
}

test("a draft, a sent invoice, and a partial payment foot to the trial balance", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.client.name, "Northstar Creative");

    const empty = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(empty.invoices.length, 0);
    assert.equal(empty.metrics.outstandingCents, 0);
    assert.equal(empty.metrics.count, 0);
    assert.equal(JSON.stringify(empty).includes("18,740"), false);
    assert.equal(JSON.stringify(empty).includes("6,800"), false);

    const rejected = await postJson(olivia, base, "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2026-05-12",
      dueDate: "2026-06-11",
      lines: [{ description: "Design work", amount: 200 }],
    });
    assert.equal(rejected.response.status, 400);

    const drafted = await postJson(olivia, base, "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2026-05-12",
      dueDate: "2026-06-11",
      memo: "May design",
      lines: [{ description: "Design work", amount: "200.00" }],
    });
    assert.equal(drafted.response.status, 201);
    assert.equal(drafted.body.invoice.status, "draft");
    assert.equal(drafted.body.invoice.number, "INV-0001");
    assert.notEqual(drafted.body.invoice.status, "paid");
    const beforeSend = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(beforeSend.entries.length, 0);
    const openDraft = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(openDraft.metrics.outstandingCents, 0);
    assert.equal(openDraft.invoices[0].totalCents, 20000);

    const sent = await postJson(olivia, base, `/api/invoices/${drafted.body.invoice.id}/send`);
    assert.equal(sent.response.status, 200);
    assert.equal(sent.body.invoice.status, "sent");
    assert.equal(sent.body.invoice.statusLabel === "Paid", false);
    const sentBooks = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(account(sentBooks, "1100").debitCents, 20000);
    assert.equal(account(sentBooks, "4000").creditCents, 20000);
    assert.equal(account(sentBooks, "1000").debitCents, 0);
    const sendEntry = sentBooks.entries.find((entry) => entry.memo === "Invoice INV-0001");
    assert.ok(sendEntry);
    const originalLines = sendEntry.lines.map((line) => [line.accountCode, line.debitCents, line.creditCents]);

    const paid = await postJson(olivia, base, `/api/invoices/${drafted.body.invoice.id}/payments`, {
      amount: "80.00",
      paidOn: "2026-05-20",
    });
    assert.equal(paid.response.status, 201);
    assert.equal(paid.body.invoice.status, "partial");
    assert.equal(paid.body.invoice.paidCents, 8000);
    assert.equal(paid.body.invoice.balanceCents, 12000);
    assert.notEqual(paid.body.invoice.status, "paid");
    const partialBooks = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(account(partialBooks, "1100").debitCents, 12000);
    assert.equal(account(partialBooks, "4000").creditCents, 20000);
    assert.equal(account(partialBooks, "1000").debitCents, 8000);
    const listed = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(listed.metrics.outstandingCents, account(partialBooks, "1100").debitCents);
    assert.equal(listed.metrics.outstanding, "$120.00");

    const tooMuch = await postJson(olivia, base, `/api/invoices/${drafted.body.invoice.id}/payments`, {
      amount: "200.00",
      paidOn: "2026-05-21",
    });
    assert.equal(tooMuch.response.status, 400);

    const voided = await postJson(olivia, base, `/api/invoices/${drafted.body.invoice.id}/void`);
    assert.equal(voided.response.status, 200);
    assert.equal(voided.body.invoice.status, "void");
    assert.notEqual(voided.body.entry.id, sendEntry.id);
    const closed = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(closed.entries.length, 3);
    const stillThere = closed.entries.find((entry) => entry.id === sendEntry.id);
    assert.deepEqual(stillThere.lines.map((line) => [line.accountCode, line.debitCents, line.creditCents]), originalLines);
    const reversal = closed.entries.find((entry) => entry.memo === "Void INV-0001");
    assert.ok(reversal);
    assert.equal(reversal.debitCents, reversal.creditCents);
    assert.equal(account(closed, "1100").debitCents, 0);
    assert.equal(account(closed, "4000").creditCents, 0);
    assert.equal(account(closed, "1000").debitCents, 0);
    const afterVoid = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(afterVoid.metrics.outstandingCents, 0);
    assert.equal(afterVoid.invoices[0].statusLabel === "Paid", false);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const untouched = db.prepare(
      "SELECT debit_cents, credit_cents FROM journal_lines WHERE entry_id = ? ORDER BY position",
    ).all(sendEntry.id);
    assert.equal(untouched.length, 2);
    assert.equal(Number(untouched[0].debit_cents) + Number(untouched[1].debit_cents), 20000);
    db.close();

    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const switched = await olivia.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: haven.id }),
    });
    assert.equal(switched.status, 200);
    const otherClient = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(otherClient.invoices.length, 0);
    assert.equal(JSON.stringify(otherClient).includes("Fixture Customer"), false);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await (await harbor.fetch(`${base}/api/invoices`)).json();
    assert.equal(JSON.stringify(hidden).includes("Fixture Customer"), false);
    assert.equal(JSON.stringify(hidden).includes("INV-0001"), false);
    const hiddenOne = await harbor.fetch(`${base}/api/invoices/${drafted.body.invoice.id}/void`, { method: "POST" });
    assert.equal(hiddenOne.status, 404);
  });
});

test("the invoice screen does not keep the published invoice totals", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const invoices = readFileSync(new URL("../src/Invoices.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /\$18,740\.00/);
  assert.doesNotMatch(shell, /\$6,800\.00/);
  assert.doesNotMatch(shell, /12\.4%/);
  assert.doesNotMatch(invoices, /18,740|6,800|Stripe|Charge card|card number/i);
  assert.match(invoices, /does not charge a card/);
  assert.match(invoices, /of \{filtered\.length\} invoices/);
  assert.match(invoices, /Save draft/);
  assert.match(invoices, /Record payment/);
  assert.match(invoices, /Void invoice/);
  assert.match(shell, /OutstandingInvoices/);
});
