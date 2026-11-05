import { useEffect, useMemo, useState } from "react";
import { monthGrid, monthTitle, shiftMonth, shiftWeek, taskTiming, tasksOnDay, weekGrid, weekTitle } from "../shared/work-calendar.js";

const CARDS = [
  ["open", "Open"],
  ["overdue", "Overdue"],
  ["dueToday", "Due today"],
  ["dueThisWeek", "Due this week"],
  ["waitingOnClient", "Waiting on client"],
  ["completedThisMonth", "Completed this month"],
];

function Icon({ name }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Button({ children, variant = "primary", icon, disabled = false, type = "button", onClick }) {
  return (
    <button className={`button ${variant}`} type={type} disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function badgeTone(status) {
  if (status === "completed") return "green";
  if (status === "waiting_on_client") return "amber";
  return "blue";
}

function matchesCard(task, card, queue) {
  if (!card) return true;
  const open = task.status !== "completed";
  if (card === "open") return task.status === "open";
  if (card === "overdue") return open && task.dueOn && task.dueOn < queue.today;
  if (card === "dueToday") return open && task.dueOn === queue.today;
  if (card === "dueThisWeek") return open && task.dueOn && task.dueOn >= queue.week.start && task.dueOn <= queue.week.end;
  if (card === "waitingOnClient") return task.status === "waiting_on_client";
  if (card === "completedThisMonth") {
    if (task.status !== "completed" || !task.completedAt) return false;
    const date = new Date(task.completedAt);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return day >= queue.month.start && day <= queue.month.end;
  }
  return true;
}

function TaskForm({ queue, task, onClose, onSaved }) {
  const [title, setTitle] = useState(task?.title || "");
  const [detail, setDetail] = useState(task?.detail || "");
  const [notes, setNotes] = useState(task?.notes || "");
  const [category, setCategory] = useState(task?.category || "general");
  const [priority, setPriority] = useState(task?.priority || "normal");
  const [status, setStatus] = useState(task?.status || "open");
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId || "");
  const [clientId, setClientId] = useState(task?.clientId || queue.clients?.[0]?.id || "");
  const [dueOn, setDueOn] = useState(task ? (task.dueOn || "") : (queue.today || ""));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    const body = { title, detail, notes, category, priority, status, assigneeId, clientId, dueOn };
    const response = await fetch(task ? `/api/tasks/${task.id}` : "/api/tasks", {
      method: task ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);
    setPending(false);
    if (!response.ok || !payload.task) {
      setError(payload.error || "The task was not saved.");
      return;
    }
    onSaved(payload);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" aria-labelledby="work-task-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <div className="modal-header">
          <div>
            <h2 id="work-task-title">{task ? "Edit task" : "New task"}</h2>
            <p>Saved for this firm. The note stays off the client portal.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label className="field full"><span>Detail</span><input value={detail} onChange={(event) => setDetail(event.target.value)} /></label>
          <label className="field"><span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="open">Open</option>
              <option value="waiting_on_client">Waiting on client</option>
              <option value="completed">Completed</option>
            </select>
          </label>
          <label className="field"><span>Priority</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="field"><span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="general">General</option>
              <option value="uncategorized">Uncategorized activity</option>
              <option value="bill">Bill approval</option>
              <option value="invoice">Overdue invoice</option>
              <option value="document">Document request</option>
            </select>
          </label>
          <label className="field"><span>Due date</span><input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} /></label>
          <label className="field"><span>Client</span>
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">No client</option>
              {(queue.clients || []).map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Assignee</span>
            <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              <option value="">Unassigned</option>
              {(queue.members || []).map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label className="field full"><span>Internal note</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !title.trim()}>{pending ? "Saving…" : "Save task"}</Button>
        </div>
      </form>
    </div>
  );
}

function TaskCalendar({ tasks, today, anchor, view, onAnchor, onOpen }) {
  const days = view === "week" ? weekGrid(anchor) : monthGrid(anchor);
  const monthKey = anchor.slice(0, 7);
  return (
    <div className={`task-calendar ${view}`}>
      <div className="calendar-toolbar">
        <div className="queue-view">
          <button className="button secondary" type="button" onClick={() => onAnchor(view === "week" ? shiftWeek(anchor, -1) : shiftMonth(anchor, -1))}>Previous</button>
          <button className="button secondary" type="button" onClick={() => onAnchor(today || anchor)}>Today</button>
          <button className="button secondary" type="button" onClick={() => onAnchor(view === "week" ? shiftWeek(anchor, 1) : shiftMonth(anchor, 1))}>Next</button>
        </div>
        <strong>{view === "week" ? weekTitle(anchor) : monthTitle(anchor)}</strong>
        <div className="calendar-legend">
          <span className="calendar-task overdue">Overdue</span>
          <span className="calendar-task upcoming">Upcoming</span>
        </div>
      </div>
      <div className="calendar-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => <span className="calendar-dow" key={label}>{label}</span>)}
        {days.map((day) => {
          const due = tasksOnDay(tasks, day);
          return (
            <div className={`calendar-day ${day === today ? "today" : ""} ${view === "month" && !day.startsWith(monthKey) ? "outside" : ""}`} key={day}>
              <button className="day-number" type="button" onClick={() => { if (due.length === 1) onOpen(due[0]); }}>{Number(day.slice(-2))}</button>
              {due.map((task) => (
                <button className={`calendar-task ${taskTiming(task, today)}`} type="button" key={task.id} onClick={() => onOpen(task)}>{task.title}</button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskActivity({ task, onClose, onSaved }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function save(path, options) {
    setPending(true);
    setError("");
    const response = await fetch(path, options);
    const payload = await readJson(response);
    setPending(false);
    if (!response.ok || !payload.task) {
      setError(payload.error || "The activity was not saved.");
      return;
    }
    onSaved(payload);
    setComment("");
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal task-activity" aria-labelledby="task-activity-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 id="task-activity-title">{task.title}</h2>
            <p>History stays with this firm. Internal notes stay off the client portal.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {task.history?.length ? (
          <ol className="task-history">
            {task.history.map((event) => (
              <li key={event.id}>
                <b>{event.actionLabel}</b>
                <span>{[event.actorName, event.createdAtLabel].filter(Boolean).join(" · ")}</span>
                {event.detail ? <p>{event.detail}</p> : null}
              </li>
            ))}
          </ol>
        ) : <p className="books-note">No activity stored yet.</p>}
        <form className="task-comment" onSubmit={(event) => { event.preventDefault(); save(`/api/tasks/${task.id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: comment }) }); }}>
          <label className="field full"><span>Comment</span><textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="modal-footer">
            {task.status === "completed" ? <Button variant="secondary" disabled={pending} onClick={() => save(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "open" }) })}>Reopen</Button> : null}
            <Button type="submit" disabled={pending || !comment.trim()}>{pending ? "Saving…" : "Add comment"}</Button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function WorkQueue({ onOpenTask }) {
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState("");
  const [card, setCard] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [category, setCategory] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [clientId, setClientId] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [activityId, setActivityId] = useState("");
  const [view, setView] = useState("table");
  const [cursor, setCursor] = useState("");

  function load() {
    return fetch("/api/tasks").then(async (response) => {
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "Could not load the work queue.");
      setQueue(body);
      setError("");
      return body;
    }).catch((reason) => {
      setError(reason.message || "Could not load the work queue.");
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tasks").then(async (response) => {
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load the work queue.");
        return;
      }
      setQueue(body);
    }).catch(() => {
      if (!cancelled) setError("Could not load the work queue.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!queue) return [];
    const needle = query.trim().toLowerCase();
    return queue.tasks.filter((task) => {
      if (!matchesCard(task, card, queue)) return false;
      if (status && task.status !== status) return false;
      if (priority && task.priority !== priority) return false;
      if (category && task.category !== category) return false;
      if (assigneeId === "unassigned" && task.assigneeId) return false;
      if (assigneeId && assigneeId !== "unassigned" && task.assigneeId !== assigneeId) return false;
      if (clientId && task.clientId !== clientId) return false;
      if (dueOn && task.dueOn !== dueOn) return false;
      if (!needle) return true;
      return `${task.title} ${task.detail} ${task.notes} ${task.clientName} ${task.assigneeName} ${task.categoryLabel}`.toLowerCase().includes(needle);
    });
  }, [queue, card, query, status, priority, category, assigneeId, clientId, dueOn]);

  async function complete(task) {
    const response = await fetch(`/api/tasks/${task.id}/complete`, { method: "POST" });
    const body = await readJson(response);
    if (!response.ok) {
      setError(body.error || "The task was not completed.");
      return;
    }
    setQueue(body);
  }

  function openCalendarTask(task) {
    if (task.target) onOpenTask?.(task);
    else setActivityId(task.id);
  }

  const anchor = cursor || queue?.today || "";

  return (
    <div className="page work-queue">
      <div className="page-header">
        <div>
          <h1>{queue?.scopeLabel || "Work Queue"}</h1>
          <p>Tasks for this firm. Cards and filters use the same stored rows.</p>
        </div>
        <div className="header-actions">
          <div className="queue-view" role="group" aria-label="Queue view">
            {[["table", "Table"], ["month", "Month"], ["week", "Week"]].map(([id, label]) => (
              <button className={`button secondary ${view === id ? "active" : ""}`} type="button" key={id} onClick={() => setView(id)}>{label}</button>
            ))}
          </div>
          <Button icon="plus" onClick={() => { setCreating(true); setEditing(null); }}>New task</Button>
        </div>
      </div>
      <div className="queue-cards">
        {CARDS.map(([id, label]) => (
          <button className={`queue-card ${card === id ? "active" : ""}`} type="button" key={id} onClick={() => setCard((current) => current === id ? "" : id)}>
            <span>{label}</span>
            <strong>{queue ? queue[id] : "—"}</strong>
          </button>
        ))}
      </div>
      <section className="card table-card">
        <div className="toolbar queue-filters">
          <div className="search-field">
            <Icon name="search" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
          </div>
          <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="waiting_on_client">Waiting on client</option>
            <option value="completed">Completed</option>
          </select>
          <select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="">All priorities</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            <option value="uncategorized">Uncategorized activity</option>
            <option value="bill">Bill approval</option>
            <option value="invoice">Overdue invoice</option>
            <option value="document">Document request</option>
            <option value="general">General</option>
          </select>
          <select aria-label="Assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
            <option value="">All assignees</option>
            <option value="unassigned">Unassigned</option>
            {(queue?.members || []).map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
          </select>
          <select aria-label="Client" value={clientId} onChange={(event) => setClientId(event.target.value)}>
            <option value="">All clients</option>
            {(queue?.clients || []).map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
          </select>
          <input aria-label="Due date" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
        </div>
        {error ? <p className="form-error books-error" role="alert">{error}</p> : null}
        {view !== "table" && anchor ? <TaskCalendar tasks={rows} today={queue?.today || ""} anchor={anchor} view={view} onAnchor={setCursor} onOpen={openCalendarTask} /> : null}
        {view === "table" && rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Client</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <div className="table-primary">
                        <span><b>{task.title}</b><small>{task.completedAtLabel ? `Completed by ${task.completedByName} · ${task.completedAtLabel}` : (task.detail || "No detail")}</small></span>
                      </div>
                    </td>
                    <td>{task.clientName || "—"}</td>
                    <td>{task.categoryLabel}</td>
                    <td>{task.priorityLabel}</td>
                    <td><span className={`badge ${badgeTone(task.status)}`}>{task.statusLabel}</span></td>
                    <td>{task.assigneeName || "Unassigned"}</td>
                    <td>{task.dueOnLabel || "—"}</td>
                    <td className="queue-actions">
                      {task.target ? <button className="row-action" type="button" onClick={() => onOpenTask?.(task)}>Open</button> : null}
                      <button className="row-action" type="button" onClick={() => setActivityId(task.id)}>Activity</button>
                      <button className="row-action" type="button" onClick={() => { setEditing(task); setCreating(false); }}>Edit</button>
                      {task.status !== "completed" ? <button className="row-action" type="button" onClick={() => complete(task)}>Complete</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {view === "table" && !rows.length ? <div className="empty-state"><b>{queue ? "No tasks match" : "Loading tasks…"}</b><p>{queue ? "Try another card or filter." : ""}</p></div> : null}
        <div className="table-footer"><span>Showing {rows.length} of {queue?.tasks.length || 0} tasks</span></div>
      </section>
      {creating && queue ? <TaskForm queue={queue} onClose={() => setCreating(false)} onSaved={(payload) => { setQueue(payload); setCreating(false); }} /> : null}
      {editing && queue ? <TaskForm queue={queue} task={editing} onClose={() => setEditing(null)} onSaved={(payload) => { setQueue(payload); setEditing(null); }} /> : null}
      {activityId && queue?.tasks?.some((task) => task.id === activityId) ? (
        <TaskActivity
          task={queue.tasks.find((task) => task.id === activityId)}
          onClose={() => setActivityId(null)}
          onSaved={setQueue}
        />
      ) : null}
    </div>
  );
}
