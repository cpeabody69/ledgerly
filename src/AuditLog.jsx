import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

export function AuditLog() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [clientId, setClientId] = useState("");
  const [actorId, setActorId] = useState("");
  const [action, setAction] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const params = new URLSearchParams();
    if (clientId) params.set("clientId", clientId);
    if (actorId) params.set("actorId", actorId);
    if (action) params.set("action", action);
    if (query.trim()) params.set("q", query.trim());
    const suffix = params.toString();
    let cancel = false;
    fetch(`/api/audit${suffix ? `?${suffix}` : ""}`)
      .then(async (response) => {
        const body = await readJson(response);
        if (cancel) return;
        if (!response.ok) {
          setError(body.error || "Could not load the audit log.");
          setPayload(null);
          return;
        }
        setError("");
        setPayload(body);
      })
      .catch(() => {
        if (!cancel) setError("Could not load the audit log.");
      });
    return () => {
      cancel = true;
    };
  }, [clientId, actorId, action, query]);

  const events = payload?.events || [];
  return (
    <section className="table-card audit-card">
      <header className="card-header">
        <div>
          <h2>Audit log</h2>
          <p>Owners and administrators can see who changed this firm’s records. Another firm’s activity is not included.</p>
        </div>
      </header>
      <div className="audit-filters">
        <label className="field">
          <span>Client</span>
          <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
            <option value="">All clients</option>
            {(payload?.clients || []).map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Person</span>
          <select value={actorId} onChange={(event) => setActorId(event.target.value)}>
            <option value="">Everyone</option>
            {(payload?.actors || []).map((actor) => <option value={actor.id} key={actor.id}>{actor.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Action</span>
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">All actions</option>
            {(payload?.actions || []).map((name) => <option value={name} key={name}>{name.replaceAll(".", " ")}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, action, or change" />
        </label>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <table className="audit-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Person</th>
            <th>Action</th>
            <th>Client</th>
            <th>Record</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td title={event.createdAt}>{event.createdAtLabel}</td>
              <td>{event.actorName}</td>
              <td>{event.actionLabel}</td>
              <td>{event.clientName || "—"}</td>
              <td>{event.entityType ? `${event.entityType}${event.entityId ? ` ${event.entityId.slice(0, 8)}` : ""}` : "—"}</td>
              <td>{event.detail || "—"}</td>
            </tr>
          ))}
          {payload && !events.length ? <tr><td colSpan="6">No matching activity.</td></tr> : null}
        </tbody>
      </table>
    </section>
  );
}
