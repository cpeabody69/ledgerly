import { useEffect, useState } from "react";

const COLORS = ["blue", "amber", "teal", "purple", "coral", "navy"];

function Icon({ name }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 20h14" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    building: <><path d="M4 21V5l8-3 8 3v16M8 8h2m4 0h2M8 12h2m4 0h2M8 16h2m4 0h2M2 21h20" /></>,
    file: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
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

function workLabel(client) {
  const parts = [];
  if (client.uncategorized) parts.push(`${client.uncategorized} uncategorized`);
  if (client.unreconciled) parts.push(`${client.unreconciled} unreconciled`);
  return parts.join(" · ");
}

async function payloadFor(file) {
  if (!file) return null;
  if (file.size > 48 * 1024) throw new Error("Choose a synthetic file of 48 KB or less.");
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".txt") ? "text/plain" : "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return { name: file.name, mediaType, contentBase64: btoa(binary) };
}

function glance(count) {
  if (!count) return "No clients need attention.";
  if (count === 1) return "1 client needs attention.";
  return `${count} clients need attention.`;
}

function statusTone(status) {
  if (status === "inactive") return "neutral";
  if (status === "archived") return "red";
  return "green";
}

const BUSINESS_TYPES = ["", "Sole proprietorship", "Partnership", "LLC", "S corporation", "C corporation", "Nonprofit"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ClientForm({ client, members, onClose, onCreated }) {
  const [name, setName] = useState(client?.name || "");
  const [legalName, setLegalName] = useState(client?.legalName || "");
  const [industry, setIndustry] = useState(client?.industry || "");
  const [businessType, setBusinessType] = useState(client?.businessType || "");
  const [contactName, setContactName] = useState(client?.contactName || "");
  const [contactEmail, setContactEmail] = useState(client?.contactEmail || "");
  const [contactPhone, setContactPhone] = useState(client?.contactPhone || "");
  const [address, setAddress] = useState(client?.address || "");
  const [taxId, setTaxId] = useState(client?.taxId || "");
  const [fiscalYearStart, setFiscalYearStart] = useState(client?.fiscalYearStart || "January");
  const [accountingMethod, setAccountingMethod] = useState(client?.accountingMethod || "accrual");
  const [assignedUserId, setAssignedUserId] = useState(client?.assignedUserId || "");
  const [status, setStatus] = useState(client?.status === "inactive" ? "inactive" : "active");
  const [notes, setNotes] = useState(client?.notes || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = name.trim() && !pending;

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const payload = {
      name, legalName, industry, businessType, contactName, contactEmail, contactPhone, address, taxId,
      fiscalYearStart, accountingMethod, assignedUserId, status, notes,
    };
    const response = await fetch(client ? `/api/clients/${client.id}` : "/api/clients", {
      method: client ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The client was not saved.");
      return;
    }
    onCreated(body);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal wide" role="dialog" aria-modal="true" aria-labelledby="add-client-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="add-client-title">{client ? "Edit client" : "Add client"}</h2>
            <p>The profile stays in this firm. The tax ID is not included in the client list.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field"><span>Business name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Legal name</span><input value={legalName} onChange={(event) => setLegalName(event.target.value)} /></label>
          <label className="field"><span>Type</span>
            <select value={businessType} onChange={(event) => setBusinessType(event.target.value)}>
              {BUSINESS_TYPES.map((type) => <option value={type} key={type || "none"}>{type || "Not set"}</option>)}
            </select>
          </label>
          <label className="field"><span>Industry</span><input value={industry} onChange={(event) => setIndustry(event.target.value)} /></label>
          <label className="field"><span>Contact</span><input value={contactName} onChange={(event) => setContactName(event.target.value)} /></label>
          <label className="field"><span>Email</span><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /></label>
          <label className="field"><span>Phone</span><input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} /></label>
          <label className="field"><span>Assigned accountant</span>
            <select value={assignedUserId} onChange={(event) => setAssignedUserId(event.target.value)}>
              <option value="">Unassigned</option>
              {members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label className="field full"><span>Address</span><input value={address} onChange={(event) => setAddress(event.target.value)} /></label>
          <label className="field"><span>Tax ID</span><input value={taxId} onChange={(event) => setTaxId(event.target.value)} placeholder="12-3456789" autoComplete="off" /></label>
          <label className="field"><span>Fiscal year starts</span>
            <select value={fiscalYearStart} onChange={(event) => setFiscalYearStart(event.target.value)}>
              {MONTHS.map((month) => <option key={month}>{month}</option>)}
            </select>
          </label>
          <label className="field"><span>Accounting method</span>
            <select value={accountingMethod} onChange={(event) => setAccountingMethod(event.target.value)}>
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </label>
          <label className="field"><span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          <label className="field full"><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : client ? "Save profile" : "Add client"}</Button>
        </div>
      </form>
    </div>
  );
}

function ClientTasks({ clientId }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [pending, setPending] = useState(false);

  function load() {
    return fetch(`/api/clients/${encodeURIComponent(clientId)}/tasks`).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load tasks.");
      setBoard(body);
      setError("");
      return body;
    }).catch((reason) => {
      setError(reason.message || "Could not load tasks.");
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${encodeURIComponent(clientId)}/tasks`).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load tasks.");
        return;
      }
      setBoard(body);
      setDueOn(body.today || "");
    }).catch(() => {
      if (!cancelled) setError("Could not load tasks.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function createTask(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, clientId, dueOn }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok || !body.task) {
      setError(body.error || "The task was not saved.");
      return;
    }
    setTitle("");
    setCreating(false);
    load();
  }

  const groups = [
    ["open", "Open"],
    ["overdue", "Overdue"],
    ["waiting", "Waiting"],
    ["completed", "Completed"],
  ];

  return (
    <div className="drawer-section">
      <div className="client-task-heading">
        <h3>Tasks</h3>
        <button className="text-button" type="button" onClick={() => setCreating((open) => !open)}>{creating ? "Cancel" : "New task"}</button>
      </div>
      {creating ? (
        <form className="client-task-form" onSubmit={createTask}>
          <label className="field"><span>Title</span><input aria-label="Task title" value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label className="field"><span>Due date</span><input aria-label="Task due date" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} /></label>
          <Button type="submit" disabled={pending || !title.trim()}>{pending ? "Saving…" : "Save task"}</Button>
        </form>
      ) : null}
      {groups.map(([key, label]) => (
        <div className="client-task-group" key={key}>
          <h4>{label}</h4>
          {board?.[key]?.length ? (
            <ul className="plain-list">
              {board[key].map((task) => (
                <li key={task.id}><b>{task.title}</b> · {task.statusLabel}{task.dueOnLabel ? ` · ${task.dueOnLabel}` : ""}{task.assigneeName ? ` · ${task.assigneeName}` : ""}</li>
              ))}
            </ul>
          ) : <p className="books-note">{board ? "None" : "Loading…"}</p>}
        </div>
      ))}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}

function ClientProfile({ clientId, onClose, onOpen, onEdit, onChanged }) {
  const [client, setClient] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${encodeURIComponent(clientId)}`).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load this client.");
        return;
      }
      setClient(body.client);
    }).catch(() => {
      if (!cancelled) setError("Could not load this client.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function archive() {
    setPending(true);
    setError("");
    const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/archive`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The client was not archived.");
      return;
    }
    setClient(body.client);
    onChanged();
  }

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} />
      <aside className="detail-drawer" aria-label={client?.name || "Client profile"}>
        <div className="drawer-header">
          <div>
            <span className={`badge ${statusTone(client?.status)}`}>{client?.statusLabel || "Client"}</span>
            <h2>{client?.name || "Client"}</h2>
            <p>{client?.legalName || "Profile"}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {client ? (
          <>
            <div className="drawer-section">
              <h3>Profile</h3>
              <dl>
                <div><dt>Type</dt><dd>{client.businessType || "—"}</dd></div>
                <div><dt>Industry</dt><dd>{client.industry || "—"}</dd></div>
                <div><dt>Contact</dt><dd>{[client.contactName, client.contactEmail, client.contactPhone].filter(Boolean).join(" · ") || "—"}</dd></div>
                <div><dt>Address</dt><dd>{client.address || "—"}</dd></div>
                <div><dt>Tax ID</dt><dd>{client.taxId || "—"}</dd></div>
                <div><dt>Fiscal year</dt><dd>{client.fiscalYearStart}</dd></div>
                <div><dt>Method</dt><dd>{client.accountingMethodLabel}</dd></div>
                <div><dt>Accountant</dt><dd>{client.assignedUserName || "Unassigned"}</dd></div>
                <div><dt>Notes</dt><dd>{client.notes || "—"}</dd></div>
              </dl>
            </div>
            <ClientTasks clientId={clientId} />
            <div className="drawer-section">
              <h3>Outstanding tasks</h3>
              {client.tasks?.length ? (
                <ul className="plain-list">{client.tasks.map((task) => <li key={`${task.kind}-${task.id || task.label}`}>{task.label}</li>)}</ul>
              ) : <p className="books-note">Nothing is open on this client.</p>}
            </div>
            <div className="drawer-section">
              <h3>Activity</h3>
              {client.activity?.length ? (
                <ul className="plain-list">{client.activity.map((event) => <li key={`${event.action}-${event.createdAt}`}>{event.label}</li>)}</ul>
              ) : <p className="books-note">No activity stored yet.</p>}
            </div>
          </>
        ) : <p className="books-note">Loading the profile…</p>}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onOpen} disabled={!client}>Open books</Button>
          <Button variant="secondary" onClick={() => onEdit(client)} disabled={!client || pending}>Edit</Button>
          {client && client.status !== "archived" ? <Button onClick={archive} disabled={pending}>Archive</Button> : null}
        </div>
      </aside>
    </>
  );
}

function RequestDocuments({ clients, selectedClientId, onClose, onCreated }) {
  const [clientId, setClientId] = useState(selectedClientId || clients[0]?.id || "");
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = clientId && title.trim() && !pending;

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/document-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, title, dueOn }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The request was not stored.");
      return;
    }
    onCreated(body);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="request-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="request-title">Request documents</h2>
            <p>This stores an open request on the client. Attaching a file completes it.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full">
            <span>Client</span>
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              {clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
            </select>
          </label>
          <label className="field full"><span>Title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field full"><span>Due date</span><input value={dueOn} onChange={(event) => setDueOn(event.target.value)} placeholder="2026-06-15" /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Create request"}</Button>
        </div>
      </form>
    </div>
  );
}

export function Clients({ selectedClientId, onOpenClient, onReview, onSession, focusRequestId = "" }) {
  const [firm, setFirm] = useState(null);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [assignee, setAssignee] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!focusRequestId) return;
    document.getElementById(`request-${focusRequestId}`)?.scrollIntoView({ block: "center" });
  }, [focusRequestId, firm]);

  async function load(next = {}) {
    const params = new URLSearchParams();
    const q = next.q ?? query;
    const nextStatus = next.status ?? status;
    const nextAssignee = next.assignee ?? assignee;
    if (q.trim()) params.set("q", q.trim());
    if (nextStatus) params.set("status", nextStatus);
    if (nextAssignee) params.set("assignee", nextAssignee);
    const [clientResponse, fileResponse] = await Promise.all([
      fetch(`/api/clients?${params.toString()}`),
      fetch("/api/documents"),
    ]);
    const body = await clientResponse.json().catch(() => ({}));
    const fileBody = await fileResponse.json().catch(() => ({}));
    if (!clientResponse.ok) throw new Error(body.error || "Could not load clients.");
    if (!fileResponse.ok) throw new Error(fileBody.error || "Could not load files.");
    setFirm(body);
    setFiles(fileBody.files || []);
    return body;
  }

  async function attach(request, file) {
    setError("");
    try {
      const payload = await payloadFor(file);
      if (!payload) return;
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, clientId: request.clientId, requestId: request.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The file was not stored.");
      await load();
    } catch (attachError) {
      setError(attachError.message);
    }
  }

  async function removeFile(file) {
    setError("");
    const response = await fetch(`/api/documents/${file.id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || "The file was not removed.");
      return;
    }
    await load();
  }

  useEffect(() => {
    let cancelled = false;
    setError("");
    load().catch((loadError) => {
      if (!cancelled) setError(loadError.message);
    });
    return () => {
      cancelled = true;
    };
  }, [query, status, assignee]);

  const clients = firm?.clients || [];
  const visible = clients;
  const counts = firm?.counts || { total: 0, active: 0, inactive: 0, needingAttention: 0, recentlyAdded: 0, readyToReview: 0, openRequests: 0, uncategorized: 0, unreconciled: 0 };
  const reviewClients = clients.filter((client) => client.ready);
  const badge = counts.uncategorized
    ? `${counts.uncategorized} uncategorized`
    : counts.unreconciled
      ? `${counts.unreconciled} unreconciled`
      : "";

  return (
    <div className="page client-page">
      <div className="page-header">
        <div>
          <div className="eyebrow">CPA PORTAL</div>
          <h1>Client workspace</h1>
          <p>Monitor every client’s books, requests, and review status in one place.</p>
        </div>
        <div className="header-actions">
          <Button variant="secondary" icon="upload" onClick={() => setRequesting(true)}>Request documents</Button>
          <Button icon="plus" onClick={() => { setEditing(null); setAdding(true); }}>Add client</Button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="portal-banner">
        <div>
          <span className="round-icon inverse"><Icon name="building" /></span>
          <div>
            <h2>Your firm at a glance</h2>
            <p>{firm ? glance(counts.needingAttention) : "Loading this firm’s clients…"}</p>
          </div>
        </div>
        <div className="portal-stats">
          <span><b>{firm ? counts.total : "—"}</b>Total</span>
          <span><b>{firm ? counts.active : "—"}</b>Active</span>
          <span><b>{firm ? counts.inactive : "—"}</b>Inactive</span>
          <span><b>{firm ? counts.needingAttention : "—"}</b>Needing attention</span>
          <span><b>{firm ? counts.recentlyAdded : "—"}</b>Recently added</span>
        </div>
      </div>
      <div className="client-layout">
        <section className="card client-table">
          <div className="card-header">
            <div>
              <h2>Client accounts</h2>
              <p>{firm?.period?.label ? `Financial snapshots for ${firm.period.label}` : "Financial snapshots"}</p>
            </div>
            <div className="client-filters">
              <label className="field"><span>Status</span>
                <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">All</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <label className="field"><span>Assignee</span>
                <select aria-label="Assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                  <option value="">Anyone</option>
                  <option value="unassigned">Unassigned</option>
                  {(firm?.members || []).map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
                </select>
              </label>
              <div className="search-mini">
                <Icon name="search" />
                <input aria-label="Search clients" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients" />
              </div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Assignee</th>
                <th>Status</th>
                <th>Tasks</th>
                <th>Revenue</th>
                <th>Books updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.length ? visible.map((client, index) => (
                <tr key={client.id} onClick={() => setProfileId(client.id)}>
                  <td>
                    <div className="customer">
                      <span className={`avatar ${COLORS[index % COLORS.length]}`}>{client.initials}</span>
                      <span><b>{client.name}</b><small>{[client.businessType, client.industry].filter(Boolean).join(" · ") || "Client"}</small></span>
                    </div>
                  </td>
                  <td>{client.assignedUserName || "Unassigned"}</td>
                  <td><span className={`badge ${statusTone(client.status)}`}>{client.statusLabel}</span></td>
                  <td>{client.tasks?.length ? client.tasks.map((task) => task.label).join(" · ") : "None"}</td>
                  <td><strong>{client.revenue}</strong></td>
                  <td>{client.booksUpdated || "—"}</td>
                </tr>
              )) : (
                <tr><td colSpan={6}>{firm ? "No clients match that search." : "Loading clients…"}</td></tr>
              )}
            </tbody>
          </table>
        </section>
        <div className="portal-side">
          <section className="card">
            <div className="card-header"><div><h2>Document requests</h2><p>Outstanding requests stay open until a file is stored.</p></div></div>
            <h3 className="request-heading">Outstanding</h3>
            {(firm?.requestHistory?.outstanding || []).length ? firm.requestHistory.outstanding.map((request) => (
              <div className={`request-row ${focusRequestId === request.id ? "request-focus" : ""}`} id={`request-${request.id}`} key={request.id}>
                <span className="file-icon"><Icon name="file" /></span>
                <span><b>{request.title}</b><small>{[request.clientName, request.dueOnLabel || "No due date"].join(" · ")}</small></span>
                <span className="badge amber">{request.statusLabel}</span>
                <label className="text-button">
                  Attach file
                  <input aria-label={`Attach file to ${request.title}`} type="file" accept=".txt,.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,text/plain,application/pdf,image/png,image/jpeg,text/csv" hidden onChange={(event) => attach(request, event.target.files?.[0])} />
                </label>
              </div>
            )) : <p className="books-note">No outstanding requests.</p>}
            <h3 className="request-heading">Completed</h3>
            {(firm?.requestHistory?.completed || []).length ? firm.requestHistory.completed.map((request) => (
              <div className="request-row" key={request.id}>
                <span className="file-icon"><Icon name="file" /></span>
                <span><b>{request.title}</b><small>{[request.clientName, request.dueOnLabel || "No due date"].join(" · ")}</small></span>
                <span className="badge green">{request.statusLabel}</span>
              </div>
            )) : <p className="books-note">No completed requests.</p>}
            <Button variant="secondary" icon="plus" onClick={() => setRequesting(true)}>New document request</Button>
          </section>
          <section className="card">
            <div className="card-header"><div><h2>Client files</h2></div></div>
            {files.length ? files.map((file) => (
              <div className="request-row" key={file.id}>
                <span className="file-icon"><Icon name="file" /></span>
                <span>
                  <b>{file.name}</b>
                  <small>{[file.clientName, file.requestTitle, file.transactionDescription].filter(Boolean).join(" · ")}</small>
                </span>
                <a className="text-button" href={`/api/documents/${file.id}`} target="_blank" rel="noreferrer">View</a>
                <button className="text-button" type="button" onClick={() => removeFile(file)}>Remove</button>
              </div>
            )) : <p className="books-note">No files stored.</p>}
          </section>
          <section className="card">
            <div className="card-header">
              <div><h2>Review queue</h2></div>
              {badge ? <span className="badge blue">{badge}</span> : null}
            </div>
            {reviewClients.length ? reviewClients.map((client) => (
              <div className="review-row" key={client.id}>
                <span className="avatar blue small">{client.initials}</span>
                <span><b>{client.name}</b><small>{workLabel(client)}</small></span>
                <Button variant="secondary" onClick={() => onReview(client)}>Review</Button>
              </div>
            )) : <p className="books-note">Nothing is waiting for review.</p>}
          </section>
        </div>
      </div>
      {profileId ? (
        <ClientProfile
          clientId={profileId}
          onClose={() => setProfileId(null)}
          onOpen={() => { setProfileId(null); onOpenClient(profileId); }}
          onEdit={(client) => { setEditing(client); setAdding(false); }}
          onChanged={() => load().catch((loadError) => setError(loadError.message))}
        />
      ) : null}
      {adding || editing ? (
        <ClientForm
          client={editing}
          members={firm?.members || []}
          onClose={() => { setAdding(false); setEditing(null); }}
          onCreated={(body) => {
            setAdding(false);
            setEditing(null);
            if (body.session) onSession(body.session);
            load().catch((loadError) => setError(loadError.message));
          }}
        />
      ) : null}
      {requesting ? (
        <RequestDocuments
          clients={clients}
          selectedClientId={selectedClientId}
          onClose={() => setRequesting(false)}
          onCreated={() => {
            setRequesting(false);
            load().catch((loadError) => setError(loadError.message));
          }}
        />
      ) : null}
    </div>
  );
}
