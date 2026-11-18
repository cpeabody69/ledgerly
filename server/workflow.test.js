import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-workflow-"));
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

function member(firm, email) {
  return firm.members.find((person) => person.email === email);
}

test("a repeating task creates one next task and a second read does not duplicate it", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const cases = [
      ["daily", "2026-01-31", "2026-02-01"],
      ["weekly", "2026-01-01", "2026-01-08"],
      ["monthly", "2026-01-31", "2026-02-28"],
      ["quarterly", "2026-01-15", "2026-04-15"],
      ["annual", "2026-05-01", "2027-05-01"],
    ];
    for (const [recurrence, dueOn, nextDue] of cases) {
      const created = await sendJson(olivia, base, "POST", "/api/tasks", {
        title: `${recurrence} close`,
        clientId: signedIn.client.id,
        dueOn,
        recurrence,
      });
      assert.equal(created.response.status, 201, created.body.error);
      const done = await sendJson(olivia, base, "POST", `/api/tasks/${created.body.task.id}/complete`);
      assert.equal(done.response.status, 200, done.body.error);
      const children = done.body.tasks.filter((task) => task.sourceType === "recurrence" && task.sourceId === `recur:${created.body.task.id}:${nextDue}`);
      assert.equal(children.length, 1);
      assert.equal(children[0].dueOn, nextDue);
      assert.equal(children[0].recurrence, recurrence);
      assert.equal(children[0].status, "open");
      const again = await (await olivia.fetch(`${base}/api/tasks`)).json();
      assert.equal(again.tasks.filter((task) => task.sourceId === children[0].sourceId).length, 1);
      const repeat = await sendJson(olivia, base, "POST", `/api/tasks/${created.body.task.id}/complete`);
      assert.equal(repeat.body.tasks.filter((task) => task.sourceId === children[0].sourceId).length, 1);
    }

    const monthly = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const february = monthly.tasks.find((task) => task.title === "monthly close" && task.dueOn === "2026-02-28");
    const next = await sendJson(olivia, base, "POST", `/api/tasks/${february.id}/complete`);
    const march = next.body.tasks.filter((task) => task.sourceType === "recurrence" && task.dueOn === "2026-03-28" && task.title === "monthly close");
    assert.equal(march.length, 1);
    const reopened = await sendJson(olivia, base, "PATCH", `/api/tasks/${february.id}`, { status: "open" });
    assert.equal(reopened.response.status, 200, reopened.body.error);
    const closedAgain = await sendJson(olivia, base, "POST", `/api/tasks/${february.id}/complete`);
    assert.equal(closedAgain.body.tasks.filter((task) => task.dueOn === "2026-03-28" && task.title === "monthly close").length, 1);
  });
});

