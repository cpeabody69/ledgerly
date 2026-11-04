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

function tableCount(db, table) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function bookCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const counts = {
    journals: tableCount(db, "journal_entries"),
    bills: tableCount(db, "ap_bills"),
    tax: tableCount(db, "tax_workflows"),
  };
  db.close();
  return counts;
}

test("an unreviewed file creates no journal, and accepting a label does not post", async () => {
  const saved = {
    provider: process.env.LEDGERLY_MODEL_PROVIDER,
    key: process.env.LEDGERLY_MODEL_API_KEY,
    url: process.env.LEDGERLY_MODEL_URL,
  };
  delete process.env.LEDGERLY_MODEL_PROVIDER;
  delete process.env.LEDGERLY_MODEL_API_KEY;
  delete process.env.LEDGERLY_MODEL_URL;
  try {
    await withServer(async (base, dbPath) => {
      const olivia = cookieJar();
      const signedIn = await signIn(olivia, base, firms.northstar.owner);
      const before = bookCounts(dbPath);
      const invoice = Buffer.from("Vendor: Harbor Supply\nDate: 2026-03-04\nAmount: 42.50\nVendor invoice\n");
      const stored = await postJson(olivia, base, "/api/documents", {
        name: "harbor-supply-vendor-invoice.txt",
        mediaType: "text/plain",
        contentBase64: invoice.toString("base64"),
      });
      assert.equal(stored.response.status, 201);
      const script = await postJson(olivia, base, "/api/documents", {
        name: "do-not-run.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("process.exit(1)\n").toString("base64"),
      });
      assert.equal(script.response.status, 201);
      const queued = await (await olivia.fetch(`${base}/api/documents/reviews`)).json();
      assert.match(queued.notice, /external model is not configured/i);
      assert.equal(queued.label, "AI-generated");
      const suggestion = queued.queue.find((item) => item.name === "harbor-supply-vendor-invoice.txt");
      const untouched = queued.queue.find((item) => item.name === "do-not-run.txt");
      assert.equal(suggestion.suggestion.kind, "vendor invoice");
      assert.equal(suggestion.suggestion.party, "Harbor Supply");
      assert.equal(suggestion.suggestion.date, "2026-03-04");
      assert.equal(suggestion.suggestion.amount, "42.50");
      assert.equal(suggestion.suggestion.label, "AI-generated");
      assert.equal(suggestion.suggestion.confidenceLabel.length > 0, true);
      assert.equal(untouched.suggestion.kind, "unknown");
      assert.deepEqual(bookCounts(dbPath), before);

      const accepted = await postJson(olivia, base, `/api/documents/${stored.body.file.id}/review`, { decision: "accept" });
      assert.equal(accepted.response.status, 201);
      assert.equal(accepted.body.review.status, "accepted");
      assert.equal(accepted.body.review.kind, "vendor invoice");
      assert.equal(accepted.body.review.label, "AI-generated");
      assert.equal(JSON.stringify(accepted.body).includes("journal"), false);
      const corrected = await postJson(olivia, base, `/api/documents/${script.body.file.id}/review`, {
        decision: "correct",
        kind: "contract",
        party: "Harbor Supply",
        date: "2026-04-01",
        amount: "10.00",
      });
      assert.equal(corrected.response.status, 201);
      assert.equal(corrected.body.review.status, "corrected");
      assert.equal(corrected.body.review.kind, "contract");
      assert.deepEqual(bookCounts(dbPath), before);

      const harbor = cookieJar();
      await signIn(harbor, base, firms.harbor.owner);
      const hidden = await (await harbor.fetch(`${base}/api/documents/reviews`)).json();
      assert.equal(JSON.stringify(hidden).includes("Harbor Supply"), false);
      assert.equal(JSON.stringify(hidden).includes("vendor invoice"), false);
      assert.equal(JSON.stringify(hidden).includes("harbor-supply"), false);
      const hiddenReview = await postJson(harbor, base, `/api/documents/${stored.body.file.id}/review`, { decision: "accept" });
      assert.equal(hiddenReview.response.status, 404);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const reviews = db.prepare("SELECT firm_id, kind, status FROM document_reviews").all();
      assert.equal(reviews.length, 2);
      assert.equal(reviews.every((row) => row.firm_id === signedIn.firm.id), true);
      db.close();
    });
  } finally {
    if (saved.provider === undefined) delete process.env.LEDGERLY_MODEL_PROVIDER;
    else process.env.LEDGERLY_MODEL_PROVIDER = saved.provider;
    if (saved.key === undefined) delete process.env.LEDGERLY_MODEL_API_KEY;
    else process.env.LEDGERLY_MODEL_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.LEDGERLY_MODEL_URL;
    else process.env.LEDGERLY_MODEL_URL = saved.url;
  }
});

