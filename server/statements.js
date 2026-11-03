import { buildStatements, resolvePeriod, priorRange } from "../shared/statements.js";

function fail(status, error) {
  return { status, error };
}

function asCents(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function readStatements(db, session, { clientId, period, basis } = {}) {
  if (clientId && clientId !== session.selected_client_id) return fail(404, "Client not found.");
  const client = db.prepare(
    "SELECT id, name, legal_name FROM clients WHERE id = ? AND firm_id = ?",
  ).get(session.selected_client_id, session.firm_id);
  if (!client) return fail(404, "Client not found.");
  const books = db.prepare(
    "SELECT fiscal_year_start_month FROM client_books WHERE client_id = ? AND firm_id = ?",
  ).get(client.id, session.firm_id);
  const selectedBasis = basis === "cash" ? "cash" : "accrual";
  const today = todayIso();
  const resolved = resolvePeriod(period || "May 1 – May 31", today);
  const prior = priorRange(resolved);
  const accounts = db.prepare(
    `SELECT id, code, name, type, cash FROM accounts
     WHERE firm_id = ? AND client_id = ? ORDER BY code`,
  ).all(session.firm_id, client.id).map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    cash: account.cash === 1,
  }));
  const lineRows = db.prepare(
    `SELECT journal_entries.id AS entry_id, journal_entries.entry_date,
            journal_lines.account_id, journal_lines.debit_cents, journal_lines.credit_cents
     FROM journal_lines
     JOIN journal_entries ON journal_entries.id = journal_lines.entry_id
       AND journal_entries.firm_id = journal_lines.firm_id
       AND journal_entries.client_id = journal_lines.client_id
     WHERE journal_lines.firm_id = ? AND journal_lines.client_id = ?
     ORDER BY journal_entries.entry_date, journal_entries.reference, journal_lines.position`,
  ).all(session.firm_id, client.id);
  const entries = [];
  const byId = new Map();
  for (const row of lineRows) {
    let entry = byId.get(row.entry_id);
    if (!entry) {
      entry = { id: row.entry_id, date: row.entry_date, lines: [] };
      byId.set(row.entry_id, entry);
      entries.push(entry);
    }
    entry.lines.push({
      accountId: row.account_id,
      debitCents: asCents(row.debit_cents),
      creditCents: asCents(row.credit_cents),
    });
  }
  const statement = buildStatements({
    accounts,
    entries,
    period: resolved,
    prior,
    basis: selectedBasis,
    fiscalYearStartMonth: books?.fiscal_year_start_month || 1,
    chartEnd: today,
  });
  return {
    status: 200,
    payload: {
      client: { id: client.id, name: client.name, legalName: client.legal_name },
      ...statement,
    },
  };
}
