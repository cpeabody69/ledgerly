import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { CHART } from "./chart.js";
import { openDatabase } from "./db.js";
import { postJournalEntry } from "./ledger.js";
import { addCents, formatMoney, parseCents } from "../shared/money.js";

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-ledger-"));
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
  return { response, body: await response.json() };
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

function accountId(ledger, code) {
  return ledger.accounts.find((account) => account.code === code).id;
}

function entryBody(ledger, memo, debit, credit) {
  return {
    entryDate: "2026-11-03",
    memo,
    lines: [
      { accountId: accountId(ledger, "1000"), debit, credit: "" },
      { accountId: accountId(ledger, "4000"), debit: "", credit },
    ],
  };
}

test("money parses decimal text and rejects JSON numbers", () => {
  assert.equal(parseCents("250.00"), 25000);
  assert.equal(parseCents("75.25"), 7525);
  assert.equal(parseCents("10"), 1000);
  assert.equal(parseCents("$10.50"), 1050);
  assert.equal(parseCents("", { blank: true }), 0);
  assert.equal(formatMoney(25000), "$250.00");
  assert.equal(formatMoney(7525), "$75.25");
  assert.equal(formatMoney(32525), "$325.25");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(addCents(25000, 7525), 32525);
  assert.throws(() => parseCents(10.1));
  assert.throws(() => parseCents("10.001"));
  assert.throws(() => parseCents("-1.00"));
});

