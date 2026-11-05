import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

const RETURN_MESSAGES = {
  state: "QuickBooks returned a sign-in that Avenue could not match. This attempt did not connect a company.",
  denied: "QuickBooks authorization was declined. This attempt did not connect a company.",
  missing_token: "QuickBooks did not return a token. This attempt did not connect a company.",
  realm: "QuickBooks did not return a company id. This attempt did not connect a company.",
  intuit: "QuickBooks did not complete the connection.",
};

function historyLine(row) {
  if (row.status === "error") return `${row.entity}: ${row.error || "QuickBooks did not return records."}`;
  if (row.imported > 0) return `${row.entity}: stored ${row.imported} new id${row.imported === 1 ? "" : "s"}.`;
  return `${row.entity}: QuickBooks returned no records.`;
}

function Button({ children, variant = "primary", disabled = false, onClick }) {
  return <button className={`button ${variant}`} type="button" disabled={disabled} onClick={onClick}><span>{children}</span></button>;
}

export function Integrations({ clientId, canConnect }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [returned] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { result: params.get("quickbooks") || "", code: params.get("quickbooks_code") || "" };
  });

  useEffect(() => {
    let cancel = false;
    setData(null);
    fetch("/api/quickbooks")
      .then(async (response) => {
        const body = await readJson(response);
        if (cancel) return;
        if (!response.ok) {
          setError(body.error || "Could not load QuickBooks.");
          setData(null);
          return;
        }
        setData(body);
      })
      .catch(() => {
        if (!cancel) setError("Could not load QuickBooks.");
      });
    return () => {
      cancel = true;
    };
  }, [clientId]);

  const connection = data?.connection;
  const connected = connection?.status === "connected";
  const returnMessage = returned.result === "error" ? (RETURN_MESSAGES[returned.code] || RETURN_MESSAGES.intuit) : "";
  const mismatchedReturn = returned.result === "connected" && data && !connected
    ? "The return from QuickBooks did not leave this client connected."
    : "";

  async function connect() {
    setPending("connect");
    setError("");
    const response = await fetch("/api/quickbooks/connect", { method: "POST" });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || data?.notice || "QuickBooks credentials are not configured. No company was connected.");
      return;
    }
    let target;
    try {
      target = new URL(body.authorizationUrl || "");
    } catch {
      setError("QuickBooks did not return an authorization link. No company was connected.");
      return;
    }
    if (target.origin !== "https://appcenter.intuit.com" || target.pathname !== "/connect/oauth2") {
      setError("QuickBooks did not return an authorization link. No company was connected.");
      return;
    }
    window.location.assign(target.toString());
  }

  async function disconnect() {
    if (!connection?.id) return;
    setPending("disconnect");
    setError("");
    const response = await fetch("/api/quickbooks/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.id }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "QuickBooks was not disconnected.");
      if (body.connection) setData((current) => ({ ...(current || {}), ...body, connection: body.connection }));
      return;
    }
    setData(body);
  }

  async function sync() {
    if (!connection?.id) return;
    setPending("sync");
    setError("");
    const response = await fetch("/api/quickbooks/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.id }),
    });
    const body = await readJson(response);
    setPending("");
    if (body.connection) setData((current) => ({ ...(current || {}), ...body, connection: body.connection }));
    if (!response.ok || body.sync?.ok === false) {
      setError(body.error || "QuickBooks did not finish the sync.");
    }
  }

  return (
    <section className="card qb-card" aria-label="QuickBooks Online">
      <div className="card-header">
        <div>
          <h2>QuickBooks Online</h2>
          <p>Sandbox connection for this client. Tokens stay on the server.</p>
        </div>
        <div className="plaid-actions">
          {connected ? (
            <Button variant="secondary" disabled={pending !== "" || !canConnect} onClick={sync}>{pending === "sync" ? "Syncing…" : "Sync"}</Button>
          ) : null}
          {connection?.id && connection.status !== "not_connected" ? (
            <Button variant="secondary" disabled={pending !== "" || !canConnect} onClick={disconnect}>{pending === "disconnect" ? "Disconnecting…" : "Disconnect"}</Button>
          ) : null}
          {!connected ? (
            <Button disabled={pending !== "" || !data || !canConnect} onClick={connect}>{pending === "connect" ? "Opening…" : "Connect QuickBooks"}</Button>
          ) : null}
        </div>
      </div>
      <p className="qb-notice" id="quickbooks-notice">{data?.notice || "QuickBooks credentials are not configured. Connect does not start, and no company is marked connected."}</p>
      {!canConnect ? <p className="qb-notice">An owner or administrator can connect QuickBooks for this client.</p> : null}
      {returnMessage ? <p className="form-error qb-alert" role="alert">{returnMessage}</p> : null}
      {mismatchedReturn ? <p className="form-error qb-alert" role="alert">{mismatchedReturn}</p> : null}
      {error ? <p className="form-error qb-alert" role="alert">{error}</p> : null}
      <dl className="qb-meta">
        <div>
          <dt>Status</dt>
          <dd className={`qb-status ${connection?.status || "not_connected"}`}>{connection?.statusLabel || "Not connected"}</dd>
        </div>
        <div>
          <dt>Connected company</dt>
          <dd>{connection?.companyName || (connected ? "Not returned by QuickBooks" : "—")}</dd>
        </div>
        <div>
          <dt>Company ID</dt>
          <dd>{connection?.realmId || "—"}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>{connection?.lastSyncLabel || "No sync yet"}</dd>
        </div>
      </dl>
      {connection?.error ? <p className="form-error qb-alert" role="alert">{connection.error}</p> : null}
      <div className="plaid-history" aria-label="Synchronization history">
        <b>Synchronization history</b>
        {connection?.history?.length ? connection.history.map((row) => (
          <p key={row.id}>{row.createdLabel} · {historyLine(row)}</p>
        )) : <p>No QuickBooks synchronization yet.</p>}
      </div>
    </section>
  );
}
