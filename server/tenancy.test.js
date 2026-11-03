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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-"));
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

test("two firms stay separate, sessions survive refresh, and staff cannot invite", async () => {
  await withServer(async (base, dbPath) => {
    const northstar = cookieJar();
    const harbor = cookieJar();
    const signedIn = await signIn(northstar, base, firms.northstar.owner);
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.body.firm.name, "Northstar");
    assert.equal(signedIn.body.user.role, "owner");
    assert.equal(signedIn.body.user.roleLabel, "Administrator");
    assert.equal(signedIn.body.user.name, "Olivia Martin");
    assert.equal(signedIn.body.clients.length, 4);
    assert.equal(signedIn.body.client.name, "Northstar Creative");
    assert.equal(JSON.stringify(signedIn.body).includes("scrypt"), false);
    assert.equal(JSON.stringify(signedIn.body).includes("128,430"), false);
    assert.equal(JSON.stringify(signedIn.body).includes("$84.2k"), false);

    const haven = signedIn.body.clients.find((client) => client.name === "Haven Coffee Roasters");
    const switched = await northstar.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: haven.id }),
    });
    assert.equal(switched.status, 200);
    const switchedBody = await switched.json();
    assert.equal(switchedBody.client.id, haven.id);

    const refreshed = await northstar.fetch(`${base}/api/session`);
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json();
    assert.equal(refreshedBody.user.email, firms.northstar.owner.email);
    assert.equal(refreshedBody.client.id, haven.id);

    const opened = await northstar.fetch(`${base}/api/clients/${haven.id}`);
    assert.equal(opened.status, 200);

    const otherFirm = await signIn(harbor, base, firms.harbor.owner);
    assert.equal(otherFirm.response.status, 200);
    assert.equal(otherFirm.body.firm.name, "Harbor Street Advisors");
    assert.equal(otherFirm.body.clients.length, 2);
    assert.ok(otherFirm.body.clients.every((client) => client.id !== haven.id));

    const crossed = await harbor.fetch(`${base}/api/clients/${haven.id}`);
    assert.equal(crossed.status, 404);
    const crossedBody = await crossed.json();
    assert.equal(crossedBody.client, undefined);
    assert.equal(JSON.stringify(crossedBody).includes("Haven"), false);

    const crossedSwitch = await harbor.fetch(`${base}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: haven.id }),
    });
    assert.equal(crossedSwitch.status, 404);
    const harborStill = await harbor.fetch(`${base}/api/session`);
    const harborBody = await harborStill.json();
    assert.notEqual(harborBody.client.id, haven.id);
    assert.ok(harborBody.clients.every((client) => client.firmId === undefined));

    const invite = await northstar.fetch(`${base}/api/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sam Rivera",
        email: "sam@northstarcreative.co",
        role: "staff",
        password: "ledgerly-staff",
      }),
    });
    assert.equal(invite.status, 201);
    const invitedFirm = await invite.json();
    const sam = invitedFirm.members.find((member) => member.email === "sam@northstarcreative.co");
    assert.ok(sam);
    assert.equal(sam.role, "staff");
    assert.equal(sam.roleLabel, "Staff");
    assert.equal(invitedFirm.members.some((member) => member.email === firms.harbor.owner.email), false);

    const staff = cookieJar();
    const staffSignIn = await signIn(staff, base, { email: "sam@northstarcreative.co", password: "ledgerly-staff" });
    assert.equal(staffSignIn.response.status, 200);
    assert.equal(staffSignIn.body.user.role, "staff");
    assert.equal(staffSignIn.body.firm.name, "Northstar");
    const staffRefresh = await staff.fetch(`${base}/api/session`);
    assert.equal((await staffRefresh.json()).client.name, "Northstar Creative");

    const staffInvite = await staff.fetch(`${base}/api/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Other Person",
        email: "other@northstarcreative.co",
        role: "staff",
        password: "ledgerly-staff",
      }),
    });
    assert.equal(staffInvite.status, 403);
    const afterRefusal = await northstar.fetch(`${base}/api/session`);
    const afterBody = await afterRefusal.json();
    assert.equal(afterBody.members.some((member) => member.email === "other@northstarcreative.co"), false);

    const staffCross = await staff.fetch(`${base}/api/clients/${otherFirm.body.client.id}`);
    assert.equal(staffCross.status, 404);

    const signedOut = await northstar.fetch(`${base}/api/session`, { method: "DELETE" });
    assert.equal(signedOut.status, 200);
    const gone = await northstar.fetch(`${base}/api/session`);
    assert.equal(gone.status, 401);

    const db = new DatabaseSync(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    for (const name of ["firms", "users", "clients", "sessions", "audit_events"]) assert.ok(tables.includes(name));
    for (const name of ["accounts", "journals", "journal_lines", "transactions", "invoices"]) assert.equal(tables.includes(name), false);

    const clientRows = db.prepare("SELECT * FROM clients").all();
    assert.ok(clientRows.every((row) => row.firm_id));
    assert.equal(JSON.stringify(clientRows).includes("$"), false);
    const userRows = db.prepare("SELECT * FROM users").all();
    assert.ok(userRows.every((row) => row.firm_id && row.password_hash.startsWith("scrypt:")));
    const auditRows = db.prepare("SELECT * FROM audit_events").all();
    assert.ok(auditRows.length >= 4);
    assert.ok(auditRows.every((row) => row.firm_id && row.actor_user_id));
    const selected = auditRows.filter((row) => row.action === "client.selected");
    assert.ok(selected.every((row) => row.client_id));
    const firmsRows = db.prepare("SELECT id, name FROM firms").all();
    const northstarFirm = firmsRows.find((row) => row.name === "Northstar");
    const harborFirm = firmsRows.find((row) => row.name === "Harbor Street Advisors");
    assert.equal(clientRows.filter((row) => row.firm_id === northstarFirm.id).length, 4);
    assert.equal(clientRows.filter((row) => row.firm_id === harborFirm.id).length, 2);
    assert.equal(userRows.filter((row) => row.email === "sam@northstarcreative.co" && row.firm_id === northstarFirm.id).length, 1);
    db.close();
  });
});

test("wrong password does not start a session", async () => {
  await withServer(async (base) => {
    const jar = cookieJar();
    const response = await jar.fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: firms.northstar.owner.email, password: "not-the-password" }),
    });
    assert.equal(response.status, 401);
    const follow = await jar.fetch(`${base}/api/session`);
    assert.equal(follow.status, 401);
  });
});
