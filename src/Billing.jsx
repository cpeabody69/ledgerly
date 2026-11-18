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

export function Billing({ clientId }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("Monthly books");
  const [amount, setAmount] = useState("500.00");

  async function load() {
    const response = await fetch("/api/billing");
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load billing.");
    setBoard(body);
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

  async function saveEngagement(event) {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/billing/engagements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, name, kind: "fixed", amount }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      setError(body.error || "The engagement was not saved.");
      return;
    }
    setBoard(body);
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Billing</h1>
          <p>Fees the firm charges this client. These invoices stay off the client ledger, and no card number is stored.</p>
        </div>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <p className="books-note">{board?.payments?.note}</p>
      <section className="card">
        <div className="card-header"><div><h2>Engagement</h2></div></div>
        <form className="close-status-row" onSubmit={saveEngagement}>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Fixed fee<input value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <button className="button primary" type="submit">Save</button>
        </form>
        <ul className="plain-list">
          {(board?.engagements || []).map((item) => (
            <li key={item.id}><span>{item.clientName} · {item.name}</span><small>{item.kind} · {dollars(item.amountCents)}</small></li>
          ))}
        </ul>
      </section>
      <section className="card">
        <div className="card-header"><div><h2>Invoices</h2><p>Open balances by age, in cents on the server.</p></div></div>
        {board?.aging ? <p className="books-note">Current {dollars(board.aging.current)} · 1–30 {dollars(board.aging.days30)} · 31–60 {dollars(board.aging.days60)} · 61–90 {dollars(board.aging.days90)} · Over 90 {dollars(board.aging.over90)}</p> : null}
        <ul className="plain-list">
          {(board?.invoices || []).map((invoice) => (
            <li key={invoice.id}><span>{invoice.number} · {invoice.clientName}</span><small>{invoice.status} · {dollars(invoice.balanceCents)} open</small></li>
          ))}
        </ul>
      </section>
    </div>
  );
}
