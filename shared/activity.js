import { addCents, formatMoney } from "./money.js";

export const PERIODS = ["May 1 – May 31", "Apr 1 – Apr 30", "Q2 2025", "Year to date", "Custom range"];

export function matchesPeriod(postedOn, period, today = "2026-11-03") {
  if (!postedOn) return false;
  const [yearText, monthText] = String(postedOn).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (period === "May 1 – May 31") return month === 5;
  if (period === "Apr 1 – Apr 30") return month === 4;
  if (period === "Q2 2025") return year === 2025 && month >= 4 && month <= 6;
  if (period === "Year to date") return postedOn >= `${today.slice(0, 4)}-01-01` && postedOn <= today;
  return true;
}

export function summarize(rows) {
  return {
    all: rows.length,
    forReview: rows.filter((row) => row.status === "for_review").length,
    categorized: rows.filter((row) => row.status === "categorized").length,
    excluded: rows.filter((row) => row.status === "excluded").length,
  };
}

export function reconciliationMath(beginningCents, statementEndingCents, clearedAmounts) {
  let clearedCents = 0;
  for (const amount of clearedAmounts) clearedCents = addCents(clearedCents, amount);
  const computedEndingCents = addCents(beginningCents, clearedCents);
  const differenceCents = statementEndingCents - computedEndingCents;
  if (!Number.isSafeInteger(differenceCents)) {
    throw Object.assign(new Error("That amount is too large."), { status: 400 });
  }
  return { clearedCents, computedEndingCents, differenceCents };
}

export function formatSigned(cents) {
  const text = formatMoney(Math.abs(cents));
  if (cents < 0) return `−${text}`;
  if (cents > 0) return `+${text}`;
  return text;
}

export function recentActivity(payload, clientId, limit = 4) {
  if (!payload || typeof payload !== "object" || !clientId) return [];
  if (payload.client?.id !== clientId) return [];
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  return transactions.slice(0, limit).map((row) => ({
    id: row.id,
    date: row.postedOnLabel || "",
    description: row.description || "",
    amount: formatSigned(row.amountCents),
    type: row.amountCents < 0 ? "expense" : "income",
  }));
}
