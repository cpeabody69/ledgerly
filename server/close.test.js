import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-close-"));
  const dbPath = path.join(dir, "test.sqlite");
  const running = await start(dbPath, 0);
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
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  return body;
}

async function sendJson(jar, base, method, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, body: payload };
}

function accountId(ledger, code) {
  return ledger.accounts.find((account) => account.code === code).id;
}

test("a closed month rejects a new entry, accepts an owner adjustment, and still foots", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    assert.equal(creative.name, "Northstar Creative");
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const cash = accountId(ledger, "1000");
    const income = accountId(ledger, "4000");
    const rent = accountId(ledger, "6100");

    const unbalanced = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-01-04",
      memo: "This entry should not post",
      lines: [
        { accountId: cash, debit: "10.00", credit: "" },
        { accountId: income, debit: "", credit: "9.00" },
      ],
    });
    assert.equal(unbalanced.response.status, 400);
    assert.match(unbalanced.body.error, /equal/);

    const posted = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-01-04",
      memo: "January service",
      lines: [
        { accountId: cash, debit: "40.00", credit: "" },
        { accountId: income, debit: "", credit: "40.00" },
      ],
    });
    assert.equal(posted.response.status, 201, posted.body.error);
    const originalId = posted.body.entry.id;

    const january = await (await olivia.fetch(`${base}/api/close/${creative.id}?period=2026-01`)).json();
    assert.equal(january.issueCounts.unbalanced, 0);
    assert.equal(january.status, "not_started");
    assert.equal(january.overdue, true);
    const satisfied = january.checks.filter((check) => check.satisfied).length;
    assert.equal(january.completion, Math.round((satisfied / january.checks.length) * 100));
    assert.equal(january.completion, 70);
    assert.equal(january.quickBooks.postsToBooks, false);
    assert.equal(january.quickBooks.locksQuickBooks, false);
    assert.equal(january.filesReturn, false);

    const byMonth = await (await olivia.fetch(`${base}/api/close?year=2026&month=1&status=overdue`)).json();
    assert.equal(byMonth.period, "2026-01");
    assert.equal(byMonth.clients.some((client) => client.id === creative.id), true);

    const csvResponse = await olivia.fetch(`${base}/api/close/${creative.id}/package.csv?period=2026-01`);
    const csv = await csvResponse.text();
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get("content-type"), /text\/csv/);
    assert.match(csv, /profit_and_loss,net_income,,,4000/);
    const pdfResponse = await olivia.fetch(`${base}/api/close/${creative.id}/package.pdf?period=2026-01`);
    const pdf = await pdfResponse.text();
    assert.equal(pdfResponse.status, 200);
    assert.equal(pdf.startsWith("%PDF"), true);

    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const staffPackage = await sendJson(sam, base, "POST", `/api/close/${creative.id}/package`, {
      period: "2026-01",
      reviewStatus: "approved",
    });
    assert.equal(staffPackage.response.status, 403);
    const approved = await sendJson(olivia, base, "POST", `/api/close/${creative.id}/package`, {
      period: "2026-01",
      reviewStatus: "approved",
    });
    assert.equal(approved.response.status, 200, approved.body.error);
    assert.equal(approved.body.reviewStatus, "approved");
    assert.equal(approved.body.trialBalance.foots, true);
    assert.equal(approved.body.trialBalance.debitsCents, approved.body.trialBalance.creditsCents);

    for (const checkKey of ["profit_and_loss", "balance_sheet", "accountant_approval"]) {
      const marked = await sendJson(olivia, base, "POST", `/api/close/${creative.id}/checks`, {
        period: "2026-01",
        checkKey,
        status: "complete",
      });
      assert.equal(marked.response.status, 200, marked.body.error);
    }
    const ready = await (await olivia.fetch(`${base}/api/close/${creative.id}?period=2026-01`)).json();
    assert.equal(ready.completion, 100);
    assert.equal(ready.checks.every((check) => check.satisfied), true);

    const staffLock = await sendJson(sam, base, "POST", `/api/close/${creative.id}/lock`, { period: "2026-01" });
    assert.equal(staffLock.response.status, 403);
    const locked = await sendJson(olivia, base, "POST", `/api/close/${creative.id}/lock`, { period: "2026-01" });
    assert.equal(locked.response.status, 200, locked.body.error);
    assert.equal(locked.body.status, "closed");
    assert.equal(locked.body.overdue, false);

    const staffEntry = await sendJson(sam, base, "POST", "/api/journal-entries", {
      entryDate: "2026-01-15",
      memo: "Staff backdate",
      lines: [
        { accountId: cash, debit: "5.00", credit: "" },
        { accountId: income, debit: "", credit: "5.00" },
      ],
    });
    assert.equal(staffEntry.response.status, 409);
    const ownerBlocked = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-01-15",
      memo: "Owner without the flag",
      adjustment: "true",
      lines: [
        { accountId: cash, debit: "5.00", credit: "" },
        { accountId: income, debit: "", credit: "5.00" },
      ],
    });
    assert.equal(ownerBlocked.response.status, 409);
    const beforeAdjust = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const adjustment = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-01-16",
      memo: "January adjustment",
      adjustment: true,
      lines: [
        { accountId: cash, debit: "15.00", credit: "" },
        { accountId: income, debit: "", credit: "15.00" },
      ],
    });
    assert.equal(adjustment.response.status, 201, adjustment.body.error);
    assert.notEqual(adjustment.body.entry.id, originalId);
    assert.equal(adjustment.body.ledger.foots, true);
    assert.equal(adjustment.body.ledger.entries.some((entry) => entry.id === originalId && entry.memo === "January service"), true);
    assert.equal(adjustment.body.ledger.entries.length, beforeAdjust.entries.length + 1);

    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "January checking", kind: "bank" });
    assert.equal(account.response.status, 201, account.body.error);
    const line = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-01-20",
      description: "January statement line",
      amount: "-12.00",
    });
    assert.equal(line.response.status, 201, line.body.error);
    assert.equal(line.body.transaction.status, "for_review");
    const categorized = await sendJson(olivia, base, "POST", `/api/transactions/${line.body.transaction.id}/categorize`, { accountId: rent });
    assert.equal(categorized.response.status, 409);
    const still = await (await olivia.fetch(`${base}/api/transactions`)).json();
    const kept = still.transactions.find((row) => row.id === line.body.transaction.id);
    assert.equal(kept.status, "for_review");

    const missingReason = await sendJson(olivia, base, "POST", `/api/close/${creative.id}/reopen`, { period: "2026-01" });
    assert.equal(missingReason.response.status, 400);
    const staffReopen = await sendJson(sam, base, "POST", `/api/close/${creative.id}/reopen`, {
      period: "2026-01",
      reason: "Sam should not reopen this month.",
    });
    assert.equal(staffReopen.response.status, 403);
    const reason = "A late receipt belongs in January.";
    const reopened = await sendJson(olivia, base, "POST", `/api/close/${creative.id}/reopen`, {
      period: "2026-01",
      reason,
    });
    assert.equal(reopened.response.status, 200, reopened.body.error);
    assert.equal(reopened.body.status, "in_progress");
    const audit = await (await olivia.fetch(`${base}/api/audit`)).json();
    assert.equal(audit.events.some((event) => event.action === "period.closed"), true);
    assert.equal(audit.events.some((event) => event.action === "period.reopened" && event.detail.includes(reason)), true);
    assert.equal(audit.events.some((event) => event.action === "period.adjustment" && event.detail.includes("not edited")), true);

    const afterReopen = await sendJson(sam, base, "POST", "/api/journal-entries", {
      entryDate: "2026-01-18",
      memo: "Staff entry after reopen",
      lines: [
        { accountId: cash, debit: "6.00", credit: "" },
        { accountId: income, debit: "", credit: "6.00" },
      ],
    });
    assert.equal(afterReopen.response.status, 201, afterReopen.body.error);
    assert.equal(afterReopen.body.ledger.foots, true);

    const may = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(may.balanceSheet.balances, true);
    const firm = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(typeof firm.close.counts.completion, "number");
    assert.equal(JSON.stringify(firm).includes("$"), false);
  });
});

