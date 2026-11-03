import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findClient, inviteMember, loadSession, openDatabase, selectClient, sessionPayload, signIn, signOut } from "./db.js";
import { getJournalEntry, postJournalEntry, readLedger } from "./ledger.js";
import { bulkTransactions, categorizeTransaction, completeReconciliation, createBankAccount, createTransaction, excludeTransaction, importTransactions, listBanking, listTransactions } from "./banking.js";
import { readStatements } from "./statements.js";

const COOKIE = "ledgerly_session";

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function setSessionCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 24 * 60 * 60}`;
}

function clearSessionCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(Object.assign(new Error("Body is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, staticDir) {
  const url = new URL(req.url, "http://127.0.0.1");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const requested = path.normalize(path.join(staticDir, pathname));
  if (!requested.startsWith(staticDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  let target = requested;
  if (!existsSync(target) || statSync(target).isDirectory()) target = path.join(staticDir, "index.html");
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, { "content-type": types[path.extname(target)] || "application/octet-stream" });
  res.end(readFileSync(target));
}

async function handle(req, res, db, options) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) {
    if (options.staticDir) serveStatic(req, res, options.staticDir);
    else {
      send(res, 404, { error: "Not found." });
    }
    return;
  }

  const session = loadSession(db, readCookie(req, COOKIE));

  if (req.method === "POST" && pathname === "/api/session") {
    const body = await readBody(req);
    const signedIn = signIn(db, body.email, body.password);
    if (!signedIn) {
      send(res, 401, { error: "Email or password is incorrect." });
      return;
    }
    send(res, 200, signedIn.payload, { "set-cookie": setSessionCookie(signedIn.token) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/session") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    send(res, 200, sessionPayload(db, session));
    return;
  }

  if (req.method === "PATCH" && pathname === "/api/session") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const body = await readBody(req);
    const next = selectClient(db, session, body.clientId);
    if (!next) {
      send(res, 404, { error: "Client not found." });
      return;
    }
    send(res, 200, next);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/session") {
    if (session) signOut(db, session);
    send(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/clients") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    send(res, 200, { clients: sessionPayload(db, session).clients });
    return;
  }

  const clientMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (req.method === "GET" && clientMatch) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const client = findClient(db, session, decodeURIComponent(clientMatch[1]));
    if (!client) {
      send(res, 404, { error: "Client not found." });
      return;
    }
    send(res, 200, { client });
    return;
  }

  if (req.method === "GET" && pathname === "/api/statements") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = readStatements(db, session, {
      clientId: url.searchParams.get("clientId"),
      period: url.searchParams.get("period"),
      basis: url.searchParams.get("basis"),
    });
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (req.method === "GET" && pathname === "/api/ledger") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = readLedger(db, session, url.searchParams.get("clientId"));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && pathname === "/api/journal-entries") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const body = await readBody(req);
    const result = postJournalEntry(db, session, body);
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  const entryMatch = pathname.match(/^\/api\/journal-entries\/([^/]+)$/);
  if (req.method === "GET" && entryMatch) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = getJournalEntry(db, session, decodeURIComponent(entryMatch[1]));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, { entry: result.entry });
    return;
  }

  if (req.method === "GET" && pathname === "/api/transactions") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, listTransactions(db, session, { clientId: url.searchParams.get("clientId"), month: url.searchParams.get("month") }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/transactions/import") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, importTransactions(db, session, await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/transactions/bulk") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, bulkTransactions(db, session, await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/transactions") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, createTransaction(db, session, await readBody(req)));
    return;
  }

  const categorizeMatch = pathname.match(/^\/api\/transactions\/([^/]+)\/categorize$/);
  if (req.method === "POST" && categorizeMatch) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, categorizeTransaction(db, session, decodeURIComponent(categorizeMatch[1]), await readBody(req)));
    return;
  }

  const excludeMatch = pathname.match(/^\/api\/transactions\/([^/]+)\/exclude$/);
  if (req.method === "POST" && excludeMatch) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, excludeTransaction(db, session, decodeURIComponent(excludeMatch[1]), await readBody(req)));
    return;
  }

  if (req.method === "GET" && pathname === "/api/banking") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, listBanking(db, session, url.searchParams.get("clientId")));
    return;
  }

  if (req.method === "POST" && pathname === "/api/bank-accounts") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, createBankAccount(db, session, await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/reconciliations") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    sendResult(res, completeReconciliation(db, session, await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/members") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const body = await readBody(req);
    const result = inviteMember(db, session, body);
    if (result.error) {
      send(res, result.status, { error: result.error });
      return;
    }
    send(res, result.status, result.payload);
    return;
  }

  send(res, 404, { error: "Not found." });
}

function sendResult(res, result) {
  if (result.error) send(res, result.status, { error: result.error, ...(result.payload || {}) });
  else send(res, result.status, result.payload);
}

export function start(dbPath, port = 0, options = {}) {
  const db = openDatabase(dbPath);
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : null;
  const server = createServer((req, res) => {
    handle(req, res, db, { staticDir }).catch((error) => {
      const status = error.status || 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong." : error.message });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, db, port: server.address().port });
    });
  });
}
