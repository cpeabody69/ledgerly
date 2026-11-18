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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-health-"));
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

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

test("financial alerts explain the records, the calculation, and the reason", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const empty = await (await olivia.fetch(`${base}/api/health`)).json();
    assert.equal(empty.counts.needingAttention, 0);
    assert.equal(JSON.stringify(empty).includes("$"), false);

    const firmBefore = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(firmBefore.health.counts.needingAttention, 0);
    const tasksBefore = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(tasksBefore.tasks.filter((task) => task.sourceType === "health_issue").length, 0);

    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Health checking", kind: "bank" });
    assert.equal(account.response.status, 201, account.body.error);
    const bankId = account.body.accounts.find((row) => row.name === "Health checking").id;
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
    assert.equal(first.response.status, 201, first.body.error);
    assert.equal(second.response.status, 201, second.body.error);
    for (let index = 0; index < 5; index += 1) {
      const small = await sendJson(olivia, base, "POST", "/api/transactions", {
        bankAccountId: bankId,
        postedOn: `2026-05-0${index + 1}`,
        description: `Usual supply ${index + 1}`,
        amount: "-10.00",
      });
      assert.equal(small.response.status, 201, small.body.error);
    }
    const large = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: "2026-05-08",
      description: "Unusual equipment",
      amount: "-80.00",
    });
    assert.equal(large.response.status, 201, large.body.error);

    const drafted = await sendJson(olivia, base, "POST", "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2025-01-01",
      dueDate: "2025-01-15",
      memo: "Old design",
      lines: [{ description: "Design work", amount: "25.00" }],
    });
    assert.equal(drafted.response.status, 201, drafted.body.error);
    const sent = await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/send`);
    assert.equal(sent.response.status, 200, sent.body.error);

    const payables = await (await olivia.fetch(`${base}/api/payables`)).json();
    const office = payables.accounts.find((row) => row.code === "6400");
    const vendor = await sendJson(olivia, base, "POST", "/api/payables/vendors", { name: "Fictional Paper Co." });
    assert.equal(vendor.response.status, 201, vendor.body.error);
    const dueSoon = addDays(todayIso(), 10);
    const bill = await sendJson(olivia, base, "POST", "/api/payables/bills", {
      vendorId: vendor.body.vendor.id,
      invoiceNumber: "FP-910",
      billDate: todayIso(),
      dueDate: dueSoon,
      lines: [{ description: "Paper", accountId: office.id, amount: "50.00", tax: "" }],
    });
    assert.equal(bill.response.status, 201, bill.body.error);
    const submitted = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/submit`);
    assert.equal(submitted.response.status, 200, submitted.body.error);

    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const cash = ledger.accounts.find((row) => row.code === "1000").id;
    const income = ledger.accounts.find((row) => row.code === "4000").id;
    const expense = ledger.accounts.find((row) => row.code === "6400").id;
    const journals = [
      ["2025-03-03", "100.00", income, "credit"],
      ["2025-02-02", "10.00", expense, "debit"],
      ["2026-03-03", "10.00", income, "credit"],
      ["2026-02-02", "80.00", expense, "debit"],
    ];
    for (const [entryDate, amount, accountId, side] of journals) {
      const lines = side === "credit"
        ? [{ accountId: cash, debit: amount, credit: "" }, { accountId, debit: "", credit: amount }]
        : [{ accountId, debit: amount, credit: "" }, { accountId: cash, debit: "", credit: amount }];
      const posted = await sendJson(olivia, base, "POST", "/api/journal-entries", { entryDate, memo: "Health fixture", lines });
      assert.equal(posted.response.status, 201, posted.body.error);
    }

    const firmDuring = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(firmDuring.health.counts.needingAttention, 1);
    assert.equal(JSON.stringify(firmDuring).includes("$"), false);
    const stillQuiet = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const createdEarly = stillQuiet.tasks.filter((task) => task.sourceType === "health_issue");
    assert.equal(createdEarly.length > 0, true);

    const view = await (await olivia.fetch(`${base}/api/health/${creative.id}`)).json();
    assert.equal(view.note.includes("no score"), true);
    assert.equal(JSON.stringify(view).includes("$"), false);
    const duplicate = view.alerts.find((alert) => alert.key === "duplicate");
    assert.equal(duplicate.records.length, 2);
    assert.equal(duplicate.records.map((record) => record.id).sort().join(), [first.body.transaction.id, second.body.transaction.id].sort().join());
    assert.match(duplicate.calculation, /1800 cents/);
    assert.match(duplicate.reason, /more than once/);
    const unusual = view.alerts.find((alert) => alert.key === "unusual");
    assert.equal(unusual.records[0].id, large.body.transaction.id);
    assert.match(unusual.calculation, /median absolute amount of 8 bank lines/);
    assert.match(unusual.calculation, /1000 cents/);
    assert.match(unusual.reason, /far from the other lines/);
    assert.equal(view.receivables.over90, 2500);
    assert.equal(view.alerts.some((alert) => alert.key === "receivable" && alert.records[0].id === drafted.body.invoice.id), true);
    const liquidity = view.alerts.find((alert) => alert.key === "liquidity");
    assert.equal(liquidity.records.some((record) => record.id === bill.body.bill.id), true);
    assert.match(liquidity.calculation, /shortfall is/);
    assert.equal(view.trends.revenue.priorCents, 12500);
    assert.equal(view.trends.revenue.currentCents, 1000);
    assert.equal(view.trends.profit.currentCents, 1000 - 8000);
    assert.equal(view.trends.yearOverYear.priorNetCents, 12500 - 1000);
    assert.equal(view.alerts.some((alert) => alert.key === "revenue"), true);
    assert.equal(view.alerts.some((alert) => alert.key === "expense"), true);
    assert.equal(view.alerts.some((alert) => alert.key === "profit"), true);
    assert.equal(view.alerts.some((alert) => alert.key === "close" && alert.recordKey === "2026-02"), true);
    assert.equal(view.close.months.some((month) => month.period === "2026-01" && month.activity), false);

    const queued = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const healthTasks = queued.tasks.filter((task) => task.sourceType === "health_issue");
    const duplicateTask = healthTasks.find((task) => task.sourceId.endsWith(":duplicate:2026-04-04|-1800|duplicate paper order"));
    assert.equal(Boolean(duplicateTask), true);
    assert.match(duplicateTask.detail, /1800 cents/);
    assert.equal(duplicateTask.target.screen, "Financial health");
    const again = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(again.tasks.find((task) => task.id === duplicateTask.id).id, duplicateTask.id);

    const excluded = await sendJson(olivia, base, "POST", `/api/transactions/${second.body.transaction.id}/exclude`, { note: "Second copy" });
    assert.equal(excluded.response.status, 200, excluded.body.error);
    const cleared = await (await olivia.fetch(`${base}/api/health/${creative.id}`)).json();
    assert.equal(cleared.alerts.some((alert) => alert.key === "duplicate"), false);
    const after = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(after.tasks.find((task) => task.id === duplicateTask.id).status, "completed");

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const foreign = await (await jordan.fetch(`${base}/api/health`)).json();
    assert.equal(JSON.stringify(foreign).includes("Northstar Creative"), false);
    assert.equal(JSON.stringify(foreign).includes("Duplicate paper"), false);
    const hidden = await jordan.fetch(`${base}/api/health/${creative.id}`);
    assert.equal(hidden.status, 404);
    const foreignTasks = await (await jordan.fetch(`${base}/api/tasks`)).json();
    assert.equal(foreignTasks.tasks.length, 0);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const portal = await casey.fetch(`${base}/api/health`);
    assert.equal(portal.status, 404);
  });
});