test("the same client, name, and size is not stored twice, and only a pdf or image is previewable", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const before = bookCounts(dbPath);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const stored = await postJson(olivia, base, "/api/documents", {
      name: "pixel.png",
      mediaType: "image/png",
      contentBase64: png.toString("base64"),
    });
    assert.equal(stored.response.status, 201);
    assert.equal(stored.body.file.preview, "image");
    const again = await postJson(olivia, base, "/api/documents", {
      name: "pixel.png",
      mediaType: "image/png",
      contentBase64: png.toString("base64"),
    });
    assert.equal(again.response.status, 409);
    assert.match(again.body.error, /already stored/i);
    const listed = await (await olivia.fetch(`${base}/api/documents`)).json();
    assert.equal(listed.files.filter((file) => file.name === "pixel.png").length, 1);
    const download = await olivia.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.equal(download.headers.get("content-disposition").includes("inline"), true);
    assert.equal(Buffer.compare(Buffer.from(await download.arrayBuffer()), png), 0);
    const notes = await postJson(olivia, base, "/api/documents", {
      name: "notes.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("notes\n").toString("base64"),
    });
    assert.equal(notes.body.file.preview, "");
    const pdf = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const statement = await postJson(olivia, base, "/api/documents", {
      name: "statement.pdf",
      mediaType: "application/pdf",
      contentBase64: pdf.toString("base64"),
    });
    assert.equal(statement.response.status, 201);
    assert.equal(statement.body.file.preview, "pdf");
    assert.deepEqual(bookCounts(dbPath), before);
  });
});

test("an open request keeps its due date, and the client sees that request", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const brightline = signedIn.clients.find((row) => row.name === "Brightline Labs");
    const before = bookCounts(dbPath);
    const invalid = await postJson(olivia, base, "/api/document-requests", {
      clientId: brightline.id,
      title: "Bad date",
      dueOn: "June 15",
    });
    assert.equal(invalid.response.status, 400);
    const open = await postJson(olivia, base, "/api/document-requests", {
      clientId: brightline.id,
      title: "May bank statement",
      dueOn: "2026-06-15",
    });
    assert.equal(open.response.status, 201);
    assert.equal(open.body.request.status, "open");
    assert.equal(open.body.request.statusLabel, "Outstanding");
    assert.equal(open.body.request.dueOn, "2026-06-15");
    const done = await postJson(olivia, base, "/api/document-requests", {
      clientId: brightline.id,
      title: "Old receipt",
      dueOn: "2026-05-01",
    });
    const file = await postJson(olivia, base, "/api/documents", {
      clientId: brightline.id,
      requestId: done.body.request.id,
      name: "old-receipt.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("receipt\n").toString("base64"),
    });
    assert.equal(file.response.status, 201);
    const firm = await (await olivia.fetch(`${base}/api/clients`)).json();
    assert.equal(firm.requestHistory.outstanding.some((row) => row.title === "May bank statement" && row.dueOn === "2026-06-15" && row.statusLabel === "Outstanding"), true);
    assert.equal(firm.requestHistory.completed.some((row) => row.title === "Old receipt" && row.status === "complete" && row.statusLabel === "Completed"), true);
    assert.equal(firm.requestHistory.outstanding.some((row) => row.title === "Old receipt"), false);

    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const portal = await (await casey.fetch(`${base}/api/portal`)).json();
    assert.equal(portal.notifications.length, 1);
    assert.match(portal.notifications[0].message, /May bank statement/);
    assert.match(portal.notifications[0].message, /June 15, 2026/);
    assert.equal(JSON.stringify(portal.notifications).includes("Old receipt"), false);
    assert.equal(portal.requests.some((row) => row.title === "May bank statement" && row.status === "open"), true);

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await (await harbor.fetch(`${base}/api/clients`)).json();
    assert.equal(JSON.stringify(hidden.requestHistory).includes("May bank statement"), false);
    assert.deepEqual(bookCounts(dbPath), before);
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
