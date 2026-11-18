import assert from "node:assert/strict";
import { readdir, mkdtemp, rm } from "node:fs/promises";
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

function quoteName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Unexpected table.");
  return name;
}

function payingFirmSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, name FROM firms WHERE demo = 0 ORDER BY name").all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const snapshot = {};
    for (const firm of rows) {
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
      };
    }
    return snapshot;
  } finally {
    db.close();
  }
}

async function withServer(options, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-public-demo-"));
  const dbPath = path.join(dir, "practice.sqlite");
  const demoDir = path.join(dir, "public-demo");
  const running = await start(dbPath, 0, {
    publicDemoDir: demoDir,
    publicDemoTtlMs: options.ttlMs,
    publicDemoMaxLive: options.maxLive,
    rateScope: `public-demo-${dir}`,
    rateLimits: {
      "public-demo": { limit: 30, windowMs: 60 * 60 * 1000 },
      "public-demo-interest": { limit: 30, windowMs: 60 * 60 * 1000 },
      "public-demo-event": { limit: 100, windowMs: 60 * 60 * 1000 },
    },
  });
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base, dbPath, demoDir);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

async function json(jar, base, path, options) {
  const response = await jar.fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function enter(jar, base) {
  return json(jar, base, "/api/public-demo", { method: "POST" });
}

test("public demo sessions stay isolated from practice data", { timeout: 180000 }, async () => {
  await withServer({ ttlMs: 2 * 60 * 60 * 1000, maxLive: 4 }, async (base, dbPath, demoDir) => {
    const olivia = cookieJar();
    const signedIn = await json(olivia, base, "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firms.northstar.owner),
    });
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.body.firm.name, "Northstar");
    assert.equal(signedIn.body.publicDemo, false);
    const northstarClientId = signedIn.body.client.id;
    const before = payingFirmSnapshot(dbPath);

    const firstStarted = Date.now();
    const visitor = cookieJar();
    const opened = await enter(visitor, base);
    const firstMs = Date.now() - firstStarted;
    console.log(`public demo first enter ${firstMs}ms`);
    assert.equal(opened.response.status, 200);
    assert.equal(opened.body.firm.name, "Avenue Pro Demo (fictional)");
    assert.equal(opened.body.firm.demo, true);
    assert.equal(opened.body.publicDemo, true);
    assert.match(opened.body.demoNotice, /in development/i);
    assert.equal(opened.body.clients.length, 25);
    assert.equal(opened.body.members.length, 3);
    assert.equal(opened.body.members.filter((member) => member.role === "accountant").length, 2);
    assert.equal(opened.body.clients.every((client) => /fictional/i.test(client.name)), true);
    assert.equal(JSON.stringify(opened.body).includes("\"ledgerly-demo\""), false);
    assert.equal(JSON.stringify(opened.body).includes(northstarClientId), false);
    const industries = new Set(opened.body.clients.map((client) => client.industry));
    assert.ok(industries.size >= 10);

    const secondStarted = Date.now();
    const other = cookieJar();
    const second = await enter(other, base);
    const secondMs = Date.now() - secondStarted;
    console.log(`public demo second enter ${secondMs}ms`);
    assert.equal(second.response.status, 200);
    assert.ok(secondMs < 5000, `second enter took ${secondMs}ms`);
    assert.notEqual(second.body.firm.id, opened.body.firm.id);

    assert.deepEqual(payingFirmSnapshot(dbPath), before);
    const hidden = await json(olivia, base, `/api/clients/${opened.body.client.id}`);
    assert.equal(hidden.response.status, 404);
    const crossed = await json(visitor, base, "/api/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: northstarClientId }),
    });
    assert.equal(crossed.response.status, 404);

    const knownPassword = await json(visitor, base, "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "avery@ledgerly-demo.example", password: "ledgerly-demo" }),
    });
    assert.equal(knownPassword.response.status, 401);

    const renamed = await json(visitor, base, `/api/clients/${opened.body.client.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Studio (fictional)",
        legalName: "Renamed Studio (fictional)",
        industry: "Design services",
        businessType: "Sole proprietorship",
        contactName: "Fictional contact",
        contactEmail: "",
        contactPhone: "",
        address: "",
        taxId: "",
        fiscalYearStart: "January",
        accountingMethod: "accrual",
        status: "active",
        notes: "",
        clientKind: "business",
      }),
    });
    assert.equal(renamed.response.status, 200);
    const otherStill = await json(other, base, "/api/clients");
    assert.equal(otherStill.body.clients.some((client) => client.name === "Renamed Studio (fictional)"), false);
    assert.equal(otherStill.body.clients.some((client) => client.name === "Northwind Studio (fictional)"), true);

    const firmStarted = Date.now();
    const firm = await json(visitor, base, "/api/firm");
    const firmMs = Date.now() - firmStarted;
    console.log(`public demo firm dashboard ${firmMs}ms`);
    assert.equal(firm.response.status, 200);
    assert.equal(firm.body.counts.activeClients, 25);
    assert.equal(firm.body.clients.length, 25);
    assert.ok(firmMs < 8000, `firm dashboard took ${firmMs}ms`);

    const ledger = await json(visitor, base, "/api/ledger");
    assert.equal(ledger.response.status, 200);
    const cash = ledger.body.accounts.find((account) => account.code === "1000").id;
    const revenue = ledger.body.accounts.find((account) => account.code === "4000").id;
    const beforeStatements = await json(visitor, base, "/api/statements?period=Year%20to%20date&basis=accrual");
    assert.equal(beforeStatements.body.balanceSheet.balances, true);
    assert.equal(
      beforeStatements.body.balanceSheet.assetsCents,
      beforeStatements.body.balanceSheet.liabilitiesCents + beforeStatements.body.balanceSheet.equityCents,
    );
    const posted = await json(visitor, base, "/api/journal-entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryDate: "2026-11-12",
        memo: "Fictional demo adjustment",
        lines: [
          { accountId: cash, debit: "10.00", credit: "" },
          { accountId: revenue, debit: "", credit: "10.00" },
        ],
      }),
    });
    assert.equal(posted.response.status, 201);
    const afterStatements = await json(visitor, base, "/api/statements?period=Year%20to%20date&basis=accrual");
    assert.equal(afterStatements.body.balanceSheet.balances, true);
    assert.equal(afterStatements.body.profitAndLoss.netIncomeCents, beforeStatements.body.profitAndLoss.netIncomeCents + 1000);

    const bakery = opened.body.clients.find((client) => client.name === "Maple Hearth Bakery (fictional)");
    const switched = await json(visitor, base, "/api/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: bakery.id }),
    });
    assert.equal(switched.response.status, 200);
    const bakeryStatements = await json(visitor, base, "/api/statements?period=Year%20to%20date&basis=accrual");
    assert.equal(bakeryStatements.body.balanceSheet.balances, true);
    assert.ok(bakeryStatements.body.profitAndLoss.incomeCents > 0);

    await json(visitor, base, "/api/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: opened.body.client.id }),
    });
    const invoices = await json(visitor, base, "/api/invoices");
    assert.equal(invoices.response.status, 200);
    assert.ok(invoices.body.invoices.length > 0);
    const tasks = await json(visitor, base, "/api/tasks");
    assert.ok(tasks.body.tasks.length > 0);
    const completed = await json(visitor, base, `/api/tasks/${tasks.body.tasks[0].id}/complete`, { method: "POST" });
    assert.equal(completed.response.status, 200);
    const close = await json(visitor, base, "/api/close?period=2026-10");
    assert.equal(close.response.status, 200);
    assert.ok(close.body.counts.inProgress >= 1);
    assert.ok(close.body.counts.underReview >= 1);
    const tax = await json(visitor, base, "/api/tax-intel?year=2026");
    assert.equal(tax.response.status, 200);
    assert.equal(tax.body.rulesVersion, "2026.1");
    assert.equal(tax.body.counts.clients, 25);
    const sole = tax.body.clients.find((client) => client.entityType === "sole_proprietor");
    const corporation = tax.body.clients.find((client) => client.entityType === "corporation");
    assert.equal(sole.rulesVersion, "2026.1");
    assert.equal(corporation.status, "unsupported");
    const projection = await json(visitor, base, `/api/tax-intel/${sole.id}?year=2026`);
    assert.equal(projection.response.status, 200);
    assert.equal(typeof projection.body.yearToDate.incomeCents, "number");
    assert.ok(projection.body.yearToDate.incomeCents > 0);

    const files = await json(visitor, base, "/api/documents");
    assert.ok(files.body.files.length > 0);
    const upload = await json(visitor, base, "/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "note.txt", mediaType: "text/plain", contentBase64: "aGVsbG8=" }),
    });
    assert.equal(upload.response.status, 403);
    for (const path of ["/api/plaid/link-token", "/api/quickbooks/connect", "/api/subscription/checkout", "/api/members", "/api/assistant"]) {
      const blocked = await json(visitor, base, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(blocked.response.status, 403, path);
    }
    const extraClient = await json(visitor, base, "/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "One more fictional client" }),
    });
    assert.equal(extraClient.response.status, 403);

    const interest = await json(visitor, base, "/api/public-demo/interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "beta", name: "Fictional Visitor", email: "visitor.one@example.com", note: "A tour" }),
    });
    assert.equal(interest.response.status, 400);
    const accepted = await json(visitor, base, "/api/public-demo/interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "beta", name: "Fictional Visitor", email: "visitor.one@example.com", note: "A tour", acknowledged: true }),
    });
    assert.equal(accepted.response.status, 200);
    assert.match(accepted.body.message, /Nothing was emailed/);
    const practiceText = await import("node:fs/promises").then((fs) => fs.readFile(dbPath));
    assert.equal(practiceText.includes("visitor.one@example.com"), false);
    const registry = new DatabaseSync(path.join(demoDir, "registry.sqlite"), { readOnly: true });
    const saved = registry.prepare("SELECT kind, email, acknowledged_at FROM interest").all();
    const eventColumns = registry.prepare("PRAGMA table_info(events)").all().map((column) => column.name);
    registry.close();
    const stored = saved.find((row) => row.email === "visitor.one@example.com" && row.kind === "beta");
    assert.ok(stored);
    assert.ok(stored.acknowledged_at);
    assert.equal(eventColumns.includes("email"), false);

    const portal = await json(visitor, base, "/api/public-demo/portal", { method: "POST" });
    assert.equal(portal.response.status, 200);
    assert.equal(portal.body.portal, true);
    assert.equal(portal.body.publicDemo, true);
    assert.equal(portal.body.client.name, "Renamed Studio (fictional)");
    const portalLedger = await json(visitor, base, "/api/ledger");
    assert.equal(portalLedger.response.status, 404);
    const back = await json(visitor, base, "/api/public-demo/firm", { method: "POST" });
    assert.equal(back.response.status, 200);
    assert.equal(back.body.publicDemo, true);
    assert.equal(back.body.clients.length, 25);

    const restored = await json(visitor, base, "/api/public-demo/reset", { method: "POST" });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.clients.some((client) => client.name === "Northwind Studio (fictional)"), true);
    assert.equal(restored.body.clients.some((client) => client.name === "Renamed Studio (fictional)"), false);
    assert.equal(restored.body.clients.length, 25);
    const otherAfterReset = await json(other, base, "/api/clients");
    assert.equal(otherAfterReset.body.clients.some((client) => client.name === "Northwind Studio (fictional)"), true);
    assert.deepEqual(payingFirmSnapshot(dbPath), before);
    const stillOlivia = await json(olivia, base, "/api/session");
    assert.equal(stillOlivia.body.firm.name, "Northstar");
    assert.equal(stillOlivia.body.client.name, "Northstar Creative");
  });
});

test("public demo sessions expire and stay within the live limit", { timeout: 180000 }, async () => {
  await withServer({ ttlMs: 700, maxLive: 1 }, async (base, dbPath, demoDir) => {
    const before = payingFirmSnapshot(dbPath);
    const first = cookieJar();
    const opened = await enter(first, base);
    assert.equal(opened.response.status, 200);
    const blocked = await enter(cookieJar(), base);
    assert.equal(blocked.response.status, 429);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const expired = await json(first, base, "/api/session");
    assert.equal(expired.response.status, 401);
    const names = await readdir(demoDir);
    assert.equal(names.some((name) => name.endsWith(".sqlite") && name !== "template.sqlite" && name !== "registry.sqlite"), false);
    const again = await enter(cookieJar(), base);
    assert.equal(again.response.status, 200);
    assert.equal(again.body.clients.length, 25);
    assert.deepEqual(payingFirmSnapshot(dbPath), before);
  });
});
