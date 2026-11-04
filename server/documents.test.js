import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";

const fixture = Buffer.from("Ledgerly synthetic receipt\n");

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-docs-"));
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

async function postJson(jar, base, pathname, body) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("a requested document keeps its bytes, shows on the transaction, and stays inside the firm", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const client = signedIn.clients.find((row) => row.name === "Northstar Creative");
    assert.equal(client.id, signedIn.client.id);

    const before = await (await olivia.fetch(`${base}/api/clients`)).json();
    assert.equal(before.counts.openRequests, 0);

    const requested = await postJson(olivia, base, "/api/document-requests", {
      clientId: client.id,
      title: "Fixture receipt",
    });
    assert.equal(requested.response.status, 201);
    assert.equal(requested.body.request.status, "open");
    assert.equal(requested.body.request.clientName, "Northstar Creative");
    const open = await (await olivia.fetch(`${base}/api/clients`)).json();
    assert.equal(open.counts.openRequests, 1);
    assert.equal(open.requests.some((row) => row.id === requested.body.request.id && row.title === "Fixture receipt"), true);

    const stored = await postJson(olivia, base, "/api/documents", {
      clientId: client.id,
      requestId: requested.body.request.id,
      name: "synthetic-receipt.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(stored.response.status, 201);
    assert.equal(stored.body.file.name, "synthetic-receipt.txt");
    assert.equal(stored.body.file.requestTitle, "Fixture receipt");
    assert.equal(JSON.stringify(stored.body).includes("share"), false);
    const completed = await (await olivia.fetch(`${base}/api/clients`)).json();
    assert.equal(completed.counts.openRequests, 0);
    assert.equal(completed.requests.some((row) => row.id === requested.body.request.id), false);

    const listed = await (await olivia.fetch(`${base}/api/documents`)).json();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].id, stored.body.file.id);
    assert.equal(JSON.stringify(listed).includes(fixture.toString()), false);

    const fileUrl = `${base}/api/documents/${stored.body.file.id}`;
    const first = await olivia.fetch(fileUrl);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "text/plain");
    assert.equal(Buffer.compare(Buffer.from(await first.arrayBuffer()), fixture), 0);
    const refreshed = await olivia.fetch(fileUrl);
    assert.equal(Buffer.compare(Buffer.from(await refreshed.arrayBuffer()), fixture), 0);
    const listedAgain = await (await olivia.fetch(`${base}/api/documents`)).json();
    assert.equal(listedAgain.files[0].name, "synthetic-receipt.txt");

    const account = await postJson(olivia, base, "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    const line = await postJson(olivia, base, "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-20",
      description: "Uncoded studio deposit",
      amount: "80.00",
    });
    assert.equal(line.response.status, 201);
    const attached = await postJson(olivia, base, "/api/documents", {
      clientId: client.id,
      transactionId: line.body.transaction.id,
      name: "synthetic-deposit.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(attached.response.status, 201);
    const activity = await (await olivia.fetch(`${base}/api/transactions`)).json();
    const deposit = activity.transactions.find((row) => row.id === line.body.transaction.id);
    assert.equal(deposit.attachments.length, 1);
    assert.equal(deposit.attachments[0].name, "synthetic-deposit.txt");
    assert.equal(deposit.attachments[0].id, attached.body.file.id);

    const both = await postJson(olivia, base, "/api/documents", {
      clientId: client.id,
      requestId: requested.body.request.id,
      transactionId: line.body.transaction.id,
      name: "both.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(both.response.status, 400);

    const harbor = cookieJar();
    const other = await signIn(harbor, base, firms.harbor.owner);
    assert.equal(other.firm.name, "Harbor Street Advisors");
    const hiddenList = await (await harbor.fetch(`${base}/api/documents`)).json();
    assert.equal(JSON.stringify(hiddenList).includes("synthetic-receipt"), false);
    assert.equal(JSON.stringify(hiddenList).includes(fixture.toString()), false);
    const hiddenFile = await harbor.fetch(fileUrl);
    assert.equal(hiddenFile.status, 404);
    const hiddenBody = await hiddenFile.text();
    assert.equal(hiddenBody.includes(fixture.toString()), false);
    assert.equal(hiddenBody.includes("synthetic-receipt"), false);
    const hiddenDelete = await harbor.fetch(fileUrl, { method: "DELETE" });
    assert.equal(hiddenDelete.status, 404);
    const hiddenRequest = await postJson(harbor, base, "/api/document-requests", {
      clientId: client.id,
      title: "Outside the firm",
    });
    assert.equal(hiddenRequest.response.status, 404);
    const hiddenStore = await postJson(harbor, base, "/api/documents", {
      clientId: client.id,
      name: "outside.txt",
      mediaType: "text/plain",
      contentBase64: fixture.toString("base64"),
    });
    assert.equal(hiddenStore.response.status, 404);
    const stillThere = await olivia.fetch(fileUrl);
    assert.equal(Buffer.compare(Buffer.from(await stillThere.arrayBuffer()), fixture), 0);

    const removed = await olivia.fetch(fileUrl, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const gone = await olivia.fetch(fileUrl);
    assert.equal(gone.status, 404);
    const reopened = await (await olivia.fetch(`${base}/api/clients`)).json();
    assert.equal(reopened.counts.openRequests, 1);
    assert.equal(reopened.requests.some((row) => row.title === "Fixture receipt"), true);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const audits = db.prepare(
      "SELECT action, entity_id, firm_id FROM audit_events WHERE action IN ('document_request.created', 'document.stored', 'document.removed')",
    ).all();
    assert.equal(audits.some((row) => row.action === "document_request.created" && row.entity_id === requested.body.request.id), true);
    assert.equal(audits.filter((row) => row.action === "document.stored").length, 2);
    const removal = audits.find((row) => row.action === "document.removed");
    assert.equal(removal.entity_id, stored.body.file.id);
    assert.equal(removal.firm_id, signedIn.firm.id);
    assert.equal(audits.every((row) => row.firm_id === signedIn.firm.id), true);
    db.close();
  });
});

test("a library file rejects the wrong type, stays in the firm, and keeps its bytes when archived", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const csv = Buffer.from("date,amount\n2026-01-02,12.00\n");
    const rejected = await postJson(olivia, base, "/api/documents", {
      name: "notes.html",
      mediaType: "text/html",
      contentBase64: Buffer.from("<html>no</html>").toString("base64"),
    });
    assert.equal(rejected.response.status, 400);
    const folder = await postJson(olivia, base, "/api/documents/folders", { name: "Tax files" });
    assert.equal(folder.response.status, 201);
    const stored = await postJson(olivia, base, "/api/documents", {
      name: "ledger-2026.csv",
      mediaType: "text/csv",
      contentBase64: csv.toString("base64"),
      category: "Tax",
      taxYear: "2026",
      folderId: folder.body.folder.id,
    });
    assert.equal(stored.response.status, 201);
    const renamed = await olivia.fetch(`${base}/api/documents/${stored.body.file.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "studio-ledger-2026.csv" }),
    });
    assert.equal(renamed.status, 200);
    const tagged = await postJson(olivia, base, `/api/documents/${stored.body.file.id}/tags`, { name: "fictional" });
    assert.equal(tagged.response.status, 201);
    const noted = await postJson(olivia, base, `/api/documents/${stored.body.file.id}/notes`, { body: "Synthetic ledger export." });
    assert.equal(noted.response.status, 201);
    const found = await (await olivia.fetch(`${base}/api/documents/library?q=studio-ledger`)).json();
    assert.equal(found.files.length, 1);
    assert.equal(found.files[0].name, "studio-ledger-2026.csv");
    assert.equal(found.files[0].category, "Tax");
    assert.equal(found.files[0].taxYear, "2026");
    assert.equal(found.files[0].folderName, "Tax files");
    assert.equal(found.files[0].tags[0].name, "fictional");
    assert.equal(found.files[0].notes[0].body, "Synthetic ledger export.");
    assert.equal(found.files[0].versions.length >= 1, true);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await harbor.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes("12.00"), false);
    const hiddenLibrary = await (await harbor.fetch(`${base}/api/documents/library?q=studio-ledger`)).json();
    assert.equal(hiddenLibrary.files.length, 0);

    const archived = await postJson(olivia, base, `/api/documents/${stored.body.file.id}/archive`, {});
    assert.equal(archived.response.status, 200);
    assert.equal(archived.body.file.status, "archived");
    const download = await olivia.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(download.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await download.arrayBuffer()), csv), 0);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT bytes, status FROM client_files WHERE id = ?").get(stored.body.file.id);
    assert.equal(row.status, "archived");
    assert.equal(Buffer.compare(Buffer.from(row.bytes), csv), 0);
    const kinds = db.prepare(
      "SELECT kind, COUNT(*) AS count FROM document_records WHERE firm_id = ? GROUP BY kind",
    ).all(signedIn.firm.id);
    assert.equal(kinds.some((item) => item.kind === "folder" && Number(item.count) >= 1), true);
    assert.equal(kinds.some((item) => item.kind === "tag" && Number(item.count) >= 1), true);
    assert.equal(kinds.some((item) => item.kind === "note" && Number(item.count) >= 1), true);
    assert.equal(kinds.some((item) => item.kind === "version" && Number(item.count) >= 1), true);
    db.close();
  });
});

test("the document screens store a file instead of announcing one", () => {
  const clients = readFileSync(new URL("../src/Clients.jsx", import.meta.url), "utf8");
  const receipt = readFileSync(new URL("../src/Receipt.jsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  const drawer = readFileSync(new URL("../src/Transactions.jsx", import.meta.url), "utf8");
  assert.match(clients, /Request documents/);
  assert.match(clients, /Attach file/);
  assert.match(clients, /Client files/);
  assert.match(clients, /\/api\/documents\//);
  assert.doesNotMatch(clients, /sharing link/i);
  assert.doesNotMatch(clients, /Copy link/);
  assert.doesNotMatch(receipt, /Receipt uploaded and ready to match/);
  assert.doesNotMatch(receipt, /sharing link/i);
  assert.match(shell, /n === `upload` \? <ReceiptModal/);
  assert.match(drawer, /Attachment/);
  assert.match(drawer, /transaction\.attachments/);
});
