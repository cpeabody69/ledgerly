import { randomUUID } from "node:crypto";
import { formatMoney } from "../shared/money.js";
import { addStatementLine } from "./banking.js";

const SANDBOX_ORIGIN = "https://sandbox.plaid.com";
const NOT_CONFIGURED = "Sandbox credentials are not configured.";
const SANDBOX_ONLY = "Plaid is limited to the sandbox. Set PLAID_ENV to sandbox.";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  item_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'error', 'disconnected')),
  error_message TEXT NOT NULL DEFAULT '',
  sync_cursor TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (firm_id, item_id)
);

CREATE TABLE IF NOT EXISTS plaid_accounts (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  plaid_item_id TEXT NOT NULL REFERENCES plaid_items(id),
  plaid_account_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  mask TEXT NOT NULL DEFAULT '',
  balance_cents INTEGER,
  available_cents INTEGER,
  UNIQUE (firm_id, plaid_account_id)
);

CREATE TABLE IF NOT EXISTS plaid_imported (
  firm_id TEXT NOT NULL REFERENCES firms(id),
  plaid_transaction_id TEXT NOT NULL,
  bank_transaction_id TEXT NOT NULL REFERENCES bank_transactions(id),
  PRIMARY KEY (firm_id, plaid_transaction_id)
);
`;

function fail(status, error) {
  return { status, error };
}

function httpUrl(value) {
  return /^https?:\/\//i.test(value) ? value : "";
}

export function plaidConfig(env = process.env) {
  const clientId = String(env.PLAID_CLIENT_ID || "").trim();
  const secret = String(env.PLAID_SECRET || "").trim();
  const plaidEnv = String(env.PLAID_ENV || "").trim();
  const redirectUri = httpUrl(String(env.PLAID_REDIRECT_URI || "").trim());
  const webhook = httpUrl(String(env.PLAID_WEBHOOK || "").trim());
  const keysPresent = Boolean(clientId && secret);
  const configured = keysPresent && plaidEnv === "sandbox";
  let notice = NOT_CONFIGURED;
  if (keysPresent && plaidEnv !== "sandbox") notice = SANDBOX_ONLY;
  if (configured) notice = "Plaid sandbox only. Imported lines stay for review until a person categorizes them.";
  return {
    clientId,
    secret,
    env: configured ? "sandbox" : "",
    redirectUri,
    webhook,
    configured,
    notice,
  };
}

export function ensurePlaid(db) {
  db.exec(SCHEMA);
}

function audit(db, session, action, entityId) {
  db.prepare(
    "INSERT INTO audit_events (id, firm_id, actor_user_id, action, client_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, 'plaid_item', ?, ?)",
  ).run(randomUUID(), session.firm_id, session.user_id, action, session.selected_client_id, entityId, new Date().toISOString());
}

function numberToCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const negative = value < 0;
  const [whole, frac] = Math.abs(value).toFixed(2).split(".");
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

function ledgerCentsFromPlaid(amount) {
  const cents = numberToCents(amount);
  if (cents === null || cents === 0) return null;
  return -cents;
}

async function plaidPost(config, path, body) {
  if (config.env !== "sandbox") throw Object.assign(new Error(SANDBOX_ONLY), { status: 400 });
  const response = await fetch(`${SANDBOX_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.client_id || config.clientId, secret: config.secret, ...body }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error_message === "string" && payload.error_message
      ? payload.error_message
      : "Plaid sandbox did not accept the request.";
    throw Object.assign(new Error(message), { status: 502 });
  }
  return payload;
}

function publicPayload(config, connections) {
  return {
    configured: config.configured,
    env: config.configured ? "sandbox" : null,
    notice: config.notice,
    connections,
  };
}

function loadConnections(db, session) {
  const items = db.prepare(
    `SELECT id, institution_name, status, error_message, updated_at
     FROM plaid_items
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at, institution_name`,
  ).all(session.firm_id, session.selected_client_id);
  if (!items.length) return [];
  const accounts = db.prepare(
    `SELECT plaid_accounts.id, plaid_accounts.plaid_item_id, plaid_accounts.bank_account_id, plaid_accounts.mask,
            plaid_accounts.balance_cents, plaid_accounts.available_cents,
            bank_accounts.name, bank_accounts.kind
     FROM plaid_accounts
     JOIN bank_accounts ON bank_accounts.id = plaid_accounts.bank_account_id
       AND bank_accounts.firm_id = plaid_accounts.firm_id
       AND bank_accounts.client_id = plaid_accounts.client_id
     WHERE plaid_accounts.firm_id = ? AND plaid_accounts.client_id = ?
     ORDER BY bank_accounts.name`,
  ).all(session.firm_id, session.selected_client_id);
  return items.map((item) => ({
    id: item.id,
    institutionName: item.institution_name,
    status: item.status,
    statusLabel: item.status === "connected" ? "Sandbox connected" : item.status === "error" ? "Sandbox error" : "Sandbox disconnected",
    error: item.error_message,
    updatedAt: item.updated_at,
    accounts: accounts.filter((account) => account.plaid_item_id === item.id).map((account) => ({
      id: account.id,
      name: account.name,
      mask: account.mask,
      kind: account.kind,
      kindLabel: account.kind === "card" ? "Card" : "Bank",
      bankAccountId: account.bank_account_id,
      balanceCents: account.balance_cents === null ? null : Number(account.balance_cents),
      balance: account.balance_cents === null ? "" : formatMoney(Number(account.balance_cents)),
      availableCents: account.available_cents === null ? null : Number(account.available_cents),
    })),
  }));
}

