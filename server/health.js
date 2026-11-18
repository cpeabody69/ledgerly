// Client financial health. Every alert names the records, the calculation, and why it needs review.
import { randomUUID } from "node:crypto";
import { lookupClient, scopeSql } from "./access.js";
import { ensureWork } from "./work.js";

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  return Math.round((Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) / 86400000);
}

function fail(status, error) {
  return { status, error };
}

function actor(db, session) {
  if (!session?.user_id || !session.firm_id || session.portal) return null;
  return db.prepare("SELECT id, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
}

function visibleClients(db, session) {
  const extra = scopeSql(db, session, "clients.id");
  return db.prepare(
    `SELECT id, name, status FROM clients
     WHERE firm_id = ? AND status != 'archived' ${extra.sql}
     ORDER BY position, name`,
  ).all(session.firm_id, ...extra.params);
}

function clientFor(db, session, clientId) {
  const row = lookupClient(db, session, clientId);
  if (!row) return null;
  return db.prepare("SELECT id, name, status FROM clients WHERE id = ? AND firm_id = ?").get(row.id, session.firm_id);
}

function activityTotals(db, session, clientId, start, end) {
  const rows = db.prepare(
    `SELECT accounts.type AS type,
            COALESCE(SUM(CASE WHEN journal_entries.id IS NOT NULL THEN journal_lines.debit_cents ELSE 0 END), 0) AS debit_cents,
            COALESCE(SUM(CASE WHEN journal_entries.id IS NOT NULL THEN journal_lines.credit_cents ELSE 0 END), 0) AS credit_cents
     FROM accounts
     LEFT JOIN journal_lines ON journal_lines.account_id = accounts.id
       AND journal_lines.firm_id = accounts.firm_id
       AND journal_lines.client_id = accounts.client_id
     LEFT JOIN journal_entries ON journal_entries.id = journal_lines.entry_id
       AND journal_entries.firm_id = journal_lines.firm_id
       AND journal_entries.entry_date >= ? AND journal_entries.entry_date <= ?
     WHERE accounts.firm_id = ? AND accounts.client_id = ? AND accounts.type IN ('income', 'expense')
     GROUP BY accounts.type`,
  ).all(start, end, session.firm_id, clientId);
  const totals = { incomeCents: 0, expenseCents: 0 };
  for (const row of rows) {
    const debit = Number(row.debit_cents);
    const credit = Number(row.credit_cents);
    if (row.type === "income") totals.incomeCents += credit - debit;
    if (row.type === "expense") totals.expenseCents += debit - credit;
  }
  totals.netCents = totals.incomeCents - totals.expenseCents;
  return totals;
}

function cashBalance(db, session, clientId, end) {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN journal_entries.id IS NOT NULL THEN journal_lines.debit_cents ELSE 0 END), 0) AS debit_cents,
       COALESCE(SUM(CASE WHEN journal_entries.id IS NOT NULL THEN journal_lines.credit_cents ELSE 0 END), 0) AS credit_cents
     FROM accounts
     LEFT JOIN journal_lines ON journal_lines.account_id = accounts.id
       AND journal_lines.firm_id = accounts.firm_id
       AND journal_lines.client_id = accounts.client_id
     LEFT JOIN journal_entries ON journal_entries.id = journal_lines.entry_id
       AND journal_entries.firm_id = journal_lines.firm_id
       AND journal_entries.entry_date <= ?
     WHERE accounts.firm_id = ? AND accounts.client_id = ?
       AND accounts.type = 'asset'
       AND (
         accounts.code = '1000'
         OR lower(accounts.name) LIKE '%cash%'
         OR lower(accounts.name) LIKE '%checking%'
         OR lower(accounts.name) LIKE '%bank%'
       )`,
  ).get(end, session.firm_id, clientId);
  return Number(row.debit_cents) - Number(row.credit_cents);
}

function monthHasActivity(db, session, clientId, period) {
  const start = `${period}-01`;
  const end = monthEnd(period);
  const journal = db.prepare(
    `SELECT COUNT(*) AS count FROM journal_entries
     WHERE firm_id = ? AND client_id = ? AND entry_date >= ? AND entry_date <= ?`,
  ).get(session.firm_id, clientId, start, end);
  const bank = db.prepare(
    `SELECT COUNT(*) AS count FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND status != 'excluded' AND posted_on >= ? AND posted_on <= ?`,
  ).get(session.firm_id, clientId, start, end);
  return Number(journal.count) + Number(bank.count) > 0;
}

function monthEnd(period) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

function closeProgress(db, session, clientId, today) {
  const year = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const months = [];
  for (let month = 1; month < currentMonth; month += 1) {
    const period = `${year}-${String(month).padStart(2, "0")}`;
    const lock = db.prepare(
      "SELECT status FROM period_locks WHERE firm_id = ? AND client_id = ? AND period = ?",
    ).get(session.firm_id, clientId, period);
    const activity = monthHasActivity(db, session, clientId, period);
    months.push({
      period,
      closed: lock?.status === "closed",
      activity,
    });
  }
  return {
    year,
    months,
    closedWithActivity: months.filter((month) => month.activity && month.closed).length,
    openWithActivity: months.filter((month) => month.activity && !month.closed).length,
    calculation: "A past month counts as open when it has a journal entry or a bank line and period_locks.status is not closed.",
  };
}

function ageBucket(due, today) {
  if (!due || due >= today) return "current";
  const age = daysBetween(due, today);
  if (age <= 30) return "days30";
  if (age <= 60) return "days60";
  if (age <= 90) return "days90";
  return "over90";
}

function emptyAging() {
  return { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
}

function receivableRows(db, session, clientId) {
  return db.prepare(
    `SELECT invoices.id, invoices.number, invoices.due_date, invoices.total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM invoice_payments
              WHERE invoice_payments.invoice_id = invoices.id AND invoice_payments.firm_id = invoices.firm_id), 0) AS paid_cents
     FROM invoices
     WHERE invoices.firm_id = ? AND invoices.client_id = ? AND invoices.status IN ('sent', 'partial')`,
  ).all(session.firm_id, clientId).map((row) => ({
    id: row.id,
    number: row.number,
    dueOn: row.due_date,
    balanceCents: Number(row.total_cents) - Number(row.paid_cents),
  })).filter((row) => row.balanceCents > 0);
}

function payableRows(db, session, clientId) {
  return db.prepare(
    `SELECT ap_bills.id, ap_bills.invoice_number, ap_bills.due_date, ap_bills.total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM ap_payments
              WHERE ap_payments.bill_id = ap_bills.id AND ap_payments.firm_id = ap_bills.firm_id AND ap_payments.status = 'recorded'), 0) AS paid_cents
     FROM ap_bills
     WHERE ap_bills.firm_id = ? AND ap_bills.client_id = ? AND ap_bills.status IN ('awaiting_approval', 'approved', 'posted')`,
  ).all(session.firm_id, clientId).map((row) => ({
    id: row.id,
    number: row.invoice_number,
    dueOn: row.due_date,
    balanceCents: Number(row.total_cents) - Number(row.paid_cents),
  })).filter((row) => row.balanceCents > 0);
}

function agingOf(rows, today) {
  const buckets = emptyAging();
  const open = [];
  for (const row of rows) {
    const bucket = ageBucket(row.dueOn, today);
    buckets[bucket] += row.balanceCents;
    open.push({ ...row, bucket });
  }
  return { buckets, open };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function bankLines(db, session, clientId, start, end) {
  return db.prepare(
    `SELECT id, posted_on, description, amount_cents FROM bank_transactions
     WHERE firm_id = ? AND client_id = ? AND status != 'excluded' AND posted_on >= ? AND posted_on <= ?
     ORDER BY posted_on, id`,
  ).all(session.firm_id, clientId, start, end);
}

function buildAlerts(db, session, client, today) {
  const year = Number(today.slice(0, 4));
  const start = `${year}-01-01`;
  const priorStart = `${year - 1}-01-01`;
  const priorEnd = `${year - 1}-${today.slice(5)}`;
  const current = activityTotals(db, session, client.id, start, today);
  const prior = activityTotals(db, session, client.id, priorStart, priorEnd);
  const monthStart = `${today.slice(0, 7)}-01`;
  const priorMonthEnd = addDays(monthStart, -1);
  const cashNow = cashBalance(db, session, client.id, today);
  const cashThen = cashBalance(db, session, client.id, priorMonthEnd);
  const cashChange = cashNow - cashThen;
  const receivables = agingOf(receivableRows(db, session, client.id), today);
  const payables = agingOf(payableRows(db, session, client.id), today);
  const dueSoon = addDays(today, 30);
  const upcomingPayables = payables.open.filter((row) => row.dueOn && row.dueOn <= dueSoon);
  const upcomingCents = upcomingPayables.reduce((sum, row) => sum + row.balanceCents, 0);
  const close = closeProgress(db, session, client.id, today);
  const lines = bankLines(db, session, client.id, start, today);
  const alerts = [];

  if (prior.incomeCents > 0 && current.incomeCents * 100 < prior.incomeCents * 80) {
    alerts.push({
      key: "revenue",
      recordKey: String(year),
      title: "Revenue is down from last year",
      review: true,
      records: [],
      calculation: `Income accounts from ${start} through ${today} total ${current.incomeCents} cents. The same dates in ${year - 1} total ${prior.incomeCents} cents. Current income is under 80 percent of that prior amount.`,
      reason: "The drop is large enough to review before the year is used for planning.",
      clear: "Confirm the missing income is posted, or record why this year is lower.",
    });
  }
  if (prior.expenseCents > 0 && current.expenseCents * 100 > prior.expenseCents * 125) {
    alerts.push({
      key: "expense",
      recordKey: String(year),
      title: "Expenses are up from last year",
      review: true,
      records: [],
      calculation: `Expense accounts from ${start} through ${today} total ${current.expenseCents} cents. The same dates in ${year - 1} total ${prior.expenseCents} cents. Current expenses are over 125 percent of that prior amount.`,
      reason: "The increase is large enough to review before the profit figure is used.",
      clear: "Confirm the extra expenses belong in this year.",
    });
  }
  if (current.incomeCents > 0 && current.netCents < 0) {
    alerts.push({
      key: "profit",
      recordKey: String(year),
      title: "Profit is negative",
      review: true,
      records: [],
      calculation: `Net is income ${current.incomeCents} cents minus expenses ${current.expenseCents} cents, which is ${current.netCents} cents.`,
      reason: "Expenses are higher than income for the year to date.",
      clear: "Review the income and expense accounts that make up the net.",
    });
  }
  if (cashThen > 0 && cashChange <= -50000 && cashChange * -2 > cashThen) {
    alerts.push({
      key: "cash",
      recordKey: today.slice(0, 7),
      title: "Cash fell since last month",
      review: true,
      records: [],
      calculation: `Cash on asset accounts coded 1000, or named cash, checking, or bank, was ${cashThen} cents on ${priorMonthEnd} and is ${cashNow} cents on ${today}. The drop is ${cashChange * -1} cents, more than half of last month and at least 50000 cents.`,
      reason: "The cash balance moved enough to review before treating the balance as available.",
      clear: "Trace the journal lines that reduced those cash accounts.",
    });
  }
  if (upcomingCents > 0 && cashNow < upcomingCents) {
    alerts.push({
      key: "liquidity",
      recordKey: "30-days",
      title: "Cash is below bills due soon",
      review: true,
      records: upcomingPayables.map((row) => ({ kind: "bill", id: row.id, number: row.number, dueOn: row.dueOn, amountCents: row.balanceCents })),
      calculation: `Cash on asset accounts coded 1000, or named cash, checking, or bank, is ${cashNow} cents. Bills due through ${dueSoon} total ${upcomingCents} cents. The shortfall is ${upcomingCents - cashNow} cents.`,
      reason: "Bills due in the next 30 days are larger than the cash balance.",
      clear: "Record a bill payment, change a due date, or post the cash that covers the bills.",
    });
  }
  for (const row of receivables.open.filter((item) => item.bucket === "over90")) {
    alerts.push({
      key: "receivable",
      recordKey: row.id,
      title: "Invoice is over 90 days past due",
      review: true,
      records: [{ kind: "invoice", id: row.id, number: row.number, dueOn: row.dueOn, amountCents: row.balanceCents }],
      calculation: `Invoice ${row.number} is due ${row.dueOn}. Today is ${today}, which is ${daysBetween(row.dueOn, today)} days later. The open balance is total minus recorded payments, ${row.balanceCents} cents.`,
      reason: "An open invoice this old needs a collection or write-off decision.",
      clear: "Record a payment, void the invoice, or document why it stays open.",
    });
  }
  for (const row of payables.open.filter((item) => item.bucket === "over90")) {
    alerts.push({
      key: "payable",
      recordKey: row.id,
      title: "Bill is over 90 days past due",
      review: true,
      records: [{ kind: "bill", id: row.id, number: row.number, dueOn: row.dueOn, amountCents: row.balanceCents }],
      calculation: `Bill ${row.number} is due ${row.dueOn}. Today is ${today}, which is ${daysBetween(row.dueOn, today)} days later. The open balance is total minus recorded payments, ${row.balanceCents} cents.`,
      reason: "An open bill this old needs a payment or a dispute note.",
      clear: "Record a payment or reject the bill if it should not be paid.",
    });
  }

  const groups = new Map();
  for (const line of lines) {
    const description = String(line.description || "").trim().toLowerCase();
    const key = `${line.posted_on}|${line.amount_cents}|${description}`;
    const group = groups.get(key) || [];
    group.push(line);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    alerts.push({
      key: "duplicate",
      recordKey: key.slice(0, 120),
      title: "Possible duplicate bank lines",
      review: true,
      records: group.map((line) => ({
        kind: "bank_transaction",
        id: line.id,
        postedOn: line.posted_on,
        amountCents: Number(line.amount_cents),
        description: line.description,
      })),
      calculation: `Grouped bank lines by date, amount, and description. ${group.length} lines share ${group[0].posted_on}, ${group[0].amount_cents} cents, and the same description.`,
      reason: "The same date, amount, and description posted more than once.",
      clear: "Exclude the extra line, or change the description if the events are different.",
    });
  }

  const amounts = lines.map((line) => Math.abs(Number(line.amount_cents)));
  if (amounts.length >= 5) {
    const middle = median(amounts);
    if (middle >= 1000) {
      for (const line of lines) {
        const amount = Math.abs(Number(line.amount_cents));
        if (amount < middle * 3) continue;
        alerts.push({
          key: "unusual",
          recordKey: line.id,
          title: "Bank line is larger than the usual amount",
          review: true,
          records: [{
            kind: "bank_transaction",
            id: line.id,
            postedOn: line.posted_on,
            amountCents: Number(line.amount_cents),
            description: line.description,
          }],
          calculation: `The median absolute amount of ${amounts.length} bank lines this year is ${middle} cents. This line is ${amount} cents, at least three times that median.`,
          reason: "One line is far from the other lines, so the total may include a mistake.",
          clear: "Confirm the amount, or exclude the line if it was entered twice.",
        });
      }
    }
  }

  for (const month of close.months.filter((item) => item.activity && !item.closed)) {
    alerts.push({
      key: "close",
      recordKey: month.period,
      title: "Month with activity is still open",
      review: true,
      records: [{ kind: "period", id: month.period }],
      calculation: `${month.period} has a journal entry or a bank line. period_locks has no closed row for it. The month ended ${monthEnd(month.period)}.`,
      reason: "Activity in a past month is still unlocked.",
      clear: "Finish the monthly close, or document why the month stays open.",
    });
  }

  return {
    alerts,
    trends: {
      revenue: {
        currentCents: current.incomeCents,
        priorCents: prior.incomeCents,
        calculation: `Income accounts from ${start} through ${today}, compared with ${priorStart} through ${priorEnd}.`,
      },
      expenses: {
        currentCents: current.expenseCents,
        priorCents: prior.expenseCents,
        calculation: `Expense accounts from ${start} through ${today}, compared with ${priorStart} through ${priorEnd}.`,
      },
      profit: {
        currentCents: current.netCents,
        priorCents: prior.netCents,
        calculation: "Net cents equal income cents minus expense cents for the same dates.",
      },
      cashFlow: {
        currentCents: cashNow,
        priorCents: cashThen,
        changeCents: cashChange,
        calculation: `Cash is the balance of asset accounts coded 1000, or named cash, checking, or bank, through ${today}. The prior figure is the same balance through ${priorMonthEnd}.`,
      },
      yearOverYear: {
        currentIncomeCents: current.incomeCents,
        priorIncomeCents: prior.incomeCents,
        currentExpenseCents: current.expenseCents,
        priorExpenseCents: prior.expenseCents,
        currentNetCents: current.netCents,
        priorNetCents: prior.netCents,
        calculation: "Year-over-year uses the year-to-date income, expense, and net figures above. It is not a score.",
      },
    },
    receivables: receivables.buckets,
    payables: payables.buckets,
    liquidity: {
      cashCents: cashNow,
      billsDueSoonCents: upcomingCents,
      through: dueSoon,
      calculation: `Compares the cash balance with bills due on or before ${dueSoon}.`,
    },
    close,
  };
}

function inspect(db, session, client, today) {
  const built = buildAlerts(db, session, client, today);
  return {
    clientId: client.id,
    clientName: client.name,
    asOf: today,
    ...built,
    note: "Each alert names the records, the calculation, and the reason for review. There is no score.",
  };
}

function taskSourceId(clientId, alert) {
  return `${clientId}:${alert.key}:${alert.recordKey}`;
}

function writeHealthTask(db, session, client, alert) {
  const sourceId = taskSourceId(client.id, alert);
  const detail = `${alert.calculation} ${alert.reason}`.slice(0, 900);
  const existing = db.prepare(
    "SELECT * FROM work_tasks WHERE firm_id = ? AND source_type = 'health_issue' AND source_id = ?",
  ).get(session.firm_id, sourceId);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === "completed") {
      db.prepare(
        `UPDATE work_tasks SET status = 'open', stage = 'ready', detail = ?, completed_by_user_id = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ? AND firm_id = ?`,
      ).run(detail, now, existing.id, session.firm_id);
      db.prepare(
        `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
         VALUES (?, ?, ?, ?, 'reopen', 'The financial alert is open again.', ?)`,
      ).run(randomUUID(), session.firm_id, existing.id, session.user_id, now);
    }
    return;
  }
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO work_tasks (
        id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
        source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at,
        stage, recurrence, blocked_by_task_id, schedule_id
      ) VALUES (?, ?, ?, ?, ?, '', 'bookkeeping', 'open', 'normal', NULL, ?, 'health_issue', ?, NULL, NULL, ?, ?, ?, 'ready', '', NULL, NULL)`,
    ).run(id, session.firm_id, client.id, alert.title, detail, todayIso(), sourceId, session.user_id, now, now);
    db.prepare(
      `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
       VALUES (?, ?, ?, ?, 'create', ?, ?)`,
    ).run(randomUUID(), session.firm_id, id, session.user_id, alert.title, now);
  } catch (error) {
    if (!String(error.message || error).includes("UNIQUE")) throw error;
  }
}

