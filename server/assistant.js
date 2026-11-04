import { randomUUID } from "node:crypto";
import { loadStatement } from "./statements.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assistant_recommendations (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT,
  label TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_approvals (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  recommendation_id TEXT NOT NULL REFERENCES assistant_recommendations(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
`;

// Read-only tools. A person posts a journal, approves a treatment, or files a return.
export const ASSISTANT_TOOLS = Object.freeze([
  "explain_statements",
  "list_uncategorized",
  "list_missing_documents",
  "draft_journal",
  "suggest_classification",
  "explain_discrepancy",
  "summarize_activity",
  "tax_checklist",
]);

const NOT_CONFIGURED = "The external model is not configured.";
const REFUSAL = "I can't file a return, approve a treatment, or post a journal. Nothing was sent, and the ledger was not changed. A person does that in Ledgerly.";

const MODEL_ENV = ["LEDGERLY_MODEL_PROVIDER", "LEDGERLY_MODEL_API_KEY", "LEDGERLY_MODEL_URL", "LEDGERLY_MODEL_NAME"];

function fail(status, error) {
  return { status, error };
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function amountText(cents) {
  const absolute = Math.abs(asCents(cents));
  return `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function modelConfig(env = process.env) {
  const provider = String(env.LEDGERLY_MODEL_PROVIDER || "").trim();
  const apiKey = String(env.LEDGERLY_MODEL_API_KEY || "").trim();
  const url = String(env.LEDGERLY_MODEL_URL || "").trim();
  const model = String(env.LEDGERLY_MODEL_NAME || "").trim();
  const configured = Boolean(provider && apiKey && /^https?:\/\//i.test(url));
  return {
    provider,
    apiKey,
    url,
    model,
    configured,
    env: MODEL_ENV,
  };
}

export function ensureAssistant(db) {
  db.exec(SCHEMA);
}

function sameClient(session, clientId) {
  return clientId && clientId !== session.selected_client_id;
}

function audit(db, session, action, entityId) {
  db.prepare(
    `INSERT INTO audit_events (
      id, firm_id, actor_user_id, client_user_id, action, client_id, entity_type, entity_id, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'assistant_recommendation', ?, ?)`,
  ).run(randomUUID(), session.firm_id, session.user_id, action, session.selected_client_id, entityId, new Date().toISOString());
}

function accountByCode(accounts, code) {
  return accounts.find((account) => account.code === code) || null;
}

function suggestedCode(description, amountCents) {
  const text = String(description || "").toLowerCase();
  if (/rent/.test(text)) return "6100";
  if (/software|subscription/.test(text)) return "6200";
  if (/marketing|\bads?\b/.test(text)) return "6300";
  if (/office|supplies|paper|ink/.test(text)) return "6400";
  if (/legal|accountant|professional/.test(text)) return "6500";
  if (/insurance/.test(text)) return "6600";
  if (/utility|utilities|electric/.test(text)) return "6700";
  if (/payroll|salary|wage/.test(text)) return "6000";
  if (/fee/.test(text)) return "6900";
  if (amountCents < 0) return "6400";
  return "4000";
}

function loadContext(db, session) {
  const firmId = session.firm_id;
  const clientId = session.selected_client_id;
  const client = db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(clientId, firmId);
  const accounts = db.prepare(
    "SELECT id, code, name, type FROM accounts WHERE firm_id = ? AND client_id = ? ORDER BY code",
  ).all(firmId, clientId).map((row) => ({ id: row.id, code: row.code, name: row.name, type: row.type }));
  const uncategorized = db.prepare(
    `SELECT bank_transactions.id, bank_transactions.posted_on, bank_transactions.description, bank_transactions.amount_cents,
            bank_accounts.ledger_code, bank_accounts.name AS account_name
     FROM bank_transactions
     JOIN bank_accounts ON bank_accounts.id = bank_transactions.bank_account_id
       AND bank_accounts.firm_id = bank_transactions.firm_id
     WHERE bank_transactions.firm_id = ? AND bank_transactions.client_id = ? AND bank_transactions.status = 'for_review'
     ORDER BY bank_transactions.posted_on, bank_transactions.description`,
  ).all(firmId, clientId).map((row) => ({
    id: row.id,
    postedOn: row.posted_on,
    description: row.description,
    amountCents: asCents(row.amount_cents),
    ledgerCode: row.ledger_code,
    accountName: row.account_name,
  }));
  const requests = db.prepare(
    `SELECT id, title, status FROM document_requests
     WHERE firm_id = ? AND client_id = ? AND status = 'open'
     ORDER BY created_at, title`,
  ).all(firmId, clientId);
  const openInvoices = db.prepare(
    `SELECT number FROM invoices
     WHERE firm_id = ? AND client_id = ? AND status IN ('sent', 'partial')
     ORDER BY number`,
  ).all(firmId, clientId);
  const unfinished = db.prepare(
    `SELECT COUNT(*) AS count FROM bank_accounts
     WHERE firm_id = ? AND client_id = ?
       AND EXISTS (
         SELECT 1 FROM reconciliations
         WHERE reconciliations.bank_account_id = bank_accounts.id
           AND reconciliations.firm_id = bank_accounts.firm_id
           AND reconciliations.client_id = bank_accounts.client_id
           AND reconciliations.status = 'complete'
       )
       AND EXISTS (
         SELECT 1 FROM bank_transactions
         WHERE bank_transactions.bank_account_id = bank_accounts.id
           AND bank_transactions.firm_id = bank_accounts.firm_id
           AND bank_transactions.client_id = bank_accounts.client_id
           AND bank_transactions.cleared_reconciliation_id IS NULL
       )`,
  ).get(firmId, clientId);
  const journalCount = db.prepare(
    "SELECT COUNT(*) AS count FROM journal_entries WHERE firm_id = ? AND client_id = ?",
  ).get(firmId, clientId);
  const loaded = loadStatement(db, firmId, clientId, { period: "May 1 – May 31", basis: "accrual" });
  const statement = loaded?.statement;
  return {
    client,
    accounts,
    uncategorized,
    requests,
    openInvoices,
    unfinished: asCents(unfinished?.count),
    journalCount: asCents(journalCount?.count),
    statement,
  };
}

function classifyIntent(prompt) {
  const text = String(prompt || "");
  if (/\b(file|filing)\b[\s\S]{0,40}\b(return|tax)\b|\b(irs|tax authority)\b|\bapprove\b[\s\S]{0,40}\btreatment\b|\bsubmit\b[\s\S]{0,40}\b(return|filing)\b|\bpost\b/i.test(text)) {
    return "refusal";
  }
  if (/\bjournal\b/i.test(text)) return "draft_journal";
  if (/\bclassif/i.test(text)) return "suggest_classification";
  if (/\buncategor/i.test(text)) return "list_uncategorized";
  if (/\bmissing documents?\b|\bdocument request\b|\bwhat is missing\b|\bchecklist\b/i.test(text)) return "list_missing_documents";
  if (/\b(unusual|discrepan)/i.test(text)) return "explain_discrepancy";
  if (/\b(statement|profit|balance sheet|cash flow|explain the report|explain this report)\b/i.test(text)) return "explain_statements";
  if (/\bsummar/i.test(text) || /\btax readiness\b/i.test(text)) return "summarize_activity";
  return "summarize_activity";
}

function lineFor(account, debit, credit) {
  return {
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    debit,
    credit,
  };
}

function draftFor(context, line) {
  const bank = accountByCode(context.accounts, line.ledgerCode);
  const category = accountByCode(context.accounts, suggestedCode(line.description, line.amountCents));
  if (!bank || !category || bank.id === category.id) return null;
  const amount = amountText(line.amountCents);
  const lines = line.amountCents < 0
    ? [lineFor(category, amount, ""), lineFor(bank, "", amount)]
    : [lineFor(bank, amount, ""), lineFor(category, "", amount)];
  return {
    entryDate: line.postedOn,
    memo: `Draft for ${line.description}`.slice(0, 200),
    lines,
    label: "AI-generated",
    confidence: "low",
    sourceTransactionId: line.id,
  };
}

function classificationFor(context, line) {
  const account = accountByCode(context.accounts, suggestedCode(line.description, line.amountCents));
  return {
    transactionId: line.id,
    description: line.description,
    amount: amountText(line.amountCents),
    accountCode: account?.code || "",
    accountName: account?.name || "",
    label: "AI-generated",
    confidence: "low",
    text: account
      ? `${line.description} could be ${account.code} ${account.name}. A person confirms the account.`
      : `${line.description} needs an account a person chooses.`,
  };
}

function booksNote(configured) {
  return configured ? "" : ` ${NOT_CONFIGURED}`;
}

function answerFor(intent, context, configured) {
  const note = booksNote(configured);
  if (intent === "explain_statements") {
    const profit = context.statement?.profitAndLoss;
    const period = context.statement?.period?.label || "the selected period";
    if (!profit) return { answer: `No statement is available for this client.${note}`, suggestions: [], draft: null, confidence: "high", label: "From the books" };
    return {
      answer: `${context.client.name}, ${period}, accrual. Income ${profit.income}. Expenses ${profit.expenses}. Net income ${profit.netIncome}. Uncategorized lines are not in these totals.${note}`,
      suggestions: [],
      draft: null,
      confidence: "high",
      label: "From the books",
    };
  }
  if (intent === "list_uncategorized" || intent === "suggest_classification") {
    if (!context.uncategorized.length) {
      return {
        answer: `Every stored transaction for ${context.client.name} is categorized.${note}`,
        suggestions: [],
        draft: null,
        confidence: "high",
        label: "From the books",
      };
    }
    const suggestions = context.uncategorized.map((line) => classificationFor(context, line));
    const listed = context.uncategorized.map((line) => `${line.postedOn} ${line.description} ${amountText(line.amountCents)}`).join("; ");
    return {
      answer: `${context.uncategorized.length} uncategorized ${context.uncategorized.length === 1 ? "line" : "lines"}: ${listed}.${note}`,
      suggestions,
      draft: null,
      confidence: "low",
      label: "AI-generated",
    };
  }
  if (intent === "list_missing_documents" || intent === "tax_checklist") {
    const titles = context.requests.map((row) => row.title);
    const invoiceNumbers = context.openInvoices.map((row) => row.number);
    const parts = [
      titles.length ? `Missing documents: ${titles.join(", ")}.` : "No document request is open.",
      context.uncategorized.length ? `${context.uncategorized.length} uncategorized ${context.uncategorized.length === 1 ? "transaction" : "transactions"}.` : "No uncategorized transactions.",
      context.unfinished ? `${context.unfinished} reconciliation ${context.unfinished === 1 ? "was" : "were"} left unfinished.` : "No reconciliation was left unfinished.",
      invoiceNumbers.length ? `Invoices still open: ${invoiceNumbers.join(", ")}.` : "No invoice is still open.",
    ];
    return {
      answer: `${parts.join(" ")}${note}`,
      suggestions: [],
      draft: null,
      confidence: "high",
      label: "From the books",
    };
  }
  if (intent === "draft_journal") {
    const line = context.uncategorized[0];
    if (!line) {
      return {
        answer: `There is no uncategorized line to draft from. The trial balance is unchanged until a person posts a journal.${note}`,
        suggestions: [],
        draft: null,
        confidence: "high",
        label: "From the books",
      };
    }
    const draft = draftFor(context, line);
    const suggestion = classificationFor(context, line);
    if (!draft) {
      return {
        answer: `I could not draft a balanced journal from ${line.description}. The trial balance is unchanged.${note}`,
        suggestions: [suggestion],
        draft: null,
        confidence: "low",
        label: "AI-generated",
      };
    }
    const described = draft.lines.map((entry) => {
      const side = entry.debit ? `Debit ${entry.debit}` : `Credit ${entry.credit}`;
      return `${side} ${entry.accountCode} ${entry.accountName}`;
    }).join(". ");
    return {
      answer: `Draft journal for ${line.description}, dated ${draft.entryDate}. ${described}. This is a suggestion. The trial balance is unchanged until a person posts it.${note}`,
      suggestions: [suggestion],
      draft,
      confidence: "low",
      label: "AI-generated",
    };
  }
  if (intent === "explain_discrepancy") {
    const unusual = context.uncategorized.filter((line) => Math.abs(line.amountCents) >= 100000);
    const suggestions = unusual.map((line) => ({
      ...classificationFor(context, line),
      text: `${line.description} is large and still uncategorized.`,
    }));
    const issues = [];
    if (context.uncategorized.length) issues.push(`${context.uncategorized.length} uncategorized ${context.uncategorized.length === 1 ? "line is" : "lines are"} not on the trial balance.`);
    if (context.unfinished) issues.push(`${context.unfinished} ${context.unfinished === 1 ? "account has" : "accounts have"} uncleared lines after a completed reconciliation.`);
    if (context.requests.length) issues.push(`${context.requests.length} document ${context.requests.length === 1 ? "request is" : "requests are"} open.`);
    if (!issues.length) issues.push("The stored books do not show an uncategorized line, an unfinished reconciliation, or a missing document.");
    return {
      answer: `${issues.join(" ")}${suggestions.length ? ` Flagged: ${suggestions.map((row) => row.description).join(", ")}.` : ""}${note}`,
      suggestions,
      draft: null,
      confidence: suggestions.length ? "low" : "high",
      label: suggestions.length ? "AI-generated" : "From the books",
    };
  }
  const profit = context.statement?.profitAndLoss;
  return {
    answer: `${context.client.name}: ${context.journalCount} posted ${context.journalCount === 1 ? "journal" : "journals"}, ${context.uncategorized.length} uncategorized ${context.uncategorized.length === 1 ? "line" : "lines"}, ${context.requests.length} open document ${context.requests.length === 1 ? "request" : "requests"}, ${context.openInvoices.length} open ${context.openInvoices.length === 1 ? "invoice" : "invoices"}. Net income on the May accrual statement is ${profit?.netIncome || "$0.00"}.${note}`,
    suggestions: [],
    draft: null,
    confidence: "high",
    label: "From the books",
  };
}

function publicConfig(config) {
  return {
    configured: config.configured,
    provider: config.configured ? config.provider : null,
    model: config.configured ? config.model || null : null,
    notice: config.configured ? "Answers can use the model the firm configured. This build does not train on customer data." : NOT_CONFIGURED,
    tools: ASSISTANT_TOOLS,
  };
}

function presentRecommendation(row) {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    answer: row.answer,
    confidence: row.confidence,
    label: row.label,
    source: row.source,
    createdAt: row.created_at,
  };
}

const TOOL_TEXT = {
  explain_statements: "Explain the open client's statements from stored figures.",
  list_uncategorized: "List uncategorized transactions for the open client.",
  list_missing_documents: "List open document requests for the open client.",
  draft_journal: "Draft a journal the person can post later. Do not post it.",
  suggest_classification: "Suggest an account for an uncategorized line.",
  explain_discrepancy: "Explain bookkeeping issues visible in the stored books.",
  summarize_activity: "Summarize the open client's stored activity.",
  tax_checklist: "Read the tax readiness checklist. Do not file or approve.",
};

function toolFromPayload(payload) {
  const call = payload?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name
    || payload?.tool
    || payload?.output?.tool
    || "";
  if (ASSISTANT_TOOLS.includes(call)) return call;
  const content = payload?.choices?.[0]?.message?.content || payload?.answer || payload?.content || "";
  if (content && typeof content === "object" && ASSISTANT_TOOLS.includes(content.tool)) return content.tool;
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (ASSISTANT_TOOLS.includes(parsed.tool)) return parsed.tool;
    } catch {
      return "";
    }
  }
  return "";
}

