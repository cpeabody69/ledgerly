import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { firms } from "./accounts.js";
import { CHART } from "./chart.js";
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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-crm-"));
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
  return response.json();
}

async function sendJson(jar, base, method, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

test("an individual and a business keep separate profiles inside one firm", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const sam = signedIn.members.find((member) => member.email === "sam@northstarcreative.co");
    assert.equal(signedIn.clients.some((client) => client.name === "Haven Coffee Roasters"), true);
    assert.equal(signedIn.clients.some((client) => client.name === "Brightline Labs"), true);
    assert.equal(signedIn.clients.some((client) => client.name === "Mason & Finch"), true);

    const rejected = await sendJson(olivia, base, "POST", "/api/clients", {
      name: "Rejected Person",
      clientKind: "individual",
      taxId: "123-45-6789",
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(JSON.stringify(rejected.body).includes("123-45-6789"), false);

    const individual = await sendJson(olivia, base, "POST", "/api/clients", {
      name: "Alder Quinn",
      legalName: "Alder Quinn",
      clientKind: "individual",
      contactName: "Alder Quinn",
      contactEmail: "alder@example.test",
      contactPhone: "555-0100",
      address: "9 Fictional Lane",
      services: ["advisory"],
      assignedUserId: signedIn.user.id,
      teamUserIds: [sam.id],
      status: "active",
      notes: "Fictional individual.",
    });
    assert.equal(individual.response.status, 201, individual.body.error);
    assert.equal(individual.body.client.taxId, undefined);

    const business = await sendJson(olivia, base, "POST", "/api/clients", {
      name: "Birch Advisory",
      legalName: "Birch Advisory LLC",
      clientKind: "business",
      businessType: "LLC",
      taxId: "12-3456789",
      services: ["bookkeeping", "tax"],
      status: "onboarding",
      contactName: "Blair Birch",
    });
    assert.equal(business.response.status, 201, business.body.error);
    assert.equal(business.body.client.taxId, undefined);

    const listed = await (await olivia.fetch(`${base}/api/clients?q=Alder`)).json();
    assert.equal(listed.clients.length, 1);
    assert.equal(listed.clients[0].clientKind, "individual");
    assert.equal(listed.clients[0].businessType, "");
    assert.equal(JSON.stringify(listed).includes("12-3456789"), false);
    assert.equal(JSON.stringify(listed).includes("123-45-6789"), false);
    const individuals = await (await olivia.fetch(`${base}/api/clients?kind=individual`)).json();
    assert.deepEqual(individuals.clients.map((client) => client.name), ["Alder Quinn"]);
    const bookkeeping = await (await olivia.fetch(`${base}/api/clients?service=bookkeeping&sort=name`)).json();
    assert.deepEqual(bookkeeping.clients.map((client) => client.name), ["Birch Advisory"]);
    const onboarding = await (await olivia.fetch(`${base}/api/clients?status=onboarding`)).json();
    assert.equal(onboarding.clients.some((client) => client.name === "Birch Advisory"), true);
    assert.equal(onboarding.clients.some((client) => client.name === "Northstar Creative"), false);
    const byName = await (await olivia.fetch(`${base}/api/clients?q=Alder&sort=name`)).json();
    assert.deepEqual(byName.clients.map((client) => client.name), ["Alder Quinn"]);

    const detail = await (await olivia.fetch(`${base}/api/clients/${individual.body.client.id}`)).json();
    assert.equal(detail.client.taxId, "");
    assert.equal(detail.client.contactEmail, "alder@example.test");
    assert.equal(detail.client.serviceLabels.includes("Advisory"), true);
    assert.equal(detail.client.team.some((member) => member.id === sam.id), true);
    assert.equal(detail.client.team.some((member) => member.id === signedIn.user.id), true);
    assert.equal(detail.client.noteHistory.some((note) => note.body === "Fictional individual."), true);
    const noted = await sendJson(olivia, base, "POST", `/api/clients/${individual.body.client.id}/notes`, { body: "Called the fictional contact." });
    assert.equal(noted.response.status, 200, noted.body.error);
    assert.equal(noted.body.client.noteHistory.some((note) => note.body === "Called the fictional contact."), true);

    const birch = await (await olivia.fetch(`${base}/api/clients/${business.body.client.id}`)).json();
    assert.equal(birch.client.taxId, "12-3456789");
    assert.equal(birch.client.clientKind, "business");
    assert.equal(birch.client.businessType, "LLC");
    assert.equal(birch.client.status, "onboarding");

    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: individual.body.client.id });
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(ledger.client.name, "Alder Quinn");
    assert.equal(ledger.entries.length, 0);
    assert.equal(ledger.accounts.length, CHART.length);
    assert.equal(ledger.foots, true);
    assert.equal(ledger.cards.assetsCents, 0);
    const statements = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(statements.client.name, "Alder Quinn");
    assert.equal(statements.profitAndLoss.netIncomeCents, 0);

    const task = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Alder estimated tax reminder",
      clientId: individual.body.client.id,
      assigneeId: signedIn.user.id,
      dueOn: "2026-01-15",
    });
    assert.equal(task.response.status, 201, task.body.error);
    const request = await sendJson(olivia, base, "POST", "/api/document-requests", {
      clientId: individual.body.client.id,
      title: "Alder fictional organizer",
      dueOn: "2026-11-20",
    });
    assert.equal(request.response.status, 201, request.body.error);
    const overview = await (await olivia.fetch(`${base}/api/clients/${individual.body.client.id}`)).json();
    assert.equal(overview.client.deadlines.some((item) => item.title === "Alder estimated tax reminder"), true);
    assert.equal(overview.client.deadlines.some((item) => item.title === "Alder fictional organizer"), true);
    assert.equal(overview.client.documentRequests.outstanding.some((item) => item.title === "Alder fictional organizer"), true);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await harbor.fetch(`${base}/api/clients/${individual.body.client.id}`);
    assert.equal(hidden.status, 404);
    const hiddenFirm = await (await harbor.fetch(`${base}/api/firm`)).json();
    assert.equal(JSON.stringify(hiddenFirm).includes("Alder Quinn"), false);
    assert.equal(JSON.stringify(hiddenFirm).includes("Birch Advisory"), false);
    assert.equal(JSON.stringify(hiddenFirm).includes("12-3456789"), false);

    const granted = await sendJson(olivia, base, "POST", "/api/client-grants", {
      userId: sam.id,
      access: "selected",
      clientIds: [individual.body.client.id],
    });
    assert.equal(granted.response.status, 200, granted.body.error);
    const samJar = cookieJar();
    const samSession = await signIn(samJar, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    assert.deepEqual(samSession.clients.map((client) => client.name), ["Alder Quinn"]);
    const samOverview = await samJar.fetch(`${base}/api/clients/${business.body.client.id}`);
    assert.equal(samOverview.status, 404);
    const samFirm = await (await samJar.fetch(`${base}/api/firm`)).json();
    assert.deepEqual(samFirm.clients.map((client) => client.name), ["Alder Quinn"]);
    assert.equal(JSON.stringify(samFirm).includes("Birch Advisory"), false);
    assert.equal(JSON.stringify(samFirm).includes("Northstar Creative"), false);
    const samNote = await sendJson(samJar, base, "POST", `/api/clients/${business.body.client.id}/notes`, { body: "Should not save." });
    assert.equal(samNote.response.status, 404);
  });
});

