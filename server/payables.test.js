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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-payables-"));
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

function billInput(vendorId, accountId, extra = {}) {
  return {
    vendorId,
    invoiceNumber: "HP-1044",
    billDate: "2026-05-12",
    dueDate: "2026-05-20",
    notes: "Paper stock for the studio.",
    lines: [{ description: "Cover stock", accountId, amount: "8.00", tax: "2.00" }],
    ...extra,
  };
}

test("a payable stays off the books until it is posted, and another firm cannot see the vendor", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.client.name, "Northstar Creative");

    const empty = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(empty.vendors.length, 0);
    assert.equal(empty.bills.length, 0);
    assert.equal(empty.dashboard.outstanding.count, 0);
    assert.equal(empty.dashboard.awaitingApproval.count, 0);
    assert.equal(empty.dashboard.overdue.count, 0);
    assert.equal(empty.dashboard.dueThisWeek.count, 0);
    const office = empty.accounts.find((account) => account.code === "6400");
    const equipment = empty.accounts.find((account) => account.code === "1500");
    assert.equal(office.type, "expense");
    assert.equal(equipment.type, "asset");

    const vendor = await sendJson(olivia, base, "POST", "/api/payables/vendors", {
      name: "Harbor Paper Co.",
      contactName: "Ned Alvarez",
      address: "18 Dock Street, Portland",
      email: "ned@harborpaper.example",
      phone: "503-555-0144",
      terms: "Net 30",
      defaultAccountId: office.id,
      notes: "Fictional paper vendor.",
    });
    assert.equal(vendor.response.status, 201);
    assert.equal(vendor.body.vendor.outstandingCents, 0);
    assert.deepEqual(vendor.body.vendor.payments, []);
    assert.deepEqual(vendor.body.vendor.invoiceHistory, []);

    const created = await sendJson(olivia, base, "POST", "/api/payables/bills", billInput(vendor.body.vendor.id, office.id));
    assert.equal(created.response.status, 201);
    assert.equal(created.body.bill.status, "draft");
    assert.equal(created.body.bill.totalCents, 1000);
    assert.equal(created.body.bill.taxCents, 200);
    assert.equal(created.body.bill.journalEntryId, null);

    const duplicate = await sendJson(olivia, base, "POST", "/api/payables/bills", billInput(vendor.body.vendor.id, equipment.id, {
      invoiceNumber: "hp-1044",
    }));
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.duplicate.id, created.body.bill.id);
    assert.equal(duplicate.body.error.includes("same invoice number"), true);
    const stillOne = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(stillOne.bills.length, 1);

    const quietLedger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(quietLedger.entries.length, 0);
    const quietBooks = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(quietBooks.profitAndLoss.expenseCents, 0);
    assert.equal(quietBooks.balanceSheet.balances, true);

    const submitted = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/submit`);
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body.bill.status, "awaiting_approval");
    const waiting = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(waiting.dashboard.awaitingApproval.count, 1);
    assert.equal(waiting.dashboard.awaitingApproval.cents, 1000);
    assert.equal(waiting.dashboard.outstanding.count, 0);
    const stillQuiet = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(stillQuiet.entries.length, 0);

    const pendingPost = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, {});
    assert.equal(pendingPost.response.status, 400);
    const approved = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/approve`);
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.bill.status, "approved");
    assert.equal(approved.body.bill.approvals.some((row) => row.action === "approved" && row.actorName === "Olivia Martin"), true);
    const approvedLedger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(approvedLedger.entries.length, 0);

    const unbalanced = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, { total: "1.00" });
    assert.equal(unbalanced.response.status, 400);
    assert.equal(unbalanced.body.error, "Debits and credits must be equal.");
    const rejected = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(rejected.entries.length, 0);
    assert.equal(rejected.trialBalance.debitsCents, rejected.trialBalance.creditsCents);

    const posted = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, {});
    assert.equal(posted.response.status, 200);
    assert.equal(posted.body.bill.status, "posted");
    assert.equal(posted.body.entry.debitCents, posted.body.entry.creditCents);
    assert.equal(posted.body.entry.debitCents, 1000);
    const locked = await sendJson(olivia, base, "PATCH", `/api/payables/bills/${created.body.bill.id}`, billInput(vendor.body.vendor.id, office.id, {
      invoiceNumber: "HP-1045",
    }));
    assert.equal(locked.response.status, 400);

    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.foots, true);
    assert.equal(ledger.trialBalance.debitsCents, ledger.trialBalance.creditsCents);
    assert.equal(ledger.trialBalance.debitsCents, 1000);
    const may = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(may.profitAndLoss.expenseCents, 1000);
    assert.equal(may.profitAndLoss.expenseRows.find((row) => row.code === "6400").cents, 1000);
    assert.equal(may.balanceSheet.liabilities.find((row) => row.code === "2000").cents, 1000);
    assert.equal(may.balanceSheet.balances, true);
    assert.equal(may.balanceSheet.assetsCents, may.balanceSheet.liabilitiesCents + may.balanceSheet.equityCents);
    const openBooks = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(openBooks.dashboard.outstanding.cents, 1000);
    assert.equal(openBooks.dashboard.overdue.count, 1);
    assert.equal(openBooks.dashboard.awaitingApproval.count, 0);
    assert.equal(openBooks.dashboard.dueThisWeek.count, 0);
    const withHistory = openBooks.vendors.find((row) => row.id === vendor.body.vendor.id);
    assert.equal(withHistory.invoiceHistory.length, 1);
    assert.equal(withHistory.outstandingCents, 1000);
    assert.deepEqual(withHistory.payments, []);

    const haven = signedIn.clients.find((client) => client.name === "Haven Coffee Roasters");
    const switched = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
    assert.equal(switched.response.status, 200);
    const otherClient = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(otherClient.vendors.length, 0);
    assert.equal(otherClient.bills.length, 0);
    await sendJson(olivia, base, "PATCH", "/api/session", { clientId: signedIn.client.id });

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await (await harbor.fetch(`${base}/api/payables`)).json();
    assert.equal(hidden.vendors.length, 0);
    assert.equal(JSON.stringify(hidden).includes("Harbor Paper"), false);
    const hiddenVendor = await sendJson(harbor, base, "PATCH", `/api/payables/vendors/${vendor.body.vendor.id}`, { name: "Taken" });
    assert.equal(hiddenVendor.response.status, 404);
    const hiddenBill = await sendJson(harbor, base, "POST", `/api/payables/bills/${created.body.bill.id}/void`);
    assert.equal(hiddenBill.response.status, 404);

    const voided = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/void`);
    assert.equal(voided.response.status, 200);
    assert.equal(voided.body.bill.status, "void");
    assert.equal(voided.body.bill.invoiceNumber, "HP-1044");
    const kept = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(kept.bills.length, 1);
    assert.equal(kept.dashboard.outstanding.count, 0);
    const year = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("Year to date")}&basis=accrual`)).json();
    assert.equal(year.balanceSheet.balances, true);
    assert.equal(year.balanceSheet.liabilities.some((row) => row.code === "2000"), false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const audits = db.prepare("SELECT action, entity_id FROM audit_events WHERE entity_id = ?").all(created.body.bill.id);
    assert.equal(audits.some((row) => row.action === "bill.voided"), true);
    assert.equal(audits.some((row) => row.action === "bill.posted"), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ap_bills").get().count, 1);
    db.close();
  });
});

