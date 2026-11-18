import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { firms } from "./accounts.js";
import { start } from "./app.js";
import { ASSISTANT_TOOLS } from "./assistant.js";

const MODEL_KEYS = ["LEDGERLY_MODEL_PROVIDER", "LEDGERLY_MODEL_API_KEY", "LEDGERLY_MODEL_URL", "LEDGERLY_MODEL_NAME"];

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
  const dir = await mkdtemp(path.join(tmpdir(), "ledgerly-assistant-"));
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

function withoutModelEnv(fn) {
  const saved = Object.fromEntries(MODEL_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MODEL_KEYS) delete process.env[key];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of MODEL_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test("a journal draft stays off the books, and post, approve, and file are refused", async () => {
  await withoutModelEnv(() => withServer(async (base, dbPath) => {
    const anonymous = await fetch(`${base}/api/assistant`);
    assert.equal(anonymous.status, 401);

    const olivia = cookieJar();
    const signedIn = await signIn(olivia, base, firms.northstar.owner);
    assert.equal(signedIn.response.status, 200);
    const clientId = signedIn.body.client.id;
    const before = await (await olivia.fetch(`${base}/api/ledger?clientId=${clientId}`)).json();
    assert.equal(before.trialBalance.debitsCents, 0);

    const opened = await (await olivia.fetch(`${base}/api/assistant?clientId=${clientId}`)).json();
    assert.equal(opened.configured, false);
    assert.equal(opened.provider, null);
    assert.match(opened.notice, /external model is not configured/i);
    assert.deepEqual(opened.tools, ASSISTANT_TOOLS);
    for (const banned of ["post", "approve", "file"]) {
      assert.equal(opened.tools.includes(banned), false, banned);
      assert.equal(opened.tools.some((tool) => tool.includes(banned)), false, banned);
    }

    const account = await postJson(olivia, base, "/api/bank-accounts", { name: "Operating checking", kind: "bank" });
    assert.equal(account.response.status, 201);
    const created = await postJson(olivia, base, "/api/transactions", {
      bankAccountId: account.body.accounts[0].id,
      postedOn: "2026-05-12",
      description: "Assistant fixture deposit",
      amount: "80.00",
    });
    assert.equal(created.response.status, 201);
    const request = await postJson(olivia, base, "/api/document-requests", { clientId, title: "Prior year organizer" });
    assert.equal(request.response.status, 201);

    const drafted = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "Draft a journal for the uncategorized deposit" });
    assert.equal(drafted.response.status, 200);
    assert.equal(drafted.body.sent, false);
    assert.equal(drafted.body.kind, "draft_journal");
    assert.match(drafted.body.answer, /external model is not configured/i);
    assert.match(drafted.body.answer, /Assistant fixture deposit/);
    assert.equal(drafted.body.draft.label, "AI-generated");
    assert.equal(drafted.body.draft.confidence, "low");
    assert.equal(drafted.body.draft.lines.length, 2);
    assert.equal(drafted.body.suggestions[0].label, "AI-generated");
    const unchanged = await (await olivia.fetch(`${base}/api/ledger?clientId=${clientId}`)).json();
    assert.equal(unchanged.trialBalance.debitsCents, 0);
    assert.equal(unchanged.entries.length, 0);

    const missing = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "List missing documents" });
    assert.equal(missing.response.status, 200);
    assert.match(missing.body.answer, /Prior year organizer/);
    assert.equal(missing.body.sent, false);

    let hits = 0;
    let sentBody = "";
    const sink = createServer((req, res) => {
      hits += 1;
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        sentBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tool: "summarize_activity" }));
      });
    });
    await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = sink.address().port;
    process.env.LEDGERLY_MODEL_PROVIDER = "configured-endpoint";
    process.env.LEDGERLY_MODEL_API_KEY = "synthetic-key";
    process.env.LEDGERLY_MODEL_URL = `http://127.0.0.1:${sinkPort}/model`;
    process.env.LEDGERLY_MODEL_NAME = "";
    try {
      const filed = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "File the tax return" });
      assert.equal(filed.response.status, 200);
      assert.equal(filed.body.kind, "refusal");
      assert.equal(filed.body.sent, false);
      assert.equal(filed.body.draft, null);
      assert.match(filed.body.answer, /can't file/i);
      const posted = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "Post this journal" });
      assert.equal(posted.body.kind, "refusal");
      assert.equal(posted.body.sent, false);
      const treatment = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "Approve a tax treatment for this client" });
      assert.equal(treatment.body.kind, "refusal");
      assert.equal(treatment.body.sent, false);
      assert.equal(hits, 0);
      const asked = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "Summarize activity" });
      assert.equal(asked.response.status, 200);
      assert.equal(hits, 1);
      assert.equal(asked.body.sent, true);
      assert.equal(asked.body.source, "model");
      assert.equal(asked.body.kind, "summarize_activity");
      const outbound = JSON.parse(sentBody);
      assert.equal(outbound.modelPreference, "reasoning");
      assert.equal(outbound.train, false);
      assert.equal(outbound.syntheticOnly, true);
      assert.equal(outbound.response_format.type, "json_schema");
      const toolNames = outbound.tools.map((tool) => tool.function.name);
      assert.deepEqual(toolNames, ASSISTANT_TOOLS);
      assert.equal(sentBody.includes("80.00"), false);
      assert.equal(sentBody.includes("synthetic-key"), false);
      assert.equal(sentBody.includes("scrypt"), false);
      const filedAgain = await postJson(olivia, base, "/api/assistant", { clientId, prompt: "File the return now" });
      assert.equal(filedAgain.body.sent, false);
      assert.equal(hits, 1);
    } finally {
      for (const key of MODEL_KEYS) delete process.env[key];
      await new Promise((resolve) => sink.close(resolve));
    }

    const still = await (await olivia.fetch(`${base}/api/ledger?clientId=${clientId}`)).json();
    assert.equal(still.trialBalance.debitsCents, 0);
    assert.equal(still.entries.length, 0);

    const approval = await postJson(olivia, base, "/api/assistant/approvals", {
      clientId,
      recommendationId: drafted.body.id,
    });
    assert.equal(approval.response.status, 201);
    assert.equal(approval.body.approval.actorName, "Olivia Martin");
    const afterApproval = await (await olivia.fetch(`${base}/api/ledger?clientId=${clientId}`)).json();
    assert.equal(afterApproval.trialBalance.debitsCents, 0);

    const person = await postJson(olivia, base, "/api/journal-entries", {
      entryDate: drafted.body.draft.entryDate,
      memo: drafted.body.draft.memo,
      lines: drafted.body.draft.lines.map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
    });
    assert.equal(person.response.status, 201);
    assert.equal(person.body.ledger.trialBalance.foots, true);
    assert.ok(person.body.ledger.trialBalance.debitsCents > 0);

    const db = new DatabaseSync(dbPath);
    const recommendations = db.prepare("SELECT kind, actor_user_id FROM assistant_recommendations").all();
    assert.ok(recommendations.some((row) => row.kind === "draft_journal" && row.actor_user_id === signedIn.body.user.id));
    assert.ok(recommendations.some((row) => row.kind === "refusal"));
    const approvals = db.prepare("SELECT actor_user_id FROM assistant_approvals").all();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].actor_user_id, signedIn.body.user.id);
    db.close();

    const harbor = cookieJar();
    await signIn(harbor, base, firms.harbor.owner);
    const hidden = await harbor.fetch(`${base}/api/assistant?clientId=${clientId}`);
    assert.equal(hidden.status, 404);
    const client = cookieJar();
    await signIn(client, base, firms.northstar.portal);
    for (const [pathname, method, payload] of [
      ["/api/assistant", "GET", null],
      ["/api/assistant", "POST", { prompt: "Draft a journal" }],
      ["/api/assistant/approvals", "POST", { recommendationId: drafted.body.id }],
    ]) {
      const response = await client.fetch(`${base}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      assert.equal(response.status, 404, `${method} ${pathname}`);
    }
  }));
});

test("the assistant keeps post, approve, and file out of its tools", () => {
  const server = readFileSync(new URL("./assistant.js", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../src/Assistant.jsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/Shell.jsx", import.meta.url), "utf8");
  assert.match(shell, /Ask about these books/);
  assert.doesNotMatch(shell, /coming soon/);
  assert.match(screen, /AI-generated/);
  assert.match(screen, /Use this draft/);
  assert.match(screen, /external model is not configured/);
  assert.doesNotMatch(server, /postJournalEntry/);
  for (const name of ["LEDGERLY_MODEL_PROVIDER", "LEDGERLY_MODEL_API_KEY", "LEDGERLY_MODEL_URL", "LEDGERLY_MODEL_NAME"]) {
    assert.match(server, new RegExp(name));
  }
  for (const banned of ["post", "approve", "file"]) {
    assert.equal(ASSISTANT_TOOLS.includes(banned), false);
  }
});
