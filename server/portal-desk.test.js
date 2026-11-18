import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { revealDocument } from "./document-bytes.js";
import { currentPortalCode } from "./portal.js";

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-portal-desk-"));
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

async function sendJson(jar, base, method, pathname, payload) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test("uploads are checked and stored privately, and a direct address does not open another firm's file", async () => {
  await withServer(async (base, dbPath) => {
    const anonymous = await fetch(`${base}/api/documents/not-a-file`);
    assert.equal(anonymous.status, 401);

    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const text = Buffer.from("Fictional organizer line\n");
    const stored = await sendJson(olivia, base, "POST", "/api/documents", {
      name: "organizer.txt",
      mediaType: "text/plain",
      contentBase64: text.toString("base64"),
      category: "Tax",
      taxYear: "2026",
    });
    assert.equal(stored.response.status, 201, stored.body.error);
    const download = await olivia.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(await download.text(), text.toString());
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT bytes FROM client_files WHERE id = ?").get(stored.body.file.id);
    db.close();
    assert.equal(Buffer.compare(Buffer.from(row.bytes), text) === 0, false);
    assert.equal(revealDocument(row.bytes).toString(), text.toString());

    const rejected = await sendJson(olivia, base, "POST", "/api/documents", {
      name: "sample.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*").toString("base64"),
    });
    assert.equal(rejected.response.status, 400);
    const executable = await sendJson(olivia, base, "POST", "/api/documents", {
      name: "sample.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from([0x4d, 0x5a, 0x00, 0x00]).toString("base64"),
    });
    assert.equal(executable.response.status, 400);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const hidden = await jordan.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes("Fictional organizer"), false);
    assert.equal(signedIn.user.role, "owner");
  });
});

test("a template, a reminder, and accountant approval stay inside the firm", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const casey = cookieJar();
    const portalSession = await signIn(casey, base, firms.northstar.portal);
    const creative = portalSession.client;
    const sam = cookieJar();
    await signIn(sam, base, firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
    const staffPolicy = await sendJson(sam, base, "POST", "/api/portal-policy", { requestApproval: true, clientDownloads: true, retainDays: 0 });
    assert.equal(staffPolicy.response.status, 403);
    const policy = await sendJson(olivia, base, "POST", "/api/portal-policy", { requestApproval: true, clientDownloads: true, retainDays: 0 });
    assert.equal(policy.response.status, 200, policy.body.error);
    const template = await sendJson(olivia, base, "POST", "/api/document-templates", {
      name: "Organizer pack",
      title: "Fictional organizer",
      dueOffsetDays: 0,
    });
    assert.equal(template.response.status, 200, template.body.error);
    const applied = await sendJson(olivia, base, "POST", `/api/document-templates/${template.body.templates[0].id}/apply`, { clientId: creative.id });
    assert.equal(applied.response.status, 201, applied.body.error);
    assert.equal(applied.body.request.status, "open");

    const home = await (await casey.fetch(`${base}/api/portal`)).json();
    assert.equal(typeof home.progress.uncategorized, "number");
    assert.equal(home.requests.some((request) => request.title === "Fictional organizer" && request.status === "open"), true);
    const uploaded = await sendJson(casey, base, "POST", "/api/portal/files", {
      name: "organizer.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("synthetic organizer\n").toString("base64"),
      requestId: applied.body.request.id,
    });
    assert.equal(uploaded.response.status, 201, uploaded.body.error);
    const waiting = await (await casey.fetch(`${base}/api/portal`)).json();
    const pending = waiting.requests.find((request) => request.title === "Fictional organizer");
    assert.equal(pending.status, "open");
    assert.equal(pending.reviewStatus, "submitted");

    const staffApproval = await sendJson(sam, base, "POST", `/api/document-requests/${applied.body.request.id}/approve`, {});
    assert.equal(staffApproval.response.status, 403);
    const approved = await sendJson(olivia, base, "POST", `/api/document-requests/${applied.body.request.id}/approve`, {});
    assert.equal(approved.response.status, 200, approved.body.error);
    assert.equal(approved.body.status, "complete");

    const past = await sendJson(olivia, base, "POST", "/api/document-requests", {
      clientId: creative.id,
      title: "Older fictional statement",
      dueOn: "2026-01-15",
    });
    assert.equal(past.response.status, 201, past.body.error);
    await olivia.fetch(`${base}/api/tasks`);
    await olivia.fetch(`${base}/api/tasks`);
    const reminded = await (await casey.fetch(`${base}/api/portal`)).json();
    assert.equal(reminded.reminders.filter((item) => item.title === "Older fictional statement").length, 1);

    const note = await sendJson(casey, base, "POST", "/api/portal/messages", { body: "The organizer is in." });
    assert.equal(note.response.status, 200, note.body.error);
    const firmMessages = await (await olivia.fetch(`${base}/api/clients/${creative.id}/messages`)).json();
    assert.equal(firmMessages.messages.some((item) => item.body === "The organizer is in."), true);
    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const hidden = await jordan.fetch(`${base}/api/clients/${creative.id}/messages`);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.text()).includes("organizer is in"), false);

    const firm = await (await olivia.fetch(`${base}/api/firm`)).json();
    assert.equal(typeof firm.counts.awaitingReview, "number");
    assert.equal(JSON.stringify(firm).includes("$"), false);
  });
});