test("close stays inside the firm and inside a person's client grants", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const hidden = await jordan.fetch(`${base}/api/close/${creative.id}?period=2026-01`);
    const hiddenText = await hidden.text();
    assert.equal(hidden.status, 404);
    assert.equal(hiddenText.includes(creative.id), false);
    const harborBoard = await (await jordan.fetch(`${base}/api/close?period=2026-01`)).json();
    assert.equal(JSON.stringify(harborBoard).includes("Northstar Creative"), false);

    const roster = await (await olivia.fetch(`${base}/api/session`)).json();
    const samId = roster.members.find((member) => member.email === "sam@northstarcreative.co").id;
    const granted = await sendJson(olivia, base, "POST", "/api/client-grants", {
      userId: samId,
      access: "selected",
      clientIds: [haven.id],
    });
    assert.equal(granted.response.status, 200, granted.body.error);
    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const denied = await sam.fetch(`${base}/api/close/${creative.id}?period=2026-01`);
    assert.equal(denied.status, 404);
    const samBoard = await (await sam.fetch(`${base}/api/close?period=2026-01`)).json();
    assert.deepEqual(samBoard.clients.map((client) => client.name), ["Haven Coffee Roasters"]);
    const allowed = await sam.fetch(`${base}/api/close/${haven.id}?period=2026-01`);
    assert.equal(allowed.status, 200);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const portal = await casey.fetch(`${base}/api/close`);
    assert.equal(portal.status, 404);
  });
});

