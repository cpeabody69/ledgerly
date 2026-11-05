import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { firms } from "./accounts.js";
import { start } from "./app.js";

const COVERED = ["asset", "equity", "expense", "income", "liability", "payable", "receivable"];

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-demo-"));
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
  assert.equal(response.status, 200);
  return response.json();
}

async function json(jar, base, path, options) {
  const response = await jar.fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test("demo books balance, checks are stored, and reset leaves other firms alone", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.firm.name, "Northstar");
    const northstarClients = signedIn.clients.map((client) => client.name);
    const ledger = await json(olivia, base, "/api/ledger");
    const cash = ledger.body.accounts.find((account) => account.code === "1000").id;
    const revenue = ledger.body.accounts.find((account) => account.code === "4000").id;
    const posted = await json(olivia, base, "/api/journal-entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryDate: "2026-11-03",
        memo: "Northstar stays outside the demo",
        lines: [
          { accountId: cash, debit: "25.00", credit: "" },
          { accountId: revenue, debit: "", credit: "25.00" },
        ],
      }),
    });
    assert.equal(posted.response.status, 201);
    const beforeEntries = posted.body.ledger.entries.length;

    const jordan = cookieJar();
    const harbor = await signIn(jordan, base, firms.harbor.owner);
    const harborClients = harbor.clients.map((client) => client.name);

    const reset = await json(olivia, base, "/api/demo/reset", { method: "POST" });
    assert.equal(reset.response.status, 200);
    assert.equal(reset.body.scenarioCount, 3);
    assert.equal(JSON.stringify(reset.body).toLowerCase().includes("compliant"), false);
    assert.equal(reset.body.liveBank, false);
    const stillOlivia = await json(olivia, base, "/api/session");
    assert.equal(stillOlivia.body.firm.name, "Northstar");
    assert.deepEqual(stillOlivia.body.clients.map((client) => client.name), northstarClients);
    const afterLedger = await json(olivia, base, "/api/ledger");
    assert.equal(afterLedger.body.entries.length, beforeEntries);
    assert.equal(afterLedger.body.entries.some((entry) => entry.memo === "Northstar stays outside the demo"), true);
    const harborAgain = await json(jordan, base, "/api/session");
    assert.equal(harborAgain.body.firm.name, "Harbor Street Advisors");
    assert.deepEqual(harborAgain.body.clients.map((client) => client.name), harborClients);

    const models = new Set(reset.body.scenarios.map((scenario) => scenario.model));
    assert.equal(models.size, 3);
    for (const scenario of reset.body.scenarios) {
      assert.match(scenario.name, /fictional/i);
      assert.ok(scenario.customers >= 4);
      assert.ok(scenario.vendors >= 2);
      assert.ok(scenario.invoices >= 4);
      assert.ok(scenario.bills >= 4);
      assert.ok(scenario.expenses >= 1);
      assert.ok(scenario.reconciled >= 1);
      assert.ok(scenario.unreconciled >= 1);
      assert.ok(scenario.needsReview >= 1);
      assert.ok(scenario.openRequests >= 1);
      assert.ok(scenario.invoiceStates.paid >= 1);
      assert.ok(scenario.invoiceStates.unpaid >= 1);
      assert.ok(scenario.invoiceStates.overdue >= 1);
      assert.ok(scenario.invoiceStates.partial >= 1);
      assert.ok(scenario.billStates.paid >= 1);
      assert.ok(scenario.billStates.unpaid >= 1);
      assert.ok(scenario.billStates.overdue >= 1);
      assert.ok(scenario.billStates.partial >= 1);
      assert.ok(scenario.receivableCents > 0);
      assert.ok(scenario.payableCents > 0);
      for (const type of COVERED) assert.equal(scenario.covered.includes(type), true, `${scenario.name} ${type}`);
    }
    assert.ok(reset.body.sources.uncategorized_group >= 3);
    assert.ok(reset.body.sources.bill >= 3);
    assert.ok(reset.body.sources.invoice >= 3);
    assert.ok(reset.body.sources.document_request >= 3);
    assert.equal(reset.body.duplicateSources, 0);

    const avery = cookieJar();
    const demoSession = await signIn(avery, base, reset.body.signIn);
    assert.equal(demoSession.firm.name, "Ledgerly Demo (fictional)");
    assert.equal(demoSession.clients.length, 3);
    const beforeReport = await json(avery, base, "/api/statements?period=Year%20to%20date&basis=accrual");
    const incomeBefore = beforeReport.body.profitAndLoss.netIncomeCents;

    const checks = await json(avery, base, "/api/demo/checks", { method: "POST" });
    assert.equal(checks.response.status, 200);
    assert.equal(checks.body.lastResult.result, "pass");
    assert.equal(checks.body.lastResult.passed, true);
    assert.equal(checks.body.lastResult.checks.length, 8);
    assert.equal(checks.body.lastResult.checks.every((check) => check.passed), true);
    assert.equal(JSON.stringify(checks.body).toLowerCase().includes("compliant"), false);
    const names = checks.body.lastResult.checks.map((check) => check.name);
    for (const name of [
      "Every posted journal balances",
      "Assets equal liabilities plus equity",
      "Receivable matches open invoices",
      "Payable matches open bills",
      "A payment reduces the right balance",
      "A second bank sync does not duplicate",
      "Reports change after a post",
      "A repeated source does not add a second task",
    ]) {
      assert.equal(names.includes(name), true);
    }
    const stored = await json(avery, base, "/api/demo");
    assert.equal(stored.body.lastResult.id, checks.body.lastResult.id);
    assert.equal(stored.body.lastResult.result, "pass");
    const afterReport = await json(avery, base, "/api/statements?period=Year%20to%20date&basis=accrual");
    assert.equal(afterReport.body.profitAndLoss.netIncomeCents, incomeBefore);

    const restored = await json(avery, base, "/api/demo/reset", { method: "POST" });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.session.firm.name, "Ledgerly Demo (fictional)");
    assert.equal(restored.body.scenarioCount, 3);
    const stillAvery = await json(avery, base, "/api/session");
    assert.equal(stillAvery.body.user.email, "avery@ledgerly-demo.example");
    const northstarAfter = await json(olivia, base, "/api/ledger");
    assert.equal(northstarAfter.body.entries.some((entry) => entry.memo === "Northstar stays outside the demo"), true);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const hidden = await json(casey, base, "/api/demo");
    assert.equal(hidden.response.status, 404);
    assert.equal(JSON.stringify(hidden.body).includes("Northwind Studio"), false);
  });
});
