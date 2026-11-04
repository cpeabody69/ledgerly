import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

function when(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function SubscriptionSetting({ session, onSession }) {
  const subscription = session.subscription;
  const owner = session.user.role === "owner";
  const [seatLimit, setSeatLimit] = useState(String(subscription?.seatLimit ?? ""));
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [billing, setBilling] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");

  useEffect(() => {
    setSeatLimit(String(session.subscription?.seatLimit ?? ""));
  }, [session.subscription?.seatLimit]);

  useEffect(() => {
    let cancel = false;
    fetch("/api/subscription")
      .then(async (response) => {
        const body = await readJson(response);
        if (!cancel && response.ok) setBilling(body.billing || []);
      })
      .catch(() => {
        if (!cancel) setError("Could not load the firm subscription.");
      });
    return () => {
      cancel = true;
    };
  }, [session.firm.id]);

  async function saveSeats(event) {
    event.preventDefault();
    setPending("seats");
    setError("");
    const response = await fetch("/api/subscription", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatLimit: Number(seatLimit) }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "The seat count was not saved.");
      return;
    }
    setBilling(body.billing || []);
    onSession({ ...session, subscription: body.subscription });
  }

  async function recordPayment(event) {
    event.preventDefault();
    setPending("payment");
    setError("");
    const response = await fetch("/api/subscription/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, memo }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "The firm payment was not recorded.");
      return;
    }
    setAmount("");
    setMemo("");
    setBilling(body.billing || []);
    onSession({ ...session, subscription: body.subscription });
  }

  const full = subscription && subscription.seatsUsed >= subscription.seatLimit;

  return (
    <section className="card subscription-card" aria-label="Firm subscription">
      <div className="card-header">
        <div>
          <h2>Ledgerly subscription</h2>
          <p>The plan and seats belong to {session.firm.name}. They are not part of a client’s books.</p>
        </div>
      </div>
      <div className="subscription-metrics">
        <div><span>Plan</span><strong>{subscription?.planName || "Practice"}</strong></div>
        <div><span>People who can sign in</span><strong>{subscription?.seatsUsed ?? "—"}</strong></div>
        <div><span>Seat count</span><strong>{subscription?.seatLimit ?? "—"}</strong></div>
      </div>
      <p className="books-note">{full ? "Every seat is in use, so another person cannot be invited." : "An open seat is required before another person can be invited."}</p>
      <form className="subscription-form seats" onSubmit={saveSeats}>
        <label className="field">
          <span>Seat count</span>
          <input aria-label="Seat count" inputMode="numeric" value={seatLimit} disabled={!owner || pending === "seats"} onChange={(event) => setSeatLimit(event.target.value)} />
        </label>
        <button className="button primary" type="submit" disabled={!owner || pending === "seats"}><span>{pending === "seats" ? "Saving…" : "Save seats"}</span></button>
      </form>
      <form className="subscription-form payment" onSubmit={recordPayment}>
        <label className="field">
          <span>Amount the firm paid Ledgerly</span>
          <input aria-label="Firm payment amount" value={amount} disabled={!owner || pending === "payment"} onChange={(event) => setAmount(event.target.value)} placeholder="49.00" />
        </label>
        <label className="field">
          <span>Memo</span>
          <input aria-label="Firm payment memo" value={memo} disabled={!owner || pending === "payment"} onChange={(event) => setMemo(event.target.value)} placeholder="Practice plan" />
        </label>
        <button className="button primary" type="submit" disabled={!owner || pending === "payment" || !amount.trim() || !memo.trim()}><span>{pending === "payment" ? "Recording…" : "Record firm payment"}</span></button>
      </form>
      <p className="books-note">A firm payment is recorded here. It does not post a journal entry, and it does not mark a client invoice paid.</p>
      {billing.length ? (
        <table className="books-table">
          <thead><tr><th>Date</th><th>Memo</th><th>Recorded by</th><th>Amount</th></tr></thead>
          <tbody>
            {billing.map((event) => (
              <tr key={event.id}>
                <td>{when(event.createdAt)}</td>
                <td>{event.memo}</td>
                <td>{event.actorName}</td>
                <td>{event.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="banking-empty">No firm payments recorded.</p>}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {owner ? null : <p className="books-note">An owner changes the seat count and records what the firm pays Ledgerly.</p>}
    </section>
  );
}
