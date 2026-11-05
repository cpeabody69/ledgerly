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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-work-"));
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
  return { response, body: text ? JSON.parse(text) : {}, text };
}

test("work tasks persist, match the queue counts, and stay inside the firm", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.client.name, "Northstar Creative");
    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const payables = await (await olivia.fetch(`${base}/api/payables`)).json();
    const office = payables.accounts.find((account) => account.code === "6400");

    const vendor = await sendJson(olivia, base, "POST", "/api/payables/vendors", {
      name: "Harbor Paper Co.",
      defaultAccountId: office.id,
    });
    const bill = await sendJson(olivia, base, "POST", "/api/payables/bills", {
      vendorId: vendor.body.vendor.id,
      invoiceNumber: "HP-1044",
      billDate: "2026-05-12",
      dueDate: "2026-05-20",
      lines: [{ description: "Cover stock", accountId: office.id, amount: "8.00", tax: "0.00" }],
    });
    assert.equal(bill.response.status, 201);
    const submitted = await sendJson(olivia, base, "POST", `/api/payables/bills/${bill.body.bill.id}/submit`);
    assert.equal(submitted.body.bill.status, "awaiting_approval");

    const drafted = await sendJson(olivia, base, "POST", "/api/invoices", {
      customerName: "Fixture Customer",
      issueDate: "2020-01-01",
      dueDate: "2020-01-15",
      lines: [{ description: "Design work", amount: "200.00" }],
    });
    const sent = await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/send`);
    assert.equal(sent.body.invoice.overdue, true);

    const request = await sendJson(olivia, base, "POST", "/api/document-requests", {
      clientId: signedIn.client.id,
      title: "January receipts",
      dueOn: "2026-05-31",
    });
    assert.equal(request.response.status, 201);

    const account = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-20",
      description: "Uncoded studio deposit",
      amount: "80.00",
    });
    await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-21",
      description: "Second uncoded line",
      amount: "-12.00",
    });

    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
    const havenAccount = await sendJson(olivia, base, "POST", "/api/bank-accounts", { name: "Haven checking", kind: "bank" });
    await sendJson(olivia, base, "POST", "/api/transactions", {
      bankAccountId: havenAccount.body.accounts[0].id,
      postedOn: "2026-05-22",
      description: "Haven uncoded",
      amount: "15.00",
    });
    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: signedIn.client.id });

    const first = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const second = await (await olivia.fetch(`${base}/api/tasks`)).json();
    assert.equal(first.scopeLabel, "Team Tasks");
    assert.deepEqual(second.tasks.map((task) => task.id).sort(), first.tasks.map((task) => task.id).sort());
    const sourced = (queue) => queue.tasks.filter((task) => task.sourceType);
    assert.equal(sourced(first).length, 5);
    assert.equal(sourced(first).filter((task) => task.sourceType === "uncategorized_group").length, 2);
    assert.equal(sourced(first).filter((task) => task.sourceType === "bill").length, 1);
    assert.equal(sourced(first).filter((task) => task.sourceType === "invoice").length, 1);
    assert.equal(sourced(first).filter((task) => task.sourceType === "document_request").length, 1);
    assert.equal(sourced(first).some((task) => task.category === "tax"), false);
    const billTask = first.tasks.find((task) => task.sourceType === "bill");
    const invoiceTask = first.tasks.find((task) => task.sourceType === "invoice");
    const requestTask = first.tasks.find((task) => task.sourceType === "document_request");
    assert.equal(billTask.target.screen, "Accounts Payable");
    assert.equal(billTask.target.billId, bill.body.bill.id);
    assert.equal(invoiceTask.target.screen, "Invoices");
    assert.equal(invoiceTask.target.invoiceId, drafted.body.invoice.id);
    assert.equal(requestTask.target.screen, "Clients");
    assert.equal(requestTask.target.requestId, request.body.request.id);

    const note = "Internal only: do not show Casey";
    const created = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Call the studio",
      detail: "Ask about the May deposit.",
      notes: note,
      category: "general",
      priority: "high",
      dueOn: first.today,
      clientId: signedIn.client.id,
      assigneeId: signedIn.user.id,
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.task.title, "Call the studio");
    assert.equal(created.body.task.status, "open");
    const kept = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const stored = kept.tasks.find((task) => task.id === created.body.task.id);
    assert.equal(stored.notes, note);
    assert.equal(stored.assigneeName, "Olivia Martin");

    const edited = await sendJson(olivia, base, "PATCH", `/api/tasks/${stored.id}`, {
      priority: "urgent",
      status: "waiting_on_client",
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.task.priority, "urgent");
    assert.equal(edited.body.task.status, "waiting_on_client");

    const completed = await sendJson(olivia, base, "POST", `/api/tasks/${stored.id}/complete`);
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.task.status, "completed");
    assert.equal(completed.body.task.completedByName, "Olivia Martin");
    assert.ok(completed.body.task.completedAt);
    const after = await (await olivia.fetch(`${base}/api/tasks`)).json();
    const finished = after.tasks.find((task) => task.id === stored.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.completedById, signedIn.user.id);
    assert.equal(after.open, after.tasks.filter((task) => task.status === "open").length);
    assert.equal(after.overdue, after.tasks.filter((task) => task.status !== "completed" && task.dueOn && task.dueOn < after.today).length);
    assert.equal(after.dueToday, after.tasks.filter((task) => task.status !== "completed" && task.dueOn === after.today).length);
    assert.equal(after.dueThisWeek, after.tasks.filter((task) => task.status !== "completed" && task.dueOn >= after.week.start && task.dueOn <= after.week.end).length);
    assert.equal(after.waitingOnClient, after.tasks.filter((task) => task.status === "waiting_on_client").length);
    const completedDay = (value) => {
      const date = new Date(value);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    assert.equal(after.completedThisMonth, after.tasks.filter((task) => task.status === "completed" && completedDay(task.completedAt) >= after.month.start && completedDay(task.completedAt) <= after.month.end).length);
    assert.equal(after.completedThisMonth >= 1, true);

    const invited = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Sam Lee",
      email: "sam@northstarcreative.co",
      role: "staff",
      password: "ledgerly-staff",
    });
    const samId = invited.body.members.find((member) => member.email === "sam@northstarcreative.co").id;
    const assigned = await sendJson(olivia, base, "POST", "/api/tasks", {
      title: "Sam's filing",
      assigneeId: samId,
      dueOn: after.today,
    });
    await sendJson(olivia, base, "POST", "/api/tasks", { title: "Owner only queue", dueOn: after.today });
    const sam = cookieJar();
    const samSession = await signIn(sam, base, { email: "sam@northstarcreative.co", password: "ledgerly-staff" });
    assert.equal(samSession.user.role, "staff");
    const mine = await (await sam.fetch(`${base}/api/tasks`)).json();
    assert.equal(mine.scopeLabel, "My Tasks");
    assert.deepEqual(mine.tasks.map((task) => task.title), ["Sam's filing"]);
    assert.equal(JSON.stringify(mine).includes(note), false);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const foreign = await (await jordan.fetch(`${base}/api/tasks`)).json();
    assert.equal(foreign.tasks.length, 0);
    assert.equal(JSON.stringify(foreign).includes("Call the studio"), false);
    assert.equal(JSON.stringify(foreign).includes(note), false);
    const hidden = await jordan.fetch(`${base}/api/tasks/${stored.id}/complete`, { method: "POST" });
    assert.equal(hidden.status, 404);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const portalWork = await casey.fetch(`${base}/api/tasks`);
    const portalWorkText = await portalWork.text();
    assert.equal(portalWork.status, 404);
    assert.equal(portalWorkText.includes(note), false);
    const portal = await casey.fetch(`${base}/api/portal`);
    const portalText = await portal.text();
    assert.equal(portalText.includes(note), false);
  });
});