test("duplicate lines, unusual balances, and the current month feed one work-queue task each", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const cash = accountId(ledger, "1000");
    const income = accountId(ledger, "4000");

    const small = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-03-02",
      memo: "Small March change",
      lines: [
        { accountId: cash, debit: "10.00", credit: "" },
        { accountId: income, debit: "", credit: "10.00" },
      ],
    });
    assert.equal(small.response.status, 201, small.body.error);
    const quiet = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-03`)).json();
    assert.equal(quiet.issueCounts.unusual, 0);

    const large = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-02-02",
      memo: "Large February change",
      lines: [
        { accountId: cash, debit: "200.00", credit: "" },
        { accountId: income, debit: "", credit: "200.00" },
      ],
    });
    assert.equal(large.response.status, 201, large.body.error);
    const unusual = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-02`)).json();
    assert.equal(unusual.issueCounts.unusual, 1);
    assert.equal(unusual.checks.find((check) => check.key === "journal_review").satisfied, false);

    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Haven checking", kind: "bank" });
    const card = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Haven card", kind: "card" });
    assert.equal(account.response.status, 201, account.body.error);
    const bankId = account.body.accounts.find((row) => row.name === "Haven checking").id;
    const cardId = card.body.accounts.find((row) => row.name === "Haven card").id;
    const first = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: "2026-04-04",
      description: "Duplicate paper order",
      amount: "-18.00",
    });
    const second = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: "2026-04-04",
      description: "Duplicate paper order",
      amount: "-18.00",
    });
    await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: "2026-04-04",
      description: "Different paper order",
      amount: "-18.00",
    });
    await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: cardId,
      postedOn: "2026-04-08",
      description: "Card fuel",
      amount: "-9.00",
    });
    assert.equal(first.response.status, 201, first.body.error);
    assert.equal(second.response.status, 201, second.body.error);
    const april = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-04`)).json();
    assert.equal(april.issueCounts.duplicates, 1);
    assert.equal(april.issueCounts.bank > 0, true);
    assert.equal(april.issueCounts.card, 1);
    assert.equal(april.issueCounts.uncategorized > 0, true);
    const tasks = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const duplicateTasks = tasks.tasks.filter((task) => task.sourceType === "close_issue" && task.sourceId.endsWith(":duplicates"));
    assert.equal(duplicateTasks.length, 1);
    const again = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const duplicateAgain = again.tasks.filter((task) => task.sourceType === "close_issue" && task.sourceId.endsWith(":duplicates"));
    assert.equal(duplicateAgain.length, 1);
    assert.equal(duplicateAgain[0].id, duplicateTasks[0].id);

    const excluded = await sendJson(olivia, base, "POST", `/api/transactions/${second.body.transaction.id}/exclude`, { note: "Second copy" });
    assert.equal(excluded.response.status, 200, excluded.body.error);
    const cleared = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-04`)).json();
    assert.equal(cleared.issueCounts.duplicates, 0);
    const after = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const finished = after.tasks.find((task) => task.id === duplicateTasks[0].id);
    assert.equal(finished.status, "completed");

    const current = await (await olivia.fetch(`${base}/api/close`)).json();
    const live = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: current.today,
      description: "Current month uncategorized",
      amount: "-7.00",
    });
    assert.equal(live.response.status, 201, live.body.error);
    const queued = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const uncategorized = queued.tasks.filter((task) => task.sourceType === "close_issue" && task.sourceId.endsWith(`:${current.period}:uncategorized`));
    assert.equal(uncategorized.length, 1);
    assert.equal(uncategorized[0].target.screen, "Close");
    const queuedAgain = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const uncategorizedAgain = queuedAgain.tasks.filter((task) => task.sourceType === "close_issue" && task.sourceId.endsWith(`:${current.period}:uncategorized`));
    assert.equal(uncategorizedAgain.length, 1);
    assert.equal(uncategorizedAgain[0].id, uncategorized[0].id);

    const drafted = await sendJson(olivia, base, "POST", "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2026-04-12",
      dueDate: "2026-05-12",
      memo: "April design",
      lines: [{ description: "Design work", amount: "20.00" }],
    });
    assert.equal(drafted.response.status, 201, drafted.body.error);
    const sent = await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/send`);
    assert.equal(sent.response.status, 200, sent.body.error);
    const receivable = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-04`)).json();
    assert.equal(receivable.issueCounts.receivables >= 1, true);

    const payables = await (await olivia.fetch(`${base}/api/payables`)).json();
    const office = payables.accounts.find((row) => row.code === "6400");
    const vendor = await sendJson(olivia, base, "POST", "/api/payables/vendors", { name: "Fictional Paper Co." });
    assert.equal(vendor.response.status, 201, vendor.body.error);
    const bill = await sendJson(olivia, base, "POST", "/api/payables/bills", {
      vendorId: vendor.body.vendor.id,
      invoiceNumber: "FP-440",
      billDate: "2026-04-02",
      dueDate: "2026-04-20",
      lines: [{ description: "Paper", accountId: office.id, amount: "8.00", tax: "" }],
    });
    assert.equal(bill.response.status, 201, bill.body.error);
    const submitted = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/submit`);
    assert.equal(submitted.response.status, 200, submitted.body.error);
    const payable = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-04`)).json();
    assert.equal(payable.issueCounts.payables >= 1, true);

    const request = await sendJson(olivia, base, "POST", "/api/document-requests", {
      clientId: haven.id,
      title: "April fictional statements",
      dueOn: "2026-04-18",
    });
    assert.equal(request.response.status, 201, request.body.error);
    const documents = await (await olivia.fetch(`${base}/api/close/${haven.id}?period=2026-04`)).json();
    assert.equal(documents.issueCounts.documents >= 1, true);
    assert.equal(documents.checks.find((check) => check.key === "documents").satisfied, false);
  });
});
