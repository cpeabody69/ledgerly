import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { hashPassword, openDatabase } from "./db.js";

const fixture = Buffer.from("Ledgerly synthetic statement\n");

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-portal-"));
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

test("a client sees one client's requests and invoices and cannot open the books", async () => {
  await withServer(async (base) => {
    const firm = cookieJar();
    const client = cookieJar();
    const signedIn = await signIn(firm, base, firms.northstar.owner);
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.body.portal, undefined);
    assert.equal(signedIn.body.user.role, "owner");
    const brightline = signedIn.body.clients.find((row) => row.name === "Brightline Labs");
    const haven = signedIn.body.clients.find((row) => row.name === "Haven Coffee Roasters");
    assert.ok(brightline && haven);

    const switched = await firm.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: brightline.id }),
    });
    assert.equal(switched.status, 200);
    const ledgerBefore = await (await firm.fetch(`${base}/api/ledger?clientId=${brightline.id}`)).json();

    const request = await postJson(firm, base, "/api/document-requests", {
      clientId: brightline.id,
      title: "Brightline bank statement",
    });
    assert.equal(request.response.status, 201);
    const invoice = await postJson(firm, base, "/api/invoices", {
      customerName: "Brightline Labs",
      issueDate: "2026-05-15",
      dueDate: "2026-05-29",
      memo: "Portal fixture",
      lines: [{ description: "Design support", amount: "80.00" }],
    });
    assert.equal(invoice.response.status, 201);

    const havenSwitch = await firm.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: haven.id }),
    });
    assert.equal(havenSwitch.status, 200);
    const havenRequest = await postJson(firm, base, "/api/document-requests", {
      clientId: haven.id,
      title: "Haven payroll pack",
    });
    assert.equal(havenRequest.response.status, 201);
    const havenInvoice = await postJson(firm, base, "/api/invoices", {
      customerName: "Haven Coffee Roasters",
      issueDate: "2026-05-16",
      dueDate: "2026-05-30",
      lines: [{ description: "Haven only", amount: "15.00" }],
    });
    assert.equal(havenInvoice.response.status, 201);
    const havenFile = await postJson(firm, base, "/api/documents", {
      clientId: haven.id,
      name: "haven-only.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("haven only\n").toString("base64"),
    });
    assert.equal(havenFile.response.status, 201);

    const opened = await signIn(client, base, firms.northstar.portal);
    assert.equal(opened.response.status, 200);
    assert.equal(opened.body.portal, true);
    assert.equal(opened.body.user.role, "client");
    assert.equal(opened.body.user.name, "Casey Nguyen");
    assert.equal(opened.body.client.name, "Brightline Labs");
    assert.equal(opened.body.clients, undefined);
    assert.equal(opened.body.members, undefined);
    assert.equal(JSON.stringify(opened.body).includes("Haven Coffee"), false);
    assert.equal(JSON.stringify(opened.body).includes("scrypt"), false);

    const home = await (await client.fetch(`${base}/api/portal`)).json();
    assert.equal(home.requests.some((row) => row.title === "Brightline bank statement" && row.status === "open"), true);
    assert.equal(home.requests.some((row) => row.title === "Haven payroll pack"), false);
    assert.equal(home.invoices.some((row) => row.id === invoice.body.invoice.id && row.total === "$80.00"), true);
    assert.equal(home.invoices.some((row) => row.id === havenInvoice.body.invoice.id), false);
    assert.equal(JSON.stringify(home).includes("Haven"), false);

    const blocked = [
      "/api/clients",
      `/api/clients/${haven.id}`,
      `/api/clients/${brightline.id}`,
      `/api/documents?clientId=${haven.id}`,
      `/api/documents?clientId=${brightline.id}`,
      "/api/documents",
      "/api/ledger",
      `/api/ledger?clientId=${haven.id}`,
      `/api/ledger?clientId=${brightline.id}`,
      "/api/statements",
      `/api/statements?clientId=${haven.id}`,
      `/api/statements?clientId=${brightline.id}&period=2026-05&basis=accrual`,
      "/api/reports",
      "/api/banking",
      `/api/banking?clientId=${haven.id}`,
      "/api/transactions",
      `/api/transactions?clientId=${haven.id}`,
      "/api/time",
      "/api/expenses",
      "/api/invoices",
      `/api/portal?clientId=${haven.id}`,
      `/api/documents/${havenFile.body.file.id}`,
    ];
    for (const pathname of blocked) {
      const response = await client.fetch(`${base}${pathname}`);
      assert.equal(response.status, 404, pathname);
      const body = await response.text();
      assert.equal(body.includes("Haven payroll"), false, pathname);
      assert.equal(body.includes("\"entries\""), false, pathname);
    }

    const refused = [
      ["/api/session", { clientId: haven.id }, "PATCH"],
      ["/api/journal-entries", { clientId: brightline.id, entryDate: "2026-05-20", memo: "Client post", lines: [] }, "POST"],
      ["/api/expenses", { vendor: "Client", amount: "10.00" }, "POST"],
      [`/api/invoices/${invoice.body.invoice.id}/send`, {}, "POST"],
      ["/api/invoices", { customerName: "Brightline Labs", issueDate: "2026-05-20", dueDate: "2026-05-30", lines: [{ description: "No", amount: "10.00" }] }, "POST"],
      ["/api/documents", { clientId: haven.id, requestId: havenRequest.body.request.id, name: "nope.txt", mediaType: "text/plain", contentBase64: fixture.toString("base64") }, "POST"],
      ["/api/document-requests", { clientId: brightline.id, title: "Client request" }, "POST"],
      ["/api/time", { hours: "1.00" }, "POST"],
    ];
    for (const [pathname, payload, method] of refused) {
      const response = await client.fetch(`${base}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 404, `${method} ${pathname}`);
    }

    const wrongClient = await postJson(client, base, "/api/portal/files", {
      clientId: haven.id,
      requestId: request.body.request.id,
      name: "wrong-client.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(wrongClient.response.status, 404);
    const wrongRequest = await postJson(client, base, "/api/portal/files", {
      requestId: havenRequest.body.request.id,
      name: "wrong-request.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(wrongRequest.response.status, 404);

    const uploaded = await postJson(client, base, "/api/portal/files", {
      requestId: request.body.request.id,
      name: "synthetic-statement.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.body.file.name, "synthetic-statement.txt");
    assert.equal(uploaded.body.file.requestTitle, "Brightline bank statement");

    const after = await (await client.fetch(`${base}/api/portal`)).json();
    const received = after.requests.find((row) => row.id === request.body.request.id);
    assert.equal(received.status, "complete");
    assert.equal(after.files.some((row) => row.name === "synthetic-statement.txt"), true);
    const bytes = await client.fetch(`${base}/api/documents/${uploaded.body.file.id}`);
    assert.equal(bytes.status, 200);
    assert.equal(await bytes.text(), fixture.toString());

    const stillDraft = after.invoices.find((row) => row.id === invoice.body.invoice.id);
    assert.equal(stillDraft.status, "draft");

    const harbor = cookieJar();
    const other = await signIn(harbor, base, firms.harbor.portal);
    assert.equal(other.response.status, 200);
    assert.equal(other.body.client.name, "Cedar & Pine Goods");
    assert.equal(JSON.stringify(other.body).includes("Brightline"), false);
    const foreign = await harbor.fetch(`${base}/api/portal?clientId=${brightline.id}`);
    assert.equal(foreign.status, 404);
    const foreignBooks = await harbor.fetch(`${base}/api/ledger?clientId=${brightline.id}`);
    assert.equal(foreignBooks.status, 404);

    const ended = await client.fetch(`${base}/api/session`, { method: "DELETE" });
    assert.equal(ended.status, 200);
    assert.equal((await client.fetch(`${base}/api/portal`)).status, 404);

    const firmView = await (await firm.fetch(`${base}/api/clients`)).json();
    assert.equal(firmView.requests.some((row) => row.id === request.body.request.id), false);
    assert.equal(firmView.requests.some((row) => row.id === havenRequest.body.request.id && row.status === "open"), true);
    const files = await (await firm.fetch(`${base}/api/documents`)).json();
    assert.equal(files.files.some((row) => row.name === "synthetic-statement.txt" && row.clientName === "Brightline Labs"), true);

    const back = await firm.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: brightline.id }),
    });
    assert.equal(back.status, 200);
    const ledgerAfter = await (await firm.fetch(`${base}/api/ledger?clientId=${brightline.id}`)).json();
    assert.equal(ledgerAfter.entries.length, ledgerBefore.entries.length);
    const invoices = await (await firm.fetch(`${base}/api/invoices`)).json();
    assert.equal(invoices.invoices.find((row) => row.id === invoice.body.invoice.id).status, "draft");

    const invite = await postJson(firm, base, "/api/members", {
      name: "Casey Duplicate",
      email: firms.northstar.portal.email,
      role: "staff",
      password: "ledgerly-staff",
    });
    assert.equal(invite.response.status, 409);
  });
});

test("an older database keeps stored files when client access is added", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-portal-migrate-"));
  const dbPath = path.join(dir, "test.sqlite");
  const created = new DatabaseSync(dbPath);
  created.exec("PRAGMA foreign_keys = ON");
  created.exec(`
    CREATE TABLE firms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, firm_id TEXT NOT NULL REFERENCES firms(id), email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, invited_by TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE clients (
      id TEXT PRIMARY KEY, firm_id TEXT NOT NULL REFERENCES firms(id), name TEXT NOT NULL, legal_name TEXT NOT NULL,
      initials TEXT NOT NULL, industry TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE document_requests (
      id TEXT PRIMARY KEY, firm_id TEXT NOT NULL, client_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, firm_id TEXT NOT NULL REFERENCES firms(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, client_id TEXT, entity_type TEXT, entity_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE client_files (
      id TEXT PRIMARY KEY, firm_id TEXT NOT NULL REFERENCES firms(id), client_id TEXT NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL, bytes BLOB NOT NULL,
      request_id TEXT, transaction_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  created.prepare("INSERT INTO firms (id, name, created_at) VALUES (?, ?, ?)").run("firm-1", "Northstar", now);
  created.prepare(
    "INSERT INTO users (id, firm_id, email, name, role, password_hash, invited_by, created_at) VALUES (?, ?, ?, ?, 'owner', ?, NULL, ?)",
  ).run("user-1", "firm-1", "owner@northstar.test", "Owner", hashPassword("ledgerly-northstar"), now);
  created.prepare(
    "INSERT INTO clients (id, firm_id, name, legal_name, initials, industry, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("client-1", "firm-1", "Brightline Labs", "Brightline Labs", "BL", "Technology", 0, now);
  created.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("audit-1", "firm-1", "user-1", "document.stored", "client-1", "client_file", "file-1", now);
  created.prepare(
    `INSERT INTO client_files (
      id, firm_id, client_id, name, media_type, byte_size, bytes, request_id, transaction_id, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run("file-1", "firm-1", "client-1", "kept.txt", "text/plain", 4, Buffer.from("kept"), "user-1", now);
  created.close();

  const db = openDatabase(dbPath);
  try {
    const file = db.prepare("SELECT name, bytes, created_by, client_user_id FROM client_files WHERE id = ?").get("file-1");
    assert.equal(file.name, "kept.txt");
    assert.equal(Buffer.from(file.bytes).toString(), "kept");
    assert.equal(file.created_by, "user-1");
    assert.equal(file.client_user_id, null);
    const audit = db.prepare("SELECT action, actor_user_id, client_user_id FROM audit_events WHERE id = ?").get("audit-1");
    assert.equal(audit.action, "document.stored");
    assert.equal(audit.actor_user_id, "user-1");
    assert.equal(audit.client_user_id, null);
    const portal = db.prepare("SELECT email, client_id FROM client_users WHERE email = ?").get(firms.northstar.portal.email);
    assert.equal(portal.client_id, "client-1");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the client page uses the Ledgerly sign-in and leaves the firm shell alone", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const portal = readFileSync(new URL("../src/Portal.jsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  assert.match(app, /session\.portal/);
  assert.match(app, /Sign in to Ledgerly/);
  assert.match(portal, /Ledgerly/);
  assert.match(portal, /Submit file/);
  assert.doesNotMatch(portal, /className="sidebar"/);
  assert.doesNotMatch(portal, /view as/i);
  assert.doesNotMatch(app, /view as/i);
  assert.doesNotMatch(shell, /view as/i);
  assert.match(shell, /e === `Time`/);
});