export function readPlaid(db, session) {
  ensurePlaid(db);
  const config = plaidConfig();
  return { status: 200, payload: publicPayload(config, loadConnections(db, session)) };
}

function requireConfigured() {
  const config = plaidConfig();
  if (!config.configured) return { config, error: fail(400, config.notice) };
  return { config, error: null };
}

export async function createLinkToken(db, session) {
  ensurePlaid(db);
  const { config, error } = requireConfigured();
  if (error) return error;
  const body = {
    client_name: "Ledgerly",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: session.user_id },
    products: ["transactions"],
  };
  if (config.redirectUri) body.redirect_uri = config.redirectUri;
  if (config.webhook) body.webhook = config.webhook;
  try {
    const created = await plaidPost(config, "/link/token/create", body);
    if (typeof created.link_token !== "string" || !created.link_token) {
      return fail(502, "Plaid sandbox did not return a link token.");
    }
    return { status: 200, payload: { linkToken: created.link_token, expiration: created.expiration || "" } };
  } catch (requestError) {
    return fail(requestError.status || 502, requestError.message);
  }
}

function itemFor(db, session, connectionId) {
  if (typeof connectionId !== "string" || !connectionId) return null;
  return db.prepare(
    "SELECT * FROM plaid_items WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(connectionId, session.firm_id, session.selected_client_id);
}

async function institutionName(config, institutionId) {
  if (!institutionId) return "Sandbox bank";
  try {
    const found = await plaidPost(config, "/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US"],
    });
    const name = found.institution?.name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "Sandbox bank";
  } catch {
    return "Sandbox bank";
  }
}

