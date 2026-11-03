import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { statementCsv } from "../shared/statements.js";

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-statements-"));
  const running = await start(path.join(dir, "test.sqlite"), 0);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

async function signIn(jar, base) {
  const response = await jar.fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: firms.northstar.owner.email, password: firms.northstar.owner.password }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function postEntry(jar, base, ledger, date, memo, debitCode, creditCode, amount) {
  const id = (code) => ledger.accounts.find((account) => account.code === code).id;
  const response = await jar.fetch(`${base}/api/journal-entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entryDate: date,
      memo,
      lines: [
        { accountId: id(debitCode), debit: amount, credit: "" },
        { accountId: id(creditCode), debit: "", credit: amount },
      ],
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

function earningsFromTrialBalance(ledger) {
  let income = 0;
  let expense = 0;
  for (const row of ledger.trialBalance.rows) {
    if (row.typeLabel === "Income") income += row.creditCents - row.debitCents;
    if (row.typeLabel === "Expense") expense += row.debitCents - row.creditCents;
  }
  return income - expense;
}

test("statements follow the ledger, and cash basis drops an accrual", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base);
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const may = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    const year = may.period.start.slice(0, 4);
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();

    await postEntry(olivia, base, ledger, `${year}-05-12`, "Cash service income", "1000", "4000", "500.00");
    await postEntry(olivia, base, ledger, `${year}-05-20`, "Accrued service income", "1100", "4000", "200.00");
    await postEntry(olivia, base, ledger, `${year}-05-18`, "Office supplies paid", "6400", "1000", "42.50");
    await postEntry(olivia, base, ledger, `${year}-04-03`, "Accrued rent", "6100", "2000", "100.00");

    const accrual = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    const cash = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=cash`)).json();
    assert.equal(accrual.profitAndLoss.incomeCents, 70000);
    assert.equal(accrual.profitAndLoss.expenseCents, 4250);
    assert.equal(accrual.profitAndLoss.netIncomeCents, 65750);
    assert.equal(cash.profitAndLoss.incomeCents, 50000);
    assert.equal(cash.profitAndLoss.expenseCents, 4250);
    assert.equal(cash.profitAndLoss.netIncomeCents, 45750);
    assert.notEqual(accrual.profitAndLoss.netIncomeCents, cash.profitAndLoss.netIncomeCents);
    assert.equal(accrual.metrics.revenueCents, accrual.profitAndLoss.incomeCents);
    assert.equal(accrual.metrics.netIncomeCents, accrual.profitAndLoss.netIncomeCents);
    assert.equal(accrual.metrics.cashCents, accrual.cashFlow.endingCents);
    assert.equal(accrual.balanceSheet.balances, true);
    assert.equal(cash.balanceSheet.balances, true);
    assert.equal(accrual.cashFlow.matchesCash, true);
    assert.equal(accrual.cashFlow.endingCents, accrual.cashFlow.cashAccountsCents);
    assert.equal(accrual.cashFlow.endingCents, 45750);
    assert.equal(accrual.chart.months.find((month) => month.month === 5).revenueCents, accrual.profitAndLoss.incomeCents);
    assert.equal(JSON.stringify(accrual).includes("12.5%"), false);
    assert.equal(accrual.metrics.revenueChange, null);

    const april = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Apr 1 – Apr 30")}&basis=accrual`)).json();
    const aprilCash = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Apr 1 – Apr 30")}&basis=cash`)).json();
    assert.equal(april.profitAndLoss.netIncomeCents, -10000);
    assert.equal(aprilCash.profitAndLoss.netIncomeCents, 0);
    assert.notEqual(april.metrics.netIncomeCents, accrual.metrics.netIncomeCents);
    assert.equal(april.metrics.revenueCents, april.profitAndLoss.incomeCents);

    const yearToDate = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Year to date")}&basis=accrual`)).json();
    const books = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(books.trialBalance.foots, true);
    assert.equal(yearToDate.profitAndLoss.netIncomeCents, yearToDate.currentYearEarningsCents);
    assert.equal(yearToDate.profitAndLoss.netIncomeCents, earningsFromTrialBalance(books));
    assert.equal(yearToDate.balanceSheet.balances, true);
    assert.equal(yearToDate.cashFlow.endingCents, yearToDate.cashFlow.cashAccountsCents);

    const csv = statementCsv(yearToDate, "profit-and-loss");
    assert.match(csv, /Service revenue/);
    assert.match(csv, /Net income/);
    assert.doesNotMatch(csv, /exported as PDF/);

    await olivia.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: haven.id }),
    });
    const other = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Year to date")}&basis=accrual`)).json();
    assert.equal(other.profitAndLoss.netIncomeCents, 0);
    assert.equal(other.balanceSheet.balances, true);
    assert.equal(JSON.stringify(other).includes("Service revenue"), false);
    const hidden = await olivia.fetch(`${base}/api/statements?clientId=${signedIn.client.id}`);
    assert.equal(hidden.status, 404);
  });
});

test("reports and dashboard metrics are not the published statement", () => {
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const reports = readFileSync(new URL("../src/Reports.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /\$6,800\.00/);
  assert.doesNotMatch(shell, /\$18,740\.00/);
  assert.match(shell, /Stripe Payments/);
  assert.doesNotMatch(shell, /\$84,240\.00/);
  assert.doesNotMatch(shell, /\$128,430\.62/);
  assert.doesNotMatch(shell, /12\.5%/);
  assert.doesNotMatch(reports, /\$76,240/);
  assert.doesNotMatch(reports, /exported as PDF/);
  assert.match(reports, /disabled/);
});
