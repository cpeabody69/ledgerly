import { useEffect, useState } from "react";

function Button({ children, variant = "primary", disabled = false, type = "button", onClick }) {
  return (
    <button className={`button ${variant}`} type={type} disabled={disabled} onClick={onClick}>
      <span>{children}</span>
    </button>
  );
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function payloadFor(file) {
  if (file.size > 48 * 1024) throw new Error("Choose a synthetic file of 48 KB or less.");
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".txt") ? "text/plain" : "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return { name: file.name, mediaType, contentBase64: btoa(binary) };
}

function when(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function Tax({ clientId }) {
  const [tax, setTax] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("not_started");
  const [assigneeId, setAssigneeId] = useState("");
  const [blockedReason, setBlockedReason] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState("");

  async function load() {
    const response = await fetch(`/api/tax?clientId=${encodeURIComponent(clientId || "")}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load tax readiness.");
    setTax(body);
    setStatus(body.workflow.status);
    setAssigneeId(body.workflow.assignee?.id || "");
    setBlockedReason(body.workflow.blockedReason || "");
  }

  useEffect(() => {
    let cancel = false;
    load().catch((loadError) => {
      if (!cancel) setError(loadError.message);
    });
    return () => {
      cancel = true;
    };
  }, [clientId]);

  async function saveStatus(event) {
    event.preventDefault();
    setPending("status");
    setError("");
    try {
      const response = await fetch("/api/tax", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          status,
          assigneeId: assigneeId || null,
          blockedReason: status === "blocked" ? blockedReason : "",
        }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "The status was not saved.");
      setTax(body);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setPending("");
    }
  }

  async function saveNote(event) {
    event.preventDefault();
    setPending("note");
    setError("");
    try {
      const response = await fetch("/api/tax/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, body: note }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "The note was not stored.");
      setNote("");
      setTax(body);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setPending("");
    }
  }

  async function submitWorkpaper(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files?.[0];
    if (!file) return;
    setPending("workpaper");
    setError("");
    try {
      const payload = await payloadFor(file);
      const response = await fetch("/api/tax/workpapers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, clientId }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "The workpaper was not stored.");
      form.reset();
      setTax(body);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setPending("");
    }
  }

  async function fulfill(request, file) {
    if (!file) return;
    setPending(request.id);
    setError("");
    try {
      const payload = await payloadFor(file);
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, clientId, requestId: request.id }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "The file was not stored.");
      await load();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setPending("");
    }
  }

  const items = tax?.items || [];
  const requests = tax?.requests || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="eyebrow">{tax ? `TAX ${tax.season}` : "TAX"}</div>
          <h1>Tax readiness</h1>
          <p>Checklist items are read from this client’s books. A person keeps the notes and the status.</p>
        </div>
        {tax ? <span className={`badge ${tax.ready ? "green" : "amber"}`}>{tax.ready ? "Ready" : "Not ready"}</span> : null}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="portal-stack">
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Checklist</h2>
              <p>Ready when every item is clear.</p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>From the books</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td><strong>{item.label}</strong></td>
                  <td>{item.detail}</td>
                  <td><span className={`badge ${item.ready ? "green" : "amber"}`}>{item.ready ? "Ready" : "Not ready"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Requested and in</h2>
              <p>Open requests are missing. A stored file marks the request in.</p>
            </div>
          </div>
          {requests.length ? (
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td><strong>{request.title}</strong></td>
                    <td><span className={`badge ${request.status === "complete" ? "green" : "amber"}`}>{request.statusLabel}</span></td>
                    <td>
                      {request.status === "open" ? (
                        <label className="text-button">
                          Submit file
                          <input
                            aria-label={`File for ${request.title}`}
                            type="file"
                            accept=".txt,.pdf,.png,.jpg,.jpeg,text/plain,application/pdf,image/png,image/jpeg"
                            hidden
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = "";
                              fulfill(request, file);
                            }}
                          />
                        </label>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="books-note">{tax ? "No documents have been requested." : "Loading requests…"}</p>}
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Workflow</h2>
              <p>{tax?.workflow?.updatedBy ? `Last change by ${tax.workflow.updatedBy.name}` : "Assign the work and record what is blocked."}</p>
            </div>
          </div>
          <form className="tax-form" onSubmit={saveStatus}>
            <label className="field">
              <span>Status</span>
              <select aria-label="Workflow status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="not_started">Not started</option>
                <option value="gathering">Gathering</option>
                <option value="in_review">In review</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <label className="field">
              <span>Assigned to</span>
              <select aria-label="Assigned to" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
                <option value="">Unassigned</option>
                {(tax?.members || []).map((member) => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
            </label>
            {status === "blocked" ? (
              <label className="field">
                <span>What is blocked</span>
                <input aria-label="What is blocked" value={blockedReason} onChange={(event) => setBlockedReason(event.target.value)} />
              </label>
            ) : null}
            <Button type="submit" disabled={pending === "status"}>{pending === "status" ? "Saving…" : "Save status"}</Button>
          </form>
          {tax?.events?.length ? (
            <ul className="tax-events">
              {tax.events.map((event) => (
                <li key={event.id}>
                  <b>{event.actorName}</b>
                  <span>{event.fromLabel ? `${event.fromLabel} to ${event.toLabel}` : event.toLabel}</span>
                  {event.note ? <small>{event.note}</small> : null}
                  <small>{when(event.createdAt)}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Notes</h2>
              <p>A note stays on this client’s season.</p>
            </div>
          </div>
          <form className="tax-form" onSubmit={saveNote}>
            <label className="field">
              <span>Note</span>
              <input aria-label="Tax note" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <Button type="submit" disabled={pending === "note" || !note.trim()}>Save note</Button>
          </form>
          {tax?.notes?.length ? (
            <ul className="tax-events">
              {tax.notes.map((row) => (
                <li key={row.id}>
                  <b>{row.authorName}</b>
                  <span>{row.body}</span>
                  <small>{when(row.createdAt)}</small>
                </li>
              ))}
            </ul>
          ) : <p className="books-note">{tax ? "No notes yet." : "Loading notes…"}</p>}
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Workpapers</h2>
              <p>Store a synthetic text, PDF, or image file with this season.</p>
            </div>
          </div>
          <form className="tax-form" onSubmit={submitWorkpaper}>
            <label className="field">
              <span>Workpaper</span>
              <input name="file" aria-label="Workpaper file" type="file" accept=".txt,.pdf,.png,.jpg,.jpeg,text/plain,application/pdf,image/png,image/jpeg" required />
            </label>
            <Button type="submit" disabled={pending === "workpaper"}>{pending === "workpaper" ? "Storing…" : "Store workpaper"}</Button>
          </form>
          {tax?.workpapers?.length ? (
            <ul className="tax-events">
              {tax.workpapers.map((paper) => (
                <li key={paper.id}>
                  <b>{paper.name}</b>
                  <span>{paper.authorName}</span>
                  <a className="text-button" href={`/api/tax/workpapers/${paper.id}`}>View</a>
                </li>
              ))}
            </ul>
          ) : <p className="books-note">{tax ? "No workpapers yet." : "Loading workpapers…"}</p>}
        </section>
      </div>
    </div>
  );
}
