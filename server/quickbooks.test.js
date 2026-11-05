import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { decryptToken } from "./quickbooks/crypto.js";
import { loadQuickBooksEnv } from "./quickbooks/config.js";
import { rememberQuickBooksId } from "./quickbooks/store.js";

const ENV_KEYS = [
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_REDIRECT_URI",
  "QUICKBOOKS_ENV",
  "QUICKBOOKS_WEBHOOK_VERIFIER",
];
const CLIENT_ID = "qb-client-id-test";
const SECRET = "qb-client-secret-value-test";
const REDIRECT = "http://127.0.0.1/api/quickbooks/callback";
const VERIFIER = "qb-webhook-verifier-value-test";
const TOKEN = "qb-access-token-value-test";
const REFRESH = "qb-refresh-token-value-test";
const REALM = "9341451900000123";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const FORBIDDEN_KEY = /^(access_token|refresh_token|accessToken|refreshToken|client_secret|clientSecret|id_token|idToken|token|verifier|webhookVerifier|authorization|access_token_enc|refresh_token_enc)$/;

function cookieJar() {
  const cookies = new Map();
  return {
    async fetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookies.size) headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      const response = await fetch(url, { ...options, headers, redirect: options.redirect });
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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-quickbooks-"));
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

async function sendJson(jar, base, method, pathname, payload) {
  const response = await jar.fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body, text };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function assertPublic(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [TOKEN, REFRESH, SECRET, VERIFIER]) {
    assert.equal(text.includes(secret), false);
  }
  if (typeof value === "string" || !value || typeof value !== "object") return;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, nested] of Object.entries(node)) {
      assert.equal(FORBIDDEN_KEY.test(key), false, key);
      walk(nested);
    }
  };
  walk(value);
}

function importCount(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM quickbooks_imports").get().count;
  } finally {
    db.close();
  }
}