test("workflow templates assign one schedule per client and do not file a return", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const listed = await (await olivia.fetch(`${base}/api/workflows/templates`)).json();
    assert.deepEqual(listed.templates.map((template) => template.key).sort(), [
      "annual-tax-readiness",
      "bank-reconciliation",
      "monthly-bookkeeping",
      "new-client-onboarding",
      "quarterly-tax-planning",
    ]);
    assert.equal(listed.templates.filter((template) => template.category === "tax").every((template) => template.detail.toLowerCase().includes("does not file")), true);
    assert.equal(listed.schedules.length, 0);

    const monthly = await sendJson(olivia, base, "POST", "/api/workflows/schedules", {
      templateKey: "monthly-bookkeeping",
      clientId: signedIn.client.id,
    });
    assert.equal(monthly.response.status, 201, monthly.body.error);
    const scheduleId = monthly.body.schedule.id;
    assert.equal(monthly.body.tasks.filter((task) => task.scheduleId === scheduleId).length, 1);
    assert.equal(monthly.body.tasks.filter((task) => task.category === "tax" && task.scheduleId === scheduleId).length, 0);
    assert.ok(monthly.body.schedule.nextOn > monthly.body.today);
    const second = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(second.tasks.filter((task) => task.scheduleId === scheduleId).length, 1);
    const duplicate = await sendJson(olivia, base, "POST", "/api/workflows/schedules", {
      templateKey: "monthly-bookkeeping",
      clientId: signedIn.client.id,
    });
    assert.equal(duplicate.response.status, 200, duplicate.body.error);
    assert.equal(duplicate.body.schedule.id, scheduleId);
    assert.equal(duplicate.body.tasks.filter((task) => task.scheduleId === scheduleId).length, 1);
    const finished = await sendJson(olivia, base, "POST", `/api/tasks/${monthly.body.tasks.find((task) => task.scheduleId === scheduleId).id}/complete`);
    assert.equal(finished.body.tasks.filter((task) => task.scheduleId === scheduleId).length, 1);
    assert.equal(finished.body.tasks.filter((task) => task.scheduleId === scheduleId && task.status !== "completed").length, 0);

    const onboarding = await sendJson(olivia, base, "POST", "/api/workflows/schedules", {
      templateKey: "new-client-onboarding",
      clientId: haven.id,
    });
    assert.equal(onboarding.response.status, 201, onboarding.body.error);
    assert.equal(onboarding.body.schedule.active, false);
    assert.equal(onboarding.body.tasks.filter((task) => task.scheduleId === onboarding.body.schedule.id).length, 1);
    const onboardingAgain = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(onboardingAgain.tasks.filter((task) => task.scheduleId === onboarding.body.schedule.id).length, 1);

    const catchUp = await sendJson(olivia, base, "POST", "/api/workflows/schedules", {
      templateKey: "bank-reconciliation",
      clientId: haven.id,
      nextOn: "2020-01-01",
    });
    assert.equal(catchUp.response.status, 201, catchUp.body.error);
    const firstPeriod = catchUp.body.tasks.filter((task) => task.scheduleId === catchUp.body.schedule.id);
    assert.equal(firstPeriod.length, 1);
    assert.equal(firstPeriod[0].dueOn, "2020-01-01");
    await sendJson(olivia, base, "POST", `/api/tasks/${firstPeriod[0].id}/complete`);
    const moved = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const periods = moved.tasks.filter((task) => task.scheduleId === catchUp.body.schedule.id);
    assert.equal(periods.length, 2);
    assert.equal(periods.filter((task) => task.dueOn === "2020-02-01" && task.status === "open").length, 1);
    const held = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(held.tasks.filter((task) => task.scheduleId === catchUp.body.schedule.id).length, 2);
  });
});

