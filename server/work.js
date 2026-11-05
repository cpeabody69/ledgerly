import { randomUUID } from "node:crypto";

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

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUSES = ["open", "waiting_on_client", "completed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const CATEGORIES = ["uncategorized", "bill", "invoice", "document", "general"];

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

export function ensureWork(db) {
  db.exec(SCHEMA);
}

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
  return role === "owner" || role === "manager";
}

function clientInFirm(db, session, clientId) {
  if (!clientId) return null;
  return db.prepare("SELECT id, name FROM clients WHERE id = ? AND firm_id = ?").get(clientId, session.firm_id);
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
  return db.prepare(
    `SELECT work_tasks.*, clients.name AS client_name, assignees.name AS assignee_name, completers.name AS completed_by_name
     FROM work_tasks
     LEFT JOIN clients ON clients.id = work_tasks.client_id AND clients.firm_id = work_tasks.firm_id
     LEFT JOIN users AS assignees ON assignees.id = work_tasks.assignee_user_id AND assignees.firm_id = work_tasks.firm_id
     LEFT JOIN users AS completers ON completers.id = work_tasks.completed_by_user_id AND completers.firm_id = work_tasks.firm_id
     WHERE work_tasks.firm_id = ?
       AND (? = 0 OR work_tasks.assignee_user_id = ?)
     ORDER BY CASE work_tasks.status WHEN 'completed' THEN 1 ELSE 0 END, work_tasks.due_on, work_tasks.title`,
  ).all(session.firm_id, mine, user.id);
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
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO work_tasks (
        id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
        source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', ?, 'open', ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      id,
      session.firm_id,
      source.clientId,
      source.title,
      source.detail,
      source.category,
      source.priority,
      source.dueOn || "",
      source.sourceType,
      source.sourceId,
      session.user_id,
      now,
      now,
    );
    recordEvent(db, session, id, "create", source.title);
  } catch (error) {
    if (!String(error.message || error).includes("UNIQUE")) throw error;
  }
}

function syncSources(db, session) {
  const today = localDate();
  const groups = db.prepare(
    `SELECT bank_transactions.client_id, clients.name AS client_name, COUNT(*) AS count
     FROM bank_transactions
     JOIN clients ON clients.id = bank_transactions.client_id AND clients.firm_id = bank_transactions.firm_id
     WHERE bank_transactions.firm_id = ? AND bank_transactions.status = 'for_review'
     GROUP BY bank_transactions.client_id`,
  ).all(session.firm_id);
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
    });
  }

  const bills = db.prepare(
    `SELECT ap_bills.id, ap_bills.client_id, ap_bills.invoice_number, ap_bills.due_date, ap_vendors.name AS vendor_name, clients.name AS client_name
     FROM ap_bills
     JOIN ap_vendors ON ap_vendors.id = ap_bills.vendor_id AND ap_vendors.firm_id = ap_bills.firm_id
     JOIN clients ON clients.id = ap_bills.client_id AND clients.firm_id = ap_bills.firm_id
     WHERE ap_bills.firm_id = ? AND ap_bills.status = 'awaiting_approval'`,
  ).all(session.firm_id);
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
    });
  }

  const invoices = db.prepare(
    `SELECT invoices.id, invoices.client_id, invoices.number, invoices.customer_name, invoices.due_date, clients.name AS client_name
     FROM invoices
     JOIN clients ON clients.id = invoices.client_id AND clients.firm_id = invoices.firm_id
     WHERE invoices.firm_id = ? AND invoices.status IN ('sent', 'partial') AND invoices.due_date < ?`,
  ).all(session.firm_id, today);
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
    });
  }

  const requests = db.prepare(
    `SELECT document_requests.id, document_requests.client_id, document_requests.title, document_requests.due_on, clients.name AS client_name
     FROM document_requests
     JOIN clients ON clients.id = document_requests.client_id AND clients.firm_id = document_requests.firm_id
     WHERE document_requests.firm_id = ? AND document_requests.status = 'open'`,
  ).all(session.firm_id);
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
    });
  }
}