test("quickbooks connects only from an Intuit token and keeps firms apart", async () => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalConsole = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, console[level]]));
  const logs = [];
  const calls = [];
  const mode = { refresh: "" };
  for (const key of ENV_KEYS) delete process.env[key];
  for (const level of Object.keys(originalConsole)) {
    console[level] = (...args) => {
      logs.push(args.map((part) => String(part)).join(" "));
      return originalConsole[level](...args);
    };
  }
  const seen = [];
  try {
    const envDir = await mkdtemp(path.join(tmpdir(), "ledgerly-quickbooks-env-"));
    const envFile = path.join(envDir, ".env");
    process.env.QUICKBOOKS_CLIENT_ID = "already-set";
    writeFileSync(envFile, [
      "QUICKBOOKS_CLIENT_ID=from-file",
      "QUICKBOOKS_CLIENT_SECRET=from-file-secret",
      "QUICKBOOKS_REDIRECT_URI=https://example.test/api/quickbooks/callback",
      "QUICKBOOKS_ENV=sandbox",
      "QUICKBOOKS_WEBHOOK_VERIFIER=from-file-verifier",
      "OTHER=1",
    ].join("\n"));
    delete process.env.OTHER;
    loadQuickBooksEnv(envFile);
    assert.equal(process.env.QUICKBOOKS_CLIENT_ID, "already-set");
    assert.equal(process.env.QUICKBOOKS_CLIENT_SECRET, "from-file-secret");
    assert.equal(process.env.QUICKBOOKS_ENV, "sandbox");
    assert.equal(process.env.OTHER, undefined);
    for (const key of ENV_KEYS) delete process.env[key];
    await rm(envDir, { recursive: true, force: true });

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.startsWith("http://127.0.0.1") || target.startsWith("http://localhost")) return originalFetch(url, options);
      calls.push({ url: target, body: typeof options.body === "string" ? options.body : "" });
      if (target.startsWith("https://quickbooks.api.intuit.com")) throw new Error("refused production QuickBooks host");
      if (target === TOKEN_URL) {
        const params = new URLSearchParams(options.body || "");
        if (params.get("grant_type") === "refresh_token") {
          if (mode.refresh === "empty") return jsonResponse({ token_type: "bearer" });
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
        if (params.get("code") === "pretend") return jsonResponse({ connected: true, companyName: "Fake Co" });
        if (params.get("code") === "notoken") return jsonResponse({ token_type: "bearer", expires_in: 3600 });
        if (params.get("code") === "real-auth-code") {
          return jsonResponse({
            token_type: "bearer",
            access_token: TOKEN,
            refresh_token: REFRESH,
            expires_in: 3600,
            x_refresh_token_expires_in: 8726400,
          });
        }
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (target.startsWith("https://sandbox-quickbooks.api.intuit.com/v3/company/") && target.includes("/companyinfo/")) {
        return jsonResponse({ CompanyInfo: { CompanyName: "Sandbox Company", Id: "1" } });
      }
      if (target.startsWith("https://sandbox-quickbooks.api.intuit.com/v3/company/") && target.includes("/query")) {
        const query = new URL(target).searchParams.get("query") || "";
        if (query.includes("from Customer")) {
          return jsonResponse({ QueryResponse: { Customer: [{ Id: "10", DisplayName: "Ada" }] } });
        }
        return jsonResponse({ QueryResponse: {} });
      }
      if (target === "https://developer.api.intuit.com/v2/oauth2/tokens/revoke") return new Response(null, { status: 200 });
      throw new Error(`unexpected QuickBooks URL ${target}`);
    };

    await withServer(async (base, dbPath) => {
      const olivia = cookieJar();
      const signedIn = await signIn(olivia, base, firms.northstar.owner);
      assert.equal(signedIn.response.status, 200);
      const unsigned = await fetch(`${base}/api/quickbooks`);
      assert.equal(unsigned.status, 401);

      const missing = await sendJson(olivia, base, "GET", "/api/quickbooks");
      seen.push(missing.text);
      assertPublic(missing.body);
      assert.equal(missing.body.configured, false);
      assert.equal(missing.body.env, null);
      assert.equal(missing.body.connection.status, "not_connected");
      assert.equal(missing.body.connection.companyName, "");
      assert.match(missing.body.notice, /not configured/i);
      const refused = await sendJson(olivia, base, "POST", "/api/quickbooks/connect");
      seen.push(refused.text);
      assert.equal(refused.response.status, 400);
      assert.match(refused.body.error, /not configured/i);
      assert.equal(calls.length, 0);

      process.env.QUICKBOOKS_CLIENT_ID = CLIENT_ID;
      process.env.QUICKBOOKS_CLIENT_SECRET = SECRET;
      process.env.QUICKBOOKS_REDIRECT_URI = REDIRECT;
      process.env.QUICKBOOKS_ENV = "production";
      const production = await sendJson(olivia, base, "POST", "/api/quickbooks/connect");
      seen.push(production.text);
      assert.equal(production.response.status, 400);
      assert.match(production.body.error, /sandbox/i);
      assert.equal(calls.length, 0);
      const stillMissing = await sendJson(olivia, base, "GET", "/api/quickbooks");
      seen.push(stillMissing.text);
      assert.notEqual(stillMissing.body.connection.status, "connected");

      process.env.QUICKBOOKS_ENV = "sandbox";
      process.env.QUICKBOOKS_WEBHOOK_VERIFIER = VERIFIER;
      const started = await sendJson(olivia, base, "POST", "/api/quickbooks/connect");
      seen.push(started.text);
      assertPublic(started.body);
      assert.equal(started.response.status, 200);
      const authorization = new URL(started.body.authorizationUrl);
      assert.equal(authorization.origin, "https://appcenter.intuit.com");
      assert.equal(authorization.pathname, "/connect/oauth2");
      assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(authorization.searchParams.get("response_type"), "code");
      assert.equal(calls.length, 0);

      async function callback(code, realmId = REALM) {
        const params = new URLSearchParams({ code, state: authorization.searchParams.get("state"), realmId });
        const response = await olivia.fetch(`${base}/api/quickbooks/callback?${params}`, { redirect: "manual" });
        const text = await response.text();
        seen.push(`${response.headers.get("location") || ""}\n${text}`);
        return response;
      }

      const pretended = await callback("pretend");
      assert.match(pretended.headers.get("location") || "", /quickbooks=error/);
      assert.match(pretended.headers.get("location") || "", /missing_token/);
      const afterPretend = await sendJson(olivia, base, "GET", "/api/quickbooks");
      seen.push(afterPretend.text);
      assertPublic(afterPretend.body);
      assert.notEqual(afterPretend.body.connection.status, "connected");
      assert.equal(afterPretend.body.connection.companyName, "");
      assert.equal(afterPretend.body.connection.companyName === "Fake Co", false);

      const again = await sendJson(olivia, base, "POST", "/api/quickbooks/connect");
      seen.push(again.text);
      const secondUrl = new URL(again.body.authorizationUrl);
      const notokenParams = new URLSearchParams({
        code: "notoken",
        state: secondUrl.searchParams.get("state"),
        realmId: REALM,
      });
      const notoken = await olivia.fetch(`${base}/api/quickbooks/callback?${notokenParams}`, { redirect: "manual" });
      seen.push(`${notoken.headers.get("location") || ""}\n${await notoken.text()}`);
      const afterNotoken = await sendJson(olivia, base, "GET", "/api/quickbooks");
      seen.push(afterNotoken.text);
      assertPublic(afterNotoken.body);
      assert.notEqual(afterNotoken.body.connection.status, "connected");

      const third = await sendJson(olivia, base, "POST", "/api/quickbooks/connect");
      seen.push(third.text);
      const thirdUrl = new URL(third.body.authorizationUrl);
      const realParams = new URLSearchParams({
        code: "real-auth-code",
        state: thirdUrl.searchParams.get("state"),
        realmId: REALM,
      });
      const connectedResponse = await olivia.fetch(`${base}/api/quickbooks/callback?${realParams}`, { redirect: "manual" });
      seen.push(`${connectedResponse.headers.get("location") || ""}\n${await connectedResponse.text()}`);
      assert.match(connectedResponse.headers.get("location") || "", /quickbooks=connected/);
      const connected = await sendJson(olivia, base, "GET", "/api/quickbooks");
      seen.push(connected.text);
      assertPublic(connected.body);
      assert.equal(connected.body.connection.status, "connected");
      assert.equal(connected.body.connection.companyName, "Sandbox Company");
      assert.equal(connected.body.connection.realmId, REALM);
      assert.equal(connected.body.connection.lastSyncAt, null);
      assert.equal(calls.some((call) => call.url === TOKEN_URL && call.body.includes("grant_type=authorization_code")), true);
      assert.equal(calls.some((call) => call.url.startsWith("https://quickbooks.api.intuit.com")), false);

      const storedDb = new DatabaseSync(dbPath);
      const stored = storedDb.prepare("SELECT access_token_enc, refresh_token_enc, token_type FROM quickbooks_oauth").get();
      assert.equal(stored.access_token_enc.startsWith("v1."), true);
      assert.equal(stored.access_token_enc.includes(TOKEN), false);
      assert.equal(stored.refresh_token_enc.includes(REFRESH), false);
      assert.equal(decryptToken(stored.access_token_enc, SECRET), TOKEN);
      assert.equal(decryptToken(stored.refresh_token_enc, SECRET), REFRESH);
      storedDb.close();

      const jordan = cookieJar();
      const harbor = await signIn(jordan, base, firms.harbor.owner);
      assert.equal(harbor.response.status, 200);
      const otherFirm = await sendJson(jordan, base, "GET", "/api/quickbooks");
      seen.push(otherFirm.text);
      assertPublic(otherFirm.body);
      assert.equal(otherFirm.body.connection.status, "not_connected");
      assert.equal(otherFirm.body.connection.companyName, "");
      assert.equal(otherFirm.body.connection.realmId, "");
      const otherDisconnect = await sendJson(jordan, base, "POST", "/api/quickbooks/disconnect", {
        connectionId: connected.body.connection.id,
      });
      seen.push(otherDisconnect.text);
      assert.equal(otherDisconnect.response.status, 404);
      const haven = signedIn.body.clients.find((client) => client.name === "Haven Coffee Roasters");
      const switched = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: haven.id });
      assert.equal(switched.response.status, 200);
      const otherClient = await sendJson(olivia, base, "GET", "/api/quickbooks");
      seen.push(otherClient.text);
      assertPublic(otherClient.body);
      assert.notEqual(otherClient.body.connection.status, "connected");
      assert.equal(otherClient.body.connection.companyName, "");
      const home = signedIn.body.clients.find((client) => client.name === "Northstar Creative");
      const restored = await sendJson(olivia, base, "PATCH", "/api/session", { clientId: home.id });
      assert.equal(restored.response.status, 200);

      const raw = JSON.stringify({
        eventNotifications: [{
          realmId: REALM,
          dataChangeEvent: { entities: [{ name: "Customer", id: "10", operation: "Create" }] },
        }],
      });
      const signature = createHmac("sha256", VERIFIER).update(raw).digest("base64");
      const wrong = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
      const invalid = await fetch(`${base}/api/quickbooks/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "intuit-signature": wrong },
        body: raw,
      });
      const invalidText = await invalid.text();
      seen.push(invalidText);
      assert.equal(invalid.status, 401);
      assert.match(invalidText, /signature/i);
      assert.equal(importCount(dbPath), 0);
      const eventsBefore = new DatabaseSync(dbPath);
      const beforeEvents = eventsBefore.prepare("SELECT COUNT(*) AS count FROM quickbooks_webhook_events").get().count;
      eventsBefore.close();
      assert.equal(beforeEvents, 0);
      const valid = await fetch(`${base}/api/quickbooks/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "intuit-signature": signature },
        body: raw,
      });
      const validText = await valid.text();
      seen.push(validText);
      assert.equal(valid.status, 200);
      assert.equal(importCount(dbPath), 0);

      delete process.env.QUICKBOOKS_WEBHOOK_VERIFIER;
      const unverified = await fetch(`${base}/api/quickbooks/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "intuit-signature": signature },
        body: raw,
      });
      seen.push(await unverified.text());
      assert.equal(unverified.status, 401);
      process.env.QUICKBOOKS_WEBHOOK_VERIFIER = VERIFIER;

      const ledgerBefore = await (await olivia.fetch(`${base}/api/ledger`)).json();
      const synced = await sendJson(olivia, base, "POST", "/api/quickbooks/sync", {
        connectionId: connected.body.connection.id,
      });
      seen.push(synced.text);
      assertPublic(synced.body);
      assert.equal(synced.response.status, 200);
      assert.equal(synced.body.sync.ok, true);
      assert.equal(synced.body.sync.results.find((row) => row.entity === "Customers").imported, 1);
      assert.equal(importCount(dbPath), 1);
      assert.ok(synced.body.connection.lastSyncAt);
      const ledgerAfter = await (await olivia.fetch(`${base}/api/ledger`)).json();
      assert.equal(ledgerAfter.entries.length, ledgerBefore.entries.length);

      const importDb = new DatabaseSync(dbPath);
      let duplicate;
      try {
        duplicate = rememberQuickBooksId(importDb, {
          firmId: signedIn.body.firm.id,
          clientId: home.id,
          connectionId: connected.body.connection.id,
          realmId: REALM,
          entityType: "Customer",
          qboId: "10",
        });
      } finally {
        importDb.close();
      }
      assert.equal(duplicate.ok, false);
      assert.equal(duplicate.status, 409);
      assert.match(duplicate.error, /already imported/i);
      const againSync = await sendJson(olivia, base, "POST", "/api/quickbooks/sync", {
        connectionId: connected.body.connection.id,
      });
      seen.push(againSync.text);
      assertPublic(againSync.body);
      assert.equal(againSync.body.sync.ok, false);
      assert.match(againSync.body.connection.history.find((row) => row.entity === "Customers").error, /already imported/i);
      assert.equal(importCount(dbPath), 1);

      const expire = new DatabaseSync(dbPath);
      expire.prepare("UPDATE quickbooks_oauth SET access_expires_at = ?").run("2000-01-01T00:00:00.000Z");
      expire.close();
      mode.refresh = "empty";
      const queriesBefore = calls.filter((call) => call.url.includes("/query")).length;
      const refreshFailed = await sendJson(olivia, base, "POST", "/api/quickbooks/sync", {
        connectionId: connected.body.connection.id,
      });
      seen.push(refreshFailed.text);
      assertPublic(refreshFailed.body);
      assert.equal(refreshFailed.response.status, 502);
      assert.notEqual(refreshFailed.body.connection.status, "connected");
      assert.equal(calls.filter((call) => call.url.includes("/query")).length, queriesBefore);
      assert.equal(importCount(dbPath), 1);

      const disconnected = await sendJson(olivia, base, "POST", "/api/quickbooks/disconnect", {
        connectionId: connected.body.connection.id,
      });
      seen.push(disconnected.text);
      assertPublic(disconnected.body);
      assert.equal(disconnected.response.status, 200);
      assert.equal(disconnected.body.connection.status, "disconnected");
      const cleared = new DatabaseSync(dbPath);
      const tokens = cleared.prepare("SELECT access_token_enc, refresh_token_enc FROM quickbooks_oauth").get();
      assert.equal(tokens.access_token_enc, "");
      assert.equal(tokens.refresh_token_enc, "");
      cleared.close();
      const harborStill = await sendJson(jordan, base, "GET", "/api/quickbooks");
      seen.push(harborStill.text);
      assert.equal(harborStill.body.connection.status, "not_connected");
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [level, fn] of Object.entries(originalConsole)) console[level] = fn;
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  const leaked = seen.join("\n") + logs.join("\n");
  for (const secret of [TOKEN, REFRESH, SECRET, VERIFIER]) assert.equal(leaked.includes(secret), false, secret);
});
