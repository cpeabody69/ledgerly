// Firm home counts. Additive only: this module reads clients, tasks, document
// requests, and audit events. It does not alter journals or integration rows.
import { accessScope, ensureClientGrants } from "./access.js";
import { ensureFirmCrm } from "./clients.js";
import { listRequestHistory } from "./documents.js";
import { canSeeTeamWork, ROLE_LABEL } from "./permissions.js";
import { closeBoard } from "./close.js";
import { ensureWork, workflowSnapshot } from "./work.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function countOf(row) {
  return Number(row?.count || 0);
}

function closeResult(db, session) {
  const result = closeBoard(db, session);
  if (result.error) return null;
  return result.payload;
}

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

function formatDay(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !day) return "";
  return `${name} ${Number(day)}, ${year}`;
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const label = date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${label} ET`;
}

function monthLabel() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function allowed(scope, clientId) {
  if (scope.unrestricted) return true;
  return Boolean(clientId) && scope.clientIds.includes(clientId);
}

export function firmHome(db, session) {
  ensureFirmCrm(db);
  ensureWork(db);
  ensureClientGrants(db);
  if (!session?.firm_id || !session.user_id || session.portal || session.onboarding) {
    return { status: 401, error: "Sign in required." };
  }
  const firm = db.prepare("SELECT id, name FROM firms WHERE id = ?").get(session.firm_id);
  const user = db.prepare("SELECT id, role FROM users WHERE id = ? AND firm_id = ?").get(session.user_id, session.firm_id);
  if (!firm || !user) return { status: 401, error: "Sign in required." };
  const workflow = workflowSnapshot(db, session);
  const scope = accessScope(db, session);
  const seesTeam = canSeeTeamWork(user.role);
  const clientRows = db.prepare(
    "SELECT id, name, status, client_kind FROM clients WHERE firm_id = ? ORDER BY position, name",
  ).all(session.firm_id).filter((row) => allowed(scope, row.id));
  const history = listRequestHistory(db, session) || { outstanding: [], completed: [] };
  const outstanding = history.outstanding.filter((request) => allowed(scope, request.clientId));
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
  const bookkeepingClients = clientRows.filter((row) => row.status === "active" || row.status === "onboarding");
  const review = bookkeepingClients.map((row) => {
    const uncategorized = countOf(uncategorizedFor.get(session.firm_id, row.id));
    const unreconciled = countOf(unreconciledFor.get(session.firm_id, row.id));
    const openRequests = outstanding.filter((request) => request.clientId === row.id).length;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      uncategorized,
      unreconciled,
      openRequests,
      caughtUp: uncategorized === 0 && unreconciled === 0 && openRequests === 0,
    };
  });
  const caughtUp = review.filter((row) => row.caughtUp);
  const needingReview = review.filter((row) => !row.caughtUp);
  const today = todayIso();
  const horizon = addDays(today, 14);
  const tasks = db.prepare(
    `SELECT work_tasks.id, work_tasks.client_id, work_tasks.title, work_tasks.status, work_tasks.due_on,
            work_tasks.assignee_user_id, clients.name AS client_name, users.name AS assignee_name
     FROM work_tasks
     LEFT JOIN clients ON clients.id = work_tasks.client_id AND clients.firm_id = work_tasks.firm_id
     LEFT JOIN users ON users.id = work_tasks.assignee_user_id AND users.firm_id = work_tasks.firm_id
     WHERE work_tasks.firm_id = ? AND work_tasks.status != 'completed'`,
  ).all(session.firm_id).filter((row) => allowed(scope, row.client_id) && (seesTeam || row.assignee_user_id === user.id));
  const openTasks = tasks.filter((row) => !row.due_on || row.due_on >= today);
  const overdueTasks = tasks.filter((row) => row.due_on && row.due_on < today);
  const upcomingTasks = tasks.filter((row) => row.due_on && row.due_on >= today && row.due_on <= horizon);
  const upcomingRequests = outstanding.filter((request) => request.dueOn && request.dueOn >= today && request.dueOn <= horizon);
  const deadlines = [
    ...upcomingTasks.map((row) => ({
      id: row.id,
      kind: "task",
      title: row.title,
      dueOn: row.due_on,
      dueOnLabel: formatDay(row.due_on),
      clientId: row.client_id || "",
      clientName: row.client_name || "",
    })),
    ...upcomingRequests.map((request) => ({
      id: request.id,
      kind: "request",
      title: request.title,
      dueOn: request.dueOn,
      dueOnLabel: request.dueOnLabel || formatDay(request.dueOn),
      clientId: request.clientId,
      clientName: request.clientName || "",
    })),
  ].sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title));
  const members = db.prepare(
    "SELECT id, name, role FROM users WHERE firm_id = ? ORDER BY name",
  ).all(session.firm_id);
  const workloadMembers = seesTeam ? members : members.filter((member) => member.id === user.id);
  const workload = workloadMembers.map((member) => {
    const assigned = tasks.filter((row) => row.assignee_user_id === member.id);
    return {
      userId: member.id,
      name: member.name,
      roleLabel: ROLE_LABEL[member.role] || member.role,
      openTasks: assigned.length,
      overdueTasks: assigned.filter((row) => row.due_on && row.due_on < today).length,
    };
  }).sort((a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name));
  const activity = db.prepare(
    `SELECT audit_events.id, audit_events.action, audit_events.detail, audit_events.created_at,
            audit_events.client_id, users.name AS actor_name, clients.name AS client_name
     FROM audit_events
     LEFT JOIN users ON users.id = audit_events.actor_user_id AND users.firm_id = audit_events.firm_id
     LEFT JOIN clients ON clients.id = audit_events.client_id AND clients.firm_id = audit_events.firm_id
     WHERE audit_events.firm_id = ?
     ORDER BY audit_events.created_at DESC
     LIMIT 80`,
  ).all(session.firm_id).filter((row) => (scope.unrestricted ? true : allowed(scope, row.client_id))).slice(0, 12).map((row) => ({
    id: row.id,
    action: row.action,
    label: String(row.action || "").replaceAll(".", " ").replaceAll("_", " "),
    detail: row.detail || "",
    createdAtLabel: formatWhen(row.created_at),
    actorName: row.actor_name || "",
    clientId: row.client_id || "",
    clientName: row.client_name || "",
  }));
  const denominator = review.length;
  return {
    status: 200,
    payload: {
      firm: { id: firm.id, name: firm.name },
      today,
      counts: {
        activeClients: clientRows.filter((row) => row.status === "active").length,
        onboardingClients: clientRows.filter((row) => row.status === "onboarding").length,
        openTasks: tasks.length,
        overdueTasks: overdueTasks.length,
        upcomingDeadlines: deadlines.length,
        outstandingRequests: outstanding.length,
      },
      bookkeeping: {
        monthLabel: monthLabel(),
        clients: denominator,
        caughtUp: caughtUp.length,
        needingReview: needingReview.length,
        progress: denominator ? Math.round((caughtUp.length / denominator) * 100) : 0,
        needingReviewClients: needingReview.map((row) => ({
          id: row.id,
          name: row.name,
          uncategorized: row.uncategorized,
          unreconciled: row.unreconciled,
          openRequests: row.openRequests,
        })),
      },
      deadlines: deadlines.slice(0, 12),
      workflow,
      close: closeResult(db, session),
      workload,
      activity,
      clients: clientRows.filter((row) => row.status !== "archived").map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status || "active",
        clientKind: row.client_kind === "individual" ? "individual" : "business",
      })),
      openTaskSample: openTasks.slice(0, 8).map((row) => ({
        id: row.id,
        title: row.title,
        clientId: row.client_id || "",
        clientName: row.client_name || "",
        dueOn: row.due_on || "",
        dueOnLabel: formatDay(row.due_on || ""),
        assigneeName: row.assignee_name || "",
      })),
    },
  };
}