function queuePayload(db, session, user, taskId = "") {
  syncSources(db, session);
  const history = historyMap(db, session);
  const tasks = taskRows(db, session, user).map((row) => taskJson(row, history.get(row.id) || []));
  const counts = taskCounts(tasks);
  const members = db.prepare(
    "SELECT id, name, role FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id).map((member) => ({ id: member.id, name: member.name, role: member.role }));
  const clients = db.prepare(
    "SELECT id, name FROM clients WHERE firm_id = ? ORDER BY position, name",
  ).all(session.firm_id).map((client) => ({ id: client.id, name: client.name }));
  const payload = {
    scope: teamRole(user.role) ? "team" : "mine",
    scopeLabel: teamRole(user.role) ? "Team Tasks" : "My Tasks",
    ...counts,
    tasks,
    members,
    clients,
  };
  if (taskId) payload.task = tasks.find((task) => task.id === taskId) || null;
  return { status: 200, payload };
}

function loadTask(db, session, user, taskId) {
  const mine = teamRole(user.role) ? 0 : 1;
  return db.prepare(
    `SELECT work_tasks.*, clients.name AS client_name, assignees.name AS assignee_name, completers.name AS completed_by_name
     FROM work_tasks
     LEFT JOIN clients ON clients.id = work_tasks.client_id AND clients.firm_id = work_tasks.firm_id
     LEFT JOIN users AS assignees ON assignees.id = work_tasks.assignee_user_id AND assignees.firm_id = work_tasks.firm_id
     LEFT JOIN users AS completers ON completers.id = work_tasks.completed_by_user_id AND completers.firm_id = work_tasks.firm_id
     WHERE work_tasks.id = ? AND work_tasks.firm_id = ?
       AND (? = 0 OR work_tasks.assignee_user_id = ?)`,
  ).get(taskId, session.firm_id, mine, user.id);
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
  const status = readChoice(body, "status", STATUSES) || "open";
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
  const id = randomUUID();
  const now = new Date().toISOString();
  const completed = status === "completed";
  db.prepare(
    `INSERT INTO work_tasks (
      id, firm_id, client_id, title, detail, notes, category, status, priority, assignee_user_id, due_on,
      source_type, source_id, completed_by_user_id, completed_at, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
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
  );
  recordEvent(db, session, id, "create", title);
  if (assigneeId) {
    const assignee = memberInFirm(db, session, assigneeId);
    recordEvent(db, session, id, "assign", assignee ? `Assigned to ${assignee.name}` : "Assigned");
  }
  notifyAssignment(db, session, id, title, null, assigneeId);
  if (status === "completed") {
    recordEvent(db, session, id, "complete", "");
    notifyCompleted(db, session, id, title, assigneeId);
  } else if (status !== "open") recordEvent(db, session, id, "status", STATUS_LABEL[status]);
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
  const status = body.status === undefined ? existing.status : readChoice(body, "status", STATUSES);
  if (!status) return fail(400, "Choose a status.");
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
         client_id = ?, completed_by_user_id = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND firm_id = ?`,
  ).run(title, detail, notes, category, status, priority, assigneeId, dueOn, clientId, completedBy, completedAt, now, existing.id, session.firm_id);
  if ((assigneeId || "") !== (existing.assignee_user_id || "")) {
    const assignee = assigneeId ? memberInFirm(db, session, assigneeId) : null;
    recordEvent(db, session, existing.id, "assign", assignee ? `Assigned to ${assignee.name}` : "Unassigned");
  }
  if (priority !== existing.priority) recordEvent(db, session, existing.id, "priority", PRIORITY_LABEL[priority] || priority);
  if ((dueOn || "") !== (existing.due_on || "")) recordEvent(db, session, existing.id, "due_date", dueOn ? formatDay(dueOn) : "Cleared");
  if (status !== existing.status) {
    if (status === "completed") recordEvent(db, session, existing.id, "complete", "");
    else if (existing.status === "completed") recordEvent(db, session, existing.id, "reopen", STATUS_LABEL[status] || status);
    else recordEvent(db, session, existing.id, "status", STATUS_LABEL[status] || status);
  }
  notifyAssignment(db, session, existing.id, title, existing.assignee_user_id, assigneeId);
  if (status === "completed" && existing.status !== "completed") notifyCompleted(db, session, existing.id, title, assigneeId);
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
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_tasks
       SET status = 'completed', completed_by_user_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND firm_id = ?`,
    ).run(user.id, now, now, existing.id, session.firm_id);
    recordEvent(db, session, existing.id, "complete", "");
    notifyCompleted(db, session, existing.id, existing.title, existing.assignee_user_id);
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
  const notices = db.prepare(
    "SELECT * FROM work_notices WHERE firm_id = ? AND user_id = ? ORDER BY created_at DESC, id",
  ).all(session.firm_id, user.id).map(noticeJson);
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