function rememberAccounts(db, session, itemRowId, accounts) {
  const now = new Date().toISOString();
  const map = new Map();
  for (const account of accounts || []) {
    const plaidAccountId = typeof account.account_id === "string" ? account.account_id : "";
    if (!plaidAccountId) continue;
    const kind = account.type === "credit" ? "card" : "bank";
    const ledgerCode = kind === "card" ? "2100" : "1000";
    const name = String(account.name || account.official_name || "Sandbox account").trim().slice(0, 80) || "Sandbox account";
    const mask = String(account.mask || "").slice(0, 8);
    const balanceCents = numberToCents(account.balances?.current);
    const availableCents = numberToCents(account.balances?.available);
    const existing = db.prepare(
      "SELECT id, client_id, bank_account_id FROM plaid_accounts WHERE firm_id = ? AND plaid_account_id = ?",
    ).get(session.firm_id, plaidAccountId);
    if (existing && existing.client_id !== session.selected_client_id) {
      throw Object.assign(new Error("Connection not found."), { status: 404 });
    }
    if (existing) {
      db.prepare(
        "UPDATE plaid_accounts SET mask = ?, balance_cents = ?, available_cents = ?, plaid_item_id = ? WHERE id = ? AND firm_id = ?",
      ).run(mask, balanceCents, availableCents, itemRowId, existing.id, session.firm_id);
      db.prepare("UPDATE bank_accounts SET name = ?, kind = ?, ledger_code = ? WHERE id = ? AND firm_id = ? AND client_id = ?").run(
        name, kind, ledgerCode, existing.bank_account_id, session.firm_id, session.selected_client_id,
      );
      map.set(plaidAccountId, existing.bank_account_id);
      continue;
    }
    const bankAccountId = randomUUID();
    db.prepare(
      "INSERT INTO bank_accounts (id, firm_id, client_id, name, kind, ledger_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(bankAccountId, session.firm_id, session.selected_client_id, name, kind, ledgerCode, now);
    const linkId = randomUUID();
    db.prepare(
      `INSERT INTO plaid_accounts (
        id, firm_id, client_id, plaid_item_id, plaid_account_id, bank_account_id, mask, balance_cents, available_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(linkId, session.firm_id, session.selected_client_id, itemRowId, plaidAccountId, bankAccountId, mask, balanceCents, availableCents);
    map.set(plaidAccountId, bankAccountId);
  }
  return map;
}

function applyPage(db, session, accountMap, page) {
  let imported = 0;
  for (const txn of page.added || []) {
    if (txn.pending) continue;
    const plaidId = typeof txn.transaction_id === "string" ? txn.transaction_id : "";
    if (!plaidId) continue;
    const known = db.prepare(
      "SELECT bank_transaction_id FROM plaid_imported WHERE firm_id = ? AND plaid_transaction_id = ?",
    ).get(session.firm_id, plaidId);
    if (known) continue;
    const bankAccountId = accountMap.get(txn.account_id);
    if (!bankAccountId) continue;
    const amountCents = ledgerCentsFromPlaid(txn.amount);
    if (amountCents === null) continue;
    const postedOn = typeof txn.date === "string" ? txn.date : "";
    const description = String(txn.merchant_name || txn.name || "Sandbox transaction").trim().slice(0, 120);
    db.exec("BEGIN");
    try {
      const inserted = addStatementLine(db, session, {
        bankAccountId,
        postedOn,
        description,
        amountCents,
        source: "plaid",
      });
      if (inserted.error) throw Object.assign(new Error(inserted.error), { status: inserted.status });
      db.prepare(
        "INSERT INTO plaid_imported (firm_id, plaid_transaction_id, bank_transaction_id) VALUES (?, ?, ?)",
      ).run(session.firm_id, plaidId, inserted.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    imported += 1;
  }
  for (const txn of page.modified || []) {
    if (txn.pending) continue;
    const plaidId = typeof txn.transaction_id === "string" ? txn.transaction_id : "";
    const known = plaidId
      ? db.prepare(
        `SELECT bank_transactions.id, bank_transactions.status, bank_transactions.cleared_reconciliation_id
         FROM plaid_imported
         JOIN bank_transactions ON bank_transactions.id = plaid_imported.bank_transaction_id
           AND bank_transactions.firm_id = plaid_imported.firm_id
         WHERE plaid_imported.firm_id = ? AND plaid_imported.plaid_transaction_id = ?`,
      ).get(session.firm_id, plaidId)
      : null;
    if (!known || known.status !== "for_review" || known.cleared_reconciliation_id) continue;
    const amountCents = ledgerCentsFromPlaid(txn.amount);
    const description = String(txn.merchant_name || txn.name || "").trim().slice(0, 120);
    const postedOn = typeof txn.date === "string" ? txn.date : "";
    if (amountCents === null || !description || !/^\d{4}-\d{2}-\d{2}$/.test(postedOn)) continue;
    db.prepare(
      `UPDATE bank_transactions
       SET description = ?, amount_cents = ?, posted_on = ?
       WHERE id = ? AND firm_id = ? AND client_id = ? AND status = 'for_review' AND cleared_reconciliation_id IS NULL`,
    ).run(description, amountCents, postedOn, known.id, session.firm_id, session.selected_client_id);
  }
  return imported;
}

async function pullTransactions(db, session, item, accountMap) {
  const config = plaidConfig();
  let cursor = item.sync_cursor || "";
  let imported = 0;
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard < 10) {
    const page = await plaidPost(config, "/transactions/sync", {
      access_token: item.access_token,
      cursor,
      count: 100,
    });
    imported += applyPage(db, session, accountMap, page);
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : cursor;
    hasMore = page.has_more === true;
    guard += 1;
  }
  return { cursor, imported };
}

function accountMapFor(db, session, itemRowId) {
  const rows = db.prepare(
    "SELECT plaid_account_id, bank_account_id FROM plaid_accounts WHERE firm_id = ? AND client_id = ? AND plaid_item_id = ?",
  ).all(session.firm_id, session.selected_client_id, itemRowId);
  return new Map(rows.map((row) => [row.plaid_account_id, row.bank_account_id]));
}

export async function exchangePublicToken(db, session, input) {
  ensurePlaid(db);
  const { config, error } = requireConfigured();
  if (error) return error;
  const publicToken = typeof input?.publicToken === "string" ? input.publicToken.trim() : "";
  if (!publicToken || publicToken.length > 512) return fail(400, "Plaid Link did not return a public token.");
  try {
    const exchanged = await plaidPost(config, "/item/public_token/exchange", { public_token: publicToken });
    const accessToken = exchanged.access_token;
    const itemId = exchanged.item_id;
    if (typeof accessToken !== "string" || typeof itemId !== "string" || !accessToken || !itemId) {
      return fail(502, "Plaid sandbox did not return a connection.");
    }
    const accountsPayload = await plaidPost(config, "/accounts/get", { access_token: accessToken });
    const name = await institutionName(config, accountsPayload.item?.institution_id);
    const now = new Date().toISOString();
    let item = db.prepare("SELECT * FROM plaid_items WHERE firm_id = ? AND item_id = ?").get(session.firm_id, itemId);
    if (item && item.client_id !== session.selected_client_id) return fail(404, "Connection not found.");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!item) {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO plaid_items (
            id, firm_id, client_id, item_id, access_token, institution_name, status, error_message, sync_cursor, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'connected', '', '', ?, ?, ?)`,
        ).run(id, session.firm_id, session.selected_client_id, itemId, accessToken, name, session.user_id, now, now);
        item = db.prepare("SELECT * FROM plaid_items WHERE id = ?").get(id);
      } else {
        db.prepare(
          `UPDATE plaid_items
           SET access_token = ?, institution_name = ?, status = 'connected', error_message = '', updated_at = ?
           WHERE id = ? AND firm_id = ? AND client_id = ?`,
        ).run(accessToken, name, now, item.id, session.firm_id, session.selected_client_id);
        item = db.prepare("SELECT * FROM plaid_items WHERE id = ? AND firm_id = ?").get(item.id, session.firm_id);
      }
      rememberAccounts(db, session, item.id, accountsPayload.accounts);
      db.exec("COMMIT");
    } catch (writeError) {
      db.exec("ROLLBACK");
      throw writeError;
    }
    const map = accountMapFor(db, session, item.id);
    try {
      const pulled = await pullTransactions(db, session, { ...item, access_token: accessToken, sync_cursor: item.sync_cursor }, map);
      db.prepare(
        "UPDATE plaid_items SET sync_cursor = ?, status = 'connected', error_message = '', updated_at = ? WHERE id = ? AND firm_id = ?",
      ).run(pulled.cursor, new Date().toISOString(), item.id, session.firm_id);
      audit(db, session, "plaid.connected", item.id);
    } catch (syncError) {
      db.prepare(
        "UPDATE plaid_items SET status = 'error', error_message = ?, updated_at = ? WHERE id = ? AND firm_id = ?",
      ).run(String(syncError.message || "Sandbox sync failed.").slice(0, 200), new Date().toISOString(), item.id, session.firm_id);
    }
    const payload = readPlaid(db, session).payload;
    return { status: 200, payload };
  } catch (requestError) {
    return fail(requestError.status || 502, requestError.message);
  }
}

