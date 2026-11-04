import { randomUUID } from "node:crypto";
import { modelConfig } from "./assistant.js";
import { ensureDocuments } from "./documents.js";

const NOT_CONFIGURED = "The external model is not configured.";
const LABEL = "AI-generated";
const KINDS = [
  "bank statement",
  "receipt",
  "vendor invoice",
  "customer invoice",
  "W-2",
  "1099",
  "payroll report",
  "financial statement",
  "tax document",
  "contract",
  "unknown",
];

const RULES = [
  { kind: "W-2", patterns: [/\bw-?2\b/i] },
  { kind: "1099", patterns: [/\b1099(?:-[a-z0-9]+)?\b/i] },
  { kind: "payroll report", patterns: [/\bpayroll\b/i] },
  { kind: "bank statement", patterns: [/\bbank statement\b/i, /\bchecking statement\b/i, /\baccount statement\b/i] },
  { kind: "financial statement", patterns: [/\bfinancial statement\b/i, /\bbalance sheet\b/i, /\bprofit and loss\b/i, /\bincome statement\b/i] },
  { kind: "vendor invoice", patterns: [/\bvendor invoice\b/i, /\bbill from\b/i] },
  { kind: "customer invoice", patterns: [/\bcustomer invoice\b/i, /\binvoice to\b/i] },
  { kind: "receipt", patterns: [/\breceipt\b/i] },
  { kind: "contract", patterns: [/\bcontract\b/i, /\bagreement\b/i] },
  { kind: "tax document", patterns: [/\btax document\b/i, /\btax return\b/i, /\bform 1040\b/i, /\b1040\b/i] },
  { kind: "vendor invoice", patterns: [/\binvoice\b/i] },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS document_reviews (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  file_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  party TEXT NOT NULL DEFAULT '',
  document_date TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '',
  confidence REAL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'corrected')),
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (firm_id, file_id)
);
`;

function fail(status, error) {
  return { status, error };
}

function ensureReviews(db) {
  ensureDocuments(db);
  db.exec(SCHEMA);
}

function audit(db, session, action, clientId, entityId) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    session.firm_id,
    session.portal ? null : session.user_id,
    session.portal ? session.client_user_id : null,
    action,
    clientId,
    "document_review",
    entityId,
    new Date().toISOString(),
  );
}

function textContent(bytes, mediaType) {
  const buffer = Buffer.from(bytes || []);
  if (!buffer.length || buffer.includes(0)) return "";
  if (!String(mediaType || "").startsWith("text/")) return "";
  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) return "";
  return text.replace(/[^\t\n\r\x20-\x7E]/g, " ").slice(0, 8000);
}

function cleanParty(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 80);
}

function cleanDate(value) {
  const date = String(value || "").trim();
  if (!date) return "";
  const match = date.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (!match) return "";
  const [year, month, day] = match[1].split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return "";
  return match[1];
}

function cleanAmount(value) {
  const match = String(value || "").replace(/,/g, "").match(/(\d{1,7}(?:\.\d{2})?)/);
  if (!match) return "";
  return match[1].includes(".") ? match[1] : `${match[1]}.00`;
}

function fieldParty(text) {
  const match = text.match(/(?:^|\n)\s*(?:vendor|payer|payee)\s*:\s*([^\n]{1,80})/i);
  return match ? cleanParty(match[1]) : "";
}

function fieldDate(text) {
  return cleanDate(text);
}

function fieldAmount(text) {
  const match = text.match(/(?:amount|total)\s*:\s*\$?\s*(\d{1,7}(?:,\d{3})*(?:\.\d{2})?)/i);
  return match ? cleanAmount(match[1]) : "";
}

function findKind(name, body) {
  const nameText = String(name || "").replace(/[-_]+/g, " ");
  for (const rule of RULES) {
    const inName = rule.patterns.some((pattern) => pattern.test(nameText));
    const inBody = rule.patterns.some((pattern) => pattern.test(body));
    if (inName || inBody) return { kind: rule.kind, inName, inBody };
  }
  return { kind: "unknown", inName: false, inBody: false };
}

export function confidenceLabel(value) {
  if (value >= 0.8) return "High";
  if (value >= 0.55) return "Medium";
  return "Low";
}

export function localSuggestion(file) {
  const body = textContent(file.bytes, file.media_type);
  const found = findKind(file.name, body);
  const party = fieldParty(body);
  const date = fieldDate(`${file.name}\n${body}`);
  const amount = fieldAmount(body);
  let confidence = found.kind === "unknown" ? 0.22 : (found.inName && found.inBody ? 0.86 : found.inBody ? 0.74 : 0.6);
  if (party) confidence += 0.03;
  if (date) confidence += 0.03;
  if (amount) confidence += 0.03;
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100);
  return {
    kind: found.kind,
    party,
    date,
    amount,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    label: LABEL,
    source: "local",
    text: body,
  };
}

function suggestionJson(suggestion) {
  return {
    kind: suggestion.kind,
    party: suggestion.party,
    date: suggestion.date,
    amount: suggestion.amount,
    confidence: suggestion.confidence,
    confidenceLabel: suggestion.confidenceLabel,
    label: LABEL,
    source: suggestion.source,
  };
}

function modelSuggestion(payload, fallback) {
  const content = payload?.choices?.[0]?.message?.content
    || payload?.suggestion
    || payload?.content
    || payload;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  if (!parsed || typeof parsed !== "object" || !KINDS.includes(parsed.kind)) return null;
  const confidence = Number(parsed.confidence);
  const bounded = Number.isFinite(confidence) ? Math.min(0.95, Math.max(0.05, Math.round(confidence * 100) / 100)) : fallback.confidence;
  return {
    kind: parsed.kind,
    party: cleanParty(parsed.party || parsed.vendor || parsed.payer),
    date: cleanDate(parsed.date),
    amount: cleanAmount(parsed.amount),
    confidence: bounded,
    confidenceLabel: confidenceLabel(bounded),
    label: LABEL,
    source: "model",
  };
}

async function remoteSuggestion(config, file, local) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      provider: config.provider,
      model: config.model || undefined,
      modelPreference: "reasoning",
      syntheticOnly: true,
      train: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "document_suggestion",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: KINDS },
              party: { type: "string" },
              date: { type: "string" },
              amount: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["kind", "party", "date", "amount", "confidence"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content: "Read the file name and text. Suggest a document kind and any vendor or payer, date, and amount. Do not post a journal, create a bill, or decide a tax treatment. Do not execute the file.",
        },
        { role: "user", content: `File name: ${file.name}\n\n${local.text.slice(0, 4000)}` },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  try {
    return modelSuggestion(payload, local);
  } catch {
    return null;
  }
}

async function suggest(config, file) {
  const local = localSuggestion(file);
  if (!config.configured) return local;
  try {
    const remote = await remoteSuggestion(config, file, local);
    if (remote) return remote;
  } catch {
    return local;
  }
  return local;
}

function ownedFile(db, session, id) {
  return db.prepare(
    "SELECT * FROM client_files WHERE id = ? AND firm_id = ? AND client_id = ? AND status = 'stored'",
  ).get(id, session.firm_id, session.selected_client_id);
}

function presentReview(row) {
  return {
    id: row.id,
    fileId: row.file_id,
    fileName: row.file_name,
    kind: row.kind,
    party: row.party,
    date: row.document_date,
    amount: row.amount,
    confidence: row.confidence === null ? null : Number(row.confidence),
    confidenceLabel: row.confidence === null ? "" : confidenceLabel(Number(row.confidence)),
    label: row.label,
    source: row.source,
    status: row.status,
    statusLabel: row.status === "corrected" ? "Corrected" : "Accepted",
    createdAt: row.created_at,
  };
}

export async function listDocumentReviews(db, session) {
  ensureReviews(db);
  const config = modelConfig();
  const files = db.prepare(
    `SELECT * FROM client_files
     WHERE firm_id = ? AND client_id = ? AND status = 'stored'
     ORDER BY created_at DESC, name`,
  ).all(session.firm_id, session.selected_client_id);
  const reviewed = db.prepare(
    `SELECT * FROM document_reviews
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at DESC, id`,
  ).all(session.firm_id, session.selected_client_id);
  const reviewedIds = new Set(reviewed.map((row) => row.file_id));
  const queue = [];
  for (const file of files) {
    if (reviewedIds.has(file.id)) continue;
    const suggestion = await suggest(config, file);
    queue.push({
      fileId: file.id,
      name: file.name,
      uploadedAt: file.created_at,
      suggestion: suggestionJson(suggestion),
    });
  }
  return {
    status: 200,
    payload: {
      notice: config.configured ? "" : NOT_CONFIGURED,
      label: LABEL,
      queue,
      reviewed: reviewed.map(presentReview),
    },
  };
}

function correction(input, suggestion) {
  const kind = String(input?.kind || "");
  if (!KINDS.includes(kind) || kind === "unknown") return { error: "Choose a document kind." };
  const party = cleanParty(input?.party);
  const date = input?.date ? cleanDate(input.date) : "";
  if (input?.date && !date) return { error: "Enter a date as YYYY-MM-DD." };
  const amount = input?.amount ? cleanAmount(input.amount) : "";
  if (input?.amount && !amount) return { error: "Enter an amount." };
  return {
    kind,
    party,
    date,
    amount,
    confidence: suggestion.confidence,
    source: suggestion.source,
  };
}

export async function storeDocumentReview(db, session, fileId, input) {
  ensureReviews(db);
  const file = ownedFile(db, session, fileId);
  if (!file) return fail(404, "File not found.");
  const existing = db.prepare(
    "SELECT * FROM document_reviews WHERE file_id = ? AND firm_id = ?",
  ).get(file.id, session.firm_id);
  if (existing) return fail(409, "This file is already reviewed.");
  const decision = String(input?.decision || "");
  if (decision !== "accept" && decision !== "correct") return fail(400, "Accept or correct the suggestion.");
  const suggestion = await suggest(modelConfig(), file);
  const chosen = decision === "accept"
    ? {
      kind: suggestion.kind,
      party: suggestion.party,
      date: suggestion.date,
      amount: suggestion.amount,
      confidence: suggestion.confidence,
      source: suggestion.source,
    }
    : correction(input, suggestion);
  if (chosen.error) return fail(400, chosen.error);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO document_reviews (
      id, firm_id, client_id, file_id, file_name, kind, party, document_date, amount, confidence, label, source, status, reviewed_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    session.firm_id,
    file.client_id,
    file.id,
    file.name,
    chosen.kind,
    chosen.party,
    chosen.date,
    chosen.amount,
    chosen.confidence,
    LABEL,
    chosen.source,
    decision === "accept" ? "accepted" : "corrected",
    session.portal ? null : session.user_id,
    now,
  );
  audit(db, session, "document.reviewed", file.client_id, id);
  const row = db.prepare("SELECT * FROM document_reviews WHERE id = ? AND firm_id = ?").get(id, session.firm_id);
  return { status: 201, payload: { review: presentReview(row) } };
}
