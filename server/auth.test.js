import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { allowAttempt, resetRateLimits } from "./auth.js";
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

async function withServer(fn, options = {}) {
  resetRateLimits();
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-auth-"));
  const dbPath = path.join(dir, "test.sqlite");
  const running = await start(dbPath, 0, options);
  const base = `http://127.0.0.1:${running.port}`;
  try {
    await fn(base, dbPath, running);
  } finally {
    await new Promise((resolve, reject) => running.server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}

async function post(jar, base, pathname, body, headers = {}) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function linkToken(linkPath, base) {
  return new URL(linkPath, base).searchParams.get("token");
}

async function mailbox(jar, base, email) {
  const response = await jar.fetch(`${base}/api/dev/mailbox?email=${encodeURIComponent(email)}`);
  const body = await response.json();
  return { response, body };
}

const owner = {
  name: "Ava Quinn",
  email: "ava@pine-ledger.example",
  password: "ledgerly-ava-1",
};

function registrationBody(overrides = {}) {
  return {
    name: owner.name,
    email: owner.email,
    password: owner.password,
    confirmPassword: owner.password,
    acceptTerms: true,
    acceptPrivacy: true,
    accountType: "firm",
    ...overrides,
  };
}

test("registration, verification, sessions, invitations, roles, and isolation", { concurrency: 1 }, async (t) => {
  await t.test("the attempt counter blocks the next call after the limit", () => {
    resetRateLimits();
    assert.equal(allowAttempt("unit", 2, 1000, 0), true);
    assert.equal(allowAttempt("unit", 2, 1000, 10), true);
    assert.equal(allowAttempt("unit", 2, 1000, 20), false);
    assert.equal(allowAttempt("unit", 2, 1000, 2000), true);
  });

  await t.test("firm registration verifies email, creates the organization, and rejects duplicates", async () => {
    await withServer(async (base, dbPath) => {
      const jar = cookieJar();
      const missingTerms = await post(jar, base, "/api/register", registrationBody({ acceptTerms: false }));
      assert.equal(missingTerms.response.status, 400);
      assert.match(missingTerms.body.error, /Terms/);
      const mismatch = await post(jar, base, "/api/register", registrationBody({ confirmPassword: "ledgerly-other" }));
      assert.equal(mismatch.response.status, 400);
      assert.match(mismatch.body.error, /do not match/);
      const clientAttempt = await post(jar, base, "/api/register", registrationBody({ accountType: "client" }));
      assert.equal(clientAttempt.response.status, 400);
      assert.match(clientAttempt.body.error, /invitation/);

      const registered = await post(jar, base, "/api/register", registrationBody());
      assert.equal(registered.response.status, 201);
      assert.match(registered.body.message, /not configured/);
      assert.equal(JSON.stringify(registered.body).includes(owner.password), false);
      assert.equal(registered.body.token, undefined);
      assert.equal(registered.body.linkPath, undefined);

      const duplicate = await post(jar, base, "/api/register", registrationBody());
      assert.equal(duplicate.response.status, 409);
      const existing = await post(jar, base, "/api/register", registrationBody({ email: firms.northstar.owner.email, name: "Someone Else" }));
      assert.equal(existing.response.status, 409);

      const early = await post(jar, base, "/api/session", { email: owner.email, password: owner.password });
      assert.equal(early.response.status, 403);
      assert.match(early.body.error, /Confirm your email/);
      assert.equal(JSON.stringify(early.body).includes(owner.password), false);

      const box = await mailbox(jar, base, owner.email);
      assert.equal(box.response.status, 200);
      const token = linkToken(box.body.messages[0].linkPath, base);
      assert.equal(box.body.messages[0].body.includes(token), false);
      assert.equal(JSON.stringify(registered.body).includes(token), false);
      const dbEarly = new DatabaseSync(dbPath);
      const eventText = JSON.stringify(dbEarly.prepare("SELECT email, action FROM auth_events").all());
      assert.equal(eventText.includes(owner.password), false);
      assert.equal(eventText.includes(token), false);
      const stored = dbEarly.prepare("SELECT token_hash FROM auth_tokens").get();
      assert.notEqual(stored.token_hash, token);
      dbEarly.close();

      const stale = await post(cookieJar(), base, "/api/email-verification/resend", { email: owner.email });
      assert.equal(stale.response.status, 200);
      const resent = await mailbox(jar, base, owner.email);
      const nextToken = linkToken(resent.body.messages.at(-1).linkPath, base);
      const oldLink = await post(jar, base, "/api/email-verification", { token });
      assert.equal(oldLink.response.status, 400);

      const verified = await post(jar, base, "/api/email-verification", { token: nextToken });
      assert.equal(verified.response.status, 200);
      assert.equal(verified.body.onboarding, true);
      assert.equal(verified.body.user.role, "owner");
      assert.equal(verified.body.user.roleLabel, "Organization Owner");
      assert.equal(verified.body.firm, null);
      const cookie = verified.response.headers.get("set-cookie") || "";
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.equal(cookie.includes(owner.password), false);

      const again = await post(cookieJar(), base, "/api/email-verification", { token: nextToken });
      assert.equal(again.response.status, 400);
      assert.match(again.body.error, /already used/);

      const blockedPage = await jar.fetch(`${base}/api/ledger`);
      assert.equal(blockedPage.status, 403);

      const created = await post(jar, base, "/api/onboarding/firm", {
        firmName: "Pine Ledger",
        businessType: "cpa_firm",
        country: "US",
        timeZone: "America/Chicago",
        accountingMethod: "cash",
        fiscalYearStart: 7,
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.firm.name, "Pine Ledger");
      assert.equal(created.body.firm.accountingMethod, "cash");
      assert.equal(created.body.firm.fiscalYearStart, 7);
      assert.equal(created.body.user.role, "owner");
      const profile = created.body.checklist.steps.find((step) => step.id === "firm_profile");
      assert.equal(profile.status, "complete");

      const skipped = await post(jar, base, "/api/onboarding/step", { step: "sandbox_bank", status: "skipped" });
      assert.equal(skipped.response.status, 200);
      assert.equal(skipped.body.checklist.steps.find((step) => step.id === "sandbox_bank").status, "skipped");
      const resumed = await post(jar, base, "/api/onboarding/step", { step: "sandbox_bank", status: "pending" });
      assert.equal(resumed.body.checklist.steps.find((step) => step.id === "sandbox_bank").status, "pending");
      const required = await post(jar, base, "/api/onboarding/step", { step: "firm_profile", status: "skipped" });
      assert.equal(required.response.status, 400);

      const tooSoon = await post(jar, base, "/api/onboarding/enter", {});
      assert.equal(tooSoon.response.status, 400);

      const client = await post(jar, base, "/api/clients", {
        name: "Northwind Supply",
        legalName: "Northwind Supply LLC",
        industry: "Wholesale",
        businessType: "LLC",
        accountingMethod: "cash",
        fiscalYearStart: "July",
      });
      assert.equal(client.response.status, 201);
      assert.equal(client.body.session.checklist.steps.find((step) => step.id === "first_client").status, "complete");
      const clientId = client.body.client.id;

      const entered = await post(jar, base, "/api/onboarding/enter", {});
      assert.equal(entered.response.status, 200);
      assert.equal(entered.body.onboarding, undefined);
      assert.equal(entered.body.client.name, "Northwind Supply");
      assert.equal(entered.body.firm.name, "Pine Ledger");

      const ledger = await (await jar.fetch(`${base}/api/ledger`)).json();
      assert.equal(ledger.policy.basis, "cash");
      assert.equal(ledger.policy.fiscalYearStartMonth, 7);
      const chart = (await (await jar.fetch(`${base}/api/session`)).json()).checklist.steps.find((step) => step.id === "chart");
      assert.equal(chart.status, "complete");

      const signedOut = await jar.fetch(`${base}/api/session`, { method: "DELETE" });
      assert.equal(signedOut.status, 200);
      assert.equal((await jar.fetch(`${base}/api/session`)).status, 401);
      const signedIn = await post(jar, base, "/api/session", { email: owner.email, password: owner.password });
      assert.equal(signedIn.response.status, 200);
      assert.equal(signedIn.body.firm.name, "Pine Ledger");
      assert.equal(signedIn.body.user.email, owner.email);

      const northstar = cookieJar();
      const olivia = await post(northstar, base, "/api/session", firms.northstar.owner);
      assert.equal(olivia.response.status, 200);
      const crossed = await jar.fetch(`${base}/api/clients/${olivia.body.client.id}`);
      assert.equal(crossed.status, 404);
      const crossedBack = await northstar.fetch(`${base}/api/clients/${clientId}`);
      assert.equal(crossedBack.status, 404);
      assert.equal(JSON.stringify(await crossedBack.json()).includes("Northwind"), false);

      const db = new DatabaseSync(dbPath);
      const memberships = db.prepare("SELECT firm_id FROM memberships WHERE user_id = ?").all(
        db.prepare("SELECT id FROM users WHERE email = ?").get(owner.email).id,
      );
      assert.equal(memberships.length, 1);
      db.close();
    });
  });

  await t.test("password reset replaces the password and the link cannot be reused", async () => {
    await withServer(async (base, dbPath) => {
      const jar = cookieJar();
      await post(jar, base, "/api/register", registrationBody({ email: "reset@pine-ledger.example" }));
      const box = await mailbox(jar, base, "reset@pine-ledger.example");
      const verifyToken = linkToken(box.body.messages[0].linkPath, base);
      await post(jar, base, "/api/email-verification", { token: verifyToken });
      await post(jar, base, "/api/onboarding/firm", {
        firmName: "Reset Ledger",
        businessType: "bookkeeping",
        country: "CA",
        timeZone: "America/Toronto",
        accountingMethod: "accrual",
        fiscalYearStart: 1,
      });
      await post(jar, base, "/api/clients", { name: "Reset Client", businessType: "LLC" });
      await post(jar, base, "/api/onboarding/enter", {});

      const unknown = await post(cookieJar(), base, "/api/password-reset", { email: "nobody@pine-ledger.example" });
      assert.equal(unknown.response.status, 200);
      assert.match(unknown.body.message, /If an account exists/);
      const empty = await mailbox(jar, base, "nobody@pine-ledger.example");
      assert.equal(empty.body.messages.length, 0);

      const requested = await post(cookieJar(), base, "/api/password-reset", { email: "reset@pine-ledger.example" });
      assert.equal(requested.response.status, 200);
      assert.equal(JSON.stringify(requested.body).includes("token="), false);
      const resetBox = await mailbox(jar, base, "reset@pine-ledger.example");
      const resetToken = linkToken(resetBox.body.messages.at(-1).linkPath, base);
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE auth_tokens SET expires_at = ? WHERE token_hash != '' AND purpose = 'password_reset'").run("2000-01-01T00:00:00.000Z");
      db.close();
      const expired = await post(cookieJar(), base, "/api/password-reset/confirm", {
        token: resetToken,
        password: "ledgerly-reset-2",
        confirmPassword: "ledgerly-reset-2",
      });
      assert.equal(expired.response.status, 400);
      assert.match(expired.body.error, /expired/);

      await post(cookieJar(), base, "/api/password-reset", { email: "reset@pine-ledger.example" });
      const freshBox = await mailbox(jar, base, "reset@pine-ledger.example");
      const freshToken = linkToken(freshBox.body.messages.at(-1).linkPath, base);
      const confirmed = await post(cookieJar(), base, "/api/password-reset/confirm", {
        token: freshToken,
        password: "ledgerly-reset-2",
        confirmPassword: "ledgerly-reset-2",
      });
      assert.equal(confirmed.response.status, 200);
      const reused = await post(cookieJar(), base, "/api/password-reset/confirm", {
        token: freshToken,
        password: "ledgerly-reset-3",
        confirmPassword: "ledgerly-reset-3",
      });
      assert.equal(reused.response.status, 400);
      const oldPassword = await post(cookieJar(), base, "/api/session", { email: "reset@pine-ledger.example", password: owner.password });
      assert.equal(oldPassword.response.status, 401);
      const newPassword = await post(cookieJar(), base, "/api/session", { email: "reset@pine-ledger.example", password: "ledgerly-reset-2" });
      assert.equal(newPassword.response.status, 200);
      assert.equal(newPassword.body.firm.name, "Reset Ledger");
    });
  });

  await t.test("client invitations expire, revoke, and cannot be reused or accepted by another firm", async () => {
    await withServer(async (base, dbPath) => {
      const ownerJar = cookieJar();
      await post(ownerJar, base, "/api/register", registrationBody({ email: "ira@pine-ledger.example", name: "Ira Cole" }));
      const verifyToken = linkToken((await mailbox(ownerJar, base, "ira@pine-ledger.example")).body.messages[0].linkPath, base);
      await post(ownerJar, base, "/api/email-verification", { token: verifyToken });
      await post(ownerJar, base, "/api/onboarding/firm", {
        firmName: "Ira Advisors",
        businessType: "advisory",
        country: "US",
        timeZone: "America/Los_Angeles",
        accountingMethod: "accrual",
        fiscalYearStart: 1,
      });
      const client = await post(ownerJar, base, "/api/clients", { name: "Harbor Goods", businessType: "LLC" });
      const clientId = client.body.client.id;
      await post(ownerJar, base, "/api/onboarding/enter", {});

      const invited = await post(ownerJar, base, `/api/clients/${clientId}/invitations`, {
        name: "Quinn Hart",
        email: "quinn@harbor-goods.example",
      });
      assert.equal(invited.response.status, 201);
      assert.equal(invited.body.invitation.status, "open");
      assert.equal(invited.body.invitation.token, undefined);
      assert.match(invited.body.message, /not configured/);
      const firstToken = linkToken((await mailbox(ownerJar, base, "quinn@harbor-goods.example")).body.messages[0].linkPath, base);
      assert.equal(JSON.stringify(invited.body).includes(firstToken), false);

      const second = await post(ownerJar, base, `/api/clients/${clientId}/invitations`, {
        name: "Quinn Hart",
        email: "quinn@harbor-goods.example",
      });
      assert.equal(second.response.status, 201);
      const latestToken = linkToken((await mailbox(ownerJar, base, "quinn@harbor-goods.example")).body.messages.at(-1).linkPath, base);
      const revokedByResend = await post(cookieJar(), base, "/api/invitations/preview", { token: firstToken });
      assert.equal(revokedByResend.response.status, 400);
      assert.match(revokedByResend.body.error, /revoked/);

      const preview = await post(cookieJar(), base, "/api/invitations/preview", { token: latestToken });
      assert.equal(preview.response.status, 200);
      assert.equal(preview.body.email, "quinn@harbor-goods.example");
      assert.equal(preview.body.firmName, "Ira Advisors");
      assert.equal(preview.body.clientName, "Harbor Goods");
      assert.equal(preview.body.token, undefined);

      const wrongEmail = await post(cookieJar(), base, "/api/invitations/accept", {
        token: latestToken,
        email: "other@harbor-goods.example",
        name: "Quinn Hart",
        password: "ledgerly-quinn",
        confirmPassword: "ledgerly-quinn",
      });
      assert.equal(wrongEmail.response.status, 400);

      const accepted = await post(cookieJar(), base, "/api/invitations/accept", {
        token: latestToken,
        name: "Quinn Hart",
        password: "ledgerly-quinn",
        confirmPassword: "ledgerly-quinn",
      });
      assert.equal(accepted.response.status, 200);
      assert.equal(accepted.body.portal, true);
      assert.equal(accepted.body.user.role, "client");
      assert.equal(accepted.body.user.roleLabel, "Business Client");
      assert.equal(accepted.body.client.name, "Harbor Goods");
      assert.equal(accepted.body.members, undefined);
      const clientJar = cookieJar();
      const clientSignIn = await post(clientJar, base, "/api/session", { email: "quinn@harbor-goods.example", password: "ledgerly-quinn" });
      assert.equal(clientSignIn.response.status, 200);
      const reused = await post(cookieJar(), base, "/api/invitations/accept", {
        token: latestToken,
        name: "Quinn Hart",
        password: "ledgerly-quinn",
        confirmPassword: "ledgerly-quinn",
      });
      assert.equal(reused.response.status, 400);
      assert.match(reused.body.error, /already used/);
      const guessed = await post(cookieJar(), base, "/api/invitations/accept", {
        token: "not-a-real-invitation-token-value",
        name: "Quinn Hart",
        password: "ledgerly-quinn",
        confirmPassword: "ledgerly-quinn",
      });
      assert.equal(guessed.response.status, 400);

      const note = "Internal review note for Harbor Goods only";
      const stored = await post(ownerJar, base, "/api/documents", {
        clientId,
        name: "internal-note.txt",
        mediaType: "text/plain",
        contentBase64: Buffer.from("synthetic file").toString("base64"),
      });
      assert.equal(stored.response.status, 201);
      const noted = await post(ownerJar, base, `/api/documents/${stored.body.file.id}/notes`, { body: note });
      assert.equal(noted.response.status, 201);
      for (const pathname of ["/api/tasks", "/api/ledger", "/api/clients", "/api/invitations", "/api/onboarding", "/api/documents/library"]) {
        const hidden = await clientJar.fetch(`${base}${pathname}`);
        assert.equal(hidden.status, 404, pathname);
      }
      const portal = await (await clientJar.fetch(`${base}/api/portal`)).json();
      assert.equal(JSON.stringify(portal).includes(note), false);
      assert.equal(JSON.stringify(portal).includes("Ira Cole"), false);
      assert.equal(portal.files.some((file) => file.name === "internal-note.txt"), true);

      const otherInvite = await post(ownerJar, base, `/api/clients/${clientId}/invitations`, {
        name: "Ned Moss",
        email: "ned@harbor-goods.example",
      });
      const nedToken = linkToken((await mailbox(ownerJar, base, "ned@harbor-goods.example")).body.messages[0].linkPath, base);
      const olivia = cookieJar();
      await post(olivia, base, "/api/session", firms.northstar.owner);
      const foreignRevoke = await post(olivia, base, `/api/invitations/${otherInvite.body.invitation.id}/revoke`, {});
      assert.equal(foreignRevoke.response.status, 404);
      const foreignList = await (await olivia.fetch(`${base}/api/invitations`)).json();
      assert.equal(JSON.stringify(foreignList).includes("ned@harbor-goods.example"), false);

      const revoked = await post(ownerJar, base, `/api/invitations/${otherInvite.body.invitation.id}/revoke`, {});
      assert.equal(revoked.response.status, 200);
      assert.equal(revoked.body.invitation.status, "revoked");
      const afterRevoke = await post(cookieJar(), base, "/api/invitations/accept", {
        token: nedToken,
        name: "Ned Moss",
        password: "ledgerly-ned-1",
        confirmPassword: "ledgerly-ned-1",
      });
      assert.equal(afterRevoke.response.status, 400);
      assert.match(afterRevoke.body.error, /revoked/);

      const expiring = await post(ownerJar, base, `/api/clients/${clientId}/invitations`, {
        name: "Eve Moss",
        email: "eve@harbor-goods.example",
      });
      const eveToken = linkToken((await mailbox(ownerJar, base, "eve@harbor-goods.example")).body.messages[0].linkPath, base);
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE client_invitations SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", expiring.body.invitation.id);
      db.close();
      const expired = await post(cookieJar(), base, "/api/invitations/accept", {
        token: eveToken,
        name: "Eve Moss",
        password: "ledgerly-eve-1",
        confirmPassword: "ledgerly-eve-1",
      });
      assert.equal(expired.response.status, 400);
      assert.match(expired.body.error, /expired/);

      const deactivated = await post(ownerJar, base, `/api/clients/${clientId}/portal-access`, {
        email: "quinn@harbor-goods.example",
        status: "deactivated",
      });
      assert.equal(deactivated.response.status, 200);
      const after = await clientJar.fetch(`${base}/api/portal`);
      assert.notEqual(after.status, 200);
      assert.equal((await after.json()).files, undefined);
      const denied = await post(cookieJar(), base, "/api/session", { email: "quinn@harbor-goods.example", password: "ledgerly-quinn" });
      assert.equal(denied.response.status, 403);
      assert.match(denied.body.error, /deactivated/);
    });
  });

  await t.test("employee roles are enforced and a second membership does not open another firm", async () => {
    await withServer(async (base, dbPath) => {
      const olivia = cookieJar();
      const signedIn = await post(olivia, base, "/api/session", firms.northstar.owner);
      assert.equal(signedIn.response.status, 200);
      const seats = await olivia.fetch(`${base}/api/subscription`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatLimit: 12 }),
      });
      assert.equal(seats.status, 200);
      const haven = signedIn.body.clients.find((client) => client.name === "Haven Coffee Roasters");

      async function invite(role, email) {
        const response = await post(olivia, base, "/api/members", {
          name: role,
          email,
          role,
          password: "ledgerly-role-1",
        });
        assert.equal(response.response.status, 201, response.body.error || role);
        return cookieJar();
      }

      const administrator = await invite("administrator", "ada@northstarcreative.co");
      const accountant = await invite("accountant", "alex@northstarcreative.co");
      const bookkeeper = await invite("bookkeeper", "blair@northstarcreative.co");
      const readonly = await invite("readonly", "robin@northstarcreative.co");
      await post(administrator, base, "/api/session", { email: "ada@northstarcreative.co", password: "ledgerly-role-1" });
      await post(accountant, base, "/api/session", { email: "alex@northstarcreative.co", password: "ledgerly-role-1" });
      await post(bookkeeper, base, "/api/session", { email: "blair@northstarcreative.co", password: "ledgerly-role-1" });
      await post(readonly, base, "/api/session", { email: "robin@northstarcreative.co", password: "ledgerly-role-1" });

      const ledger = await (await readonly.fetch(`${base}/api/ledger`)).json();
      const entry = {
        entryDate: "2026-11-03",
        memo: "Role check",
        lines: [
          { accountId: ledger.accounts.find((account) => account.code === "1000").id, debit: "10.00", credit: "" },
          { accountId: ledger.accounts.find((account) => account.code === "4000").id, debit: "", credit: "10.00" },
        ],
      };
      const readonlyPost = await post(readonly, base, "/api/journal-entries", entry);
      assert.equal(readonlyPost.response.status, 403);
      const readonlyLedger = await readonly.fetch(`${base}/api/ledger`);
      assert.equal(readonlyLedger.status, 200);
      const bookPost = await post(bookkeeper, base, "/api/journal-entries", entry);
      assert.equal(bookPost.response.status, 201);

      const staff = cookieJar();
      await post(staff, base, "/api/session", firms.northstar.members.find((member) => member.email === "sam@northstarcreative.co"));
      const staffInvite = await post(staff, base, `/api/clients/${haven.id}/invitations`, { name: "Pat", email: "pat@haven.example" });
      assert.equal(staffInvite.response.status, 403);
      const accountantInvite = await post(accountant, base, `/api/clients/${haven.id}/invitations`, { name: "Pat", email: "pat@haven.example" });
      assert.equal(accountantInvite.response.status, 201);
      const accountantSeats = await accountant.fetch(`${base}/api/subscription`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatLimit: 12 }),
      });
      assert.equal(accountantSeats.status, 403);
      const adminInvite = await post(administrator, base, "/api/members", {
        name: "Casey Book",
        email: "casey.book@northstarcreative.co",
        role: "bookkeeper",
        password: "ledgerly-role-1",
      });
      assert.equal(adminInvite.response.status, 201);

      const jordan = cookieJar();
      const harbor = await post(jordan, base, "/api/session", firms.harbor.owner);
      const harborClient = harbor.body.client.id;
      const hidden = await olivia.fetch(`${base}/api/clients/${harborClient}`);
      assert.equal(hidden.status, 404);
      const anonymous = await fetch(`${base}/api/tasks`);
      assert.equal(anonymous.status, 401);
      const anonymousLedger = await fetch(`${base}/api/ledger`);
      assert.equal(anonymousLedger.status, 401);

      const db = new DatabaseSync(dbPath);
      const oliviaRow = db.prepare("SELECT id FROM users WHERE email = ?").get(firms.northstar.owner.email);
      const harborFirm = db.prepare("SELECT id FROM firms WHERE name = ?").get("Harbor Street Advisors");
      db.prepare(
        "INSERT INTO memberships (id, user_id, firm_id, role, status, created_at) VALUES (?, ?, ?, 'staff', 'active', ?)",
      ).run(randomUUID(), oliviaRow.id, harborFirm.id, new Date().toISOString());
      db.close();
      const still = await (await olivia.fetch(`${base}/api/session`)).json();
      assert.equal(still.firm.name, "Northstar");
      assert.equal(still.clients.some((client) => client.name === "Cedar & Pine Goods"), false);
      assert.equal((await olivia.fetch(`${base}/api/clients/${harborClient}`)).status, 404);
    });
  });

  await t.test("login is rate limited, cross-site posts are rejected, and the dev mailbox can be turned off", async () => {
    await withServer(async (base) => {
      const sameOrigin = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email: firms.northstar.owner.email, password: firms.northstar.owner.password }),
      });
      assert.equal(sameOrigin.status, 200);
      const jar = cookieJar();
      const wrong = await post(jar, base, "/api/session", { email: "rate@pine-ledger.example", password: "wrong-password" });
      assert.equal(wrong.response.status, 401);
      const limited = await post(jar, base, "/api/session", { email: "rate@pine-ledger.example", password: "wrong-password" });
      assert.equal(limited.response.status, 429);
      assert.match(limited.body.error, /Too many attempts/);
      assert.equal(JSON.stringify(limited.body).includes("wrong-password"), false);

      const evil = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: firms.northstar.owner.email, password: firms.northstar.owner.password }),
      });
      assert.equal(evil.status, 403);
      assert.match((await evil.json()).error, /Cross-site/);
    }, { rateLimits: { login: { limit: 2, windowMs: 60_000 } }, rateScope: "login-tight" });

    await withServer(async (base) => {
      const jar = cookieJar();
      const registered = await post(jar, base, "/api/register", registrationBody({ email: "hidden@pine-ledger.example", name: "Hidden Quinn" }));
      assert.equal(registered.response.status, 201);
      assert.equal(registered.body.devMailbox, false);
      assert.equal(JSON.stringify(registered.body).toLowerCase().includes("token"), false);
      assert.equal((await jar.fetch(`${base}/api/dev/mailbox?email=hidden@pine-ledger.example`)).status, 404);
    }, { devMailbox: false, rateScope: "mailbox-off" });
  });
});