test("portal invitations activate an account, and multifactor sign-in needs the second code", async () => {
  await withServer(async (base) => {
    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    const invited = await sendJson(olivia, base, "POST", `/api/clients/${signedIn.client.id}/invitations`, {
      name: "Riley Stone",
      email: "riley@northstar-portal.example",
    });
    assert.equal(invited.response.status, 201, invited.body.error);
    const box = await (await olivia.fetch(`${base}/api/dev/mailbox?email=riley@northstar-portal.example`)).json();
    const token = new URL(box.messages[0].linkPath, "http://localhost").searchParams.get("token");
    const guest = cookieJar();
    const accepted = await sendJson(guest, base, "POST", "/api/invitations/accept", {
      token,
      name: "Riley Stone",
      password: "ledgerly-riley-1",
      confirmPassword: "ledgerly-riley-1",
    });
    assert.equal(accepted.response.status, 200, accepted.body.error);
    assert.equal(accepted.body.portal, true);
    assert.equal(accepted.body.client.name, "Northstar Creative");
    const enroll = await sendJson(guest, base, "POST", "/api/portal/mfa/enroll", {});
    assert.equal(enroll.response.status, 200, enroll.body.error);
    const confirm = await sendJson(guest, base, "POST", "/api/portal/mfa/confirm", { code: currentPortalCode(enroll.body.secret) });
    assert.equal(confirm.response.status, 200, confirm.body.error);
    await guest.fetch(`${base}/api/session`, { method: "DELETE" });
    const blocked = await sendJson(guest, base, "POST", "/api/session", {
      email: "riley@northstar-portal.example",
      password: "ledgerly-riley-1",
    });
    assert.equal(blocked.response.status, 200, blocked.body.error);
    assert.equal(blocked.body.mfaRequired, true);
    assert.equal(blocked.body.user, undefined);
    const wrong = await sendJson(guest, base, "POST", "/api/session", { ticket: blocked.body.ticket, code: "000000" });
    assert.equal(wrong.response.status, 401);
    const opened = await sendJson(guest, base, "POST", "/api/session", {
      ticket: blocked.body.ticket,
      code: currentPortalCode(enroll.body.secret),
    });
    assert.equal(opened.response.status, 200, opened.body.error);
    assert.equal(opened.body.portal, true);

    const jordan = cookieJar();
    await signIn(jordan, base, firms.harbor.owner);
    const hidden = await (await jordan.fetch(`${base}/api/invitations`)).json();
    assert.equal(JSON.stringify(hidden).includes("riley@northstar-portal.example"), false);
  });
});

test("retention removes an old file and a turned-off download does not serve it to the client", async () => {
  await withServer(async (base, dbPath) => {
    const olivia = cookieJar();
    await signIn(olivia, base, firms.northstar.owner);
    const stored = await sendJson(olivia, base, "POST", "/api/documents", {
      name: "old-note.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("old fictional note\n").toString("base64"),
    });
    assert.equal(stored.response.status, 201, stored.body.error);
    const policy = await sendJson(olivia, base, "POST", "/api/portal-policy", {
      requestApproval: false,
      clientDownloads: false,
      retainDays: 30,
    });
    assert.equal(policy.response.status, 200, policy.body.error);
    const casey = cookieJar();
    await signIn(casey, base, firms.northstar.portal);
    const blocked = await casey.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.text()).includes("old fictional"), false);
    const firmCopy = await olivia.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(firmCopy.status, 200);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE client_files SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", stored.body.file.id);
    db.close();
    const purged = await sendJson(olivia, base, "POST", "/api/documents/retention", {});
    assert.equal(purged.response.status, 200, purged.body.error);
    assert.equal(purged.body.removed, 1);
    const gone = await olivia.fetch(`${base}/api/documents/${stored.body.file.id}`);
    assert.equal(gone.status, 404);
    const audit = new DatabaseSync(dbPath, { readOnly: true });
    const event = audit.prepare("SELECT action FROM audit_events WHERE action = 'document.purged'").get();
    audit.close();
    assert.equal(event.action, "document.purged");
  });
});