async function callModel(config, prompt) {
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
          name: "assistant_tool",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { tool: { type: "string", enum: [...ASSISTANT_TOOLS] } },
            required: ["tool"],
          },
        },
      },
      tools: ASSISTANT_TOOLS.map((name) => ({
        type: "function",
        function: {
          name,
          description: TOOL_TEXT[name],
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      })),
      tool_choice: "auto",
      messages: [
        {
          role: "system",
          content: "Choose one read-only tool. You cannot post, approve, or file. Client figures stay in Ledgerly. Do not train on customer data.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  return { sent: true, tool: response.ok ? toolFromPayload(payload) : "" };
}

function storeRecommendation(db, session, { prompt, answer, kind, confidence, label, source }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assistant_recommendations (
      id, firm_id, client_id, actor_user_id, prompt, answer, kind, confidence, label, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, session.user_id, prompt, answer, kind, confidence, label, source, now);
  audit(db, session, "assistant.recommended", id);
  return id;
}

export function listAssistant(db, session, clientId) {
  ensureAssistant(db);
  if (sameClient(session, clientId)) return fail(404, "Client not found.");
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  if (!client) return fail(404, "Client not found.");
  const config = modelConfig();
  const recommendations = db.prepare(
    `SELECT * FROM assistant_recommendations
     WHERE firm_id = ? AND client_id = ?
     ORDER BY created_at, id`,
  ).all(session.firm_id, session.selected_client_id).map(presentRecommendation);
  return { status: 200, payload: { ...publicConfig(config), recommendations } };
}

export async function askAssistant(db, session, input) {
  ensureAssistant(db);
  const body = input || {};
  if (sameClient(session, body.clientId)) return fail(404, "Client not found.");
  const client = db.prepare("SELECT id FROM clients WHERE id = ? AND firm_id = ?").get(session.selected_client_id, session.firm_id);
  if (!client) return fail(404, "Client not found.");
  const prompt = String(body.prompt || "").trim();
  if (!prompt || prompt.length > 2000) return fail(400, "Enter a question.");
  const config = modelConfig();
  const localIntent = classifyIntent(prompt);
  if (localIntent === "refusal") {
    const id = storeRecommendation(db, session, {
      prompt,
      answer: REFUSAL,
      kind: "refusal",
      confidence: null,
      label: null,
      source: "books",
    });
    return {
      status: 200,
      payload: {
        ...publicConfig(config),
        id,
        kind: "refusal",
        prompt,
        answer: REFUSAL,
        confidence: null,
        label: null,
        source: "books",
        sent: false,
        suggestions: [],
        draft: null,
      },
    };
  }
  let intent = localIntent;
  let source = "books";
  let sent = false;
  if (config.configured) {
    try {
      const remote = await callModel(config, prompt);
      sent = remote.sent;
      if (remote.tool) {
        intent = remote.tool;
        source = "model";
      }
    } catch {
      sent = true;
    }
  }
  const context = loadContext(db, session);
  const local = answerFor(intent, context, config.configured);
  const id = storeRecommendation(db, session, {
    prompt,
    answer: local.answer,
    kind: intent,
    confidence: local.confidence,
    label: local.label,
    source,
  });
  const draft = local.draft ? { ...local.draft, recommendationId: id } : null;
  return {
    status: 200,
    payload: {
      ...publicConfig(config),
      id,
      kind: intent,
      prompt,
      answer: local.answer,
      confidence: local.confidence,
      label: local.label,
      source,
      sent,
      suggestions: local.suggestions,
      draft,
    },
  };
}

export function approveAssistant(db, session, input) {
  ensureAssistant(db);
  const body = input || {};
  if (sameClient(session, body.clientId)) return fail(404, "Client not found.");
  const recommendation = db.prepare(
    "SELECT id FROM assistant_recommendations WHERE id = ? AND firm_id = ? AND client_id = ?",
  ).get(String(body.recommendationId || ""), session.firm_id, session.selected_client_id);
  if (!recommendation) return fail(404, "Recommendation not found.");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assistant_approvals (
      id, firm_id, client_id, recommendation_id, actor_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, session.firm_id, session.selected_client_id, recommendation.id, session.user_id, now);
  audit(db, session, "assistant.approved", id);
  const actor = db.prepare("SELECT name FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  return {
    status: 201,
    payload: {
      approval: {
        id,
        recommendationId: recommendation.id,
        actorName: actor?.name || "",
        createdAt: now,
      },
    },
  };
}