test("a known journal entry foots and an unbalanced entry is rejected", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.body.client.name, "Northstar Creative");
    const haven = signedIn.body.clients.find((client) => client.name === "Haven Coffee Roasters");

    const emptyResponse = await olivia.fetch(`${base}/api/ledger`);
    assert.equal(emptyResponse.status, 200);
    const empty = await emptyResponse.json();
    const emptyText = JSON.stringify(empty);
    assert.equal(empty.accounts.length, CHART.length);
    assert.equal(empty.accounts.find((account) => account.code === "1000").cash, true);
    assert.equal(empty.cards.assetsCents, 0);
    assert.equal(empty.cards.liabilitiesCents, 0);
    assert.equal(empty.cards.equityCents, 0);
    assert.equal(empty.trialBalance.debitsCents, 0);
    assert.equal(empty.trialBalance.creditsCents, 0);
    assert.equal(empty.trialBalance.foots, true);
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.policy.basis, "accrual");
    assert.equal(empty.policy.fiscalYearStart, "January");
    assert.equal(empty.policy.template, "small-service-business");
    for (const banned of ["176,804", "176804", "82,420", "82420", "128,430", "84,240", "31,282", "145,521"]) {
      assert.equal(emptyText.includes(banned), false, banned);
    }

    const first = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entryBody(empty, "Sample service income", "250.00", "250.00")),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.entry.reference, "JE-00001");
    assert.equal(firstBody.entry.postedBy, "Olivia Martin");
    assert.ok(firstBody.entry.postedAt);
    assert.equal(firstBody.ledger.trialBalance.debitsCents, 25000);
    assert.equal(firstBody.ledger.trialBalance.creditsCents, 25000);
    assert.equal(firstBody.ledger.trialBalance.foots, true);
    assert.equal(firstBody.ledger.cards.assetsCents, 25000);
    assert.equal(firstBody.ledger.cards.liabilitiesCents, 0);
    assert.equal(firstBody.ledger.cards.equityCents, 25000);
    assert.equal(firstBody.ledger.cards.assets, "$250.00");
    assert.equal(firstBody.ledger.cards.equity, "$250.00");

    const second = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entryBody(empty, "Sample service income, second", "75.25", "75.25")),
    });
    assert.equal(second.status, 201);
    const secondBody = await second.json();
    assert.equal(secondBody.ledger.trialBalance.debitsCents, 32525);
    assert.equal(secondBody.ledger.trialBalance.creditsCents, 32525);
    assert.equal(secondBody.ledger.trialBalance.debitsCents - firstBody.ledger.trialBalance.debitsCents, 7525);
    assert.equal(secondBody.ledger.cards.assetsCents, 32525);
    assert.equal(secondBody.ledger.cards.equityCents, 32525);
    assert.equal(secondBody.ledger.foots, true);
    const cash = secondBody.ledger.trialBalance.rows.find((row) => row.code === "1000");
    const revenue = secondBody.ledger.trialBalance.rows.find((row) => row.code === "4000");
    assert.equal(cash.debitCents, 32525);
    assert.equal(revenue.creditCents, 32525);
    assert.equal(secondBody.ledger.activity.filter((line) => line.accountCode === "1000").at(-1).balanceCents, 32525);

    const before = secondBody.ledger.entries.length;
    const unbalanced = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entryBody(empty, "This should not post", "100.00", "40.00")),
    });
    assert.equal(unbalanced.status, 400);
    const unbalancedBody = await unbalanced.json();
    assert.match(unbalancedBody.error, /equal/i);
    const afterResponse = await olivia.fetch(`${base}/api/ledger`);
    const after = await afterResponse.json();
    assert.equal(after.entries.length, before);
    assert.equal(JSON.stringify(after).includes("This should not post"), false);
    assert.equal(after.trialBalance.debitsCents, 32525);
    assert.equal(after.activity.some((line) => line.debitCents === 10000 || line.creditCents === 4000), false);

    const numbered = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryDate: "2026-11-03",
        memo: "Number amounts",
        lines: [
          { accountId: accountId(empty, "1000"), debit: 10.1, credit: "" },
          { accountId: accountId(empty, "4000"), debit: "", credit: "10.10" },
        ],
      }),
    });
    assert.equal(numbered.status, 400);

    const oneLine = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryDate: "2026-11-03",
        memo: "Too short",
        lines: [{ accountId: accountId(empty, "1000"), debit: "10.00", credit: "" }],
      }),
    });
    assert.equal(oneLine.status, 400);

    const bothSides = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryDate: "2026-11-03",
        memo: "Both sides",
        lines: [
          { accountId: accountId(empty, "1000"), debit: "10.00", credit: "10.00" },
          { accountId: accountId(empty, "4000"), debit: "", credit: "10.00" },
        ],
      }),
    });
    assert.equal(bothSides.status, 400);

    const havenBooks = await selectClient(olivia, base, haven.id);
    assert.equal(havenBooks.client.name, "Haven Coffee Roasters");
    const havenLedgerResponse = await olivia.fetch(`${base}/api/ledger`);
    const havenLedger = await havenLedgerResponse.json();
    assert.equal(havenLedger.entries.length, 0);
    assert.equal(havenLedger.cards.assetsCents, 0);
    assert.equal(JSON.stringify(havenLedger).includes("Sample service income"), false);
    const hidden = await olivia.fetch(`${base}/api/ledger?clientId=${encodeURIComponent(signedIn.body.client.id)}`);
    assert.equal(hidden.status, 404);
    const hiddenEntry = await olivia.fetch(`${base}/api/journal-entries/${firstBody.entry.id}`);
    assert.equal(hiddenEntry.status, 404);

    const wrongAccount = await olivia.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryDate: "2026-11-03",
        memo: "Wrong client account",
        lines: [
          { accountId: accountId(empty, "1000"), debit: "10.00", credit: "" },
          { accountId: accountId(havenLedger, "4000"), debit: "", credit: "10.00" },
        ],
      }),
    });
    assert.equal(wrongAccount.status, 400);
    const havenAfter = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(havenAfter.entries.length, 0);

    await selectClient(olivia, base, signedIn.body.client.id);
    const restored = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(restored.entries.length, 2);
    assert.equal(restored.cards.assetsCents, 32525);

    const edit = await olivia.fetch(`${base}/api/journal-entries/${firstBody.entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memo: "changed" }),
    });
    assert.equal(edit.status, 404);
    const remove = await olivia.fetch(`${base}/api/journal-entries/${firstBody.entry.id}`, { method: "DELETE" });
    assert.equal(remove.status, 404);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const foreignEntry = await jordan.fetch(`${base}/api/journal-entries/${firstBody.entry.id}`);
    assert.equal(foreignEntry.status, 404);
    const harborLedger = await (await jordan.fetch(`${base}/api/ledger`)).json();
    assert.equal(harborLedger.entries.length, 0);
    assert.equal(JSON.stringify(harborLedger).includes("Sample service income"), false);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT * FROM journal_entries").all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.firm_id && row.client_id && row.created_by && row.posted_at && row.created_at));
    assert.equal(rows.filter((row) => row.client_id === signedIn.body.client.id).length, 2);
    assert.equal(rows.some((row) => row.memo === "This should not post"), false);
    const lines = db.prepare("SELECT debit_cents, credit_cents FROM journal_lines").all();
    assert.equal(lines.some((line) => line.debit_cents === 10000 || line.credit_cents === 4000), false);
    const audit = db.prepare("SELECT * FROM audit_events WHERE action = 'journal.posted'").all();
    assert.equal(audit.length, 2);
    assert.ok(audit.every((row) => row.firm_id && row.client_id && row.actor_user_id && row.entity_id));
    db.close();
  });
});

test("posted journal entries cannot be edited or deleted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-immutable-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(firms.northstar.owner.email);
    const client = db.prepare("SELECT * FROM clients WHERE firm_id = ? ORDER BY position LIMIT 1").get(user.firm_id);
    const accounts = db.prepare("SELECT id, code FROM accounts WHERE client_id = ?").all(client.id);
    const cash = accounts.find((account) => account.code === "1000").id;
    const revenue = accounts.find((account) => account.code === "4000").id;
    const session = { firm_id: user.firm_id, user_id: user.id, selected_client_id: client.id };
    const rejected = postJournalEntry(db, session, {
      entryDate: "2026-11-03",
      memo: "Unbalanced",
      lines: [
        { accountId: cash, debit: "20.00", credit: "" },
        { accountId: revenue, debit: "", credit: "5.00" },
      ],
    });
    assert.equal(rejected.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal_entries").get().count, 0);

    const posted = postJournalEntry(db, session, {
      entryDate: "2026-11-03",
      memo: "Sample service income",
      lines: [
        { accountId: cash, debit: "250.00", credit: "" },
        { accountId: revenue, debit: "", credit: "250.00" },
      ],
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.payload.ledger.trialBalance.foots, true);
    assert.equal(posted.payload.ledger.cards.assetsCents, 25000);
    const entryId = posted.payload.entry.id;
    assert.throws(() => db.prepare("UPDATE journal_entries SET memo = 'changed' WHERE id = ?").run(entryId));
    assert.equal(db.prepare("SELECT memo FROM journal_entries WHERE id = ?").get(entryId).memo, "Sample service income");
    assert.throws(() => db.prepare("DELETE FROM journal_lines WHERE entry_id = ?").run(entryId));
    assert.throws(() => db.prepare("UPDATE journal_lines SET debit_cents = 1 WHERE entry_id = ?").run(entryId));
    assert.throws(() => db.prepare("DELETE FROM journal_entries WHERE id = ?").run(entryId));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal_entries").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal_lines").get().count, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a staff user can post to the open client and not to another client's books", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const invited = await olivia.fetch(`${base}/api/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sam Lee", email: "sam@northstarcreative.co", role: "staff", password: "ledgerly-staff" }),
    });
    assert.equal(invited.status, 201);
    const sam = cookieJar();
    const staff = await signIn(sam, base, { email: "sam@northstarcreative.co", password: "ledgerly-staff" });
    assert.equal(staff.body.user.role, "staff");
    assert.equal(staff.body.client.id, signedIn.body.client.id);
    const ledger = await (await sam.fetch(`${base}/api/ledger`)).json();
    const posted = await sam.fetch(`${base}/api/journal-entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entryBody(ledger, "Staff posting", "10.00", "10.00")),
    });
    assert.equal(posted.status, 201);
    const body = await posted.json();
    assert.equal(body.entry.postedBy, "Sam Lee");
    assert.equal(body.ledger.cards.assetsCents, 1000);
    const haven = staff.body.clients.find((client) => client.name === "Haven Coffee Roasters");
    await selectClient(sam, base, haven.id);
    const other = await (await sam.fetch(`${base}/api/ledger`)).json();
    assert.equal(other.entries.length, 0);
    assert.equal(JSON.stringify(other).includes("Staff posting"), false);
  });
});

test("invoices and the dashboard's other published widgets stay in the shell", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const accounting = readFileSync(new URL("../src/Accounting.jsx", import.meta.url), "utf8");
  assert.match(shell, /\$6,800\.00/);
  assert.match(shell, /\$18,740\.00/);
  assert.match(shell, /Stripe Payments/);
  assert.doesNotMatch(shell, /\$84,240\.00/);
  assert.doesNotMatch(shell, /\$128,430\.62/);
  assert.doesNotMatch(shell, /12\.5%/);
  assert.doesNotMatch(shell, /Cmp_ge/);
  assert.doesNotMatch(shell, /\$176,804\.12/);
  assert.doesNotMatch(accounting, /176,804/);
  assert.match(accounting, /New journal entry/);
  assert.doesNotMatch(accounting, /openComposer/);
  assert.doesNotMatch(accounting, /Add transaction/);
});
