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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-expenses-"));
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
  return response.json();
}

async function sendJson(jar, base, method, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

function cents(rows, code) {
  return rows.find((item) => item.code === code)?.cents;
}

test("a bill and a paid expense post the same vendor and amount to the ledger and the statements", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.firm.requireReceipt, false);
    assert.equal(signedIn.client.name, "Northstar Creative");

    const empty = await (await olivia.fetch(`${base}/api/expenses`)).json();
    assert.equal(empty.expenses.length, 0);
    assert.equal(empty.totals.billCents, 0);
    assert.equal(empty.totals.paidCents, 0);
    assert.equal(JSON.stringify(empty).includes("1,240"), false);
    assert.equal(JSON.stringify(empty).includes("1,850"), false);
    assert.equal(JSON.stringify(empty).includes("Mercury"), false);

    const rejected = await sendJson(olivia, base, "POST", "/api/expenses", {
      vendor: "Northwind Supplies",
      spentOn: "2026-05-18",
      dueOn: "2026-06-01",
      amount: 42.5,
      accountCode: "6400",
      kind: "bill",
    });
    assert.equal(rejected.response.status, 400);

    const bill = await sendJson(olivia, base, "POST", "/api/expenses", {
      vendor: "Northwind Supplies",
      spentOn: "2026-05-18",
      dueOn: "2026-06-01",
      amount: "42.50",
      accountCode: "6400",
      kind: "bill",
    });
    assert.equal(bill.response.status, 201);
    assert.equal(bill.body.expense.vendor, "Northwind Supplies");
    assert.equal(bill.body.expense.amountCents, 4250);
    assert.equal(bill.body.expense.kind, "bill");
    assert.equal(bill.body.entry.memo, "Northwind Supplies");
    assert.equal(bill.body.entry.debitCents, 4250);
    assert.equal(bill.body.entry.lines.find((line) => line.accountCode === "6400").debitCents, 4250);
    assert.equal(bill.body.entry.lines.find((line) => line.accountCode === "2000").creditCents, 4250);

    const paid = await sendJson(olivia, base, "POST", "/api/expenses", {
      vendor: "Pine Press",
      spentOn: "2026-05-20",
      amount: "15.00",
      accountCode: "6500",
      kind: "paid",
    });
    assert.equal(paid.response.status, 201);
    assert.equal(paid.body.expense.vendor, "Pine Press");
    assert.equal(paid.body.expense.amountCents, 1500);
    assert.equal(paid.body.entry.memo, "Pine Press");
    assert.equal(paid.body.entry.lines.find((line) => line.accountCode === "6500").debitCents, 1500);
    assert.equal(paid.body.entry.lines.find((line) => line.accountCode === "1000").creditCents, 1500);

    const listed = await (await olivia.fetch(`${base}/api/expenses`)).json();
    const listedBill = listed.expenses.find((expense) => expense.vendor === "Northwind Supplies");
    const listedPaid = listed.expenses.find((expense) => expense.vendor === "Pine Press");
    assert.equal(listedBill.amountCents, 4250);
    assert.equal(listedPaid.amountCents, 1500);
    assert.equal(listed.totals.billCents, 4250);
    assert.equal(listed.totals.paidCents, 1500);

    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const billEntry = ledger.entries.find((entry) => entry.memo === "Northwind Supplies");
    const paidEntry = ledger.entries.find((entry) => entry.memo === "Pine Press");
    assert.equal(billEntry.debitCents, listedBill.amountCents);
    assert.equal(paidEntry.debitCents, listedPaid.amountCents);
    assert.equal(billEntry.memo, listedBill.vendor);
    assert.equal(paidEntry.memo, listedPaid.vendor);

    const may = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(cents(may.profitAndLoss.expenseRows, "6400"), 4250);
    assert.equal(cents(may.profitAndLoss.expenseRows, "6500"), 1500);
    assert.equal(may.profitAndLoss.expenseCents, 5750);
    assert.equal(cents(may.balanceSheet.liabilities, "2000"), 4250);
    const cashMay = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=cash`)).json();
    assert.equal(cents(cashMay.profitAndLoss.expenseRows, "6400"), undefined);
    assert.equal(cents(cashMay.profitAndLoss.expenseRows, "6500"), 1500);

    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const switched = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
    assert.equal(switched.response.status, 200);
    const otherClient = await (await olivia.fetch(`${base}/api/expenses`)).json();
    assert.equal(otherClient.expenses.length, 0);
    assert.equal(JSON.stringify(otherClient).includes("Northwind Supplies"), false);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await (await harbor.fetch(`${base}/api/expenses`)).json();
    assert.equal(JSON.stringify(hidden).includes("Northwind Supplies"), false);
    assert.equal(JSON.stringify(hidden).includes("Pine Press"), false);
    const hiddenPost = await sendJson(harbor, base, "POST", "/api/expenses", {
      vendor: "Northwind Supplies",
      spentOn: "2026-05-18",
      dueOn: "2026-06-01",
      amount: "42.50",
      accountCode: "6400",
      kind: "bill",
      clientId: signedIn.client.id,
    });
    assert.equal(hiddenPost.response.status, 404);
  });
});

test("a firm can require a stored receipt before an expense posts", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const before = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const setting = await sendJson(olivia, base, "PATCH", "/api/firm", { requireReceipt: true });
    assert.equal(setting.response.status, 200);
    assert.equal(setting.body.firm.requireReceipt, true);
    const session = await (await olivia.fetch(`${base}/api/session`)).json();
    assert.equal(session.firm.requireReceipt, true);

    const blocked = await sendJson(olivia, base, "POST", "/api/expenses", {
      vendor: "Missing Receipt Co",
      spentOn: "2026-05-21",
      dueOn: "2026-06-04",
      amount: "9.00",
      accountCode: "6400",
      kind: "bill",
    });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.body.error, /receipt/i);
    const unchanged = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(unchanged.entries.length, before.entries.length);
    const listed = await (await olivia.fetch(`${base}/api/expenses`)).json();
    assert.equal(listed.expenses.length, 0);
    assert.equal(listed.requireReceipt, true);

    const file = await sendJson(olivia, base, "POST", "/api/documents", {
      name: "synthetic-receipt.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("synthetic receipt\n").toString("base64"),
    });
    assert.equal(file.response.status, 201);
    const posted = await sendJson(olivia, base, "POST", "/api/expenses", {
      vendor: "Missing Receipt Co",
      spentOn: "2026-05-21",
      dueOn: "2026-06-04",
      amount: "9.00",
      accountCode: "6400",
      kind: "bill",
      documentId: file.body.file.id,
    });
    assert.equal(posted.response.status, 201);
    assert.equal(posted.body.expense.receiptName, "synthetic-receipt.txt");
    assert.equal(posted.body.expense.amountCents, 900);
    assert.equal(posted.body.entry.memo, "Missing Receipt Co");

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const otherFirm = await (await harbor.fetch(`${base}/api/session`)).json();
    assert.equal(otherFirm.firm.requireReceipt, false);
  });
});

test("the expenses screen does not keep the published bill cards", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const expenses = readFileSync(new URL("../src/Expenses.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /Mercury Insurance/);
  assert.doesNotMatch(shell, /\$1,240\.00/);
  assert.doesNotMatch(expenses, /Overview|Activity|Rules|\$1,240|\$1,850|Mercury/);
  assert.match(shell, /UpcomingBills/);
  assert.match(shell, /ExpenseModal/);
  assert.match(shell, /ReceiptSetting/);
  assert.match(expenses, /Attach a receipt before posting this expense/);
  assert.match(expenses, /Showing \{filtered\.length\} of \{expenses\.length\} expenses/);
});
