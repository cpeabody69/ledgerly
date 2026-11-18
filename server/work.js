import { randomUUID } from "node:crypto";
import { accessScope, lookupClient, scopeSql } from "./access.js";
import { canApproveBills, canSeeTeamWork } from "./permissions.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_tasks (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT REFERENCES clients(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'waiting_on_client', 'completed')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_user_id TEXT REFERENCES users(id),
  due_on TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  completed_by_user_id TEXT REFERENCES users(id),
  completed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_tasks_source ON work_tasks (firm_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS work_tasks_by_firm ON work_tasks (firm_id, status, due_on);
CREATE TABLE IF NOT EXISTS work_task_events (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  task_id TEXT NOT NULL REFERENCES work_tasks(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'assign', 'priority', 'status', 'due_date', 'comment', 'complete', 'reopen')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_task_events_by_task ON work_task_events (firm_id, task_id, created_at);
CREATE TABLE IF NOT EXISTS work_notices (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL REFERENCES work_tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('assigned', 'reassigned', 'completed', 'overdue')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS work_notices_by_user ON work_notices (firm_id, user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS work_notices_overdue ON work_notices (firm_id, task_id, user_id) WHERE kind = 'overdue';
`;

const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_templates (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  template_key TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_templates_key ON work_templates (firm_id, template_key);
CREATE TABLE IF NOT EXISTS work_schedules (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  template_id TEXT NOT NULL REFERENCES work_templates(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  assignee_user_id TEXT REFERENCES users(id),
  next_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_schedules_client ON work_schedules (firm_id, template_id, client_id);
CREATE INDEX IF NOT EXISTS work_schedules_due ON work_schedules (firm_id, active, next_on);
CREATE TABLE IF NOT EXISTS work_reminders (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL REFERENCES work_tasks(id),
  remind_on TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_reminders_once ON work_reminders (firm_id, user_id, task_id, remind_on);
`;

const TASK_COLUMNS = [
  ["stage", "TEXT NOT NULL DEFAULT 'ready'"],
  ["recurrence", "TEXT NOT NULL DEFAULT ''"],
  ["blocked_by_task_id", "TEXT"],
  ["schedule_id", "TEXT"],
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUSES = ["open", "waiting_on_client", "completed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const CATEGORIES = ["uncategorized", "bill", "invoice", "document", "general", "bookkeeping", "reconciliation", "tax", "onboarding"];
const STAGES = ["ready", "in_review", "approved"];
const CADENCES = ["", "daily", "weekly", "monthly", "quarterly", "annual"];
const ACCOUNTING_TYPES = ["uncategorized_group", "bill", "invoice", "document_request", "unreconciled_account", "unpaid_bill", "bookkeeping_month"];
const TEMPLATES = [
  {
    key: "monthly-bookkeeping",
    name: "Monthly bookkeeping",
    detail: "Categorize the month, reconcile the bank, and clear open document requests. This checklist does not file a return.",
    cadence: "monthly",
    category: "bookkeeping",
    priority: "normal",
  },
  {
    key: "bank-reconciliation",
    name: "Bank reconciliation",
    detail: "Reconcile the client's bank accounts to the statement.",
    cadence: "monthly",
    category: "reconciliation",
    priority: "normal",
  },
  {
    key: "quarterly-tax-planning",
    name: "Quarterly tax planning",
    detail: "Review the quarter and prepare planning notes. This template does not file a tax return.",
    cadence: "quarterly",
    category: "tax",
    priority: "normal",
  },
  {
    key: "annual-tax-readiness",
    name: "Annual tax preparation readiness",
    detail: "Gather what the annual return will need. This template does not file a tax return.",
    cadence: "annual",
    category: "tax",
    priority: "high",
  },
  {
    key: "new-client-onboarding",
    name: "New client onboarding",
    detail: "Set up the client file, chart, and first document request. This runs once.",
    cadence: "once",
    category: "onboarding",
    priority: "high",
  },
];

const STATUS_LABEL = {
  open: "Open",
  waiting_on_client: "Waiting on client",
  completed: "Completed",
};
const PRIORITY_LABEL = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};
const CATEGORY_LABEL = {
  uncategorized: "Uncategorized activity",
  bill: "Bill approval",
  invoice: "Overdue invoice",
  document: "Document request",
  general: "General",
  bookkeeping: "Bookkeeping",
  reconciliation: "Reconciliation",
  tax: "Tax",
  onboarding: "Onboarding",
};
const STAGE_LABEL = {
  ready: "Ready",
  in_review: "In review",
  approved: "Approved",
};
const CADENCE_LABEL = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  once: "Once",
};
const ACTION_LABEL = {
  create: "Created",
  assign: "Assigned",
  priority: "Priority",
  status: "Status",
  due_date: "Due date",
  comment: "Comment",
  complete: "Completed",
  reopen: "Reopened",
};

function fail(status, error) {
  return { status, error };
}

function ensureColumn(db, table, name, definition) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  if (present.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function seedTemplates(db) {
  const firms = db.prepare("SELECT id FROM firms").all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO work_templates (
      id, firm_id, template_key, name, detail, cadence, category, priority, active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const now = new Date().toISOString();
  for (const firm of firms) {
    for (const template of TEMPLATES) {
      insert.run(randomUUID(), firm.id, template.key, template.name, template.detail, template.cadence, template.category, template.priority, now);
    }
  }
}

// Additive migration when a process opens its own database:
// stage, recurrence, blocked_by_task_id, and schedule_id on work_tasks,
// plus work_templates, work_schedules, and work_reminders.
// Existing task rows stay open or completed as stored. Status, event, and
// notice checks are unchanged.
export function ensureWork(db) {
  db.exec(SCHEMA);
  db.exec(WORKFLOW_SCHEMA);
  for (const [name, definition] of TASK_COLUMNS) ensureColumn(db, "work_tasks", name, definition);
  seedTemplates(db);
}

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function addMonths(iso, months) {
  const [year, month, day] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last)));
  return result.toISOString().slice(0, 10);
}

function nextOccurrence(iso, cadence) {
  if (!iso) return "";
  if (cadence === "daily") return addDays(iso, 1);
  if (cadence === "weekly") return addDays(iso, 7);
  if (cadence === "monthly") return addMonths(iso, 1);
  if (cadence === "quarterly") return addMonths(iso, 3);
  if (cadence === "annual") return addMonths(iso, 12);
  return "";
}

function monthStamp(iso) {
  return iso.slice(0, 7);
}

function monthTitle(iso) {
  const [year, month] = iso.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

function formatDay(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return "";
  return `${name} ${Number(day)}, ${year}`;
}

function formatWhen(value) {
  if (!value) return "";
  const day = localDate(value);
  const time = new Date(value);
  if (!day || Number.isNaN(time.getTime())) return "";
  const hours = time.getHours();
  const minutes = String(time.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 || 12;
  return `${formatDay(day)} ${hour}:${minutes} ${suffix}`;
}

function parseDay(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return text;
}

function weekBounds(today) {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = date.getDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const start = new Date(year, month - 1, day + mondayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { start: localDate(start), end: localDate(end) };
}

function monthBounds(today) {
  const [year, month] = today.split("-").map(Number);
  const last = new Date(year, month, 0).getDate();
  return {
    start: `${today.slice(0, 7)}-01`,
    end: `${today.slice(0, 7)}-${String(last).padStart(2, "0")}`,
  };
}

function actor(db, session) {
  if (!session || session.portal) return null;
  return db.prepare(
    "SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?",
  ).get(session.user_id, session.firm_id);
}

function teamRole(role) {
  return canSeeTeamWork(role);
}

function clientInFirm(db, session, clientId) {
  if (!clientId) return null;
  const row = lookupClient(db, session, clientId);
  return row ? { id: row.id, name: row.name } : null;
}

function memberInFirm(db, session, userId) {
  if (!userId) return null;
  return db.prepare("SELECT id, name, role FROM users WHERE id = ? AND firm_id = ?").get(userId, session.firm_id);
}

function targetFor(row) {
  if (row.source_type === "uncategorized_group") {
    return { screen: "Transactions", transactionTab: "for_review", transactionPeriod: "Custom range" };
  }
  if (row.source_type === "bill") return { screen: "Accounts Payable", billId: row.source_id };
  if (row.source_type === "invoice") return { screen: "Invoices", invoiceId: row.source_id };
  if (row.source_type === "document_request") return { screen: "Clients", requestId: row.source_id };
  if (row.source_type === "unreconciled_account") return { screen: "Transactions", transactionTab: "reconcile", bankAccountId: row.source_id };
  if (row.source_type === "unpaid_bill") return { screen: "Accounts Payable", billId: row.source_id };
  if (row.source_type === "bookkeeping_month") return { screen: "Transactions", transactionTab: "for_review" };
  return null;
}

function insertNotice(db, session, userId, taskId, kind, title) {
  if (!userId) return;
  try {
    db.prepare(
      `INSERT INTO work_notices (id, firm_id, user_id, task_id, kind, title, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(randomUUID(), session.firm_id, userId, taskId, kind, title, new Date().toISOString());
  } catch (error) {
    if (kind === "overdue" && String(error.message || error).includes("UNIQUE")) return;
    throw error;
  }
}

function notifyAssignment(db, session, taskId, title, previousAssigneeId, assigneeId) {
  if (!assigneeId || assigneeId === (previousAssigneeId || null)) return;
  const kind = previousAssigneeId ? "reassigned" : "assigned";
  insertNotice(db, session, assigneeId, taskId, kind, `${kind === "reassigned" ? "Reassigned" : "Assigned"}: ${title}`);
}

function notifyCompleted(db, session, taskId, title, assigneeId) {
  insertNotice(db, session, assigneeId, taskId, "completed", `Completed: ${title}`);
}

function syncOverdueNotices(db, session) {
  const today = localDate();
  const rows = db.prepare(
    `SELECT id, title, assignee_user_id FROM work_tasks
     WHERE firm_id = ? AND assignee_user_id IS NOT NULL AND status != 'completed' AND due_on != '' AND due_on < ?`,
  ).all(session.firm_id, today);
  for (const row of rows) insertNotice(db, session, row.assignee_user_id, row.id, "overdue", `Overdue: ${row.title}`);
}

function noticeJson(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    taskId: row.task_id,
    createdAt: row.created_at,
    createdAtLabel: formatWhen(row.created_at),
    readAt: row.read_at || "",
  };
}

function recordEvent(db, session, taskId, action, detail = "") {
  db.prepare(
    `INSERT INTO work_task_events (id, firm_id, task_id, actor_user_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), session.firm_id, taskId, session.user_id, action, detail, new Date().toISOString());
}

function eventJson(row) {
  return {
    id: row.id,
    action: row.action,
    actionLabel: ACTION_LABEL[row.action] || row.action,
    detail: row.detail || "",
    actorId: row.actor_user_id,
    actorName: row.actor_name || "",
    createdAt: row.created_at,
    createdAtLabel: formatWhen(row.created_at),
  };
}

function historyMap(db, session) {
  const rows = db.prepare(
    `SELECT work_task_events.*, users.name AS actor_name
     FROM work_task_events
     LEFT JOIN users ON users.id = work_task_events.actor_user_id AND users.firm_id = work_task_events.firm_id
     WHERE work_task_events.firm_id = ?
     ORDER BY work_task_events.created_at, work_task_events.id`,
  ).all(session.firm_id);
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.task_id) || [];
    list.push(eventJson(row));
    map.set(row.task_id, list);
  }
  return map;
}

function taskJson(row, history = []) {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail || "",
    notes: row.notes || "",
    category: row.category,
    categoryLabel: CATEGORY_LABEL[row.category] || row.category,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    priority: row.priority,
    priorityLabel: PRIORITY_LABEL[row.priority] || row.priority,
    dueOn: row.due_on || "",
    dueOnLabel: formatDay(row.due_on || ""),
    clientId: row.client_id || "",
    clientName: row.client_name || "",
    assigneeId: row.assignee_user_id || "",
    assigneeName: row.assignee_name || "",
    sourceType: row.source_type || "",
    sourceId: row.source_type ? row.source_id : "",
    stage: row.stage || "ready",
    stageLabel: STAGE_LABEL[row.stage || "ready"] || "Ready",
    recurrence: row.recurrence || "",
    recurrenceLabel: CADENCE_LABEL[row.recurrence] || "",
    blockedByTaskId: row.blocked_by_task_id || "",
    blockedByTitle: row.blocker_title || "",
    blocked: Boolean(row.blocked_by_task_id) && row.blocker_status && row.blocker_status !== "completed",
    scheduleId: row.schedule_id || "",
    target: targetFor(row),
    completedById: row.completed_by_user_id || "",
    completedByName: row.completed_by_name || "",
    completedAt: row.completed_at || "",
    completedAtLabel: formatWhen(row.completed_at || ""),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    history,
  };
}

function taskRows(db, session, user) {
  const mine = teamRole(user.role) ? 0 : 1;
  const extra = scopeSql(db, session, "work_tasks.client_id");
  return db.prepare(
    `SELECT work_tasks.*, clients.name AS client_name, assignees.name AS assignee_name, completers.name AS completed_by_name,
            blockers.title AS blocker_title, blockers.status AS blocker_status
     FROM work_tasks
     LEFT JOIN clients ON clients.id = work_tasks.client_id AND clients.firm_id = work_tasks.firm_id
     LEFT JOIN users AS assignees ON assignees.id = work_tasks.assignee_user_id AND assignees.firm_id = work_tasks.firm_id
     LEFT JOIN users AS completers ON completers.id = work_tasks.completed_by_user_id AND completers.firm_id = work_tasks.firm_id
     LEFT JOIN work_tasks AS blockers ON blockers.id = work_tasks.blocked_by_task_id AND blockers.firm_id = work_tasks.firm_id
     WHERE work_tasks.firm_id = ?
       AND (? = 0 OR work_tasks.assignee_user_id = ?)
       ${extra.sql}
     ORDER BY CASE work_tasks.status WHEN 'completed' THEN 1 ELSE 0 END, work_tasks.due_on, work_tasks.title`,
  ).all(session.firm_id, mine, user.id, ...extra.params);
}

export function taskCounts(tasks, today = localDate()) {
  const week = weekBounds(today);
  const month = monthBounds(today);
  const openTasks = tasks.filter((task) => task.status !== "completed");
  return {
    open: tasks.filter((task) => task.status === "open").length,
    overdue: openTasks.filter((task) => task.dueOn && task.dueOn < today).length,
    dueToday: openTasks.filter((task) => task.dueOn === today).length,
    dueThisWeek: openTasks.filter((task) => task.dueOn && task.dueOn >= week.start && task.dueOn <= week.end).length,
    waitingOnClient: tasks.filter((task) => task.status === "waiting_on_client").length,
    completedThisMonth: tasks.filter((task) => {
      if (task.status !== "completed" || !task.completedAt) return false;
      const day = localDate(task.completedAt);
      return day >= month.start && day <= month.end;
    }).length,
    today,
    week,
    month,
  };
}

function insertSource(db, session, source) {
  const existing = db.prepare(
    "SELECT * FROM work_tasks WHERE firm_id = ? AND source_type = ? AND source_id = ?",
  ).get(session.firm_id, source.sourceType, source.sourceId);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === "completed" && source.reopen) {
      db.prepare(
        `UPDATE work_tasks
         SET status = 'open', stage = 'ready', detail = ?, due_on = ?, priority = ?,
             completed_by_user_id = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ? AND firm_id = ?`,
      ).run(source.detail || "", source.dueOn || "", source.priority, now, existing.id, session.firm_id);
      recordEvent(db, session, existing.id, "reopen", "The accounting issue is open again.");
    } else if (existing.status !== "completed" && ((source.detail || "") !== (existing.detail || "") || (source.dueOn || "") !== (existing.due_on || ""))) {
      db.prepare(
        "UPDATE work_tasks SET detail = ?, due_on = ?, updated_at = ? WHERE id = ? AND firm_id = ?",
      ).run(source.detail || "", source.dueOn || "", now, existing.id, session.firm_id);
    }
    return existing.id;
  }
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO work_tasks (
        id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
        source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at,
        stage, recurrence, blocked_by_task_id, schedule_id
      ) VALUES (?, ?, ?, ?, ?, '', ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'ready', ?, NULL, ?)`,
    ).run(
      id,
      session.firm_id,
      source.clientId || null,
      source.title,
      source.detail || "",
      source.category,
      source.priority,
      source.assigneeId || null,
      source.dueOn || "",
      source.sourceType,
      source.sourceId,
      session.user_id,
      now,
      now,
      source.recurrence || "",
      source.scheduleId || null,
    );
    recordEvent(db, session, id, "create", source.title);
    if (source.assigneeId) notifyAssignment(db, session, id, source.title, null, source.assigneeId);
  } catch (error) {
    if (!String(error.message || error).includes("UNIQUE")) throw error;
  }
  return id;
}

function remember(openKeys, sourceType, sourceId) {
  openKeys.add(`${sourceType}:${sourceId}`);
}

function resolveSources(db, session, openKeys) {
  const extra = scopeSql(db, session, "work_tasks.client_id");
  const rows = db.prepare(
    `SELECT id, source_type, source_id FROM work_tasks
     WHERE firm_id = ? AND status != 'completed' AND source_type IN (${ACCOUNTING_TYPES.map(() => "?").join(", ")})
     ${extra.sql}`,
  ).all(session.firm_id, ...ACCOUNTING_TYPES, ...extra.params);
  const now = new Date().toISOString();
  for (const row of rows) {
    if (openKeys.has(`${row.source_type}:${row.source_id}`)) continue;
    db.prepare(
      `UPDATE work_tasks
       SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND firm_id = ? AND status != 'completed'`,
    ).run(session.user_id, now, now, row.id, session.firm_id);
    recordEvent(db, session, row.id, "complete", "The accounting issue is resolved.");
  }
}

function advanceSchedule(db, session, row) {
  if (row.cadence === "once") {
    db.prepare("UPDATE work_schedules SET active = 0 WHERE id = ? AND firm_id = ?").run(row.id, session.firm_id);
    return;
  }
  const next = nextOccurrence(row.next_on, row.cadence);
  if (!next || next === row.next_on) return;
  db.prepare("UPDATE work_schedules SET next_on = ? WHERE id = ? AND firm_id = ?").run(next, row.id, session.firm_id);
}

function syncSchedules(db, session) {
  const today = localDate();
  const extra = scopeSql(db, session, "work_schedules.client_id");
  const rows = db.prepare(
    `SELECT work_schedules.*, work_templates.name, work_templates.detail, work_templates.cadence,
            work_templates.category, work_templates.priority, clients.name AS client_name
     FROM work_schedules
     JOIN work_templates ON work_templates.id = work_schedules.template_id AND work_templates.firm_id = work_schedules.firm_id
     JOIN clients ON clients.id = work_schedules.client_id AND clients.firm_id = work_schedules.firm_id
     WHERE work_schedules.firm_id = ? AND work_schedules.active = 1 AND work_schedules.next_on != '' AND work_schedules.next_on <= ?
     ${extra.sql}`,
  ).all(session.firm_id, today, ...extra.params);
  for (const row of rows) {
    const open = db.prepare(
      "SELECT id FROM work_tasks WHERE firm_id = ? AND schedule_id = ? AND status != 'completed'",
    ).get(session.firm_id, row.id);
    if (open) continue;
    const sourceId = `${row.id}:${row.next_on}`;
    const existing = db.prepare(
      "SELECT id FROM work_tasks WHERE firm_id = ? AND source_type = 'schedule' AND source_id = ?",
    ).get(session.firm_id, sourceId);
    if (!existing) {
      insertSource(db, session, {
        clientId: row.client_id,
        title: row.name,
        detail: `${row.detail} For ${row.client_name}.`,
        category: row.category,
        priority: row.priority,
        dueOn: row.next_on,
        sourceType: "schedule",
        sourceId,
        assigneeId: row.assignee_user_id,
        scheduleId: row.id,
      });
    }
    advanceSchedule(db, session, row);
  }
}

function syncReminders(db, session) {
  const today = localDate();
  const soon = addDays(today, 1);
  const rows = db.prepare(
    `SELECT id, assignee_user_id, due_on FROM work_tasks
     WHERE firm_id = ? AND assignee_user_id IS NOT NULL AND status != 'completed' AND due_on != '' AND due_on <= ?`,
  ).all(session.firm_id, soon);
  const insert = db.prepare(
    "INSERT INTO work_reminders (id, firm_id, user_id, task_id, remind_on, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    try {
      insert.run(randomUUID(), session.firm_id, row.assignee_user_id, row.id, row.due_on, now);
    } catch (error) {
      if (!String(error.message || error).includes("UNIQUE")) throw error;
    }
  }
}

function spawnRecurrence(db, session, task) {
  const cadence = String(task.recurrence || "");
  if (!CADENCES.includes(cadence) || !cadence) return;
  const due = nextOccurrence(task.due_on || localDate(), cadence);
  if (!due) return;
  insertSource(db, session, {
    clientId: task.client_id,
    title: task.title,
    detail: task.detail || "",
    category: task.category,
    priority: task.priority,
    dueOn: due,
    sourceType: "recurrence",
    sourceId: `recur:${task.id}:${due}`,
    assigneeId: task.assignee_user_id,
    recurrence: cadence,
    scheduleId: task.schedule_id,
  });
}

function blockerState(db, session, task) {
  if (!task?.blocked_by_task_id) return "";
  const blocker = db.prepare(
    "SELECT status FROM work_tasks WHERE id = ? AND firm_id = ?",
  ).get(task.blocked_by_task_id, session.firm_id);
  if (blocker && blocker.status !== "completed") return "Finish the earlier task first.";
  return "";
}

function syncSources(db, session) {
  const today = localDate();
  const openKeys = new Set();
  const bankScope = scopeSql(db, session, "bank_transactions.client_id");
  const groups = db.prepare(
    `SELECT bank_transactions.client_id, clients.name AS client_name, COUNT(*) AS count
     FROM bank_transactions
     JOIN clients ON clients.id = bank_transactions.client_id AND clients.firm_id = bank_transactions.firm_id
     WHERE bank_transactions.firm_id = ? AND bank_transactions.status = 'for_review'
     ${bankScope.sql}
     GROUP BY bank_transactions.client_id`,
  ).all(session.firm_id, ...bankScope.params);
  for (const group of groups) {
    const count = Number(group.count);
    insertSource(db, session, {
      clientId: group.client_id,
      title: `Categorize uncategorized bank lines for ${group.client_name}`,
      detail: `${count} ${count === 1 ? "line is" : "lines are"} still for review.`,
      category: "uncategorized",
      priority: "high",
      dueOn: today,
      sourceType: "uncategorized_group",
      sourceId: group.client_id,
      reopen: true,
    });
    remember(openKeys, "uncategorized_group", group.client_id);
  }

  const billScope = scopeSql(db, session, "ap_bills.client_id");
  const bills = db.prepare(
    `SELECT ap_bills.id, ap_bills.client_id, ap_bills.invoice_number, ap_bills.due_date, ap_vendors.name AS vendor_name, clients.name AS client_name
     FROM ap_bills
     JOIN ap_vendors ON ap_vendors.id = ap_bills.vendor_id AND ap_vendors.firm_id = ap_bills.firm_id
     JOIN clients ON clients.id = ap_bills.client_id AND clients.firm_id = ap_bills.firm_id
     WHERE ap_bills.firm_id = ? AND ap_bills.status = 'awaiting_approval'
     ${billScope.sql}`,
  ).all(session.firm_id, ...billScope.params);
  for (const bill of bills) {
    insertSource(db, session, {
      clientId: bill.client_id,
      title: `Approve ${bill.vendor_name} bill ${bill.invoice_number}`,
      detail: `${bill.client_name} bill ${bill.invoice_number} is waiting for approval.`,
      category: "bill",
      priority: "normal",
      dueOn: bill.due_date,
      sourceType: "bill",
      sourceId: bill.id,
      reopen: true,
    });
    remember(openKeys, "bill", bill.id);
  }

  const invoiceScope = scopeSql(db, session, "invoices.client_id");
  const invoices = db.prepare(
    `SELECT invoices.id, invoices.client_id, invoices.number, invoices.customer_name, invoices.due_date, clients.name AS client_name
     FROM invoices
     JOIN clients ON clients.id = invoices.client_id AND clients.firm_id = invoices.firm_id
     WHERE invoices.firm_id = ? AND invoices.status IN ('sent', 'partial') AND invoices.due_date < ?
     ${invoiceScope.sql}`,
  ).all(session.firm_id, today, ...invoiceScope.params);
  for (const invoice of invoices) {
    insertSource(db, session, {
      clientId: invoice.client_id,
      title: `Collect overdue invoice ${invoice.number}`,
      detail: `${invoice.customer_name} at ${invoice.client_name} is past ${formatDay(invoice.due_date)}.`,
      category: "invoice",
      priority: "high",
      dueOn: invoice.due_date,
      sourceType: "invoice",
      sourceId: invoice.id,
      reopen: true,
    });
    remember(openKeys, "invoice", invoice.id);
  }

  const requestScope = scopeSql(db, session, "document_requests.client_id");
  const requests = db.prepare(
    `SELECT document_requests.id, document_requests.client_id, document_requests.title, document_requests.due_on, clients.name AS client_name
     FROM document_requests
     JOIN clients ON clients.id = document_requests.client_id AND clients.firm_id = document_requests.firm_id
     WHERE document_requests.firm_id = ? AND document_requests.status = 'open'
     ${requestScope.sql}`,
  ).all(session.firm_id, ...requestScope.params);
  for (const request of requests) {
    insertSource(db, session, {
      clientId: request.client_id,
      title: `Document request: ${request.title}`,
      detail: `${request.client_name} still has this request open.`,
      category: "document",
      priority: "normal",
      dueOn: request.due_on || "",
      sourceType: "document_request",
      sourceId: request.id,
      reopen: true,
    });
    remember(openKeys, "document_request", request.id);
  }

  const accountScope = scopeSql(db, session, "bank_accounts.client_id");
  const accounts = db.prepare(
    `SELECT bank_accounts.id, bank_accounts.client_id, bank_accounts.name, clients.name AS client_name
     FROM bank_accounts
     JOIN clients ON clients.id = bank_accounts.client_id AND clients.firm_id = bank_accounts.firm_id
     WHERE bank_accounts.firm_id = ?
       AND EXISTS (
         SELECT 1 FROM bank_transactions
         WHERE bank_transactions.bank_account_id = bank_accounts.id
           AND bank_transactions.firm_id = bank_accounts.firm_id
           AND bank_transactions.client_id = bank_accounts.client_id
           AND bank_transactions.cleared_reconciliation_id IS NULL
       )
     ${accountScope.sql}`,
  ).all(session.firm_id, ...accountScope.params);
  for (const account of accounts) {
    insertSource(db, session, {
      clientId: account.client_id,
      title: `Reconcile ${account.name} for ${account.client_name}`,
      detail: `${account.name} still has uncleared statement lines.`,
      category: "reconciliation",
      priority: "normal",
      dueOn: today,
      sourceType: "unreconciled_account",
      sourceId: account.id,
      reopen: true,
    });
    remember(openKeys, "unreconciled_account", account.id);
  }

  const unpaidScope = scopeSql(db, session, "ap_bills.client_id");
  const unpaid = db.prepare(
    `SELECT ap_bills.id, ap_bills.client_id, ap_bills.invoice_number, ap_bills.due_date, ap_bills.total_cents,
            ap_vendors.name AS vendor_name, clients.name AS client_name,
            COALESCE((
              SELECT SUM(amount_cents) FROM ap_payments
              WHERE ap_payments.bill_id = ap_bills.id AND ap_payments.firm_id = ap_bills.firm_id AND ap_payments.status = 'recorded'
            ), 0) AS paid_cents
     FROM ap_bills
     JOIN ap_vendors ON ap_vendors.id = ap_bills.vendor_id AND ap_vendors.firm_id = ap_bills.firm_id
     JOIN clients ON clients.id = ap_bills.client_id AND clients.firm_id = ap_bills.firm_id
     WHERE ap_bills.firm_id = ? AND ap_bills.status = 'posted' AND ap_bills.due_date != '' AND ap_bills.due_date < ?
     ${unpaidScope.sql}`,
  ).all(session.firm_id, today, ...unpaidScope.params);
  for (const bill of unpaid) {
    const openCents = Number(bill.total_cents) - Number(bill.paid_cents);
    if (openCents <= 0) continue;
    insertSource(db, session, {
      clientId: bill.client_id,
      title: `Pay ${bill.vendor_name} bill ${bill.invoice_number}`,
      detail: `${bill.client_name} still owes ${(openCents / 100).toFixed(2)} on bill ${bill.invoice_number}.`,
      category: "bill",
      priority: "high",
      dueOn: bill.due_date,
      sourceType: "unpaid_bill",
      sourceId: bill.id,
      reopen: true,
    });
    remember(openKeys, "unpaid_bill", bill.id);
  }

  const clientScope = scopeSql(db, session, "clients.id");
  const bookkeepingClients = db.prepare(
    `SELECT id, name FROM clients
     WHERE firm_id = ? AND status IN ('active', 'onboarding')
     ${clientScope.sql}`,
  ).all(session.firm_id, ...clientScope.params);
  const uncategorizedClients = new Set(groups.map((group) => group.client_id));
  const unreconciledClients = new Set(accounts.map((account) => account.client_id));
  const requestClients = new Set(requests.map((request) => request.client_id));
  const stamp = monthStamp(today);
  for (const client of bookkeepingClients) {
    const reasons = [];
    if (uncategorizedClients.has(client.id)) reasons.push("uncategorized lines");
    if (unreconciledClients.has(client.id)) reasons.push("unreconciled accounts");
    if (requestClients.has(client.id)) reasons.push("open document requests");
    if (!reasons.length) continue;
    const sourceId = `${client.id}:${stamp}`;
    insertSource(db, session, {
      clientId: client.id,
      title: `Finish ${monthTitle(today)} bookkeeping for ${client.name}`,
      detail: `${client.name} still has ${reasons.join(", ")}.`,
      category: "bookkeeping",
      priority: "normal",
      dueOn: monthBounds(today).end,
      sourceType: "bookkeeping_month",
      sourceId,
      reopen: true,
    });
    remember(openKeys, "bookkeeping_month", sourceId);
  }

  resolveSources(db, session, openKeys);
  syncSchedules(db, session);
  syncReminders(db, session);
}

function templateJson(row) {
  return {
    id: row.id,
    key: row.template_key,
    name: row.name,
    detail: row.detail || "",
    cadence: row.cadence,
    cadenceLabel: CADENCE_LABEL[row.cadence] || row.cadence,
    category: row.category,
    categoryLabel: CATEGORY_LABEL[row.category] || row.category,
    priority: row.priority,
    priorityLabel: PRIORITY_LABEL[row.priority] || row.priority,
  };
}

function scheduleJson(row) {
  return {
    id: row.id,
    templateId: row.template_id,
    templateKey: row.template_key || "",
    templateName: row.template_name || row.name || "",
    clientId: row.client_id,
    clientName: row.client_name || "",
    assigneeId: row.assignee_user_id || "",
    assigneeName: row.assignee_name || "",
    nextOn: row.next_on || "",
    nextOnLabel: formatDay(row.next_on || ""),
    active: Boolean(row.active),
  };
}

function templateRows(db, session) {
  return db.prepare(
    "SELECT * FROM work_templates WHERE firm_id = ? AND active = 1 ORDER BY name",
  ).all(session.firm_id).map(templateJson);
}

function scheduleRows(db, session) {
  const extra = scopeSql(db, session, "work_schedules.client_id");
  return db.prepare(
    `SELECT work_schedules.*, work_templates.template_key, work_templates.name AS template_name,
            clients.name AS client_name, users.name AS assignee_name
     FROM work_schedules
     JOIN work_templates ON work_templates.id = work_schedules.template_id AND work_templates.firm_id = work_schedules.firm_id
     JOIN clients ON clients.id = work_schedules.client_id AND clients.firm_id = work_schedules.firm_id
     LEFT JOIN users ON users.id = work_schedules.assignee_user_id AND users.firm_id = work_schedules.firm_id
     WHERE work_schedules.firm_id = ?
     ${extra.sql}
     ORDER BY clients.name, work_templates.name`,
  ).all(session.firm_id, ...extra.params).map(scheduleJson);
}

function reminderRows(db, session, user) {
  const extra = scopeSql(db, session, "work_tasks.client_id");
  return db.prepare(
    `SELECT work_reminders.id, work_reminders.remind_on, work_reminders.task_id, work_tasks.title, work_tasks.due_on, work_tasks.client_id
     FROM work_reminders
     JOIN work_tasks ON work_tasks.id = work_reminders.task_id AND work_tasks.firm_id = work_reminders.firm_id
     WHERE work_reminders.firm_id = ? AND work_reminders.user_id = ? AND work_tasks.status != 'completed'
     ${extra.sql}
     ORDER BY work_reminders.remind_on, work_tasks.title`,
  ).all(session.firm_id, user.id, ...extra.params).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    remindOn: row.remind_on,
    dueOn: row.due_on || "",
    dueOnLabel: formatDay(row.due_on || ""),
    clientId: row.client_id || "",
  }));
}

function queuePayload(db, session, user, taskId = "") {
  syncSources(db, session);
  const history = historyMap(db, session);
  const tasks = taskRows(db, session, user).map((row) => taskJson(row, history.get(row.id) || []));
  const counts = taskCounts(tasks);
  const members = db.prepare(
    "SELECT id, name, role FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id).map((member) => ({ id: member.id, name: member.name, role: member.role }));
  const scope = accessScope(db, session);
  const clients = db.prepare(
    "SELECT id, name FROM clients WHERE firm_id = ? ORDER BY position, name",
  ).all(session.firm_id)
    .filter((client) => scope.unrestricted || scope.clientIds.includes(client.id))
    .map((client) => ({ id: client.id, name: client.name }));
  const payload = {
    scope: teamRole(user.role) ? "team" : "mine",
    scopeLabel: teamRole(user.role) ? "Team Tasks" : "My Tasks",
    ...counts,
    tasks,
    members,
    clients,
    templates: templateRows(db, session),
    schedules: scheduleRows(db, session),
    reminders: reminderRows(db, session, user),
  };
  if (taskId) payload.task = tasks.find((task) => task.id === taskId) || null;
  return { status: 200, payload };
}

function loadTask(db, session, user, taskId) {
  const mine = teamRole(user.role) ? 0 : 1;
  const extra = scopeSql(db, session, "work_tasks.client_id");
  return db.prepare(
    `SELECT work_tasks.*, clients.name AS client_name, assignees.name AS assignee_name, completers.name AS completed_by_name,
            blockers.title AS blocker_title, blockers.status AS blocker_status
     FROM work_tasks
     LEFT JOIN clients ON clients.id = work_tasks.client_id AND clients.firm_id = work_tasks.firm_id
     LEFT JOIN users AS assignees ON assignees.id = work_tasks.assignee_user_id AND assignees.firm_id = work_tasks.firm_id
     LEFT JOIN users AS completers ON completers.id = work_tasks.completed_by_user_id AND completers.firm_id = work_tasks.firm_id
     LEFT JOIN work_tasks AS blockers ON blockers.id = work_tasks.blocked_by_task_id AND blockers.firm_id = work_tasks.firm_id
     WHERE work_tasks.id = ? AND work_tasks.firm_id = ?
       AND (? = 0 OR work_tasks.assignee_user_id = ?)
       ${extra.sql}`,
  ).get(taskId, session.firm_id, mine, user.id, ...extra.params);
}

export function readWork(db, session) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  return queuePayload(db, session, user);
}

function readChoice(body, key, allowed) {
  const value = String(body?.[key] || "").trim();
  if (!allowed.includes(value)) return null;
  return value;
}

function readRecurrence(body, fallback) {
  if (body.recurrence === undefined) return fallback;
  const value = String(body.recurrence || "").trim();
  if (!CADENCES.includes(value)) return null;
  return value;
}

function readStage(body, fallback) {
  if (body.stage === undefined) return fallback;
  const value = String(body.stage || "").trim();
  if (!STAGES.includes(value)) return null;
  return value;
}

function wouldCycle(db, session, taskId, blockerId) {
  let current = blockerId;
  const seen = new Set();
  while (current) {
    if (current === taskId || seen.has(current)) return true;
    seen.add(current);
    const row = db.prepare(
      "SELECT blocked_by_task_id FROM work_tasks WHERE id = ? AND firm_id = ?",
    ).get(current, session.firm_id);
    current = row?.blocked_by_task_id || "";
  }
  return false;
}

function readBlocker(db, session, user, taskId, raw) {
  const id = String(raw || "").trim();
  if (!id) return { id: null };
  if (taskId && id === taskId) return { error: fail(400, "A task cannot depend on itself.") };
  const visible = loadTask(db, session, user, id);
  if (!visible) return { error: fail(404, "The earlier task was not found.") };
  if (taskId && wouldCycle(db, session, taskId, id)) return { error: fail(400, "That dependency would loop.") };
  return { id };
}

const APPROVE_ERROR = "Only an owner, administrator, manager, or accountant can approve a task.";

export function createWorkTask(db, session, input) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const body = input || {};
  const title = String(body.title || "").trim();
  if (!title || title.length > 140) return fail(400, "Enter a task title.");
  const detail = String(body.detail || "").trim();
  if (detail.length > 400) return fail(400, "Keep the detail to 400 characters.");
  const notes = String(body.notes || "").trim();
  if (notes.length > 2000) return fail(400, "Keep the note to 2000 characters.");
  const category = readChoice(body, "category", CATEGORIES) || "general";
  const priority = readChoice(body, "priority", PRIORITIES) || "normal";
  let status = readChoice(body, "status", STATUSES) || "open";
  const stage = readStage(body, "ready");
  if (!stage) return fail(400, "Choose a review stage.");
  const recurrence = readRecurrence(body, "");
  if (recurrence === null) return fail(400, "Choose how often this task repeats.");
  if (stage === "approved") {
    if (!canApproveBills(user.role)) return fail(403, APPROVE_ERROR);
    status = "completed";
  }
  const dueOn = parseDay(body.dueOn);
  if (dueOn === null) return fail(400, "Enter a due date.");
  let clientId = null;
  if (body.clientId) {
    const client = clientInFirm(db, session, body.clientId);
    if (!client) return fail(404, "Client not found.");
    clientId = client.id;
  }
  let assigneeId = null;
  if (body.assigneeId) {
    const assignee = memberInFirm(db, session, body.assigneeId);
    if (!assignee) return fail(404, "Assignee not found.");
    assigneeId = assignee.id;
  } else if (!teamRole(user.role)) {
    assigneeId = user.id;
  }
  let blockedBy = null;
  if (body.blockedByTaskId) {
    const blocker = readBlocker(db, session, user, "", body.blockedByTaskId);
    if (blocker.error) return blocker.error;
    blockedBy = blocker.id;
  }
  if (status === "completed" && blockedBy) {
    const message = blockerState(db, session, { blocked_by_task_id: blockedBy });
    if (message) return fail(409, message);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const completed = status === "completed";
  db.prepare(
    `INSERT INTO work_tasks (
      id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
      source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at,
      stage, recurrence, blocked_by_task_id, schedule_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    session.firm_id,
    clientId,
    title,
    detail,
    notes,
    category,
    status,
    priority,
    assigneeId,
    dueOn,
    id,
    completed ? user.id : null,
    completed ? now : null,
    user.id,
    now,
    now,
    stage,
    recurrence,
    blockedBy,
  );
  recordEvent(db, session, id, "create", title);
  if (assigneeId) {
    const assignee = memberInFirm(db, session, assigneeId);
    recordEvent(db, session, id, "assign", assignee ? `Assigned to ${assignee.name}` : "Assigned");
  }
  notifyAssignment(db, session, id, title, null, assigneeId);
  if (status === "completed") {
    recordEvent(db, session, id, "complete", stage === "approved" ? "Approved" : "");
    notifyCompleted(db, session, id, title, assigneeId);
    spawnRecurrence(db, session, {
      id,
      recurrence,
      due_on: dueOn,
      title,
      detail,
      category,
      priority,
      client_id: clientId,
      assignee_user_id: assigneeId,
      schedule_id: null,
    });
  } else if (status !== "open") recordEvent(db, session, id, "status", STATUS_LABEL[status]);
  else if (stage === "in_review") recordEvent(db, session, id, "status", "In review");
  syncOverdueNotices(db, session);
  return { ...queuePayload(db, session, user, id), status: 201 };
}

export function updateWorkTask(db, session, taskId, input) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const existing = loadTask(db, session, user, taskId);
  if (!existing) return fail(404, "Task not found.");
  const body = input || {};
  const title = body.title === undefined ? existing.title : String(body.title || "").trim();
  if (!title || title.length > 140) return fail(400, "Enter a task title.");
  const detail = body.detail === undefined ? existing.detail : String(body.detail || "").trim();
  if (detail.length > 400) return fail(400, "Keep the detail to 400 characters.");
  const notes = body.notes === undefined ? existing.notes : String(body.notes || "").trim();
  if (notes.length > 2000) return fail(400, "Keep the note to 2000 characters.");
  const category = body.category === undefined ? existing.category : readChoice(body, "category", CATEGORIES);
  if (!category) return fail(400, "Choose a category.");
  const priority = body.priority === undefined ? existing.priority : readChoice(body, "priority", PRIORITIES);
  if (!priority) return fail(400, "Choose a priority.");
  let status = body.status === undefined ? existing.status : readChoice(body, "status", STATUSES);
  if (!status) return fail(400, "Choose a status.");
  const stage = readStage(body, existing.stage || "ready");
  if (!stage) return fail(400, "Choose a review stage.");
  const recurrence = readRecurrence(body, existing.recurrence || "");
  if (recurrence === null) return fail(400, "Choose how often this task repeats.");
  const approving = stage === "approved" && (existing.stage || "ready") !== "approved";
  if (approving && !canApproveBills(user.role)) return fail(403, APPROVE_ERROR);
  if (approving) status = "completed";
  const dueOn = body.dueOn === undefined ? existing.due_on : parseDay(body.dueOn);
  if (dueOn === null) return fail(400, "Enter a due date.");
  let clientId = existing.client_id;
  if (body.clientId !== undefined) {
    if (!body.clientId) clientId = null;
    else {
      const client = clientInFirm(db, session, body.clientId);
      if (!client) return fail(404, "Client not found.");
      clientId = client.id;
    }
  }
  let assigneeId = existing.assignee_user_id;
  if (body.assigneeId !== undefined) {
    if (!body.assigneeId) assigneeId = null;
    else {
      const assignee = memberInFirm(db, session, body.assigneeId);
      if (!assignee) return fail(404, "Assignee not found.");
      assigneeId = assignee.id;
    }
  }
  let blockedBy = existing.blocked_by_task_id || null;
  if (body.blockedByTaskId !== undefined) {
    const blocker = readBlocker(db, session, user, existing.id, body.blockedByTaskId);
    if (blocker.error) return blocker.error;
    blockedBy = blocker.id;
  }
  const finishing = status === "completed" && existing.status !== "completed";
  if (finishing) {
    const message = blockerState(db, session, { blocked_by_task_id: blockedBy });
    if (message) return fail(409, message);
  }
  const now = new Date().toISOString();
  let completedBy = existing.completed_by_user_id;
  let completedAt = existing.completed_at;
  if (status === "completed" && existing.status !== "completed") {
    completedBy = user.id;
    completedAt = now;
  } else if (status !== "completed") {
    completedBy = null;
    completedAt = null;
  }
  db.prepare(
    `UPDATE work_tasks
     SET title = ?, detail = ?, notes = ?, category = ?, status = ?, priority = ?, assignee_user_id = ?, due_on = ?,
         client_id = ?, completed_by_user_id = ?, completed_at = ?, updated_at = ?,
         stage = ?, recurrence = ?, blocked_by_task_id = ?
     WHERE id = ? AND firm_id = ?`,
  ).run(
    title, detail, notes, category, status, priority, assigneeId, dueOn, clientId, completedBy, completedAt, now,
    stage, recurrence, blockedBy, existing.id, session.firm_id,
  );
  if ((assigneeId || "") !== (existing.assignee_user_id || "")) {
    const assignee = assigneeId ? memberInFirm(db, session, assigneeId) : null;
    recordEvent(db, session, existing.id, "assign", assignee ? `Assigned to ${assignee.name}` : "Unassigned");
  }
  if (priority !== existing.priority) recordEvent(db, session, existing.id, "priority", PRIORITY_LABEL[priority] || priority);
  if ((dueOn || "") !== (existing.due_on || "")) recordEvent(db, session, existing.id, "due_date", dueOn ? formatDay(dueOn) : "Cleared");
  if (status !== existing.status) {
    if (status === "completed") recordEvent(db, session, existing.id, "complete", approving ? "Approved" : "");
    else if (existing.status === "completed") recordEvent(db, session, existing.id, "reopen", STATUS_LABEL[status] || status);
    else recordEvent(db, session, existing.id, "status", STATUS_LABEL[status] || status);
  } else if (approving) recordEvent(db, session, existing.id, "status", "Approved");
  else if (stage !== (existing.stage || "ready")) recordEvent(db, session, existing.id, "status", STAGE_LABEL[stage] || stage);
  if ((blockedBy || "") !== (existing.blocked_by_task_id || "")) {
    recordEvent(db, session, existing.id, "status", blockedBy ? "Waiting on another task." : "No longer waiting on another task.");
  }
  notifyAssignment(db, session, existing.id, title, existing.assignee_user_id, assigneeId);
  if (finishing) {
    notifyCompleted(db, session, existing.id, title, assigneeId);
    spawnRecurrence(db, session, {
      id: existing.id,
      recurrence,
      due_on: dueOn,
      title,
      detail,
      category,
      priority,
      client_id: clientId,
      assignee_user_id: assigneeId,
      schedule_id: existing.schedule_id,
    });
  }
  syncOverdueNotices(db, session);
  return queuePayload(db, session, user, existing.id);
}

export function completeWorkTask(db, session, taskId) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const existing = loadTask(db, session, user, taskId);
  if (!existing) return fail(404, "Task not found.");
  if (existing.status !== "completed") {
    const message = blockerState(db, session, existing);
    if (message) return fail(409, message);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_tasks
       SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND firm_id = ?`,
    ).run(user.id, now, now, existing.id, session.firm_id);
    recordEvent(db, session, existing.id, "complete", "");
    notifyCompleted(db, session, existing.id, existing.title, existing.assignee_user_id);
    spawnRecurrence(db, session, existing);
  }
  return queuePayload(db, session, user, existing.id);
}

export function commentWorkTask(db, session, taskId, input) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const existing = loadTask(db, session, user, taskId);
  if (!existing) return fail(404, "Task not found.");
  const text = String(input?.body || "").trim();
  if (!text || text.length > 2000) return fail(400, "Enter a comment.");
  recordEvent(db, session, existing.id, "comment", text);
  return queuePayload(db, session, user, existing.id);
}

export function readWorkTask(db, session, taskId) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const result = queuePayload(db, session, user, taskId);
  if (!result.payload.task) return fail(404, "Task not found.");
  return result;
}

function clientTaskCard(task) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    status: task.status,
    statusLabel: task.statusLabel,
    priority: task.priority,
    priorityLabel: task.priorityLabel,
    dueOn: task.dueOn,
    dueOnLabel: task.dueOnLabel,
    assigneeName: task.assigneeName,
    categoryLabel: task.categoryLabel,
  };
}

export function readClientTasks(db, session, clientId) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const client = clientInFirm(db, session, clientId);
  if (!client) return fail(404, "Client not found.");
  const queue = queuePayload(db, session, user);
  const today = queue.payload.today;
  const tasks = queue.payload.tasks.filter((task) => task.clientId === client.id).map(clientTaskCard);
  const overdueIds = new Set(tasks.filter((task) => task.status !== "completed" && task.dueOn && task.dueOn < today).map((task) => task.id));
  return {
    status: 200,
    payload: {
      clientId: client.id,
      clientName: client.name,
      today,
      open: tasks.filter((task) => task.status === "open" && !overdueIds.has(task.id)),
      overdue: tasks.filter((task) => overdueIds.has(task.id)),
      waiting: tasks.filter((task) => task.status === "waiting_on_client" && !overdueIds.has(task.id)),
      completed: tasks.filter((task) => task.status === "completed"),
    },
  };
}

export function readNotices(db, session) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  syncOverdueNotices(db, session);
  const scope = accessScope(db, session);
  const notices = db.prepare(
    `SELECT work_notices.*, work_tasks.client_id
     FROM work_notices
     JOIN work_tasks ON work_tasks.id = work_notices.task_id AND work_tasks.firm_id = work_notices.firm_id
     WHERE work_notices.firm_id = ? AND work_notices.user_id = ?
     ORDER BY work_notices.created_at DESC, work_notices.id`,
  ).all(session.firm_id, user.id)
    .filter((row) => scope.unrestricted || (row.client_id && scope.clientIds.includes(row.client_id)))
    .map(noticeJson);
  return { status: 200, payload: { notices } };
}

export function markNoticeRead(db, session, noticeId) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const existing = db.prepare(
    "SELECT * FROM work_notices WHERE id = ? AND firm_id = ? AND user_id = ?",
  ).get(noticeId, session.firm_id, user.id);
  if (!existing) return fail(404, "Notice not found.");
  if (!existing.read_at) {
    db.prepare("UPDATE work_notices SET read_at = ? WHERE id = ? AND firm_id = ? AND user_id = ?").run(
      new Date().toISOString(),
      existing.id,
      session.firm_id,
      user.id,
    );
  }
  return readNotices(db, session);
}

export function listWorkflows(db, session) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  return {
    status: 200,
    payload: { templates: templateRows(db, session), schedules: scheduleRows(db, session) },
  };
}

export function assignSchedule(db, session, input) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  const body = input || {};
  const client = clientInFirm(db, session, body.clientId);
  if (!client) return fail(404, "Client not found.");
  const key = String(body.templateKey || body.templateId || "").trim();
  if (!key) return fail(400, "Choose a workflow template.");
  const template = db.prepare(
    "SELECT * FROM work_templates WHERE firm_id = ? AND active = 1 AND (id = ? OR template_key = ?)",
  ).get(session.firm_id, key, key);
  if (!template) return fail(404, "Template not found.");
  let assigneeId = null;
  if (body.assigneeId) {
    const assignee = memberInFirm(db, session, body.assigneeId);
    if (!assignee) return fail(404, "Assignee not found.");
    assigneeId = assignee.id;
  }
  const start = body.nextOn === undefined || body.nextOn === "" ? localDate() : parseDay(body.nextOn);
  if (start === null || start === "") return fail(400, "Enter a start date.");
  const existing = db.prepare(
    "SELECT * FROM work_schedules WHERE firm_id = ? AND template_id = ? AND client_id = ?",
  ).get(session.firm_id, template.id, client.id);
  const now = new Date().toISOString();
  let scheduleId = existing?.id;
  let created = false;
  if (!existing) {
    scheduleId = randomUUID();
    db.prepare(
      `INSERT INTO work_schedules (
        id, firm_id, template_id, client_id, assignee_user_id, next_on, active, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(scheduleId, session.firm_id, template.id, client.id, assigneeId, start, user.id, now);
    created = true;
  } else if (!existing.active) {
    db.prepare(
      "UPDATE work_schedules SET active = 1, next_on = ?, assignee_user_id = ? WHERE id = ? AND firm_id = ?",
    ).run(start, assigneeId, existing.id, session.firm_id);
  }
  const queue = queuePayload(db, session, user);
  const schedule = scheduleRows(db, session).find((row) => row.id === scheduleId) || null;
  return { status: created ? 201 : 200, payload: { ...queue.payload, schedule } };
}

export function approveWorkTask(db, session, taskId) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return fail(401, "Sign in required.");
  if (!canApproveBills(user.role)) return fail(403, APPROVE_ERROR);
  const existing = loadTask(db, session, user, taskId);
  if (!existing) return fail(404, "Task not found.");
  if (existing.status !== "completed") {
    const message = blockerState(db, session, existing);
    if (message) return fail(409, message);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_tasks
       SET status = 'completed', stage = 'approved', completed_by_user_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND firm_id = ?`,
    ).run(user.id, now, now, existing.id, session.firm_id);
    recordEvent(db, session, existing.id, "complete", "Approved");
    notifyCompleted(db, session, existing.id, existing.title, existing.assignee_user_id);
    spawnRecurrence(db, session, existing);
  } else if ((existing.stage || "ready") !== "approved") {
    db.prepare(
      "UPDATE work_tasks SET stage = 'approved', updated_at = ? WHERE id = ? AND firm_id = ?",
    ).run(new Date().toISOString(), existing.id, session.firm_id);
    recordEvent(db, session, existing.id, "status", "Approved");
  }
  return queuePayload(db, session, user, existing.id);
}

export function workflowSnapshot(db, session) {
  ensureWork(db);
  const user = actor(db, session);
  if (!user) return null;
  syncSources(db, session);
  const today = localDate();
  const tasks = taskRows(db, session, user).map((row) => taskJson(row));
  const open = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.filter((task) => task.status === "completed");
  const overdue = open.filter((task) => task.dueOn && task.dueOn < today);
  const attention = new Map();
  for (const task of open) {
    const accounting = ACCOUNTING_TYPES.includes(task.sourceType);
    const late = Boolean(task.dueOn && task.dueOn < today);
    if ((!accounting && !late) || !task.clientId) continue;
    const current = attention.get(task.clientId) || { id: task.clientId, name: task.clientName, openTasks: 0, overdueTasks: 0 };
    current.openTasks += 1;
    if (late) current.overdueTasks += 1;
    attention.set(task.clientId, current);
  }
  const total = tasks.length;
  return {
    total,
    open: open.length,
    completed: completed.length,
    overdue: overdue.length,
    completion: total ? Math.round((completed.length / total) * 100) : 0,
    clientsNeedingAttention: [...attention.values()].sort((a, b) => b.overdueTasks - a.overdueTasks || b.openTasks - a.openTasks || a.name.localeCompare(b.name)),
  };
}