test("the firm dashboard counts authorized records and leaves client statements alone", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const creative = signedIn.client;
    assert.equal(creative.name, "Northstar Creative");
    const before = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(before.firm.name, "Northstar");
    assert.equal(before.counts.activeClients >= 4, true);
    assert.equal(JSON.stringify(before).includes("$"), false);

    const onboarding = await sendJson(olivia, base, "POST", "/api/clients", {
      name: "Cedar Onboarding",
      clientKind: "business",
      status: "onboarding",
    });
    assert.equal(onboarding.response.status, 201, onboarding.body.error);
    const overdue = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Cedar overdue close",
      clientId: onboarding.body.client.id,
      dueOn: "2026-01-02",
    });
    assert.equal(overdue.response.status, 201, overdue.body.error);
    const upcoming = await sendJson(olivia, base, "POST", "/api/document-requests", {
      clientId: creative.id,
      title: "Creative fictional statements",
      dueOn: "2026-11-25",
    });
    assert.equal(upcoming.response.status, 201, upcoming.body.error);

    const home = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(home.counts.onboardingClients, before.counts.onboardingClients + 1);
    assert.equal(home.counts.openTasks >= before.counts.openTasks + 1, true);
    assert.equal(home.counts.overdueTasks, before.counts.overdueTasks + 1);
    assert.equal(home.counts.outstandingRequests, before.counts.outstandingRequests + 1);
    assert.equal(home.deadlines.some((item) => item.title === "Creative fictional statements"), true);
    assert.equal(home.workload.some((member) => member.userId === signedIn.user.id), true);
    assert.equal(home.activity.some((event) => event.clientName === "Cedar Onboarding" || event.action === "client.created"), true);
    assert.equal(home.bookkeeping.clients, home.counts.activeClients + home.counts.onboardingClients);
    const reviewBefore = home.bookkeeping.needingReview;

    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    assert.equal(account.response.status, 201, account.body.error);
    const line = await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-20",
      description: "Uncoded creative deposit",
      amount: "40.00",
    });
    assert.equal(line.response.status, 201, line.body.error);
    const waiting = await (await olivia.fetch(`${base}/api/firm`)).json();
    const waitingClient = waiting.bookkeeping.needingReviewClients.find((client) => client.id === creative.id);
    assert.equal(waitingClient.uncategorized, 1);
    assert.equal(waiting.bookkeeping.needingReview >= reviewBefore, true);

    const revenue = line.body.accounts.find((item) => item.code === "4000");
    const categorized = await sendJson(olivia, base, "POST", `/api/transactions/${line.body.transaction.id}/categorize`, { accountId: revenue.id });
    assert.equal(categorized.response.status, 200, categorized.body.error);
    const afterReview = await (await olivia.fetch(`${base}/api/firm`)).json();
    const reviewed = afterReview.bookkeeping.needingReviewClients.find((client) => client.id === creative.id);
    assert.equal(reviewed ? reviewed.uncategorized : 0, 0);

    const quiet = await sendJson(olivia, base, "POST", "/api/clients", {
      name: "Quiet Books",
      clientKind: "individual",
      status: "active",
    });
    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: quiet.body.client.id });
    const quietStatements = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Year to date")}&basis=accrual`)).json();
    assert.equal(quietStatements.client.name, "Quiet Books");
    assert.equal(quietStatements.profitAndLoss.netIncomeCents, 0);
    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: creative.id });
    const creativeStatements = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Year to date")}&basis=accrual`)).json();
    assert.equal(creativeStatements.client.name, "Northstar Creative");
    assert.notEqual(creativeStatements.profitAndLoss.netIncomeCents, quietStatements.profitAndLoss.netIncomeCents);

    const books = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const cash = books.accounts.find((row) => row.code === "1000").id;
    const income = books.accounts.find((row) => row.code === "4000").id;
    const entry = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-05-12",
      memo: "Creative stays on its own books",
      lines: [
        { accountId: cash, debit: "10.00", credit: "" },
        { accountId: income, debit: "", credit: "10.00" },
      ],
    });
    assert.equal(entry.response.status, 201, entry.body.error);
    const archived = await sendJson(olivia, base, "POST", `/api/clients/${onboarding.body.client.id}/archive`, {});
    assert.equal(archived.response.status, 200);
    const session = await (await olivia.fetch(`${base}/api/session`)).json();
    assert.equal(session.clients.some((client) => client.name === "Cedar Onboarding"), false);
    const still = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(still.entries.some((row) => row.memo === "Creative stays on its own books"), true);
    assert.equal(still.foots, true);
  });
});

test("the firm home and client screens do not publish sample counts", () => {
  const firm = readFileSync(new URL("../src/FirmHome.jsx", import.meta.url), "utf8");
  const clients = readFileSync(new URL("../src/Clients.jsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(firm, /\$84\.2k/);
  assert.doesNotMatch(firm, /<b>18<\/b>/);
  assert.match(firm, /\/api\/firm/);
  assert.match(clients, /Search clients/);
  assert.match(clients, /Add client/);
  assert.match(shell, /Firm/);
  assert.match(shell, /Dashboard/);
});