export async function syncPlaid(db, session, input) {
  ensurePlaid(db);
  const { config, error } = requireConfigured();
  if (error) return error;
  const item = itemFor(db, session, input?.connectionId);
  if (!item) return fail(404, "Connection not found.");
  if (item.status === "disconnected" || !item.access_token) {
    return fail(400, "This sandbox connection is disconnected. New lines stay off until it is connected again.");
  }
  try {
    const accountsPayload = await plaidPost(config, "/accounts/get", { access_token: item.access_token });
    rememberAccounts(db, session, item.id, accountsPayload.accounts);
    const map = accountMapFor(db, session, item.id);
    const pulled = await pullTransactions(db, session, item, map);
    db.prepare(
      "UPDATE plaid_items SET sync_cursor = ?, status = 'connected', error_message = '', updated_at = ? WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).run(pulled.cursor, new Date().toISOString(), item.id, session.firm_id, session.selected_client_id);
    audit(db, session, "plaid.synced", item.id);
    const payload = readPlaid(db, session).payload;
    payload.imported = pulled.imported;
    return { status: 200, payload };
  } catch (requestError) {
    db.prepare(
      "UPDATE plaid_items SET status = 'error', error_message = ?, updated_at = ? WHERE id = ? AND firm_id = ? AND client_id = ?",
    ).run(String(requestError.message || "Sandbox sync failed.").slice(0, 200), new Date().toISOString(), item.id, session.firm_id, session.selected_client_id);
    const payload = readPlaid(db, session).payload;
    return { status: requestError.status || 502, error: requestError.message, payload };
  }
}

export function disconnectPlaid(db, session, input) {
  ensurePlaid(db);
  const item = itemFor(db, session, input?.connectionId);
  if (!item) return fail(404, "Connection not found.");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE plaid_items
     SET status = 'disconnected', access_token = '', error_message = '', updated_at = ?
     WHERE id = ? AND firm_id = ? AND client_id = ?`,
  ).run(now, item.id, session.firm_id, session.selected_client_id);
  audit(db, session, "plaid.disconnected", item.id);
  return readPlaid(db, session);
}