function finishHealthTask(db, session, taskId) {
  const now = new Date().toISOString();
  const changed = db.prepare(
    `UPDATE work_tasks SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND firm_id = ? AND status != 'completed'`,
  ).run(session.user_id, now, now, taskId, session.firm_id);
  if (!changed.changes) return;
  db.prepare(
    `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, 'complete', 'The financial alert is resolved.', ?)`,
  ).run(randomUUID(), session.firm_id, taskId, session.user_id, now);
}

export function syncHealthIssues(db, session, onlyClientId = "") {
  if (!session?.firm_id || !session.user_id || session.portal) return;
  ensureWork(db);
  const today = todayIso();
  const clients = visibleClients(db, session).filter((client) => !onlyClientId || client.id === onlyClientId);
  const openIds = new Set();
  for (const client of clients) {
    const view = inspect(db, session, client, today);
    for (const alert of view.alerts) {
      const sourceId = taskSourceId(client.id, alert);
      openIds.add(sourceId);
      writeHealthTask(db, session, client, alert);
    }
  }
  const taskScope = scopeSql(db, session, "work_tasks.client_id");
  const openTasks = db.prepare(
    `SELECT id, source_id, client_id FROM work_tasks
     WHERE firm_id = ? AND source_type = 'health_issue' AND status != 'completed'
     ${taskScope.sql}`,
  ).all(session.firm_id, ...taskScope.params);
  for (const task of openTasks) {
    if (onlyClientId && task.client_id !== onlyClientId) continue;
    if (!openIds.has(task.source_id)) finishHealthTask(db, session, task.id);
  }
}

function summaryFor(db, session, client, today) {
  const view = inspect(db, session, client, today);
  return {
    id: client.id,
    name: client.name,
    openAlerts: view.alerts.length,
    labels: view.alerts.map((alert) => alert.title),
  };
}

export function healthBoard(db, session) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const today = todayIso();
  const rows = visibleClients(db, session).map((client) => summaryFor(db, session, client, today));
  const attention = rows.filter((row) => row.openAlerts > 0);
  return {
    status: 200,
    payload: {
      asOf: today,
      counts: {
        clients: rows.length,
        needingAttention: attention.length,
      },
      clients: attention,
      note: "Each alert names the records, the calculation, and the reason for review. There is no score.",
    },
  };
}

export function readHealth(db, session, clientId) {
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientFor(db, session, clientId);
  if (!client || client.status === "archived") return fail(404, "Client not found.");
  syncHealthIssues(db, session, client.id);
  return { status: 200, payload: inspect(db, session, client, todayIso()) };
}
