import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

function dollars(cents) {
  if (cents == null) return "—";
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}$${Math.trunc(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`;
}

export function Health({ clientId }) {
  const [board, setBoard] = useState(null);
  const [view, setView] = useState(null);
  const [error, setError] = useState("");

  async function load(id = clientId) {
    const listed = await fetch("/api/health");
    const listBody = await readJson(listed);
    if (!listed.ok) throw new Error(listBody.error || "Could not load financial health.");
    setBoard(listBody);
    const target = id || listBody.clients[0]?.id;
    if (!target) {
      setView(null);
      return listBody;
    }
    const response = await fetch(`/api/health/${encodeURIComponent(target)}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not open that client.");
    setView(body);
    setError("");
    return body;
  }

  useEffect(() => {
    let cancel = false;
    load().catch((reason) => {
      if (!cancel) setError(reason.message);
    });
    return () => {
      cancel = true;
    };
  }, [clientId]);

  const trends = view?.trends;

  return (
    <div className="financial-health">
      <header className="page-header">
        <div>
          <h1>Financial health</h1>
          <p>Trends, aging, and review items from the books. There is no score, and nothing here files a return or moves money.</p>
        </div>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="card close-filters">
        {board ? <p className="firm-progress"><b>{board.counts.needingAttention}</b> of <b>{board.counts.clients}</b> clients need attention</p> : null}
      </section>
      <div className="close-layout">
        <section className="card">
          <div className="card-header"><div><h2>Needs attention</h2></div></div>
          <ul className="plain-list">
            {(board?.clients || []).map((client) => (
              <li key={client.id}>
                <button type="button" className="text-button" onClick={() => load(client.id).catch((reason) => setError(reason.message))}>{client.name}</button>
                <small>{client.labels.join(" · ")}</small>
              </li>
            ))}
          </ul>
          {board && board.clients.length === 0 ? <p className="books-note">No client has an open alert.</p> : null}
        </section>
        {view ? (
          <section className="card">
            <div className="card-header"><div><h2>{view.clientName}</h2><p>Through {view.asOf}</p></div></div>
            <p className="books-note">{view.note}</p>
            <div className="firm-metrics">
              <div className="card firm-metric"><b>{dollars(trends.revenue.currentCents)}</b><span>Year-to-date revenue</span></div>
              <div className="card firm-metric"><b>{dollars(trends.expenses.currentCents)}</b><span>Year-to-date expenses</span></div>
              <div className="card firm-metric"><b>{dollars(trends.profit.currentCents)}</b><span>Year-to-date net</span></div>
              <div className="card firm-metric"><b>{dollars(trends.cashFlow.currentCents)}</b><span>Cash balance</span></div>
            </div>
            <p className="books-note">{trends.yearOverYear.calculation} Prior net {dollars(trends.yearOverYear.priorNetCents)}.</p>
            <p className="books-note">{trends.cashFlow.calculation}</p>
            <h3>Receivables</h3>
            <p className="books-note">Current {dollars(view.receivables.current)} · 1–30 {dollars(view.receivables.days30)} · 31–60 {dollars(view.receivables.days60)} · 61–90 {dollars(view.receivables.days90)} · Over 90 {dollars(view.receivables.over90)}</p>
            <h3>Payables</h3>
            <p className="books-note">Current {dollars(view.payables.current)} · 1–30 {dollars(view.payables.days30)} · 31–60 {dollars(view.payables.days60)} · 61–90 {dollars(view.payables.days90)} · Over 90 {dollars(view.payables.over90)}</p>
            <h3>Close</h3>
            <p className="books-note">{view.close.calculation} {view.close.openWithActivity} past {view.close.openWithActivity === 1 ? "month has" : "months have"} activity and {view.close.openWithActivity === 1 ? "is" : "are"} still open.</p>
            <h3>Alerts</h3>
            {view.alerts.length ? (
              <ul className="plain-list">
                {view.alerts.map((alert) => (
                  <li key={`${alert.key}:${alert.recordKey}`}>
                    <span>{alert.title}</span>
                    <small>{alert.calculation} {alert.reason} {alert.clear}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="books-note">Nothing on this client needs review.</p>}
          </section>
        ) : <section className="card"><p className="books-note">Choose a client.</p></section>}
      </div>
    </div>
  );
}