test("workflow schedules and tasks stay inside the firm and the client grant", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const samMember = signedIn.members.find((person) => person.email === "sam@northstarcreative.co");
    const creativeTask = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Creative overdue filing",
      clientId: signedIn.client.id,
      dueOn: "2026-01-02",
    });
    assert.equal(creativeTask.response.status, 201, creativeTask.body.error);
    const havenTask = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Haven overdue filing",
      clientId: haven.id,
      assigneeId: samMember.id,
      dueOn: "2026-01-02",
    });
    const quarterly = await sendJson(olivia, base, "POST", "/api/workflows/schedules", {
      templateKey: "quarterly-tax-planning",
      clientId: signedIn.client.id,
    });
    assert.equal(quarterly.response.status, 201, quarterly.body.error);
    const granted = await sendJson(olivia, base, "POST", "/api/client-grants", {
      userId: samMember.id,
      access: "selected",
      clientIds: [haven.id],
    });
    assert.equal(granted.response.status, 200, granted.body.error);
    const annual = await sendJson(olivia, base, "POST", "/api/workflows/schedules", {
      templateKey: "annual-tax-readiness",
      clientId: haven.id,
      assigneeId: samMember.id,
    });
    assert.equal(annual.response.status, 201, annual.body.error);

    const sam = cookieJar();
    await signIn(sam, base, member(firms.northstar, "sam@northstarcreative.co"));
    const mine = await (await sam.fetch(`${base}/api/tasks`)).json();
    assert.equal(mine.tasks.some((task) => task.title === "Annual tax preparation readiness"), true);
    assert.equal(mine.tasks.some((task) => task.title === "Quarterly tax planning"), false);
    assert.equal(mine.tasks.some((task) => task.clientId === signedIn.client.id), false);
    assert.equal(JSON.stringify(mine).includes("Creative overdue filing"), false);
    const denied = await sendJson(sam, base, "POST", "/api/workflows/schedules", {
      templateKey: "monthly-bookkeeping",
      clientId: signedIn.client.id,
    });
    assert.equal(denied.response.status, 404);
    const allowed = await sendJson(sam, base, "POST", "/api/workflows/schedules", {
      templateKey: "monthly-bookkeeping",
      clientId: haven.id,
      assigneeId: samMember.id,
    });
    assert.equal(allowed.response.status, 201, allowed.body.error);
    const samFirm = await (await sam.fetch(`${base}/api/firm`)).json();
    assert.equal(samFirm.workflow.clientsNeedingAttention.some((client) => client.name === "Northstar Creative"), false);
    assert.equal(samFirm.workflow.clientsNeedingAttention.some((client) => client.name === "Haven Coffee Roasters"), true);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const foreign = await (await jordan.fetch(`${base}/api/tasks`)).json();
    assert.equal(foreign.tasks.length, 0);
    assert.equal(JSON.stringify(foreign).includes("Haven Coffee Roasters"), false);
    assert.equal(JSON.stringify(foreign).includes("Northstar Creative"), false);
    const foreignTemplates = await (await jordan.fetch(`${base}/api/workflows/templates`)).json();
    assert.equal(foreignTemplates.schedules.length, 0);
    assert.equal(JSON.stringify(foreignTemplates).includes("Haven Coffee Roasters"), false);
    const foreignAssign = await sendJson(jordan, base, "POST", "/api/workflows/schedules", {
      templateKey: "monthly-bookkeeping",
      clientId: signedIn.client.id,
    });
    assert.equal(foreignAssign.response.status, 404);
    const foreignFirm = await (await jordan.fetch(`${base}/api/firm`)).json();
    assert.equal(JSON.stringify(foreignFirm.workflow).includes("Northstar Creative"), false);
    assert.equal(JSON.stringify(foreignFirm).includes("$"), false);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const portal = await casey.fetch(`${base}/api/workflows/templates`);
    assert.equal(portal.status, 404);
    const portalTasks = await casey.fetch(`${base}/api/tasks`);
    assert.equal(portalTasks.status, 404);
    assert.equal(havenTask.response.status, 201);
  });
});

