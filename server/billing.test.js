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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-billing-"));
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

async function sendJson(jar, base, method, pathname, payload) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test("a firm fee invoice stays off the client ledger and needs approval before payment", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const before = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const engagement = await sendJson(olivia, base, "POST", "/api/billing/engagements", {
      clientId: creative.id,
      name: "Monthly books",
      kind: "fixed",
      amount: "500.00",
      costAmount: "200.00",
    });
    assert.equal(engagement.response.status, 200, engagement.body.error);
    const engagementId = engagement.body.engagements[0].id;
    const drafted = await sendJson(olivia, base, "POST", "/api/billing/invoices", {
      clientId: creative.id,
      engagementId,
      issueOn: "2026-01-02",
      dueOn: "2026-01-15",
    });
    assert.equal(drafted.response.status, 201, drafted.body.error);
    assert.equal(drafted.body.invoice.postsToClientLedger, false);
    assert.equal(drafted.body.invoice.collectsCard, false);
    assert.equal(drafted.body.invoice.balanceCents, 50000);
    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const staff = await sendJson(sam, base, "POST", `/api/billing/invoices/${drafted.body.invoice.id}/approve`, {});
    assert.equal(staff.response.status, 403);
    const approved = await sendJson(olivia, base, "POST", `/api/billing/invoices/${drafted.body.invoice.id}/approve`, {});
    assert.equal(approved.response.status, 200, approved.body.error);
    assert.equal(approved.body.invoice.status, "approved");
    const card = await sendJson(olivia, base, "POST", `/api/billing/invoices/${drafted.body.invoice.id}/payments`, {
      amount: "100.00",
      paidOn: "2026-02-01",
      method: "recorded",
      note: "4111111111111111",
    });
    assert.equal(card.response.status, 400);
    const paid = await sendJson(olivia, base, "POST", `/api/billing/invoices/${drafted.body.invoice.id}/payments`, {
      amount: "200.00",
      paidOn: "2026-02-01",
      method: "check",
    });
    assert.equal(paid.response.status, 200, paid.body.error);
    assert.equal(paid.body.invoice.status, "partial");
    assert.equal(paid.body.invoice.balanceCents, 30000);
    const credit = await sendJson(olivia, base, "POST", `/api/billing/invoices/${drafted.body.invoice.id}/credits`, {
      amount: "300.00",
      reason: "Courtesy reduction for the first month.",
    });
    assert.equal(credit.response.status, 200, credit.body.error);
    assert.equal(credit.body.invoice.status, "paid");
    assert.equal(credit.body.invoice.balanceCents, 0);
    const after = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(after.entries.length, before.entries.length);
    assert.equal(after.foots, true);
    const board = await (await olivia.fetch(`${base}/api/billing`)).json();
    assert.equal(board.payments.enabled, false);
    const firm = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(typeof firm.counts.openFirmInvoices, "number");
    assert.equal(JSON.stringify(firm).includes("$"), false);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const hidden = await jordan.fetch(`${base}/api/billing`);
    const hiddenText = await hidden.text();
    assert.equal(hiddenText.includes("Monthly books"), false);
    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    assert.equal((await casey.fetch(`${base}/api/billing`)).status, 404);
  });
});

