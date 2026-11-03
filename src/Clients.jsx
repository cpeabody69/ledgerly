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

function glance(ready) {
  if (!ready) return "No client books are waiting for review.";
  if (ready === 1) return "1 client book is ready for review.";
  return `${ready} client books are ready for review.`;
}

function AddClient({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [industry, setIndustry] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = name.trim() && !pending;

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, legalName, industry }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The client was not created.");
      return;
    }
    onCreated(body);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="add-client-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="add-client-title">Add client</h2>
            <p>This creates a client and an empty ledger in the firm.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field full"><span>Legal name</span><input value={legalName} onChange={(event) => setLegalName(event.target.value)} placeholder="Defaults to the client name" /></label>
          <label className="field full"><span>Industry</span><input value={industry} onChange={(event) => setIndustry(event.target.value)} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Add client"}</Button>
        </div>
      </form>
    </div>
  );
}

export function Clients({ onOpenClient, onReview, onSession }) {
  const [firm, setFirm] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    const response = await fetch("/api/clients");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not load clients.");
    setFirm(body);
    return body;
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
  }, []);

  const clients = firm?.clients || [];
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? clients.filter((client) => `${client.name} ${client.legalName} ${client.industry}`.toLowerCase().includes(needle))
    : clients;
  const counts = firm?.counts || { active: 0, readyToReview: 0, openRequests: 0, uncategorized: 0, unreconciled: 0 };
  const reviewClients = clients.filter((client) => client.ready);
  const badge = counts.uncategorized
    ? `${counts.uncategorized} uncategorized`
    : counts.unreconciled
      ? `${counts.unreconciled} unreconciled`
      : "";

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="eyebrow">CPA PORTAL</div>
          <h1>Client workspace</h1>
          <p>Monitor every client’s books, requests, and review status in one place.</p>
        </div>
        <div className="header-actions">
          <Button variant="secondary" icon="upload" disabled>Request documents</Button>
          <Button icon="plus" onClick={() => setAdding(true)}>Add client</Button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="portal-banner">
        <div>
          <span className="round-icon inverse"><Icon name="building" /></span>
          <div>
            <h2>Your firm at a glance</h2>
            <p>{firm ? glance(counts.readyToReview) : "Loading this firm’s clients…"}</p>
          </div>
        </div>
        <div className="portal-stats">
          <span><b>{firm ? counts.active : "—"}</b>Active clients</span>
          <span><b>{firm ? counts.readyToReview : "—"}</b>Ready to review</span>
          <span><b>{firm ? counts.openRequests : "—"}</b>Open requests</span>
        </div>
      </div>
      <div className="client-layout">
        <section className="card client-table">
          <div className="card-header">
            <div>
              <h2>Client accounts</h2>
              <p>{firm?.period?.label ? `Financial snapshots for ${firm.period.label}` : "Financial snapshots"}</p>
            </div>
            <div className="search-mini">
              <Icon name="search" />
              <input aria-label="Search clients" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients" />
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Revenue</th>
                <th>Net income</th>
                <th>Books updated</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.length ? visible.map((client, index) => (
                <tr key={client.id} onClick={() => onOpenClient(client.id)}>
                  <td>
                    <div className="customer">
                      <span className={`avatar ${COLORS[index % COLORS.length]}`}>{client.initials}</span>
                      <span><b>{client.name}</b><small>{client.industry}</small></span>
                    </div>
                  </td>
                  <td><strong>{client.revenue}</strong></td>
                  <td>{client.netIncome}</td>
                  <td>{client.booksUpdated}</td>
                  <td><span className={`badge ${client.ready ? "amber" : "green"}`}>{client.ready ? "Ready to review" : "Active"}</span></td>
                  <td><Icon name="chevron" /></td>
                </tr>
              )) : (
                <tr><td colSpan={6}>{firm ? "No clients match that search." : "Loading clients…"}</td></tr>
              )}
            </tbody>
          </table>
        </section>
        <div className="portal-side">
          <section className="card">
            <div className="card-header"><div><h2>Document requests</h2></div></div>
            {firm?.requests?.length ? firm.requests.map((request) => (
              <div className="request-row" key={request.id}>
                <span className="file-icon"><Icon name="file" /></span>
                <span><b>{request.title}</b><small>{request.clientName}</small></span>
                <span className="badge amber">Open</span>
              </div>
            )) : <p className="books-note">No open requests.</p>}
            <Button variant="secondary" icon="plus" disabled>New document request</Button>
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
      {adding ? (
        <AddClient
          onClose={() => setAdding(false)}
          onCreated={(body) => {
            setAdding(false);
            if (body.session) onSession(body.session);
            load().catch((loadError) => setError(loadError.message));
          }}
        />
      ) : null}
    </div>
  );
}