test("accounting issues open a task, resolving the issue completes it, and the books still balance", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");

    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    assert.equal(account.response.status, 201, account.body.error);
    const line = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-20",
      description: "Uncoded studio deposit",
      amount: "40.00",
    });
    assert.equal(line.response.status, 201, line.body.error);
    const first = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const second = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.deepEqual(second.tasks.map((task) => task.id).sort(), first.tasks.map((task) => task.id).sort());
    const uncategorized = first.tasks.find((task) => task.sourceType === "uncategorized_group" && task.clientId === creative.id);
    const unreconciled = first.tasks.find((task) => task.sourceType === "unreconciled_account" && task.clientId === creative.id);
    const bookkeeping = first.tasks.find((task) => task.sourceType === "bookkeeping_month" && task.clientId === creative.id);
    assert.ok(uncategorized);
    assert.ok(unreconciled);
    assert.ok(bookkeeping);
    assert.equal(bookkeeping.category, "bookkeeping");
    assert.equal(first.tasks.filter((task) => task.sourceType === "uncategorized_group" && task.clientId === creative.id).length, 1);

    const revenue = line.body.accounts.find((item) => item.code === "4000");
    const categorized = await sendJson(olivia, base, "POST", `/api/transactions/${line.body.transaction.id}/categorize`, { accountId: revenue.id });
    assert.equal(categorized.response.status, 200, categorized.body.error);
    const afterCode = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const coded = afterCode.tasks.find((task) => task.id === uncategorized.id);
    assert.equal(coded.status, "completed");
    assert.equal(coded.history.some((event) => event.action === "complete" && event.detail === "The accounting issue is resolved."), true);
    assert.equal(afterCode.tasks.find((task) => task.id === unreconciled.id).status, "open");
    assert.equal(afterCode.tasks.find((task) => task.id === bookkeeping.id).status, "open");
    const codedBooks = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(codedBooks.foots, true);
    assert.equal(codedBooks.trialBalance.debitsCents, codedBooks.trialBalance.creditsCents);
    const entryId = categorized.body.entry.id;

    const reconciled = await sendJson(olivia, base, "POST", "/api/reconciliations", {
      bankAccountId: account.body.accounts[0].id,
      statementDate: "2026-05-31",
      statementEnding: "40.00",
      transactionIds: [line.body.transaction.id],
    });
    assert.equal(reconciled.response.status, 201, reconciled.body.error);
    const afterReconcile = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(afterReconcile.tasks.find((task) => task.id === unreconciled.id).status, "completed");
    assert.equal(afterReconcile.tasks.find((task) => task.id === bookkeeping.id).status, "completed");
    const reconciledBooks = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(reconciledBooks.foots, true);
    assert.equal(reconciledBooks.entries.some((entry) => entry.id === entryId), true);

    const added = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-22",
      description: "Another uncoded line",
      amount: "10.00",
    });
    assert.equal(added.response.status, 201, added.body.error);
    const reopened = await (await olivia.fetch(`${base}/api/tasks`)).json();
    for (const task of [uncategorized, unreconciled, bookkeeping]) {
      const row = reopened.tasks.find((item) => item.id === task.id);
      assert.equal(row.status, "open");
      assert.equal(row.history.some((event) => event.action === "reopen"), true);
    }
    assert.equal(reopened.tasks.filter((task) => task.sourceType === "uncategorized_group" && task.clientId === creative.id).length, 1);
    assert.equal(reopened.tasks.filter((task) => task.sourceType === "unreconciled_account" && task.clientId === creative.id).length, 1);
    assert.equal(reopened.tasks.filter((task) => task.sourceType === "bookkeeping_month" && task.clientId === creative.id).length, 1);

    const payables = await (await olivia.fetch(`${base}/api/payables`)).json();
    const office = payables.accounts.find((item) => item.code === "6400");
    const cash = payables.accounts.find((item) => item.code === "1000");
    const vendor = await sendJson(olivia, base, "POST", "/api/payables/vendors", { name: "Harbor Paper Co.", defaultAccountId: office.id });
    const bill = await sendJson(olivia, base, "POST", "/api/payables/bills", {
      vendorId: vendor.body.vendor.id,
      invoiceNumber: "HP-1044",
      billDate: "2026-01-10",
      dueDate: "2026-01-15",
      lines: [{ description: "Cover stock", accountId: office.id, amount: "8.00", tax: "0.00" }],
    });
    await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/submit`);
    const waiting = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const billTask = waiting.tasks.find((task) => task.sourceType === "bill" && task.sourceId === bill.body.bill.id);
    assert.equal(billTask.status, "open");
    assert.equal(waiting.tasks.some((task) => task.sourceType === "unpaid_bill"), false);
    const beforeApprove = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const approved = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/approve`);
    assert.equal(approved.response.status, 200, approved.body.error);
    const afterApprove = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(afterApprove.tasks.find((task) => task.id === billTask.id).status, "completed");
    const booksAfterApprove = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(booksAfterApprove.entries.length, beforeApprove.entries.length);
    assert.equal(booksAfterApprove.foots, true);
    const posted = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/post`, {});
    assert.equal(posted.response.status, 200, posted.body.error);
    assert.equal(posted.body.entry.debitCents, posted.body.entry.creditCents);
    const owed = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const unpaid = owed.tasks.find((task) => task.sourceType === "unpaid_bill" && task.sourceId === bill.body.bill.id);
    assert.equal(unpaid.status, "open");
    const partial = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/payments`, {
      paidOn: "2026-02-01",
      amount: "3.00",
      reference: "CHK-14",
      accountId: cash.id,
    });
    assert.equal(partial.response.status, 201, partial.body.error);
    const stillOwed = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(stillOwed.tasks.find((task) => task.id === unpaid.id).status, "open");
    const paidBill = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/payments`, {
      paidOn: "2026-02-02",
      amount: "5.00",
      reference: "CHK-15",
      accountId: cash.id,
    });
    assert.equal(paidBill.response.status, 201, paidBill.body.error);
    const settled = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(settled.tasks.find((task) => task.id === unpaid.id).status, "completed");

    const drafted = await sendJson(olivia, base, "POST", "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2020-01-01",
      dueDate: "2020-02-01",
      lines: [{ description: "Design work", amount: "25.00" }],
    });
    await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/send`);
    const invoiced = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const invoiceTask = invoiced.tasks.find((task) => task.sourceType === "invoice" && task.sourceId === drafted.body.invoice.id);
    assert.equal(invoiceTask.status, "open");
    await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/payments`, { amount: "10.00", paidOn: "2020-02-02" });
    const partialInvoice = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(partialInvoice.tasks.find((task) => task.id === invoiceTask.id).status, "open");
    const paidInvoice = await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/payments`, { amount: "15.00", paidOn: "2020-02-03" });
    assert.equal(paidInvoice.response.status, 201, paidInvoice.body.error);
    assert.equal(paidInvoice.body.invoice.status, "paid");
    const collected = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(collected.tasks.find((task) => task.id === invoiceTask.id).status, "completed");
    const books = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(books.foots, true);
    assert.equal(books.trialBalance.debitsCents, books.trialBalance.creditsCents);

    const request = await sendJson(olivia, base, "POST", "/api/document-requests", {
      clientId: haven.id,
      title: "Haven fictional receipts",
      dueOn: "2026-12-01",
    });
    assert.equal(request.response.status, 201, request.body.error);
    const requested = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const requestTask = requested.tasks.find((task) => task.sourceType === "document_request" && task.sourceId === request.body.request.id);
    const havenBooks = requested.tasks.find((task) => task.sourceType === "bookkeeping_month" && task.clientId === haven.id);
    assert.equal(requestTask.status, "open");
    assert.equal(havenBooks.status, "open");
    const uploaded = await sendJson(olivia, base, "POST", "/api/documents", {
      clientId: haven.id,
      requestId: request.body.request.id,
      name: "haven-receipt.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("fictional receipt\n").toString("base64"),
    });
    assert.equal(uploaded.response.status, 201, uploaded.body.error);
    const cleared = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(cleared.tasks.find((task) => task.id === requestTask.id).status, "completed");
    assert.equal(cleared.tasks.find((task) => task.id === havenBooks.id).status, "completed");
    assert.equal(cleared.tasks.filter((task) => task.sourceType === "document_request" && task.sourceId === request.body.request.id).length, 1);
  });
});

