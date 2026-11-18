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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-tax-intel-"));
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

test("mappings, adjustments, and exports reconcile to the books", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const cash = accountId(ledger, "1000");
    const income = accountId(ledger, "4000");
    const office = accountId(ledger, "6400");
    const draws = accountId(ledger, "3100");

    const revenue = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-02-02",
      memo: "February service",
      lines: [
        { accountId: cash, debit: "100.00", credit: "" },
        { accountId: income, debit: "", credit: "100.00" },
      ],
    });
    assert.equal(revenue.response.status, 201, revenue.body.error);
    const meal = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-02-03",
      memo: "February office",
      lines: [
        { accountId: office, debit: "40.00", credit: "" },
        { accountId: cash, debit: "", credit: "40.00" },
      ],
    });
    assert.equal(meal.response.status, 201, meal.body.error);
    const draw = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-02-04",
      memo: "Owner draw",
      lines: [
        { accountId: draws, debit: "10.00", credit: "" },
        { accountId: cash, debit: "", credit: "10.00" },
      ],
    });
    assert.equal(draw.response.status, 201, draw.body.error);

    const missing = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/profile`, {
      year: 2026,
      entityType: "sole_proprietor",
      filingStatus: "unset",
      otherWages: "0.00",
    });
    assert.equal(missing.response.status, 200, missing.body.error);
    assert.equal(missing.body.estimate.status, "missing");
    assert.equal(missing.body.estimate.totalCents, null);
    assert.equal(missing.body.yearToDate.netCents, 6000);
    assert.equal(missing.body.mappings.some((row) => row.code === "3100" && row.lineKey === "owner_draw" && row.taxCents === 0), true);

    const noReason = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/mappings`, {
      year: 2026,
      accountId: office,
      lineKey: "meals",
      deductiblePercent: 50,
    });
    assert.equal(noReason.response.status, 400);
    const mapped = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/mappings`, {
      year: 2026,
      accountId: office,
      lineKey: "meals",
      deductiblePercent: 50,
      reason: "Client meals are partly deductible.",
    });
    assert.equal(mapped.response.status, 200, mapped.body.error);
    assert.equal(mapped.body.yearToDate.taxProfitCents, 8000);
    assert.equal(mapped.body.yearToDate.taxProfitCents - mapped.body.yearToDate.netCents, 2000);

    const adjustment = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/adjustments`, {
      year: 2026,
      label: "Extra tax depreciation",
      bookAmount: "0.00",
      taxAmount: "15.00",
      reason: "Tax depreciation is higher than book.",
      status: "accepted",
    });
    assert.equal(adjustment.response.status, 200, adjustment.body.error);
    assert.equal(adjustment.body.yearToDate.taxProfitCents, 8000 - 1500);

    const profile = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/profile`, {
      year: 2026,
      entityType: "sole_proprietor",
      filingStatus: "single",
      otherWages: "0.00",
    });
    assert.equal(profile.response.status, 200, profile.body.error);
    assert.equal(profile.body.estimate.status, "calculated");
    assert.equal(profile.body.estimate.filesReturn, false);
    assert.equal(profile.body.estimate.transmits, false);
    assert.equal(profile.body.estimate.quarters.reduce((sum, quarter) => sum + quarter.amountCents, 0), profile.body.estimate.totalCents);

    const csvResponse = await olivia.fetch(`${base}/api/tax-intel/${creative.id}/workpaper.csv?year=2026`);
    const csv = await csvResponse.text();
    assert.equal(csvResponse.status, 200);
    assert.match(csv, /reconciliation,tax_profit,6000,6500/);
    assert.match(csv, /6400 .* meals,4000,2000/);
    const pdf = await (await olivia.fetch(`${base}/api/tax-intel/${creative.id}/workpaper.pdf?year=2026`)).text();
    assert.equal(pdf.startsWith("%PDF"), true);

    const firm = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(typeof firm.tax.counts.ready, "number");
    assert.equal(JSON.stringify(firm).includes("$"), false);
    const notReady = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/review`, {
      year: 2026,
      note: "Books are clear enough to review.",
    });
    assert.equal(notReady.response.status, 400);

    const corporation = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/profile`, {
      year: 2026,
      entityType: "corporation",
      filingStatus: "unset",
    });
    assert.equal(corporation.response.status, 200, corporation.body.error);
    assert.equal(corporation.body.estimate.status, "unsupported");
    assert.equal(corporation.body.estimate.totalCents, null);
    assert.equal(corporation.body.status, "unsupported");
  });
});

test("tax planning stays inside the firm, and a clear future year can be marked ready", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const staffProfile = await sendJson(sam, base, "POST", `/api/tax-intel/${creative.id}/profile`, {
      year: 2027,
      entityType: "sole_proprietor",
      filingStatus: "single",
      otherWages: "0.00",
    });
    assert.equal(staffProfile.response.status, 403);
    const saved = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/profile`, {
      year: 2027,
      entityType: "sole_proprietor",
      filingStatus: "single",
      otherWages: "0.00",
    });
    assert.equal(saved.response.status, 200, saved.body.error);
    assert.equal(saved.body.eligible, true);
    const staffReady = await sendJson(sam, base, "POST", `/api/tax-intel/${creative.id}/review`, {
      year: 2027,
      note: "Sam should not sign this review.",
    });
    assert.equal(staffReady.response.status, 403);
    const ready = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/review`, {
      year: 2027,
      note: "No open items for this future year.",
    });
    assert.equal(ready.response.status, 200, ready.body.error);
    assert.equal(ready.body.status, "ready");

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const hidden = await jordan.fetch(`${base}/api/tax-intel/${creative.id}?year=2027`);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes(creative.id), false);
    const harbor = await (await jordan.fetch(`${base}/api/tax-intel?year=2027`)).json();
    assert.equal(JSON.stringify(harbor).includes("Northstar Creative"), false);

    const roster = await (await olivia.fetch(`${base}/api/session`)).json();
    const samId = roster.members.find((member) => member.email === "sam@northstarcreative.co").id;
    const granted = await sendJson(olivia, base, "POST", "/api/client-grants", {
      userId: samId,
      access: "selected",
      clientIds: [haven.id],
    });
    assert.equal(granted.response.status, 200, granted.body.error);
    const limited = cookieJar();
    await signIn(limited, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    assert.equal((await limited.fetch(`${base}/api/tax-intel/${creative.id}?year=2027`)).status, 404);
    const board = await (await limited.fetch(`${base}/api/tax-intel?year=2027`)).json();
    assert.deepEqual(board.clients.map((client) => client.name), ["Haven Coffee Roasters"]);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    assert.equal((await casey.fetch(`${base}/api/tax-intel`)).status, 404);
  });
});

test("a flagged line and an uncategorized line become one task each until they are cleared", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    const bankId = account.body.accounts[0].id;
    const penalty = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: "2026-03-03",
      description: "Parking penalty",
      amount: "-12.00",
    });
    const openLine = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: bankId,
      postedOn: "2026-03-04",
      description: "Uncoded supply",
      amount: "-8.00",
    });
    assert.equal(penalty.response.status, 201, penalty.body.error);
    const office = penalty.body.accounts.find((row) => row.code === "6400");
    const coded = await sendJson(olivia, base, "POST", `/api/transactions/${penalty.body.transaction.id}/categorize`, { accountId: office.id });
    assert.equal(coded.response.status, 200, coded.body.error);
    const profile = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/profile`, {
      year: 2026,
      entityType: "sole_proprietor",
      filingStatus: "single",
      otherWages: "0.00",
    });
    assert.equal(profile.body.flags.some((flag) => flag.description === "Parking penalty"), true);
    const first = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const uncategorized = first.tasks.filter((task) => task.sourceType === "tax_issue" && task.sourceId.endsWith(":2026:uncategorized"));
    assert.equal(uncategorized.length, 1);
    assert.equal(uncategorized[0].target.screen, "Tax Planning");
    const second = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(second.tasks.find((task) => task.sourceType === "tax_issue" && task.sourceId.endsWith(":2026:uncategorized")).id, uncategorized[0].id);

    const reviewed = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/flags`, {
      year: 2026,
      transactionId: penalty.body.transaction.id,
      reason: "The penalty is not deductible.",
    });
    assert.equal(reviewed.response.status, 200, reviewed.body.error);
    assert.equal(reviewed.body.flags.some((flag) => flag.description === "Parking penalty"), false);
    const revenue = openLine.body.accounts.find((row) => row.code === "6400");
    const categorized = await sendJson(olivia, base, "POST", `/api/transactions/${openLine.body.transaction.id}/categorize`, { accountId: revenue.id });
    assert.equal(categorized.response.status, 200, categorized.body.error);
    const cleared = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(cleared.tasks.find((task) => task.id === uncategorized[0].id).status, "completed");

    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const cash = ledger.accounts.find((row) => row.code === "1000").id;
    const service = ledger.accounts.find((row) => row.code === "4000").id;
    const posted = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-03-05",
      memo: "Planning income",
      lines: [
        { accountId: cash, debit: "20000.00", credit: "" },
        { accountId: service, debit: "", credit: "20000.00" },
      ],
    });
    assert.equal(posted.response.status, 201, posted.body.error);
    const scenario = await sendJson(olivia, base, "POST", `/api/tax-intel/${creative.id}/scenario`, {
      year: 2026,
      incomeChange: "0.00",
      expenseChange: "0.00",
      retirementAmount: "100.00",
      retirementKind: "sep",
      depreciationAmount: "500.00",
    });
    assert.equal(scenario.response.status, 200, scenario.body.error);
    assert.equal(scenario.body.filesReturn, false);
    assert.equal(scenario.body.scenario.selfEmploymentTaxCents < scenario.body.base.selfEmploymentTaxCents, true);
    assert.match(scenario.body.retirement.note, /does not reduce self-employment tax/);
    assert.match(scenario.body.depreciation.note, /does not post to the books/);
  });
});
