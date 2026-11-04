import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";

const organizer = Buffer.from("Ledgerly synthetic organizer\n");
const workpaper = Buffer.from("Ledgerly synthetic workpaper\n");

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-tax-"));
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
  return { response, body };
}

async function postJson(jar, base, pathname, payload) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function patchJson(jar, base, pathname, payload) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function item(body, key) {
  const found = body.items.find((row) => row.key === key);
  assert.ok(found, key);
  return found;
}

test("one uncategorized transaction and one open request stay not ready until both are resolved", async () => {
  await withServer(async (base, dbPath) => {
    const anonymous = await fetch(`${base}/api/tax`);
    assert.equal(anonymous.status, 401);

    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.body.user.name, "Olivia Martin");
    assert.equal(signedIn.body.client.name, "Northstar Creative");
    const clientId = signedIn.body.client.id;

    const account = await postJson(olivia, base, "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    assert.equal(account.response.status, 201);
    const bankAccountId = account.body.accounts[0].id;
    const created = await postJson(olivia, base, "/api/transactions", {
      bankAccountId,
      postedOn: "2026-05-12",
      description: "Tax fixture deposit",
      amount: "100.00",
    });
    assert.equal(created.response.status, 201);
    const transactionId = created.body.transaction.id;
    const revenue = created.body.accounts.find((row) => row.code === "4000");
    assert.ok(revenue);
    const request = await postJson(olivia, base, "/api/document-requests", {
      clientId,
      title: "Tax organizer",
    });
    assert.equal(request.response.status, 201);

    const open = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(open.ready, false);
    assert.equal(item(open, "uncategorized").ready, false);
    assert.match(item(open, "uncategorized").detail, /Tax fixture deposit/);
    assert.equal(item(open, "documents").ready, false);
    assert.match(item(open, "documents").detail, /Tax organizer/);
    assert.equal(item(open, "reconciliations").ready, true);
    assert.equal(item(open, "invoices").ready, true);
    assert.equal(open.requests.some((row) => row.title === "Tax organizer" && row.status === "open" && row.statusLabel === "Requested"), true);
    assert.equal(open.workflow.status, "not_started");
    assert.equal(open.events.some((row) => row.actorId === signedIn.body.user.id && row.actorName === "Olivia Martin" && row.toStatus === "not_started"), true);

    const categorizedOnly = await postJson(olivia, base, `/api/transactions/${transactionId}/categorize`, { accountId: revenue.id });
    assert.equal(categorizedOnly.response.status, 200);
    const halfway = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(item(halfway, "uncategorized").ready, true);
    assert.equal(item(halfway, "documents").ready, false);
    assert.equal(item(halfway, "reconciliations").ready, true);
    assert.equal(halfway.ready, false);

    const stored = await postJson(olivia, base, "/api/documents", {
      clientId,
      requestId: request.body.request.id,
      name: "synthetic-organizer.txt",
      mediaType: "text/plain",
      contentBase64: organizer.toString("base64"),
    });
    assert.equal(stored.response.status, 201);
    const ready = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(item(ready, "uncategorized").ready, true);
    assert.equal(item(ready, "documents").ready, true);
    assert.equal(item(ready, "reconciliations").ready, true);
    assert.equal(item(ready, "invoices").ready, true);
    assert.equal(ready.ready, true);
    assert.equal(ready.requests.find((row) => row.title === "Tax organizer").statusLabel, "In");
    const readyText = JSON.stringify(ready);
    for (const banned of ["taxable", "deduction", "balanceDue", "filed", "IRS", "tax authority"]) {
      assert.equal(readyText.toLowerCase().includes(banned.toLowerCase()), false, banned);
    }

    const blocked = await patchJson(olivia, base, "/api/tax", {
      clientId,
      status: "blocked",
      blockedReason: "Waiting on the organizer",
      assigneeId: signedIn.body.user.id,
    });
    assert.equal(blocked.response.status, 200);
    assert.equal(blocked.body.workflow.status, "blocked");
    assert.equal(blocked.body.workflow.assignee.name, "Olivia Martin");
    assert.equal(blocked.body.workflow.updatedBy.name, "Olivia Martin");
    const change = blocked.body.events.find((row) => row.toStatus === "blocked");
    assert.equal(change.actorId, signedIn.body.user.id);
    assert.equal(change.actorName, "Olivia Martin");
    assert.equal(change.fromStatus, "not_started");
    assert.equal(change.note, "Waiting on the organizer");

    const refused = await patchJson(olivia, base, "/api/tax", { clientId, status: "filed" });
    assert.equal(refused.response.status, 400);
    const stillBlocked = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(stillBlocked.workflow.status, "blocked");
    assert.equal(JSON.stringify(stillBlocked.workflow).includes("filed"), false);

    const note = await postJson(olivia, base, "/api/tax/notes", { clientId, body: "Organizer is in." });
    assert.equal(note.response.status, 200);
    assert.equal(note.body.notes.some((row) => row.body === "Organizer is in." && row.authorName === "Olivia Martin"), true);
    const paper = await postJson(olivia, base, "/api/tax/workpapers", {
      clientId,
      name: "organizer-note.txt",
      mediaType: "text/plain",
      contentBase64: workpaper.toString("base64"),
    });
    assert.equal(paper.response.status, 200);
    const storedPaper = paper.body.workpapers.find((row) => row.name === "organizer-note.txt");
    assert.equal(storedPaper.authorName, "Olivia Martin");
    const bytes = await olivia.fetch(`${base}/api/tax/workpapers/${storedPaper.id}`);
    assert.equal(bytes.status, 200);
    assert.equal(Buffer.from(await bytes.arrayBuffer()).equals(workpaper), true);

    const db = new DatabaseSync(dbPath);
    const audit = db.prepare("SELECT actor_user_id, action FROM audit_events WHERE action = 'tax.status_changed'").all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, signedIn.body.user.id);
    db.close();

    const harbor = cookieJar();
    const jordan = await signIn(harbor, base, firms.harbor.owner);
    assert.equal(jordan.response.status, 200);
    const hidden = await harbor.fetch(`${base}/api/tax?clientId=${clientId}`);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes("Tax fixture deposit"), false);

    const client = cookieJar();
    const casey = await signIn(client, base, firms.northstar.portal);
    assert.equal(casey.response.status, 200);
    for (const [pathname, method] of [
      ["/api/tax", "GET"],
      ["/api/tax", "PATCH"],
      ["/api/tax/notes", "POST"],
      ["/api/tax/workpapers", "POST"],
      [`/api/tax/workpapers/${storedPaper.id}`, "GET"],
    ]) {
      const response = await client.fetch(`${base}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ status: "blocked", body: "no" }),
      });
      assert.equal(response.status, 404, `${method} ${pathname}`);
    }

    const draft = await postJson(olivia, base, "/api/invoices", {
      customerName: "Northstar Creative",
      issueDate: "2026-05-20",
      dueDate: "2026-06-03",
      lines: [{ description: "Season draft", amount: "40.00" }],
    });
    assert.equal(draft.response.status, 201);
    const withDraft = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(item(withDraft, "invoices").ready, true);
    assert.equal(withDraft.ready, true);
    const sent = await postJson(olivia, base, `/api/invoices/${draft.body.invoice.id}/send`, {});
    assert.equal(sent.response.status, 200);
    const withSent = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(item(withSent, "invoices").ready, false);
    assert.match(item(withSent, "invoices").detail, new RegExp(draft.body.invoice.number));
    assert.equal(withSent.ready, false);
    const voided = await postJson(olivia, base, `/api/invoices/${draft.body.invoice.id}/void`, {});
    assert.equal(voided.response.status, 200);
    const afterVoid = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(item(afterVoid, "invoices").ready, true);
    assert.equal(afterVoid.ready, true);

    const reconciled = await postJson(olivia, base, "/api/reconciliations", {
      bankAccountId,
      statementDate: "2026-05-31",
      statementEnding: "100.00",
      transactionIds: [transactionId],
    });
    assert.equal(reconciled.response.status, 201);
    const followUp = await postJson(olivia, base, "/api/transactions", {
      bankAccountId,
      postedOn: "2026-06-02",
      description: "Follow-up deposit",
      amount: "25.00",
    });
    assert.equal(followUp.response.status, 201);
    const followUpCoded = await postJson(olivia, base, `/api/transactions/${followUp.body.transaction.id}/categorize`, { accountId: revenue.id });
    assert.equal(followUpCoded.response.status, 200);
    const unfinished = await (await olivia.fetch(`${base}/api/tax?clientId=${clientId}`)).json();
    assert.equal(item(unfinished, "uncategorized").ready, true);
    assert.equal(item(unfinished, "documents").ready, true);
    assert.equal(item(unfinished, "reconciliations").ready, false);
    assert.equal(item(unfinished, "reconciliations").count, 1);
    assert.equal(unfinished.ready, false);
  });
});

test("the tax screen records a person and does not file a return", () => {
  const tax = readFileSync(new URL("../src/Tax.jsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("./tax.js", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  assert.match(shell, /e === `Tax`/);
  assert.match(shell, /e === `Time`/);
  assert.match(shell, /\[`Tax`, `check`\]/);
  assert.match(tax, /Save status/);
  assert.match(tax, /Store workpaper/);
  assert.match(tax, /Not ready/);
  const source = `${tax}\n${server}`;
  for (const banned of ["taxable income", "balance due", "File return", "tax authority", "IRS", "approve a treatment", "filed"]) {
    assert.equal(source.toLowerCase().includes(banned.toLowerCase()), false, banned);
  }
});
