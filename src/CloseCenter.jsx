import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

const CHECK_ACTION = {
  complete: "Mark done",
  waived: "Waive",
  open: "Reopen check",
};

export function CloseCenter({ clientId, onOpenHealth }) {
  const [period, setPeriod] = useState("");
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");
  const [board, setBoard] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [pack, setPack] = useState(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");

  async function loadBoard(next = {}) {
    const month = next.period ?? period;
    const statusFilter = next.status ?? status;
    const assigneeFilter = next.assignee ?? assignee;
    const params = new URLSearchParams();
    if (month) params.set("period", month);
    if (statusFilter) params.set("status", statusFilter);
    if (assigneeFilter) params.set("assignee", assigneeFilter);
    const response = await fetch(`/api/close?${params.toString()}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load the close.");
    setBoard(body);
    if (!period) setPeriod(body.period);
    setError("");
    return body;
  }

  async function loadWorkspace(id, month) {
    const params = new URLSearchParams();
    if (month || period) params.set("period", month || period);
    const response = await fetch(`/api/close/${encodeURIComponent(id)}?${params.toString()}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not open that close.");
    setWorkspace(body);
    setError("");
    return body;
  }

  useEffect(() => {
    let cancel = false;
    loadBoard().then((body) => {
      if (cancel) return;
      const match = body.clients.find((client) => client.id === clientId) || body.clients[0];
      if (match) return loadWorkspace(match.id, body.period);
      return null;
    }).catch((reason) => {
      if (!cancel) setError(reason.message || "Could not load the close.");
    });
    return () => {
      cancel = true;
    };
  }, [clientId]);

  async function refresh(id = workspace?.clientId) {
    const body = await loadBoard();
    if (id) await loadWorkspace(id, body.period || period);
  }

  async function post(path, payload) {
    setPending(path);
    setError("");
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "That close change was not saved.");
      return null;
    }
    if (body.checks) setWorkspace(body);
    if (body.profitAndLoss) setPack(body);
    await loadBoard();
    return body;
  }

  async function loadPackage() {
    if (!workspace) return;
    setPending("package");
    const response = await fetch(`/api/close/${encodeURIComponent(workspace.clientId)}/package?period=${encodeURIComponent(workspace.period)}`);
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "Could not build the package.");
      return;
    }
    setPack(body);
  }

  const counts = board?.counts;
  const month = workspace?.period || board?.period || period;

  return (
    <div className="close-center">
      <header className="page-header">
        <div>
          <h1>Monthly close</h1>
          <p>Close the books for a month. A lock is not a tax filing and does not calculate tax.</p>
          {onOpenHealth ? <button type="button" className="text-button" onClick={onOpenHealth}>Open financial health</button> : null}
        </div>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="card close-filters">
        <label>Month<input type="month" value={period || board?.period || ""} onChange={(event) => { setPeriod(event.target.value); loadBoard({ period: event.target.value }).catch((reason) => setError(reason.message)); }} /></label>
        <label>Status
          <select value={status} onChange={(event) => { setStatus(event.target.value); loadBoard({ status: event.target.value }).catch((reason) => setError(reason.message)); }}>
            <option value="">All statuses</option>
            <option value="overdue">Overdue</option>
            {(board?.statuses || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>Accountant
          <select value={assignee} onChange={(event) => { setAssignee(event.target.value); loadBoard({ assignee: event.target.value }).catch((reason) => setError(reason.message)); }}>
            <option value="">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {(board?.members || []).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </label>
        {counts ? <p className="firm-progress"><b>{counts.completion}%</b> checklist · <b>{counts.closed}</b> closed · <b>{counts.overdue}</b> overdue · <b>{counts.outstanding}</b> open checks</p> : null}
      </section>
      <div className="close-layout">
        <section className="card">
          <div className="card-header"><div><h2>Clients</h2><p>{board ? board.period : "This month"}</p></div></div>
          <ul className="plain-list close-client-list">
            {(board?.clients || []).map((client) => (
              <li key={client.id}>
                <button type="button" className={workspace?.clientId === client.id ? "text-button active" : "text-button"} onClick={() => loadWorkspace(client.id, period || board?.period).catch((reason) => setError(reason.message))}>{client.name}</button>
                <small>{client.statusLabel} · {client.completion}% · {client.outstanding} open{client.overdue ? " · overdue" : ""}{client.assigneeName ? ` · ${client.assigneeName}` : ""}</small>
              </li>
            ))}
          </ul>
          {board && !board.clients.length ? <p className="books-note">No client matches these filters.</p> : null}
        </section>
        {workspace ? (
          <section className="card">
            <div className="card-header">
              <div>
                <h2>{workspace.clientName}</h2>
                <p>{workspace.statusLabel} · due {workspace.dueOn}{workspace.overdue ? " · overdue" : ""} · {workspace.completion}%</p>
              </div>
            </div>
            <p className="books-note">{workspace.note}</p>
            <p className="books-note">{workspace.quickBooks?.note}</p>
            <div className="close-status-row">
              <label>Close status
                <select value={workspace.status === "closed" ? "closed" : workspace.status} disabled={workspace.status === "closed" || pending === "status"} onChange={(event) => post(`/api/close/${encodeURIComponent(workspace.clientId)}/status`, { period: workspace.period, status: event.target.value })}>
                  <option value="not_started">Not Started</option>
                  <option value="in_progress">In Progress</option>
                  <option value="awaiting_client">Awaiting Client</option>
                  <option value="under_review">Under Review</option>
                  {workspace.status === "closed" ? <option value="closed">Closed</option> : null}
                </select>
              </label>
              <label>Assignee
                <select value={workspace.assigneeId || ""} disabled={workspace.status === "closed"} onChange={(event) => post(`/api/close/${encodeURIComponent(workspace.clientId)}/status`, { period: workspace.period, assigneeId: event.target.value })}>
                  <option value="">Unassigned</option>
                  {(board?.members || []).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                </select>
              </label>
            </div>
            <ul className="close-checks">
              {workspace.checks.map((check) => (
                <li key={check.key}>
                  <div>
                    <b>{check.label}</b>
                    <small>{check.status === "clear" ? "Clear in the books" : check.status === "complete" ? "Reviewed" : check.status === "waived" ? "Waived" : "Open"}{check.note ? ` · ${check.note}` : ""}</small>
                  </div>
                  {workspace.status === "closed" ? null : (
                    <div className="close-check-actions">
                      {Object.entries(CHECK_ACTION).map(([value, label]) => (
                        <button key={value} type="button" className="text-button" disabled={pending.startsWith("check")} onClick={() => post(`/api/close/${encodeURIComponent(workspace.clientId)}/checks`, { period: workspace.period, checkKey: check.key, status: value, note: value === "waived" ? note : "" })}>{label}</button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <label className="close-note">Waiver note<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} /></label>
            {workspace.issues.length ? (
              <ul className="plain-list">
                {workspace.issues.map((issue) => <li key={issue.key}><span>{issue.detail}</span></li>)}
              </ul>
            ) : <p className="books-note">No automatic issue is open for this month.</p>}
            <div className="close-actions">
              {workspace.status === "closed" ? (
                <>
                  <label>Reason to reopen<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                  <button type="button" className="button secondary" disabled={pending === "reopen"} onClick={() => post(`/api/close/${encodeURIComponent(workspace.clientId)}/reopen`, { period: workspace.period, reason })}>Reopen month</button>
                </>
              ) : (
                <button type="button" className="button primary" disabled={pending === "lock"} onClick={() => post(`/api/close/${encodeURIComponent(workspace.clientId)}/lock`, { period: workspace.period })}>Close and lock</button>
              )}
            </div>
            <div className="close-package">
              <h3>Financial package</h3>
              <p>Profit and loss, balance sheet, cash flow, and trial balance. QuickBooks stays in sandbox.</p>
              <div className="close-actions">
                <button type="button" className="button secondary" onClick={loadPackage}>Build package</button>
                <a href={`/api/close/${encodeURIComponent(workspace.clientId)}/package.csv?period=${encodeURIComponent(month)}`}>CSV</a>
                <a href={`/api/close/${encodeURIComponent(workspace.clientId)}/package.pdf?period=${encodeURIComponent(month)}`}>PDF</a>
                <button type="button" className="text-button" onClick={() => post(`/api/close/${encodeURIComponent(workspace.clientId)}/package`, { period: workspace.period, reviewStatus: "in_review" })}>Send to review</button>
                <button type="button" className="text-button" onClick={() => post(`/api/close/${encodeURIComponent(workspace.clientId)}/package`, { period: workspace.period, reviewStatus: "approved" })}>Approve package</button>
              </div>
              {pack && pack.period === workspace.period ? (
                <p className="books-note">Review {pack.reviewStatus}. Net income {pack.profitAndLoss.netIncomeCents} cents. Trial balance {pack.trialBalance.foots ? "foots" : "does not foot"}.</p>
              ) : null}
            </div>
          </section>
        ) : <section className="card"><p className="books-note">Choose a client.</p></section>}
      </div>
    </div>
  );
}
