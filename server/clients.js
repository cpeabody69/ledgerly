import { loadStatement } from "./statements.js";

const REQUESTS = `
CREATE TABLE IF NOT EXISTS document_requests (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'complete')),
  created_at TEXT NOT NULL
);
`;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function countOf(row) {
  return Number(row?.count || 0);
}

function formatDay(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return "";
  return `${name} ${Number(day)}, ${year}`;
}

export function ensureFirmCrm(db) {
  db.exec(REQUESTS);
}

export function listFirm(db, session) {
  ensureFirmCrm(db);
  const firm = db.prepare("SELECT id, name FROM firms WHERE id = ?").get(session.firm_id);
  const rows = db.prepare("SELECT * FROM clients WHERE firm_id = ? ORDER BY position, name").all(session.firm_id);
  const uncategorizedFor = db.prepare(
    "SELECT COUNT(*) AS count FROM bank_transactions WHERE firm_id = ? AND client_id = ? AND status = 'for_review'",
  );
  const unreconciledFor = db.prepare(
    `SELECT COUNT(*) AS count FROM bank_accounts
     WHERE firm_id = ? AND client_id = ?
       AND EXISTS (
         SELECT 1 FROM bank_transactions
         WHERE bank_transactions.bank_account_id = bank_accounts.id
           AND bank_transactions.firm_id = bank_accounts.firm_id
           AND bank_transactions.client_id = bank_accounts.client_id
           AND bank_transactions.cleared_reconciliation_id IS NULL
       )`,
  );
  const lastJournal = db.prepare(
    "SELECT MAX(entry_date) AS day FROM journal_entries WHERE firm_id = ? AND client_id = ?",
  );
  const lastBank = db.prepare(
    "SELECT MAX(posted_on) AS day FROM bank_transactions WHERE firm_id = ? AND client_id = ?",
  );
  let periodLabel = "";
  const clients = rows.map((row) => {
    const loaded = loadStatement(db, session.firm_id, row.id, { period: "May 1 – May 31", basis: "accrual" });
    if (!periodLabel && loaded?.period?.label) periodLabel = loaded.period.label;
    const uncategorized = countOf(uncategorizedFor.get(session.firm_id, row.id));
    const unreconciled = countOf(unreconciledFor.get(session.firm_id, row.id));
    const days = [lastJournal.get(session.firm_id, row.id)?.day, lastBank.get(session.firm_id, row.id)?.day].filter(Boolean).sort();
    const profit = loaded?.statement?.profitAndLoss;
    return {
      id: row.id,
      name: row.name,
      legalName: row.legal_name,
      initials: row.initials,
      industry: row.industry,
      revenue: profit ? profit.income : "",
      netIncome: profit ? profit.netIncome : "",
      revenueCents: profit ? profit.incomeCents : null,
      netIncomeCents: profit ? profit.netIncomeCents : null,
      booksUpdated: formatDay(days.at(-1)),
      uncategorized,
      unreconciled,
      ready: uncategorized > 0 || unreconciled > 0,
    };
  });
  const requests = db.prepare(
    `SELECT document_requests.id, document_requests.title, document_requests.status, document_requests.client_id, clients.name AS client_name
     FROM document_requests
     JOIN clients ON clients.id = document_requests.client_id AND clients.firm_id = document_requests.firm_id
     WHERE document_requests.firm_id = ? AND document_requests.status = 'open'
     ORDER BY document_requests.created_at, clients.name`,
  ).all(session.firm_id).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    clientId: row.client_id,
    clientName: row.client_name,
  }));
  const uncategorized = clients.reduce((total, client) => total + client.uncategorized, 0);
  const unreconciled = clients.reduce((total, client) => total + client.unreconciled, 0);
  return {
    status: 200,
    payload: {
      firm: { id: firm.id, name: firm.name },
      period: { label: periodLabel },
      counts: {
        active: clients.length,
        readyToReview: clients.filter((client) => client.ready).length,
        openRequests: requests.length,
        uncategorized,
        unreconciled,
      },
      clients,
      requests,
    },
  };
}
