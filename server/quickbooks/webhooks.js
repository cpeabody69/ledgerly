import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { quickBooksConfig } from "./config.js";
import { ensureQuickBooks, writeAudit } from "./store.js";

export function verifyIntuitSignature(rawBody, signature, verifier) {
  const provided = String(signature || "").trim();
  if (!verifier || !provided) return false;
  const expected = createHmac("sha256", verifier).update(rawBody).digest("base64");
  const actual = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actual, expectedBuffer);
}

function clip(value, max) {
  return String(value || "").replace(/[\u0000-\u001f]/g, "").slice(0, max);
}

function attachConnection(db, realmId) {
  if (!/^[0-9]{1,32}$/.test(realmId)) return null;
  const rows = db.prepare(
    `SELECT id, firm_id, client_id FROM quickbooks_connections
     WHERE realm_id = ? AND status = 'connected'`,
  ).all(realmId);
  if (rows.length !== 1) return null;
  return rows[0];
}

export function storeWebhookEvents(db, payload) {
  const notifications = Array.isArray(payload?.eventNotifications) ? payload.eventNotifications : [];
  const now = new Date().toISOString();
  let count = 0;
  for (const note of notifications) {
    const realmId = typeof note?.realmId === "string" && /^[0-9]{1,32}$/.test(note.realmId) ? note.realmId : "";
    const connection = attachConnection(db, realmId);
    const entities = Array.isArray(note?.dataChangeEvent?.entities) ? note.dataChangeEvent.entities : [];
    const listed = entities.length ? entities : [{}];
    for (const entity of listed) {
      db.prepare(
        `INSERT INTO quickbooks_webhook_events (
          id, firm_id, client_id, connection_id, realm_id, entity_name, qbo_id, operation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        connection?.firm_id || null,
        connection?.client_id || null,
        connection?.id || null,
        realmId,
        clip(entity?.name, 40),
        clip(entity?.id, 40),
        clip(entity?.operation, 20),
        now,
      );
      count += 1;
    }
    if (connection) {
      writeAudit(db, {
        firm_id: connection.firm_id,
        client_id: connection.client_id,
        user_id: null,
      }, "quickbooks.webhook", connection.id, realmId ? "Webhook received." : "Webhook received without a company id.");
    }
  }
  return { count };
}

export function handleQuickBooksWebhook(db, rawBody, signature) {
  ensureQuickBooks(db);
  const config = quickBooksConfig();
  if (!config.webhookVerifier) return { status: 401, error: "QuickBooks webhook verifier is not configured." };
  if (!verifyIntuitSignature(rawBody, signature, config.webhookVerifier)) {
    return { status: 401, error: "Intuit signature does not match." };
  }
  let payload;
  try {
    payload = JSON.parse(String(rawBody || ""));
  } catch {
    return { status: 400, error: "QuickBooks webhook body must be JSON." };
  }
  const stored = storeWebhookEvents(db, payload);
  return { status: 200, payload: { received: true, events: stored.count } };
}