test("dependencies, review, reminders, and the firm workflow summary stay consistent", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const first = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Gather the statements",
      clientId: signedIn.client.id,
      dueOn: "2026-11-18",
    });
    const blocked = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Send the package",
      clientId: signedIn.client.id,
      dueOn: "2026-11-20",
      recurrence: "monthly",
      blockedByTaskId: first.body.task.id,
    });
    assert.equal(blocked.response.status, 201, blocked.body.error);
    assert.equal(blocked.body.task.blocked, true);
    const early = await sendJson(olivia, base, "POST", `/api/tasks/${blocked.body.task.id}/complete`);
    assert.equal(early.response.status, 409);
    assert.equal(early.body.error, "Finish the earlier task first.");
    const held = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(held.tasks.filter((task) => task.title === "Send the package" && task.sourceType === "recurrence").length, 0);
    await sendJson(olivia, base, "POST", `/api/tasks/${first.body.task.id}/complete`);
    const released = await sendJson(olivia, base, "POST", `/api/tasks/${blocked.body.task.id}/complete`);
    assert.equal(released.response.status, 200, released.body.error);
    assert.equal(released.body.tasks.filter((task) => task.sourceType === "recurrence" && task.title === "Send the package").length, 1);

    const loop = await sendJson(olivia, base, "PATCH", `/api/tasks/${first.body.task.id}`, { blockedByTaskId: blocked.body.task.id });
    assert.equal(loop.response.status, 400);
    const self = await sendJson(olivia, base, "PATCH", `/api/tasks/${first.body.task.id}`, { blockedByTaskId: first.body.task.id });
    assert.equal(self.response.status, 400);

    const review = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Review the package",
      clientId: signedIn.client.id,
      assigneeId: signedIn.members.find((person) => person.email === "sam@northstarcreative.co").id,
      dueOn: "2026-11-17",
      stage: "in_review",
    });
    assert.equal(review.response.status, 201, review.body.error);
    assert.equal(review.body.task.stage, "in_review");
    assert.equal(review.body.task.history.some((event) => event.detail === "In review"), true);
    const sam = cookieJar();
    await signIn(sam, base, member(firms.northstar, "sam@northstarcreative.co"));
    const staffApprove = await sendJson(sam, base, "POST", `/api/tasks/${review.body.task.id}/approve`);
    assert.equal(staffApprove.response.status, 403);
    const morgan = cookieJar();
    await signIn(morgan, base, member(firms.northstar, "morgan@northstarcreative.co"));
    const approved = await sendJson(morgan, base, "POST", `/api/tasks/${review.body.task.id}/approve`);
    assert.equal(approved.response.status, 200, approved.body.error);
    assert.equal(approved.body.task.status, "completed");
    assert.equal(approved.body.task.stage, "approved");
    assert.equal(approved.body.task.history.some((event) => event.action === "complete" && event.detail === "Approved"), true);

    const reminded = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const reminder = reminded.reminders.filter((item) => item.taskId === review.body.task.id);
    assert.equal(reminder.length, 0);
    const dueToday = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Olivia reminder",
      clientId: signedIn.client.id,
      assigneeId: signedIn.user.id,
      dueOn: reminded.today,
    });
    const withReminder = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(withReminder.reminders.filter((item) => item.taskId === dueToday.body.task.id).length, 1);
    const reminderAgain = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(reminderAgain.reminders.filter((item) => item.taskId === dueToday.body.task.id).length, 1);

    await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Creative still late",
      clientId: signedIn.client.id,
      dueOn: "2026-01-02",
    });
    const home = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(home.workflow.completion, home.workflow.total ? Math.round((home.workflow.completed / home.workflow.total) * 100) : 0);
    assert.equal(typeof home.workflow.overdue, "number");
    assert.equal(home.workflow.clientsNeedingAttention.some((client) => client.id === signedIn.client.id), true);
    assert.equal(home.workload.some((person) => person.userId === signedIn.user.id), true);
    assert.equal(JSON.stringify(home).includes("$"), false);

    const page = readFileSync(new URL("../src/WorkQueue.jsx", import.meta.url), "utf8");
    const firm = readFileSync(new URL("../src/FirmHome.jsx", import.meta.url), "utf8");
    assert.match(page, /tasks=\{rows\}/);
    assert.match(page, /Kanban/);
    assert.match(firm, /home\.workflow/);
    assert.doesNotMatch(firm, /<b>18<\/b>/);
  });
});
