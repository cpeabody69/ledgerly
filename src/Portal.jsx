import { useEffect, useState } from "react";

function Button({ children, variant = "primary", disabled = false, type = "button", onClick }) {
  return (
    <button className={`button ${variant}`} type={type} disabled={disabled} onClick={onClick}>
      <span>{children}</span>
    </button>
  );
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

function tone(status) {
  if (status === "complete" || status === "paid") return "green";
  if (status === "open" || status === "partial") return "amber";
  if (status === "sent") return "blue";
  if (status === "void") return "red";
  return "";
}

export function Portal({ session, onSession }) {
  const [portal, setPortal] = useState(null);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState("");

  async function load() {
    const response = await fetch("/api/portal");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not load this client.");
    setPortal(body);
  }

  useEffect(() => {
    let cancel = false;
    load().catch((loadError) => {
      if (!cancel) setError(loadError.message);
    });
    return () => {
      cancel = true;
    };
  }, []);

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" });
    onSession(null);
  }

  async function submitFile(event, request) {
    event.preventDefault();
    const file = event.currentTarget.elements.file.files?.[0];
    if (!file || pendingId) return;
    setPendingId(request.id);
    setError("");
    try {
      const payload = await payloadFor(file);
      const response = await fetch("/api/portal/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: request.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The file was not stored.");
      await load();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setPendingId("");
    }
  }

  const requests = portal?.requests || [];
  const files = portal?.files || [];
  const invoices = portal?.invoices || [];
  const client = session.client;

  return (
    <div className="client-portal">
      <header className="portal-bar">
        <div className="sign-in-brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>Avenue</span>
        </div>
        <div className="portal-account">
          <span className="avatar blue">{client?.initials}</span>
          <span>
            <b>{client?.name}</b>
            <small>{session.user?.name}</small>
          </span>
          <Button variant="secondary" onClick={signOut}>Sign out</Button>
        </div>
      </header>
      <div className="page">
        <div className="page-header">
          <div>
            <div className="eyebrow">{session.firm?.name}</div>
            <h1>{client?.name}</h1>
            <p>Requests, files, and invoices for this client. The firm keeps the books.</p>
          </div>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="portal-stack">
          {(portal?.notifications || []).length ? (
            <section className="card" aria-label="Notifications">
              <div className="card-header">
                <div>
                  <h2>Notifications</h2>
                  <p>Open document requests from your firm.</p>
                </div>
              </div>
              {portal.notifications.map((notice) => <p className="assistant-banner" key={notice.id}>{notice.message}</p>)}
            </section>
          ) : null}
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Requests</h2>
                <p>Submit a file to fulfill an open request.</p>
              </div>
            </div>
            {requests.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr key={request.id}>
                      <td><strong>{request.title}</strong></td>
                      <td>{request.dueOnLabel || "—"}</td>
                      <td>
                        <span className={`badge ${tone(request.status)}`}>
                          {request.statusLabel || (request.status === "complete" ? "Completed" : "Outstanding")}
                        </span>
                      </td>
                      <td>
                        {request.status === "open" ? (
                          <form className="portal-upload" onSubmit={(event) => submitFile(event, request)}>
                            <input
                              name="file"
                              aria-label={`File for ${request.title}`}
                              type="file"
                              accept=".txt,.pdf,.png,.jpg,.jpeg,text/plain,application/pdf,image/png,image/jpeg"
                              required
                            />
                            <Button type="submit" disabled={pendingId === request.id}>
                              {pendingId === request.id ? "Submitting…" : "Submit file"}
                            </Button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="books-note">{portal ? "No requests yet." : "Loading requests…"}</p>}
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Files</h2>
                <p>Files submitted for this client.</p>
              </div>
            </div>
            {files.length ? (
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Request</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={file.id}>
                      <td><strong>{file.name}</strong></td>
                      <td>{file.requestTitle}</td>
                      <td><a className="text-button" href={`/api/documents/${file.id}`}>View</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="books-note">{portal ? "No files yet." : "Loading files…"}</p>}
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Invoices</h2>
                <p>Invoices for this client.</p>
              </div>
            </div>
            {invoices.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Issued</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td><strong>{invoice.number}</strong><small>{invoice.customerName}</small></td>
                      <td>{invoice.issueDateLabel}</td>
                      <td><span className={`badge ${tone(invoice.status)}`}>{invoice.statusLabel}</span></td>
                      <td>{invoice.total}</td>
                      <td>{invoice.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="books-note">{portal ? "No invoices yet." : "Loading invoices…"}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
