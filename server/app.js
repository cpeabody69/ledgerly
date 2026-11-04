import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createClient, findClient, inviteMember, loadSession, openDatabase, selectClient, sessionPayload, signIn, signOut } from "./db.js";
import { listFirm } from "./clients.js";
import { createDocumentRequest, listDocuments, readDocument, removeDocument, storeDocument } from "./documents.js";
import { listPortal, readPortalDocument, submitPortalFile } from "./portal.js";
import { createExpense, listExpenses, updateReceiptSetting } from "./expenses.js";
import { createTimeEntry, createWork, invoiceTime, listTime, readTimeEntry, releaseInvoicedTime } from "./time.js";
import { createInvoice, discardInvoice, listInvoices, recordPayment, sendInvoice, voidInvoice } from "./invoices.js";
import { getJournalEntry, postJournalEntry, readLedger } from "./ledger.js";
import { bulkTransactions, categorizeTransaction, completeReconciliation, createBankAccount, createTransaction, excludeTransaction, importTransactions, listBanking, listTransactions } from "./banking.js";
import { readStatements } from "./statements.js";
import { addTaxNote, readTax, readTaxWorkpaper, storeTaxWorkpaper, updateTax } from "./tax.js";
import { approveAssistant, askAssistant, listAssistant } from "./assistant.js";

const COOKIE = "ledgerly_session";

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sendBytes(res, file) {
  const name = file.name.replace(/["\r\n]/g, "");
  res.writeHead(200, {
    "content-type": file.mediaType,
    "content-length": file.bytes.length,
    "content-disposition": `inline; filename="${name}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(file.bytes);
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

  if (session?.portal) {
    if (req.method === "DELETE" && pathname === "/api/session") {
      signOut(db, session);
      send(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
      return;
    }
    if (req.method === "GET" && pathname === "/api/portal") {
      const result = listPortal(db, session, url.searchParams.get("clientId"));
      if (result.error) send(res, result.status, { error: result.error });
      else send(res, result.status, result.payload);
      return;
    }
    if (req.method === "POST" && pathname === "/api/portal/files") {
      const result = submitPortalFile(db, session, await readBody(req));
      if (result.error) send(res, result.status, { error: result.error });
      else send(res, result.status, result.payload);
      return;
    }
    const portalDocument = pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (portalDocument && req.method === "GET") {
      const file = readPortalDocument(db, session, decodeURIComponent(portalDocument[1]));
      if (!file) send(res, 404, { error: "File not found." });
      else sendBytes(res, file);
      return;
    }
    send(res, 404, { error: "Not found." });
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
    const result = listFirm(db, session);
    send(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && pathname === "/api/clients") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = createClient(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (req.method === "POST" && pathname === "/api/document-requests") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = createDocumentRequest(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/documents" && (req.method === "GET" || req.method === "POST")) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = req.method === "GET"
      ? listDocuments(db, session, url.searchParams.get("clientId"))
      : storeDocument(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/expenses" && (req.method === "GET" || req.method === "POST")) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = req.method === "GET" ? listExpenses(db, session) : createExpense(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (req.method === "PATCH" && pathname === "/api/firm") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = updateReceiptSetting(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/invoices" && (req.method === "GET" || req.method === "POST")) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = req.method === "GET" ? listInvoices(db, session) : createInvoice(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  const invoiceAction = pathname.match(/^\/api\/invoices\/([^/]+)\/(send|payments|void)$/);
  if (invoiceAction && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const id = decodeURIComponent(invoiceAction[1]);
    const result = invoiceAction[2] === "send"
      ? sendInvoice(db, session, id)
      : invoiceAction[2] === "payments"
        ? recordPayment(db, session, id, await readBody(req))
        : voidInvoice(db, session, id);
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  const invoiceMatch = pathname.match(/^\/api\/invoices\/([^/]+)$/);
  if (invoiceMatch && req.method === "DELETE") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const invoiceId = decodeURIComponent(invoiceMatch[1]);
    const result = discardInvoice(db, session, invoiceId);
    if (!result.error) releaseInvoicedTime(db, session, invoiceId);
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/time" && req.method === "GET") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = listTime(db, session);
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/time" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = createTimeEntry(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/time/invoice" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = invoiceTime(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/work" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = createWork(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  const timeMatch = pathname.match(/^\/api\/time\/([^/]+)$/);
  if (timeMatch && req.method === "GET") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = readTimeEntry(db, session, decodeURIComponent(timeMatch[1]));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (documentMatch && (req.method === "GET" || req.method === "DELETE")) {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const id = decodeURIComponent(documentMatch[1]);
    if (req.method === "DELETE") {
      const result = removeDocument(db, session, id);
      if (result.error) send(res, result.status, { error: result.error });
      else send(res, result.status, result.payload);
      return;
    }
    const file = readDocument(db, session, id);
    if (!file) send(res, 404, { error: "File not found." });
    else sendBytes(res, file);
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

  if (pathname === "/api/tax" && req.method === "GET") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = readTax(db, session, url.searchParams.get("clientId"));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/tax" && req.method === "PATCH") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = updateTax(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/tax/notes" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = addTaxNote(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/tax/workpapers" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = storeTaxWorkpaper(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  const workpaperMatch = pathname.match(/^\/api\/tax\/workpapers\/([^/]+)$/);
  if (workpaperMatch && req.method === "GET") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const file = readTaxWorkpaper(db, session, decodeURIComponent(workpaperMatch[1]));
    if (!file) send(res, 404, { error: "File not found." });
    else sendBytes(res, file);
    return;
  }

  if (pathname === "/api/assistant" && req.method === "GET") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = listAssistant(db, session, url.searchParams.get("clientId"));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/assistant" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = await askAssistant(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
    return;
  }

  if (pathname === "/api/assistant/approvals" && req.method === "POST") {
    if (!session) {
      send(res, 401, { error: "Sign in required." });
      return;
    }
    const result = approveAssistant(db, session, await readBody(req));
    if (result.error) send(res, result.status, { error: result.error });
    else send(res, result.status, result.payload);
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
