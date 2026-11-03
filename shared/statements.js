import { addCents, formatMoney } from "./money.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(value) {
  return String(value).padStart(2, "0");
}

function parts(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function iso(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function lastDay(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function range(start, end, label) {
  return { start, end, label };
}

export function resolvePeriod(name, today) {
  const { year, month } = parts(today);
  if (name === "May 1 – May 31") {
    const periodYear = month >= 5 ? year : year - 1;
    return range(iso(periodYear, 5, 1), iso(periodYear, 5, 31), `May 1 – May 31, ${periodYear}`);
  }
  if (name === "Apr 1 – Apr 30") {
    const periodYear = month >= 4 ? year : year - 1;
    return range(iso(periodYear, 4, 1), iso(periodYear, 4, 30), `April 1 – April 30, ${periodYear}`);
  }
  if (name === "Q2 2025") return range("2025-04-01", "2025-06-30", "Q2 2025");
  if (name === "Year to date") return range(iso(year, 1, 1), today, `January 1 – ${pretty(today)}`);
  return range("0001-01-01", "9999-12-31", "All activity");
}

export function priorRange(period) {
  if (!period || period.start === "0001-01-01") return null;
  if (period.start === "2025-04-01" && period.end === "2025-06-30") {
    return range("2025-01-01", "2025-03-31", "Q1 2025");
  }
  const start = parts(period.start);
  const end = parts(period.end);
  if (start.day === 1 && start.year === end.year && start.month === end.month && end.day === lastDay(end.year, end.month)) {
    const month = start.month === 1 ? 12 : start.month - 1;
    const year = start.month === 1 ? start.year - 1 : start.year;
    return range(iso(year, month, 1), iso(year, month, lastDay(year, month)), `${MONTHS[month - 1]} ${year}`);
  }
  if (period.start.endsWith("-01-01")) {
    const year = start.year - 1;
    const endDay = Math.min(end.day, lastDay(year, end.month));
    return range(iso(year, 1, 1), iso(year, end.month, endDay), `January 1 – ${pretty(iso(year, end.month, endDay))}`);
  }
  return null;
}

export function chartMonths(endDate, count = 6) {
  const { year, month } = parts(endDate);
  const months = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    let nextMonth = month - offset;
    let nextYear = year;
    while (nextMonth <= 0) {
      nextMonth += 12;
      nextYear -= 1;
    }
    months.push({
      year: nextYear,
      month: nextMonth,
      label: SHORT_MONTHS[nextMonth - 1],
      start: iso(nextYear, nextMonth, 1),
      end: iso(nextYear, nextMonth, lastDay(nextYear, nextMonth)),
    });
  }
  return months;
}

export function percentChange(currentCents, priorCents) {
  if (!Number.isSafeInteger(currentCents) || !Number.isSafeInteger(priorCents) || priorCents === 0) return null;
  const tenths = Math.round(((currentCents - priorCents) * 1000) / Math.abs(priorCents));
  const absolute = Math.abs(tenths);
  return {
    text: `${tenths < 0 ? "−" : ""}${Math.trunc(absolute / 10)}.${absolute % 10}%`,
    positive: tenths >= 0,
  };
}

function pretty(date) {
  const { year, month, day } = parts(date);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function signed(account, debit, credit) {
  if (account.type === "asset" || account.type === "expense") return debit - credit;
  return credit - debit;
}

function includeEntry(entry, accounts, basis) {
  if (basis !== "cash") return true;
  return entry.lines.some((line) => accounts.get(line.accountId)?.cash);
}

function accumulate(entries, accounts, basis, from, to) {
  const totals = new Map();
  for (const entry of entries) {
    if (entry.date < from || entry.date > to) continue;
    if (!includeEntry(entry, accounts, basis)) continue;
    for (const line of entry.lines) {
      const current = totals.get(line.accountId) || { debit: 0, credit: 0 };
      totals.set(line.accountId, {
        debit: addCents(current.debit, line.debitCents),
        credit: addCents(current.credit, line.creditCents),
      });
    }
  }
  return totals;
}

function amountFor(account, totals) {
  const bucket = totals.get(account.id) || { debit: 0, credit: 0 };
  return signed(account, bucket.debit, bucket.credit);
}

function rowsFor(accounts, type, currentTotals, priorTotals) {
  return accounts.filter((account) => account.type === type).map((account) => {
    const cents = amountFor(account, currentTotals);
    const priorCents = priorTotals ? amountFor(account, priorTotals) : 0;
    return {
      id: account.id,
      code: account.code,
      name: account.name,
      cents,
      priorCents,
      amount: formatMoney(cents),
      priorAmount: formatMoney(priorCents),
      change: formatMoney(cents - priorCents),
    };
  }).filter((row) => row.cents !== 0 || row.priorCents !== 0);
}

function sum(rows) {
  return rows.reduce((total, row) => addCents(total, row.cents), 0);
}

function earnings(accounts, totals) {
  let income = 0;
  let expense = 0;
  for (const account of accounts) {
    const amount = amountFor(account, totals);
    if (account.type === "income") income = addCents(income, amount);
    if (account.type === "expense") expense = addCents(expense, amount);
  }
  return { income, expense, net: addCents(income, -expense) };
}

function cashBalance(accounts, totals) {
  let balance = 0;
  for (const account of accounts) {
    if (!account.cash) continue;
    const bucket = totals.get(account.id) || { debit: 0, credit: 0 };
    balance = addCents(balance, bucket.debit - bucket.credit);
  }
  return balance;
}

function fiscalStart(endDate, fiscalYearStartMonth) {
  const { year, month } = parts(endDate);
  const fiscalYear = month >= fiscalYearStartMonth ? year : year - 1;
  return iso(fiscalYear, fiscalYearStartMonth, 1);
}

function dayBefore(date) {
  const { year, month, day } = parts(date);
  const previous = new Date(Date.UTC(year, month - 1, day));
  previous.setUTCDate(previous.getUTCDate() - 1);
  return iso(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

export function buildStatements({ accounts, entries, period, prior, basis, fiscalYearStartMonth = 1, chartEnd }) {
  const accountList = Array.isArray(accounts) ? [...accounts].sort((left, right) => left.code.localeCompare(right.code)) : [];
  const accountMap = new Map(accountList.map((account) => [account.id, account]));
  const current = accumulate(entries, accountMap, basis, period.start, period.end);
  const previous = prior ? accumulate(entries, accountMap, basis, prior.start, prior.end) : null;
  const incomeRows = rowsFor(accountList, "income", current, previous);
  const expenseRows = rowsFor(accountList, "expense", current, previous);
  const incomeCents = sum(incomeRows);
  const expenseCents = sum(expenseRows);
  const netIncomeCents = addCents(incomeCents, -expenseCents);
  const priorIncomeCents = previous ? incomeRows.reduce((total, row) => addCents(total, row.priorCents), 0) : 0;
  const priorExpenseCents = previous ? expenseRows.reduce((total, row) => addCents(total, row.priorCents), 0) : 0;
  const priorNetIncomeCents = previous ? addCents(priorIncomeCents, -priorExpenseCents) : null;

  const through = accumulate(entries, accountMap, basis, "0001-01-01", period.end);
  const yearStart = fiscalStart(period.end === "9999-12-31" ? chartEnd : period.end, fiscalYearStartMonth);
  const yearTotals = accumulate(entries, accountMap, basis, yearStart, period.end === "9999-12-31" ? chartEnd : period.end);
  const beforeYear = accumulate(entries, accountMap, basis, "0001-01-01", dayBefore(yearStart));
  const currentYear = earnings(accountList, yearTotals);
  const earlier = earnings(accountList, beforeYear);
  const assetRows = rowsFor(accountList, "asset", through, null);
  const liabilityRows = rowsFor(accountList, "liability", through, null);
  const equityAccountRows = rowsFor(accountList, "equity", through, null);
  const equityRows = [
    ...equityAccountRows,
    {
      id: "current-year-earnings",
      code: "",
      name: "Current year earnings",
      cents: currentYear.net,
      priorCents: 0,
      amount: formatMoney(currentYear.net),
      priorAmount: formatMoney(0),
      change: formatMoney(currentYear.net),
    },
  ];
  if (earlier.net !== 0) {
    equityRows.push({
      id: "prior-earnings",
      code: "",
      name: "Earnings from prior years",
      cents: earlier.net,
      priorCents: 0,
      amount: formatMoney(earlier.net),
      priorAmount: formatMoney(0),
      change: formatMoney(earlier.net),
    });
  }
  const assetsCents = sum(assetRows);
  const liabilitiesCents = sum(liabilityRows);
  const equityCents = sum(equityRows);
  const balances = assetsCents === addCents(liabilitiesCents, equityCents);

  const cashNow = cashBalance(accountList, through);
  const beginningTotals = accumulate(entries, accountMap, basis, "0001-01-01", dayBefore(period.start));
  const beginningCents = cashBalance(accountList, beginningTotals);
  let receivedCents = 0;
  let paidCents = 0;
  for (const entry of entries) {
    if (entry.date < period.start || entry.date > period.end) continue;
    if (!includeEntry(entry, accountMap, basis)) continue;
    for (const line of entry.lines) {
      const account = accountMap.get(line.accountId);
      if (!account?.cash) continue;
      receivedCents = addCents(receivedCents, line.debitCents);
      paidCents = addCents(paidCents, line.creditCents);
    }
  }
  const endingCents = addCents(beginningCents, receivedCents - paidCents);
  const priorEnding = prior ? cashBalance(accountList, accumulate(entries, accountMap, basis, "0001-01-01", prior.end)) : null;

  const chartAnchor = chartEnd && period.end > chartEnd ? chartEnd : period.end === "9999-12-31" ? chartEnd : period.end;
  const monthWindows = chartMonths(chartAnchor);
  const months = monthWindows.map((month) => {
    const totals = accumulate(entries, accountMap, basis, month.start, month.end);
    const result = earnings(accountList, totals);
    return {
      label: month.label,
      year: month.year,
      month: month.month,
      revenueCents: result.income,
      expenseCents: result.expense,
      revenue: formatMoney(result.income),
      expenses: formatMoney(result.expense),
    };
  });
  const chartRevenue = months.reduce((total, month) => addCents(total, month.revenueCents), 0);
  const previousMonths = chartMonths(dayBefore(monthWindows[0].start));
  const previousRevenue = previousMonths.reduce((total, month) => {
    const result = earnings(accountList, accumulate(entries, accountMap, basis, month.start, month.end));
    return addCents(total, result.income);
  }, 0);

  return {
    basis,
    period,
    prior,
    profitAndLoss: {
      incomeRows,
      expenseRows,
      incomeCents,
      expenseCents,
      netIncomeCents,
      priorIncomeCents,
      priorExpenseCents,
      priorNetIncomeCents,
      income: formatMoney(incomeCents),
      expenses: formatMoney(expenseCents),
      netIncome: formatMoney(netIncomeCents),
    },
    currentYearEarningsCents: currentYear.net,
    balanceSheet: {
      assets: assetRows,
      liabilities: liabilityRows,
      equity: equityRows,
      assetsCents,
      liabilitiesCents,
      equityCents,
      assetsTotal: formatMoney(assetsCents),
      liabilitiesTotal: formatMoney(liabilitiesCents),
      equityTotal: formatMoney(equityCents),
      balances,
    },
    cashFlow: {
      beginningCents,
      receivedCents,
      paidCents,
      endingCents,
      cashAccountsCents: cashNow,
      matchesCash: endingCents === cashNow,
      lines: [
        { label: "Beginning cash", cents: beginningCents, amount: formatMoney(beginningCents) },
        { label: "Cash received", cents: receivedCents, amount: formatMoney(receivedCents) },
        { label: "Cash paid", cents: -paidCents, amount: formatMoney(-paidCents) },
        { label: "Ending cash", cents: endingCents, amount: formatMoney(endingCents) },
      ],
    },
    metrics: {
      revenueCents: incomeCents,
      expenseCents,
      netIncomeCents,
      cashCents: endingCents,
      revenue: formatMoney(incomeCents),
      expenses: formatMoney(expenseCents),
      netIncome: formatMoney(netIncomeCents),
      cash: formatMoney(endingCents),
      revenueChange: previous ? percentChange(incomeCents, priorIncomeCents) : null,
      expenseChange: previous ? percentChange(expenseCents, priorExpenseCents) : null,
      netIncomeChange: previous ? percentChange(netIncomeCents, priorNetIncomeCents) : null,
      cashChange: priorEnding === null ? null : formatMoney(endingCents - priorEnding),
      cashChangePositive: priorEnding === null ? null : endingCents - priorEnding >= 0,
    },
    chart: {
      months,
      revenueCents: chartRevenue,
      revenue: formatMoney(chartRevenue),
      change: percentChange(chartRevenue, previousRevenue),
    },
  };
}

export function statementCsv(statement, report) {
  const header = ["Account", statement.period.label, statement.prior ? statement.prior.label : "Prior period", "Change"];
  const lines = [header.join(",")];
  const push = (label, current, prior, change) => {
    lines.push([label, current, prior, change].map(csvCell).join(","));
  };
  if (report === "balance-sheet") {
    push("Assets", "", "", "");
    for (const row of statement.balanceSheet.assets) push(`${row.code} ${row.name}`.trim(), row.amount, "", "");
    push("Total assets", statement.balanceSheet.assetsTotal, "", "");
    push("Liabilities", "", "", "");
    for (const row of statement.balanceSheet.liabilities) push(`${row.code} ${row.name}`.trim(), row.amount, "", "");
    push("Total liabilities", statement.balanceSheet.liabilitiesTotal, "", "");
    push("Equity", "", "", "");
    for (const row of statement.balanceSheet.equity) push(`${row.code} ${row.name}`.trim(), row.amount, "", "");
    push("Total equity", statement.balanceSheet.equityTotal, "", "");
  } else if (report === "cash-flow") {
    for (const row of statement.cashFlow.lines) push(row.label, row.amount, "", "");
  } else {
    push("Income", "", "", "");
    for (const row of statement.profitAndLoss.incomeRows) push(`${row.code} ${row.name}`, row.amount, row.priorAmount, row.change);
    push("Total income", statement.profitAndLoss.income, formatMoney(statement.profitAndLoss.priorIncomeCents), formatMoney(addCents(statement.profitAndLoss.incomeCents, -statement.profitAndLoss.priorIncomeCents)));
    push("Expenses", "", "", "");
    for (const row of statement.profitAndLoss.expenseRows) push(`${row.code} ${row.name}`, row.amount, row.priorAmount, row.change);
    push("Total expenses", statement.profitAndLoss.expenses, formatMoney(statement.profitAndLoss.priorExpenseCents), formatMoney(addCents(statement.profitAndLoss.expenseCents, -statement.profitAndLoss.priorExpenseCents)));
    push("Net income", statement.profitAndLoss.netIncome, formatMoney(statement.profitAndLoss.priorNetIncomeCents || 0), formatMoney(addCents(statement.profitAndLoss.netIncomeCents, -(statement.profitAndLoss.priorNetIncomeCents || 0))));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
  return text;
}
