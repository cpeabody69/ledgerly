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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-time-"));
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

test("two staff log time, firm-wide roles can open it, and a draft invoice matches the hours", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.client.name, "Northstar Creative");
    const empty = await (await olivia.fetch(`${base}/api/time`)).json();
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.viewer.firmWide, true);
    assert.ok(empty.staff.some((person) => person.userId === signedIn.user.id && person.role === "owner" && person.title));
    assert.equal(JSON.stringify(empty).includes("%"), false);

    const work = await sendJson(olivia, base, "POST", "/api/work", {
      clientId: signedIn.client.id,
      name: "Monthly close",
      hourlyRate: "100.00",
    });
    assert.equal(work.response.status, 201);
    assert.equal(work.body.work.hourlyRateCents, 10000);

    for (const member of [
      ["Sam Lee", "sam@northstarcreative.co", "staff"],
      ["Riley Chen", "riley@northstarcreative.co", "staff"],
      ["Morgan Hale", "morgan@northstarcreative.co", "manager"],
    ]) {
      const invited = await sendJson(olivia, base, "POST", "/api/members", {
        name: member[0],
        email: member[1],
        role: member[2],
        password: "ledgerly-staff",
      });
      assert.equal(invited.response.status, 201);
    }

    const sam = cookieJar();
    const samSession = await signIn(sam, base, { email: "sam@northstarcreative.co", password: "ledgerly-staff" });
    assert.equal(samSession.user.role, "staff");
    const riley = cookieJar();
    await signIn(riley, base, { email: "riley@northstarcreative.co", password: "ledgerly-staff" });
    const morgan = cookieJar();
    const morganSession = await signIn(morgan, base, { email: "morgan@northstarcreative.co", password: "ledgerly-staff" });
    assert.equal(morganSession.user.role, "manager");

    const rejectedHours = await sendJson(sam, base, "POST", "/api/time", {
      clientId: signedIn.client.id,
      workId: work.body.work.id,
      workedOn: "2026-05-12",
      hours: 2,
    });
    assert.equal(rejectedHours.response.status, 400);

    const samTime = await sendJson(sam, base, "POST", "/api/time", {
      clientId: signedIn.client.id,
      workId: work.body.work.id,
      workedOn: "2026-05-12",
      hours: "2.00",
      note: "Bank rec",
    });
    assert.equal(samTime.response.status, 201);
    assert.equal(samTime.body.entry.amountCents, 20000);
    assert.equal(samTime.body.entry.personName, "Sam Lee");
    assert.equal(samTime.body.entry.billed, false);

    const samExtra = await sendJson(sam, base, "POST", "/api/time", {
      clientId: signedIn.client.id,
      workId: work.body.work.id,
      workedOn: "2026-05-13",
      hours: "1.00",
      note: "Leave this off the invoice",
    });
    assert.equal(samExtra.response.status, 201);

    const rileyTime = await sendJson(riley, base, "POST", "/api/time", {
      clientId: signedIn.client.id,
      workId: work.body.work.id,
      workedOn: "2026-05-14",
      hours: "1.50",
      note: "Schedules",
    });
    assert.equal(rileyTime.response.status, 201);
    assert.equal(rileyTime.body.entry.amountCents, 15000);

    const samList = await (await sam.fetch(`${base}/api/time`)).json();
    assert.equal(samList.viewer.firmWide, false);
    assert.equal(samList.entries.length, 2);
    assert.equal(JSON.stringify(samList.entries).includes("Riley Chen"), false);
    assert.equal(samList.byClient[0].clientName, "Northstar Creative");
    assert.equal(samList.byClient[0].hours, "3.00");
    const hidden = await sam.fetch(`${base}/api/time/${rileyTime.body.entry.id}`);
    assert.equal(hidden.status, 404);

    const opened = await morgan.fetch(`${base}/api/time/${samTime.body.entry.id}`);
    assert.equal(opened.status, 200);
    const openedBody = await opened.json();
    assert.equal(openedBody.entry.personName, "Sam Lee");
    assert.equal(openedBody.entry.hours, "2.00");
    const ownerOpen = await olivia.fetch(`${base}/api/time/${rileyTime.body.entry.id}`);
    assert.equal(ownerOpen.status, 200);

    const firm = await (await olivia.fetch(`${base}/api/time`)).json();
    assert.equal(firm.entries.length, 3);
    assert.equal(firm.byClient[0].hours, "4.50");
    assert.equal(firm.byClient[0].amountCents, 45000);
    assert.deepEqual(firm.byClient[0].people.slice().sort(), ["Riley Chen", "Sam Lee"]);
    assert.ok(firm.staff.some((person) => person.name === "Sam Lee" && person.role === "staff" && person.title === "Staff"));
    assert.equal(JSON.stringify(firm).includes("utilization"), false);

    const before = await (await olivia.fetch(`${base}/api/ledger`)).json();
    const drafted = await sendJson(olivia, base, "POST", "/api/time/invoice", {
      entryIds: [samTime.body.entry.id, rileyTime.body.entry.id],
      issueDate: "2026-05-15",
      dueDate: "2026-05-29",
    });
    assert.equal(drafted.response.status, 201);
    assert.equal(drafted.body.invoice.status, "draft");
    assert.equal(drafted.body.invoice.totalCents, 35000);
    assert.equal(drafted.body.invoice.lines.length, 2);
    assert.equal(drafted.body.amountCents, 35000);
    const afterDraft = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(afterDraft.entries.length, before.entries.length);
    const listed = await (await olivia.fetch(`${base}/api/invoices`)).json();
    assert.equal(listed.invoices.length, 1);
    assert.equal(listed.invoices[0].status, "draft");
    assert.equal(listed.metrics.outstandingCents, 0);
    const billed = await (await olivia.fetch(`${base}/api/time`)).json();
    const invoiced = billed.entries.filter((entry) => entry.invoiceNumber === drafted.body.invoice.number);
    assert.equal(invoiced.length, 2);
    assert.equal(billed.entries.find((entry) => entry.id === samExtra.body.entry.id).billed, false);

    const sent = await sendJson(olivia, base, "POST", `/api/invoices/${drafted.body.invoice.id}/send`);
    assert.equal(sent.response.status, 200);
    assert.equal(sent.body.invoice.status, "sent");
    const books = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(books.entries.length, before.entries.length + 1);
    const receivable = books.trialBalance.rows.find((row) => row.code === "1100");
    const income = books.trialBalance.rows.find((row) => row.code === "4000");
    assert.equal(receivable.debitCents, 35000);
    assert.equal(income.creditCents, 35000);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const outside = await (await harbor.fetch(`${base}/api/time`)).json();
    assert.equal(JSON.stringify(outside).includes("Sam Lee"), false);
    assert.equal(JSON.stringify(outside).includes("Monthly close"), false);
    const outsideOne = await harbor.fetch(`${base}/api/time/${samTime.body.entry.id}`);
    assert.equal(outsideOne.status, 404);
  });
});

test("the time screen does not invent utilization or post wages", () => {
  const time = readFileSync(new URL("../src/Time.jsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(time, /utilization/i);
  assert.doesNotMatch(time, /payroll/i);
  assert.match(time, /Wages are not posted/);
  assert.match(time, /Create invoice from selected time/);
  assert.doesNotMatch(time, /Overview|Activity|Rules/);
  assert.match(shell, /e === `Time`/);
});
