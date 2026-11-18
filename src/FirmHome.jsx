import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

export function FirmHome({ onOpenClient, onOpenClients, onOpenQueue, onOpenClose, onOpenTax, onSession }) {
  const [home, setHome] = useState(null);
  const [error, setError] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientKind, setClientKind] = useState("business");
  const [clientStatus, setClientStatus] = useState("prospect");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskClientId, setTaskClientId] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [requestTitle, setRequestTitle] = useState("");
  const [requestClientId, setRequestClientId] = useState("");
  const [requestDue, setRequestDue] = useState("");
  const [pending, setPending] = useState("");

  async function load() {
    const response = await fetch("/api/firm");
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load the firm.");
    setHome(body);
    setError("");
    if (!taskClientId && body.clients?.[0]) setTaskClientId(body.clients[0].id);
    if (!requestClientId && body.clients?.[0]) setRequestClientId(body.clients[0].id);
    if (!taskDue && body.today) setTaskDue(body.today);
    return body;
  }

  useEffect(() => {
    let cancel = false;
    load().catch((reason) => {
      if (!cancel) setError(reason.message || "Could not load the firm.");
    });
    return () => {
      cancel = true;
    };
  }, []);

  async function createClient(event) {
    event.preventDefault();
    setPending("client");
    setError("");
    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: clientName, clientKind, status: clientStatus }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "The client was not created.");
      return;
    }
    if (body.session) onSession(body.session);
    setClientName("");
    await load();
  }

  async function createTask(event) {
    event.preventDefault();
    setPending("task");
    setError("");
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: taskTitle, clientId: taskClientId, dueOn: taskDue }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "The task was not created.");
      return;
    }
    setTaskTitle("");
    await load();
  }

  async function createRequest(event) {
    event.preventDefault();
    setPending("request");
    setError("");
    const response = await fetch("/api/document-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: requestTitle, clientId: requestClientId, dueOn: requestDue }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "The request was not created.");
      return;
    }
    setRequestTitle("");
    await load();
  }

  const counts = home?.counts;
  const bookkeeping = home?.bookkeeping;

  return (
    <div className="page firm-home">
      <div className="page-header">
        <div>
          <div className="eyebrow">Firm</div>
          <h1>{home?.firm?.name || "Firm"}</h1>
          <p>Counts from the clients, tasks, and document requests this person can open. Client books stay on the client dashboard.</p>
        </div>
        <div className="header-actions">
          <button className="button secondary" type="button" onClick={onOpenClients}>Client list</button>
          <button className="button secondary" type="button" onClick={onOpenQueue}>Work queue</button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="firm-metrics">
        <button type="button" className="card firm-metric" onClick={onOpenClients}><b>{counts ? counts.activeClients : "—"}</b><span>Active clients</span></button>
        <button type="button" className="card firm-metric" onClick={onOpenClients}><b>{counts ? counts.onboardingClients : "—"}</b><span>Onboarding</span></button>
        <button type="button" className="card firm-metric" onClick={onOpenQueue}><b>{counts ? counts.openTasks : "—"}</b><span>Open tasks</span></button>
        <button type="button" className="card firm-metric" onClick={onOpenQueue}><b>{counts ? counts.overdueTasks : "—"}</b><span>Overdue tasks</span></button>
        <button type="button" className="card firm-metric" onClick={onOpenQueue}><b>{counts ? counts.upcomingDeadlines : "—"}</b><span>Deadlines in 14 days</span></button>
        <button type="button" className="card firm-metric" onClick={onOpenClients}><b>{counts ? counts.outstandingRequests : "—"}</b><span>Document requests</span></button>
        <button type="button" className="card firm-metric" onClick={onOpenClients}><b>{counts ? counts.awaitingReview : "—"}</b><span>Awaiting review</span></button>
      </div>
      <section className="card workflow-summary">
        <div className="card-header"><div><h2>Workflow</h2><p>Completion, overdue work, and clients that still have an accounting task.</p></div></div>
        {home?.workflow ? (
          <>
            <p className="firm-progress"><b>{home.workflow.completion}%</b> of {home.workflow.total} workflow tasks are complete. <b>{home.workflow.overdue}</b> are overdue.</p>
            {home.workflow.clientsNeedingAttention.length ? (
              <ul className="plain-list">
                {home.workflow.clientsNeedingAttention.map((client) => (
                  <li key={client.id}>
                    <button type="button" className="text-button" onClick={() => onOpenClient(client.id)}>{client.name}</button>
                    <small>{client.openTasks} open · {client.overdueTasks} overdue</small>
                  </li>
                ))}
              </ul>
            ) : <p className="books-note">{home.workflow.total ? "No client needs attention for an open accounting task." : "No workflow tasks yet."}</p>}
          </>
        ) : <p className="books-note">Loading the firm…</p>}
      </section>
      <section className="card close-summary">
        <div className="card-header"><div><h2>Monthly close</h2><p>{home?.close ? home.close.period : "This month"}</p></div>{onOpenClose ? <button type="button" className="text-button" onClick={() => onOpenClose()}>Open close</button> : null}</div>
        {home?.close ? (
          <>
            <p className="firm-progress"><b>{home.close.counts.completion}%</b> of the checklist is done across {home.close.counts.clients} clients. <b>{home.close.counts.overdue}</b> are overdue. <b>{home.close.counts.outstanding}</b> checks are still open.</p>
            {home.close.clients.filter((client) => client.overdue || client.outstanding).slice(0, 8).length ? (
              <ul className="plain-list">
                {home.close.clients.filter((client) => client.overdue || client.outstanding).slice(0, 8).map((client) => (
                  <li key={client.id}>
                    <button type="button" className="text-button" onClick={() => onOpenClose ? onOpenClose(client.id) : onOpenClient(client.id)}>{client.name}</button>
                    <small>{client.statusLabel} · {client.completion}% · {client.outstanding} open{client.overdue ? " · overdue" : ""}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="books-note">{home.close.counts.clients ? "No close is overdue and no check is open." : "No clients to close."}</p>}
          </>
        ) : <p className="books-note">Loading the firm…</p>}
      </section>
      <section className="card tax-summary">
        <div className="card-header"><div><h2>Tax readiness</h2><p>{home?.tax ? home.tax.year : "This year"}</p></div>{onOpenTax ? <button type="button" className="text-button" onClick={() => onOpenTax()}>Open planning</button> : null}</div>
        {home?.tax ? (
          <>
            <p className="firm-progress"><b>{home.tax.counts.ready}</b> of <b>{home.tax.counts.clients}</b> clients are tax-ready. <b>{home.tax.counts.outstanding}</b> items are still open.</p>
            {home.tax.clients.filter((client) => client.status !== "ready").slice(0, 8).length ? (
              <ul className="plain-list">
                {home.tax.clients.filter((client) => client.status !== "ready").slice(0, 8).map((client) => (
                  <li key={client.id}>
                    <button type="button" className="text-button" onClick={() => onOpenTax ? onOpenTax(client.id) : onOpenClient(client.id)}>{client.name}</button>
                    <small>{client.statusLabel} · {client.outstanding} open</small>
                  </li>
                ))}
              </ul>
            ) : <p className="books-note">Every visible client is tax-ready.</p>}
          </>
        ) : <p className="books-note">Loading the firm…</p>}
      </section>
      <div className="firm-grid">
        <section className="card">
          <div className="card-header"><div><h2>Bookkeeping progress</h2><p>{bookkeeping ? bookkeeping.monthLabel : "This month"}</p></div></div>
          {bookkeeping ? (
            <>
              <p className="firm-progress"><b>{bookkeeping.caughtUp}</b> of <b>{bookkeeping.clients}</b> active and onboarding clients are caught up. <b>{bookkeeping.progress}%</b></p>
              {bookkeeping.needingReviewClients.length ? (
                <ul className="plain-list">
                  {bookkeeping.needingReviewClients.map((client) => (
                    <li key={client.id}>
                      <button type="button" className="text-button" onClick={() => onOpenClient(client.id)}>{client.name}</button>
                      <small>{[client.uncategorized ? `${client.uncategorized} uncategorized` : "", client.unreconciled ? `${client.unreconciled} unreconciled` : "", client.openRequests ? `${client.openRequests} requests` : ""].filter(Boolean).join(" · ")}</small>
                    </li>
                  ))}
                </ul>
              ) : <p className="books-note">{bookkeeping.clients ? "Nothing is waiting on these clients." : "No active or onboarding clients."}</p>}
            </>
          ) : <p className="books-note">Loading the firm…</p>}
        </section>
        <section className="card">
          <div className="card-header"><div><h2>Upcoming deadlines</h2><p>Tasks and document requests due within 14 days.</p></div></div>
          {home?.deadlines?.length ? (
            <ul className="plain-list">
              {home.deadlines.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <b>{item.title}</b>
                  <small>{[item.dueOnLabel, item.clientName, item.kind === "request" ? "Document request" : "Task"].filter(Boolean).join(" · ")}</small>
                  {item.clientId ? <button type="button" className="text-button" onClick={() => onOpenClient(item.clientId)}>Open books</button> : null}
                </li>
              ))}
            </ul>
          ) : <p className="books-note">{home ? "No deadlines in the next 14 days." : "Loading the firm…"}</p>}
        </section>
        <section className="card">
          <div className="card-header"><div><h2>Team workload</h2><p>Open tasks on clients this person can see.</p></div></div>
          {home?.workload?.length ? (
            <ul className="plain-list">
              {home.workload.map((member) => (
                <li key={member.userId}><b>{member.name}</b><small>{member.roleLabel} · {member.openTasks} open · {member.overdueTasks} overdue</small></li>
              ))}
            </ul>
          ) : <p className="books-note">{home ? "No team members." : "Loading the firm…"}</p>}
        </section>
        <section className="card">
          <div className="card-header"><div><h2>Recent activity</h2><p>Latest changes in this firm.</p></div></div>
          {home?.activity?.length ? (
            <ul className="plain-list">
              {home.activity.map((event) => (
                <li key={event.id}><b>{event.actorName || "Someone"}</b> · {event.label}{event.clientName ? ` · ${event.clientName}` : ""}<small>{[event.createdAtLabel, event.detail].filter(Boolean).join(" · ")}</small></li>
              ))}
            </ul>
          ) : <p className="books-note">{home ? "No activity yet." : "Loading the firm…"}</p>}
        </section>
      </div>
      <section className="card">
        <div className="card-header"><div><h2>Quick actions</h2><p>These write the same client, task, and document-request records as the other screens.</p></div></div>
        <div className="firm-actions">
          <form onSubmit={createClient}>
            <h3>New client</h3>
            <label className="field"><span>Name</span><input aria-label="New client name" value={clientName} onChange={(event) => setClientName(event.target.value)} /></label>
            <label className="field"><span>Kind</span>
              <select aria-label="New client kind" value={clientKind} onChange={(event) => setClientKind(event.target.value)}>
                <option value="business">Business</option>
                <option value="individual">Individual</option>
              </select>
            </label>
            <label className="field"><span>Status</span>
              <select aria-label="New client status" value={clientStatus} onChange={(event) => setClientStatus(event.target.value)}>
                <option value="prospect">Prospect</option>
                <option value="onboarding">Onboarding</option>
                <option value="active">Active</option>
              </select>
            </label>
            <button className="button" type="submit" disabled={pending === "client" || !clientName.trim()}>{pending === "client" ? "Saving…" : "Create client"}</button>
          </form>
          <form onSubmit={createTask}>
            <h3>New task</h3>
            <label className="field"><span>Title</span><input aria-label="New task title" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
            <label className="field"><span>Client</span>
              <select aria-label="Task client" value={taskClientId} onChange={(event) => setTaskClientId(event.target.value)}>
                {(home?.clients || []).map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Due date</span><input aria-label="Task due date" type="date" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} /></label>
            <button className="button" type="submit" disabled={pending === "task" || !taskTitle.trim() || !taskClientId}>{pending === "task" ? "Saving…" : "Create task"}</button>
          </form>
          <form onSubmit={createRequest}>
            <h3>Document request</h3>
            <label className="field"><span>Title</span><input aria-label="Request title" value={requestTitle} onChange={(event) => setRequestTitle(event.target.value)} /></label>
            <label className="field"><span>Client</span>
              <select aria-label="Request client" value={requestClientId} onChange={(event) => setRequestClientId(event.target.value)}>
                {(home?.clients || []).map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Due date</span><input aria-label="Request due date" value={requestDue} onChange={(event) => setRequestDue(event.target.value)} placeholder="2026-12-01" /></label>
            <button className="button" type="submit" disabled={pending === "request" || !requestTitle.trim() || !requestClientId}>{pending === "request" ? "Saving…" : "Create request"}</button>
          </form>
        </div>
      </section>
      <section className="card">
        <div className="card-header"><div><h2>Open a client’s books</h2><p>The client dashboard is that client’s accounting workspace.</p></div></div>
        {home?.clients?.length ? (
          <ul className="plain-list">
            {home.clients.map((client) => (
              <li key={client.id}>
                <b>{client.name}</b>
                <small>{client.clientKind === "individual" ? "Individual" : "Business"} · {client.status}</small>
                <button type="button" className="text-button" onClick={() => onOpenClient(client.id)}>Open books</button>
              </li>
            ))}
          </ul>
        ) : <p className="books-note">{home ? "No open clients." : "Loading the firm…"}</p>}
      </section>
    </div>
  );
}
