import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-access-"));
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
  const body = await response.json();
  assert.equal(response.status, 200, body.error || "sign in");
  return body;
}

async function sendJson(jar, base, method, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {}, text };
}

test("owners read the audit log and other firms cannot", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const cash = (await (await olivia.fetch(`${base}/api/ledger`)).json()).accounts.find((account) => account.code === "1000");
    const revenue = (await (await olivia.fetch(`${base}/api/ledger`)).json()).accounts.find((account) => account.code === "4000");
    const posted = await sendJson(olivia, base, "POST", "/api/journal-entries", {
      entryDate: "2026-11-03",
      memo: "Sample service income",
      lines: [
        { accountId: cash.id, debit: "25.00", credit: "" },
        { accountId: revenue.id, debit: "", credit: "25.00" },
      ],
    });
    assert.equal(posted.response.status, 201, posted.body.error);

    const audit = await sendJson(olivia, base, "GET", "/api/audit");
    assert.equal(audit.response.status, 200);
    const entry = audit.body.events.find((event) => event.action === "journal.posted" && event.entityId === posted.body.entry.id);
    assert.ok(entry);
    assert.equal(entry.actorName, "Olivia Martin");
    assert.equal(entry.clientName, signedIn.client.name);
    assert.equal(entry.entityType, "journal_entry");
    assert.match(entry.createdAtLabel, /ET$/);
    assert.equal(audit.body.events.some((event) => event.detail && event.detail.includes("sk_")), false);

    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const hidden = await sendJson(sam, base, "GET", "/api/audit");
    assert.equal(hidden.response.status, 403);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const foreign = await sendJson(jordan, base, "GET", "/api/audit");
    assert.equal(foreign.response.status, 200);
    assert.equal(JSON.stringify(foreign.body).includes(posted.body.entry.id), false);
    assert.equal(JSON.stringify(foreign.body).includes("Sample service income"), false);

    const northstarClient = signedIn.client.id;
    for (const path of [
      `/api/clients/${northstarClient}`,
      `/api/ledger?clientId=${northstarClient}`,
      `/api/statements?clientId=${northstarClient}`,
      `/api/transactions?clientId=${northstarClient}`,
      `/api/banking?clientId=${northstarClient}`,
      `/api/invoices`,
      `/api/expenses`,
      `/api/payables?clientId=${northstarClient}`,
      `/api/documents?clientId=${northstarClient}`,
      `/api/tasks`,
    ]) {
      const response = await jordan.fetch(`${base}${path}`);
      if (path.endsWith("/invoices") || path.endsWith("/expenses") || path.endsWith("/tasks")) {
        const body = await response.json();
        assert.equal(JSON.stringify(body).includes(posted.body.entry.id), false, path);
        assert.equal(JSON.stringify(body).includes("Northstar Creative"), false, path);
      } else {
        assert.equal(response.status, 404, path);
      }
    }
    const harborAudit = await sendJson(jordan, base, "GET", "/api/audit?action=access.denied");
    assert.equal(harborAudit.body.events.some((event) => event.detail === "Cross-firm client access was rejected."), true);
    assert.equal(harborAudit.body.events.every((event) => event.clientId === ""), true);
  });
});

test("client grants limit financial records, documents, and the work queue", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const creative = signedIn.client;
    const samMember = signedIn.members.find((member) => member.email === "sam@northstarcreative.co");

    const locked = await sendJson(olivia, base, "POST", "/api/client-grants", {
      userId: signedIn.user.id,
      access: "selected",
      clientIds: [haven.id],
    });
    assert.equal(locked.response.status, 400);

    const granted = await sendJson(olivia, base, "POST", "/api/client-grants", {
      userId: samMember.id,
      access: "selected",
      clientIds: [haven.id],
    });
    assert.equal(granted.response.status, 200, granted.body.error);
    assert.equal(granted.body.members.find((member) => member.id === samMember.id).access, "selected");

    const stored = await sendJson(olivia, base, "POST", "/api/documents", {
      clientId: creative.id,
      name: "creative-note.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("fictional creative note").toString("base64"),
    });
    assert.equal(stored.response.status, 201, stored.body.error);
    await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Creative only task",
      clientId: creative.id,
      assigneeId: samMember.id,
      dueOn: "2026-11-30",
    });

    const sam = cookieJar();
    const samSession = await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    assert.equal(samSession.client.name, "Haven Coffee Roasters");
    assert.deepEqual(samSession.clients.map((client) => client.name), ["Haven Coffee Roasters"]);

    const switched = await sendJson(sam, base, "PATCH", "/api/session", { clientId: creative.id });
    assert.equal(switched.response.status, 404);
    const profile = await sam.fetch(`${base}/api/clients/${creative.id}`);
    assert.equal(profile.status, 404);
    const ledger = await sam.fetch(`${base}/api/ledger?clientId=${creative.id}`);
    assert.equal(ledger.status, 404);
    const statements = await sam.fetch(`${base}/api/statements?clientId=${creative.id}`);
    assert.equal(statements.status, 404);
    const transactions = await sam.fetch(`${base}/api/transactions?clientId=${creative.id}`);
    assert.equal(transactions.status, 404);
    const file = await sam.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(file.status, 404);
    const documents = await (await sam.fetch(`${base}/api/documents`)).json();
    assert.equal(JSON.stringify(documents).includes("creative-note.txt"), false);
    const tasks = await (await sam.fetch(`${base}/api/tasks`)).json();
    assert.equal(JSON.stringify(tasks).includes("Creative only task"), false);
    const firmList = await (await sam.fetch(`${base}/api/clients`)).json();
    assert.deepEqual(firmList.clients.map((client) => client.name), ["Haven Coffee Roasters"]);

    const stillOwner = await (await olivia.fetch(`${base}/api/session`)).json();
    assert.equal(stillOwner.clients.length, 4);
    const ownerAudit = await (await olivia.fetch(`${base}/api/audit?action=access.granted`)).json();
    assert.match(ownerAudit.events[0].detail, /limited Sam Lee to Haven Coffee Roasters/);

    const sums = new DatabaseSync(dbPath, { readOnly: true }).prepare(
      "SELECT SUM(debit_cents) AS debit, SUM(credit_cents) AS credit FROM journal_lines",
    ).get();
    assert.equal(Number(sums.debit || 0), Number(sums.credit || 0));
  });
});