test("hourly billing skips nonbillable time, and a recurring draft is created once", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const work = await sendJson(olivia, base, "POST", "/api/work", {
      clientId: creative.id,
      name: "Advisory",
      hourlyRate: "100.00",
    });
    assert.equal(work.response.status, 201, work.body.error);
    const billable = await sendJson(olivia, base, "POST", "/api/time", {
      clientId: creative.id,
      workId: work.body.work.id,
      workedOn: "2026-03-02",
      hours: "2.00",
      note: "Billable review",
    });
    const quiet = await sendJson(olivia, base, "POST", "/api/time", {
      clientId: creative.id,
      workId: work.body.work.id,
      workedOn: "2026-03-03",
      hours: "1.00",
      note: "Internal training",
      billable: false,
    });
    assert.equal(billable.response.status, 201, billable.body.error);
    assert.equal(quiet.body.entry.billable, false);
    const refused = await sendJson(olivia, base, "POST", "/api/billing/invoices", {
      clientId: creative.id,
      issueOn: "2026-03-04",
      dueOn: "2026-03-18",
      entryIds: [billable.body.entry.id, quiet.body.entry.id],
    });
    assert.equal(refused.response.status, 400);
    const hourly = await sendJson(olivia, base, "POST", "/api/billing/invoices", {
      clientId: creative.id,
      issueOn: "2026-03-04",
      dueOn: "2026-01-10",
      entryIds: [billable.body.entry.id],
    });
    assert.equal(hourly.response.status, 201, hourly.body.error);
    assert.equal(hourly.body.invoice.balanceCents, 20000);
    assert.equal(hourly.body.invoice.clientLedgerWarning, "");
    const clientDraft = await sendJson(olivia, base, "POST", "/api/time/invoice", {
      entryIds: [billable.body.entry.id],
      issueDate: "2026-03-04",
      dueDate: "2026-03-18",
    });
    assert.equal(clientDraft.response.status, 201, clientDraft.body.error);
    assert.match(clientDraft.body.firmFeeWarning, /firm fee invoice/);
    const later = await sendJson(olivia, base, "POST", "/api/time", {
      clientId: creative.id,
      workId: work.body.work.id,
      workedOn: "2026-03-06",
      hours: "1.00",
      note: "Already on the client invoice path",
    });
    const clientFirst = await sendJson(olivia, base, "POST", "/api/time/invoice", {
      entryIds: [later.body.entry.id],
      issueDate: "2026-03-06",
      dueDate: "2026-03-20",
    });
    assert.equal(clientFirst.response.status, 201, clientFirst.body.error);
    assert.equal(clientFirst.body.firmFeeWarning, "");
    const firmAfter = await sendJson(olivia, base, "POST", "/api/billing/invoices", {
      clientId: creative.id,
      issueOn: "2026-03-06",
      dueOn: "2026-03-20",
      entryIds: [later.body.entry.id],
    });
    assert.equal(firmAfter.response.status, 201, firmAfter.body.error);
    assert.equal(firmAfter.body.invoice.lines[0].alreadyOnClientInvoice, true);
    assert.match(firmAfter.body.invoice.clientLedgerWarning, /client-ledger invoice/);
    await sendJson(olivia, base, "POST", `/api/billing/invoices/${hourly.body.invoice.id}/approve`, {});
    const firstTasks = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const secondTasks = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const reminder = firstTasks.tasks.filter((task) => task.sourceType === "firm_invoice");
    assert.equal(reminder.length, 1);
    assert.equal(secondTasks.tasks.find((task) => task.sourceType === "firm_invoice").id, reminder[0].id);
    assert.equal(reminder[0].target.screen, "Billing");

    const recurring = await sendJson(olivia, base, "POST", "/api/billing/engagements", {
      clientId: creative.id,
      name: "Retainer",
      kind: "recurring",
      amount: "250.00",
      intervalDays: 30,
      nextOn: "2026-11-17",
    });
    assert.equal(recurring.response.status, 200, recurring.body.error);
    const once = await sendJson(olivia, base, "POST", "/api/billing/recurring", {});
    const twice = await sendJson(olivia, base, "POST", "/api/billing/recurring", {});
    assert.equal(once.body.created, 1);
    assert.equal(twice.body.created, 0);
    const reports = await (await olivia.fetch(`${base}/api/billing/reports`)).json();
    const books = reports.profitability.find((row) => row.name === "Monthly books");
    assert.equal(books, undefined);
    const advisory = reports.byService.find((row) => row.service === "Advisory");
    assert.equal(advisory.billedCents, 20000);
  });
});