test("staff cannot approve a bill, and a partial payment stays inside the firm", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const books = await (await olivia.fetch(`${base}/api/payables`)).json();
    const office = books.accounts.find((account) => account.code === "6400");
    const cash = books.cashAccounts.find((account) => account.code === "1000");
    assert.equal(books.canApprove, true);
    const vendor = await sendJson(olivia, base, "POST", "/api/payables/vendors", { name: "Northwind Paper" });
    const created = await sendJson(olivia, base, "POST", "/api/payables/bills", billInput(vendor.body.vendor.id, office.id, {
      invoiceNumber: "NW-20",
    }));
    const submitted = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/submit`);
    assert.equal(submitted.response.status, 200);

    const invited = await sendJson(olivia, base, "POST", "/api/members", {
      name: "Sam Rivera",
      email: "sam.payables@northstarcreative.co",
      role: "staff",
      password: "ledgerly-staff",
    });
    assert.equal(invited.response.status, 201);
    const staff = cookieJar();
    const staffSignIn = await signIn(staff, base, { email: "sam.payables@northstarcreative.co", password: "ledgerly-staff" });
    assert.equal(staffSignIn.user.role, "staff");
    assert.equal(staffSignIn.client.id, signedIn.client.id);
    const staffBooks = await (await staff.fetch(`${base}/api/payables`)).json();
    assert.equal(staffBooks.canApprove, false);
    const staffApprove = await sendJson(staff, base, "POST", `/api/payables/bills/${created.body.bill.id}/approve`);
    assert.equal(staffApprove.response.status, 403);
    const staffReject = await sendJson(staff, base, "POST", `/api/payables/bills/${created.body.bill.id}/reject`, { note: "No" });
    assert.equal(staffReject.response.status, 403);
    const staffPost = await sendJson(staff, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, {});
    assert.equal(staffPost.response.status, 403);
    const untouched = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(untouched.entries.length, 0);

    const other = await sendJson(olivia, base, "POST", "/api/payables/bills", billInput(vendor.body.vendor.id, office.id, {
      invoiceNumber: "NW-21",
      lines: [{ description: "Rejected stock", accountId: office.id, amount: "5.00", tax: "0.00" }],
    }));
    await sendJson(olivia, base, "POST", `/api/payables/bills/${other.body.bill.id}/submit`);
    const rejected = await sendJson(olivia, base, "POST", `/api/payables/bills/${other.body.bill.id}/reject`, { note: "Not our order." });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.bill.status, "rejected");
    assert.equal(rejected.body.bill.approvals.some((row) => row.action === "rejected" && row.actorName === "Olivia Martin"), true);
    const rejectedPost = await sendJson(olivia, base, "POST", `/api/payables/bills/${other.body.bill.id}/post`, {});
    assert.equal(rejectedPost.response.status, 400);
    assert.equal(rejectedPost.body.error, "A rejected bill does not post.");

    const approved = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/approve`);
    assert.equal(approved.response.status, 200);
    const staffApprovedPost = await sendJson(staff, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, {});
    assert.equal(staffApprovedPost.response.status, 403);
    const posted = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, {});
    assert.equal(posted.response.status, 200);
    assert.equal(posted.body.entry.debitCents, posted.body.entry.creditCents);

    const partial = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/payments`, {
      paidOn: "2026-05-18",
      amount: "4.00",
      reference: "CHK-14",
      accountId: cash.id,
    });
    assert.equal(partial.response.status, 201);
    assert.equal(partial.body.entry.debitCents, partial.body.entry.creditCents);
    assert.equal(partial.body.entry.debitCents, 400);
    assert.equal(partial.body.bill.openCents, 600);
    const afterPartial = await (await olivia.fetch(`${base}/api/payables`)).json();
    const vendorRow = afterPartial.vendors.find((row) => row.id === vendor.body.vendor.id);
    assert.equal(vendorRow.outstandingCents, 600);
    assert.equal(vendorRow.payments.length, 1);
    assert.equal(vendorRow.payments[0].reference, "CHK-14");
    const ledger = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(ledger.foots, true);
    assert.equal(ledger.trialBalance.debitsCents, ledger.trialBalance.creditsCents);
    const may = await (await olivia.fetch(`${base}/api/statements?period=${encodeURIComponent("May 1 – May 31")}&basis=accrual`)).json();
    assert.equal(may.balanceSheet.liabilities.find((row) => row.code === "2000").cents, 600);
    assert.equal(may.balanceSheet.balances, true);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await (await harbor.fetch(`${base}/api/payables`)).json();
    assert.equal(hidden.payments.length, 0);
    assert.equal(JSON.stringify(hidden).includes("CHK-14"), false);
    const hiddenPayment = await sendJson(harbor, base, "POST", `/api/payables/payments/${partial.body.payment.id}/void`);
    assert.equal(hiddenPayment.response.status, 404);

    const rest = await sendJson(olivia, base, "POST", `/api/payables/bills/${created.body.bill.id}/payments`, {
      paidOn: "2026-05-19",
      amount: "6.00",
      reference: "CHK-15",
      accountId: cash.id,
    });
    assert.equal(rest.response.status, 201);
    const cleared = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(cleared.vendors.find((row) => row.id === vendor.body.vendor.id).outstandingCents, 0);
    assert.equal(cleared.dashboard.outstanding.count, 0);

    const voided = await sendJson(olivia, base, "POST", `/api/payables/payments/${partial.body.payment.id}/void`);
    assert.equal(voided.response.status, 200);
    assert.equal(voided.body.payment.status, "void");
    const restored = await (await olivia.fetch(`${base}/api/payables`)).json();
    assert.equal(restored.vendors.find((row) => row.id === vendor.body.vendor.id).outstandingCents, 400);
    const footed = await (await olivia.fetch(`${base}/api/ledger`)).json();
    assert.equal(footed.foots, true);
    assert.equal(footed.trialBalance.debitsCents, footed.trialBalance.creditsCents);
  });
});

function isoToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function shiftDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function postOpenBill(jar, base, vendorId, accountId, extra) {
  const created = await sendJson(jar, base, "POST", "/api/payables/bills", billInput(vendorId, accountId, extra));
  assert.equal(created.response.status, 201);
  const submitted = await sendJson(jar, base, "POST", `/api/payables/bills/${created.body.bill.id}/submit`);
  assert.equal(submitted.response.status, 200);
  const approved = await sendJson(jar, base, "POST", `/api/payables/bills/${created.body.bill.id}/approve`);
  assert.equal(approved.response.status, 200);
  const posted = await sendJson(jar, base, "POST", `/api/payables/bills/${created.body.bill.id}/post`, {});
  assert.equal(posted.response.status, 200);
  return posted.body.bill;
}

test("aging groups open bills by due date and unpaid balance", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const books = await (await olivia.fetch(`${base}/api/payables`)).json();
    const office = books.accounts.find((account) => account.code === "6400");
    const cash = books.cashAccounts.find((account) => account.code === "1000");
    const today = isoToday();
    const future = await sendJson(olivia, base, "POST", "/api/payables/vendors", { name: "Future Supply" });
    const late = await sendJson(olivia, base, "POST", "/api/payables/vendors", { name: "Late Supply" });
    const currentBill = await postOpenBill(olivia, base, future.body.vendor.id, office.id, {
      invoiceNumber: "FS-1",
      billDate: today,
      dueDate: shiftDays(today, 12),
    });
    const agedDue = shiftDays(today, -45);
    const agedBill = await postOpenBill(olivia, base, late.body.vendor.id, office.id, {
      invoiceNumber: "LS-45",
      billDate: agedDue,
      dueDate: agedDue,
    });
    const draft = await sendJson(olivia, base, "POST", "/api/payables/bills", billInput(late.body.vendor.id, office.id, {
      invoiceNumber: "LS-DRAFT",
      billDate: today,
      dueDate: today,
      lines: [{ description: "Not posted", accountId: office.id, amount: "50.00", tax: "0.00" }],
    }));
    assert.equal(draft.response.status, 201);

    const before = await (await olivia.fetch(`${base}/api/payables`)).json();
    const current = before.aging.buckets.find((bucket) => bucket.id === "current");
    const mid = before.aging.buckets.find((bucket) => bucket.id === "days31to60");
    assert.equal(before.aging.bills?.length, undefined);
    assert.equal(current.cents, 1000);
    assert.equal(before.aging.vendors.find((vendor) => vendor.vendorName === "Future Supply").bills[0].id, currentBill.id);
    assert.equal(mid.cents, 1000);
    assert.equal(before.aging.vendors.find((vendor) => vendor.vendorName === "Late Supply").bills[0].id, agedBill.id);
    const beforeSum = before.aging.buckets.reduce((sum, bucket) => sum + bucket.cents, 0);
    assert.equal(beforeSum, before.aging.outstandingCents);
    assert.equal(beforeSum, before.dashboard.outstanding.cents);
    assert.equal(JSON.stringify(before.aging).includes("50.00"), false);

    const partial = await sendJson(olivia, base, "POST", `/api/payables/bills/${agedBill.id}/payments`, {
      paidOn: today,
      amount: "4.00",
      reference: "AGE-4",
      accountId: cash.id,
    });
    assert.equal(partial.response.status, 201);
    const after = await (await olivia.fetch(`${base}/api/payables`)).json();
    const reduced = after.aging.buckets.find((bucket) => bucket.id === "days31to60");
    assert.equal(reduced.cents, 600);
    assert.equal(after.aging.buckets.find((bucket) => bucket.id === "current").cents, 1000);
    assert.equal(after.aging.vendors.find((vendor) => vendor.vendorName === "Late Supply").days31to60Cents, 600);
    assert.equal(after.aging.vendors.find((vendor) => vendor.vendorName === "Late Supply").totalCents, 600);
    const afterSum = after.aging.buckets.reduce((sum, bucket) => sum + bucket.cents, 0);
    assert.equal(afterSum, after.aging.outstandingCents);
    assert.equal(afterSum, after.dashboard.outstanding.cents);
    assert.equal(afterSum, 1600);

    const csvResponse = await olivia.fetch(`${base}/api/payables/aging.csv`);
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get("content-type"), /text\/csv/);
    const csv = await csvResponse.text();
    assert.equal(csv.includes("Late Supply"), true);
    assert.equal(csv.includes("$6.00"), true);
    assert.equal(csv.includes("Future Supply"), true);
    assert.equal(csv.includes("LS-DRAFT"), false);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await (await harbor.fetch(`${base}/api/payables`)).json();
    assert.equal(hidden.aging.outstandingCents, 0);
    assert.equal(JSON.stringify(hidden.aging).includes("Late Supply"), false);
    const hiddenCsv = await (await harbor.fetch(`${base}/api/payables/aging.csv`)).text();
    assert.equal(hiddenCsv.includes("Late Supply"), false);
  });
});
