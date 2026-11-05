import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
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

function quoteName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Unexpected table.");
  return name;
}

function payingFirmSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const firms = db.prepare("SELECT id, name FROM firms WHERE demo = 0 ORDER BY name").all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const snapshot = {};
    for (const firm of firms) {
      const counts = {};
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info(${quoteName(table.name)})`).all();
        if (!columns.some((column) => column.name === "firm_id")) continue;
        counts[table.name] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteName(table.name)} WHERE firm_id = ?`).get(firm.id).count);
      }
      snapshot[firm.name] = {
        id: firm.id,
        counts,
        clients: db.prepare("SELECT name FROM clients WHERE firm_id = ? ORDER BY position, name").all(firm.id).map((row) => row.name),
        users: db.prepare("SELECT email FROM users WHERE firm_id = ? ORDER BY email").all(firm.id).map((row) => row.email),
      };
    }
    return snapshot;
  } finally {
    db.close();
  }
}

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-demo-"));
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
  assert.equal(response.status, 200);
  return response.json();
}

async function json(jar, base, path, options) {
  const response = await jar.fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function containsDemo(body) {
  const text = JSON.stringify(body);
  return ["Northwind Studio", "Market Lane Goods", "Fieldline Repairs", "avery@ledgerly-demo.example", "ledgerly-demo"].some((needle) => text.includes(needle));
}

test("demo books balance, checks are stored, and reset leaves other firms alone", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.firm.name, "Northstar");
    assert.equal(signedIn.firm.demo, false);
    assert.equal(signedIn.client.name, "Northstar Creative");
    const northstarClients = signedIn.clients.map((client) => client.name);
    const northstarClientId = signedIn.client.id;
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
    assert.equal(harbor.firm.demo, false);
    assert.equal(harbor.client.name, "Cedar & Pine Goods");
    const harborClients = harbor.clients.map((client) => client.name);
    const payingBefore = payingFirmSnapshot(dbPath);

    for (const [method, path] of [["GET", "/api/demo"], ["POST", "/api/demo/reset"], ["POST", "/api/demo/checks"]]) {
      const blocked = await json(olivia, base, path, method === "POST" ? { method } : undefined);
      assert.equal(blocked.response.status, 404);
      assert.equal(containsDemo(blocked.body), false);
    }
    assert.deepEqual(payingFirmSnapshot(dbPath), payingBefore);

    const avery = cookieJar();
    const demoSession = await signIn(avery, base, { email: "avery@ledgerly-demo.example", password: "ledgerly-demo" });
    assert.equal(demoSession.firm.name, "Avenue Demo (fictional)");
    assert.equal(demoSession.firm.demo, true);
    assert.equal(demoSession.clients.length, 3);
    assert.match(demoSession.client.name, /fictional/i);
    assert.equal(demoSession.clients.some((client) => northstarClients.includes(client.name) || harborClients.includes(client.name)), false);
    assert.equal(demoSession.members.some((member) => member.email === firms.northstar.owner.email), false);
    assert.deepEqual(payingFirmSnapshot(dbPath), payingBefore);

    const stillOlivia = await json(olivia, base, "/api/session");
    assert.equal(stillOlivia.body.firm.name, "Northstar");
    assert.equal(stillOlivia.body.firm.demo, false);
    assert.equal(stillOlivia.body.client.name, "Northstar Creative");
    assert.deepEqual(stillOlivia.body.clients.map((client) => client.name), northstarClients);
    assert.equal(stillOlivia.body.members.some((member) => member.email === "avery@ledgerly-demo.example"), false);
    const afterLedger = await json(olivia, base, "/api/ledger");
    assert.equal(afterLedger.body.entries.length, beforeEntries);
    assert.equal(afterLedger.body.entries.some((entry) => entry.memo === "Northstar stays outside the demo"), true);
    assert.equal(afterLedger.body.entries.some((entry) => /fictional/i.test(entry.memo)), false);

    const refusedReset = await json(olivia, base, "/api/demo/reset", { method: "POST" });
    assert.equal(refusedReset.response.status, 404);
    assert.equal(containsDemo(refusedReset.body), false);
    assert.deepEqual(payingFirmSnapshot(dbPath), payingBefore);
    const demoClients = await json(avery, base, "/api/clients");
    assert.equal(demoClients.body.clients.length, 3);
    const demoClientId = demoClients.body.clients[0].id;
    const northstarList = await json(olivia, base, "/api/clients");
    assert.equal(northstarList.body.clients.some((client) => /fictional/i.test(client.name)), false);
    assert.equal(demoClients.body.clients.some((client) => client.name === "Northstar Creative" || client.name === "Cedar & Pine Goods"), false);

    const demoTasks = await json(avery, base, "/api/tasks");
    const northstarTasks = await json(olivia, base, "/api/tasks");
    assert.ok(demoTasks.body.tasks.length > 0);
    assert.equal(JSON.stringify(northstarTasks.body).includes("Northwind Studio"), false);
    assert.equal(JSON.stringify(demoTasks.body).includes("Northstar Creative"), false);
    assert.equal(JSON.stringify(demoTasks.body).includes("Cedar & Pine"), false);

    const demoFiles = await json(avery, base, "/api/documents");
    const northstarFiles = await json(olivia, base, "/api/documents");
    assert.ok(demoFiles.body.files.length > 0);
    assert.equal(JSON.stringify(northstarFiles.body).includes("fictional"), false);
    assert.equal(JSON.stringify(demoFiles.body).includes("Northstar"), false);
    const hiddenFile = await json(olivia, base, `/api/documents/${demoFiles.body.files[0].id}`);
    assert.equal(hiddenFile.response.status, 404);
    const hiddenClient = await json(olivia, base, `/api/clients/${demoClientId}`);
    assert.equal(hiddenClient.response.status, 404);
    assert.equal(JSON.stringify(hiddenClient.body).includes("Northwind"), false);
    const hiddenSwitch = await json(olivia, base, "/api/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: demoClientId }),
    });
    assert.equal(hiddenSwitch.response.status, 404);
    const oliviaStays = await json(olivia, base, "/api/session");
    assert.equal(oliviaStays.body.client.id, northstarClientId);
    const demoSwitch = await json(avery, base, "/api/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: northstarClientId }),
    });
    assert.equal(demoSwitch.response.status, 404);
    const averyStays = await json(avery, base, "/api/session");
    assert.equal(averyStays.body.firm.demo, true);
    assert.notEqual(averyStays.body.client.id, northstarClientId);

    const harborAgain = await json(jordan, base, "/api/session");
    assert.equal(harborAgain.body.firm.name, "Harbor Street Advisors");
    assert.equal(harborAgain.body.firm.demo, false);
    assert.deepEqual(harborAgain.body.clients.map((client) => client.name), harborClients);

    const page = await json(avery, base, "/api/demo");
    assert.equal(page.response.status, 200);
    assert.equal(page.body.scenarioCount, 3);
    assert.equal(JSON.stringify(page.body).toLowerCase().includes("compliant"), false);
    assert.equal(page.body.liveBank, false);
    const models = new Set(page.body.scenarios.map((scenario) => scenario.model));
    assert.equal(models.size, 3);
    for (const scenario of page.body.scenarios) {
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
    assert.ok(page.body.sources.uncategorized_group >= 3);
    assert.ok(page.body.sources.bill >= 3);
    assert.ok(page.body.sources.invoice >= 3);
    assert.ok(page.body.sources.document_request >= 3);
    assert.equal(page.body.duplicateSources, 0);
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

    const payingAtChecks = payingFirmSnapshot(dbPath);
    assert.deepEqual(payingAtChecks, payingBefore);
    const restored = await json(avery, base, "/api/demo/reset", { method: "POST" });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.session.firm.name, "Avenue Demo (fictional)");
    assert.equal(restored.body.session.firm.demo, true);
    assert.equal(restored.body.scenarioCount, 3);
    assert.equal(restored.body.lastResult, null);
    assert.deepEqual(payingFirmSnapshot(dbPath), payingBefore);
    const stillAvery = await json(avery, base, "/api/session");
    assert.equal(stillAvery.body.user.email, "avery@ledgerly-demo.example");
    assert.equal(stillAvery.body.firm.demo, true);
    assert.equal(stillAvery.body.clients.length, 3);
    assert.equal(stillAvery.body.clients.some((client) => client.id === demoClientId), false);
    const northstarAfter = await json(olivia, base, "/api/ledger");
    assert.equal(northstarAfter.body.entries.some((entry) => entry.memo === "Northstar stays outside the demo"), true);
    assert.equal(northstarAfter.body.entries.length, beforeEntries);
    const oldDemoClient = await json(avery, base, `/api/clients/${demoClientId}`);
    assert.equal(oldDemoClient.response.status, 404);

    await json(olivia, base, "/api/session", { method: "DELETE" });
    const oliviaAgain = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(oliviaAgain.firm.demo, false);
    assert.equal(oliviaAgain.firm.name, "Northstar");
    assert.equal(oliviaAgain.client.name, "Northstar Creative");
    assert.equal(oliviaAgain.clients.some((client) => /fictional/i.test(client.name)), false);
    await json(avery, base, "/api/session", { method: "DELETE" });
    const averyAgain = await signIn(avery, base, { email: "avery@ledgerly-demo.example", password: "ledgerly-demo" });
    assert.equal(averyAgain.firm.demo, true);
    assert.equal(averyAgain.firm.name, "Avenue Demo (fictional)");
    assert.match(averyAgain.client.name, /fictional/i);
    assert.equal(averyAgain.clients.some((client) => client.name === "Northstar Creative" || client.name === "Cedar & Pine Goods"), false);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const hidden = await json(casey, base, "/api/demo");
    assert.equal(hidden.response.status, 404);
    assert.equal(JSON.stringify(hidden.body).includes("Northwind Studio"), false);
  });
});