test("roles keep bill approval, expenses, and the team queue on the server", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const seats = await sendJson(olivia, base, "PATCH", "/api/subscription", { seatLimit: 12 });
    assert.equal(seats.response.status, 200, seats.body.error);
    const invited = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Blair Books",
      email: "blair@northstarcreative.co",
      role: "bookkeeper",
      password: "ledgerly-book-1",
    });
    assert.equal(invited.response.status, 201, invited.body.error);
    const adminInvite = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Ada Admin",
      email: "ada@northstarcreative.co",
      role: "administrator",
      password: "ledgerly-admin-1",
    });
    assert.equal(adminInvite.response.status, 201, adminInvite.body.error);
    const readonlyInvite = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Robin Read",
      email: "robin@northstarcreative.co",
      role: "readonly",
      password: "ledgerly-role-1",
    });
    assert.equal(readonlyInvite.response.status, 201, readonlyInvite.body.error);

    const blair = cookieJar();
    await signIn(blair, base, { email: "blair@northstarcreative.co", password: "ledgerly-book-1" });
    const expense = await sendJson(blair, base, "POST", "/api/expenses", {
      vendor: "Fictional Paper",
      spentOn: "2026-11-04",
      kind: "paid",
      amount: "18.00",
      accountCode: "6400",
    });
    assert.equal(expense.response.status, 201, expense.body.error);
    const approve = await blair.fetch(`${base}/api/payables/bills/missing/approve`, { method: "POST" });
    assert.equal(approve.status, 403);

    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const staffApprove = await sam.fetch(`${base}/api/payables/bills/missing/approve`, { method: "POST" });
    assert.equal(staffApprove.status, 403);
    const staffInvite = await sendJson(sam, base, "POST", "/api/members", {
      name: "Extra",
      email: "extra@northstarcreative.co",
      role: "staff",
      password: "ledgerly-extra-1",
    });
    assert.equal(staffInvite.response.status, 403);
    const grants = await sendJson(sam, base, "GET", "/api/client-grants");
    assert.equal(grants.response.status, 403);

    const ada = cookieJar();
    await signIn(ada, base, { email: "ada@northstarcreative.co", password: "ledgerly-admin-1" });
    const queue = await (await ada.fetch(`${base}/api/tasks`)).json();
    assert.equal(queue.scopeLabel, "Team Tasks");
    const adaClients = await (await ada.fetch(`${base}/api/session`)).json();
    assert.equal(adaClients.clients.length, 4);

    const robin = cookieJar();
    await signIn(robin, base, { email: "robin@northstarcreative.co", password: "ledgerly-role-1" });
    const ledger = await (await robin.fetch(`${base}/api/ledger`)).json();
    const blocked = await sendJson(robin, base, "POST", "/api/journal-entries", {
      entryDate: "2026-11-04",
      memo: "Should not post",
      lines: [
        { accountId: ledger.accounts.find((account) => account.code === "1000").id, debit: "5.00", credit: "" },
        { accountId: ledger.accounts.find((account) => account.code === "4000").id, debit: "", credit: "5.00" },
      ],
    });
    assert.equal(blocked.response.status, 403);
    const denial = await (await olivia.fetch(`${base}/api/audit?action=access.denied`)).json();
    assert.equal(denial.events.some((event) => event.actorName === "Robin Read"), true);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const sums = db.prepare("SELECT SUM(debit_cents) AS debit, SUM(credit_cents) AS credit FROM journal_lines").get();
    db.close();
    assert.equal(Number(sums.debit), Number(sums.credit));
    assert.equal(Number(sums.debit) > 0, true);
  });
});
