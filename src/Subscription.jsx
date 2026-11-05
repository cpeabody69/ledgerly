import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

function when(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusLabel(status) {
  if (status === "active") return "Active";
  if (status === "past_due") return "Past due";
  if (status === "canceled") return "Canceled";
  return "Not started";
}

const confirmRequests = new Map();

function confirmCheckout(sessionId) {
  if (!confirmRequests.has(sessionId)) {
    confirmRequests.set(
      sessionId,
      fetch("/api/subscription/checkout/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).then(readJson),
    );
  }
  return confirmRequests.get(sessionId);
}

export function SubscribeGate({ onSession }) {
  const [stripe, setStripe] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [planId, setPlanId] = useState("practice");
  const [seatCount, setSeatCount] = useState("1");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");

  useEffect(() => {
    let cancel = false;
    fetch("/api/subscription")
      .then(async (response) => {
        const body = await readJson(response);
        if (cancel) return;
        if (!response.ok) {
          setError(body.error || "Could not load the firm subscription.");
          setStripe({ configured: false, notice: "Stripe test keys are not configured. No charge is attempted.", plans: [] });
          return;
        }
        setStripe(body.stripe || { configured: false, notice: "Stripe test keys are not configured. No charge is attempted.", plans: [] });
        setSubscription(body.subscription || null);
        const used = body.subscription?.seatsUsed || 1;
        setSeatCount(String(Math.max(used, 1)));
        const first = (body.stripe?.plans || []).find((plan) => plan.available);
        if (first) setPlanId(first.id);
      })
      .catch(() => {
        if (!cancel) {
          setError("Could not load the firm subscription.");
          setStripe({ configured: false, notice: "Stripe test keys are not configured. No charge is attempted.", plans: [] });
        }
      });
    return () => {
      cancel = true;
    };
  }, []);

  async function refreshSession() {
    if (!onSession) return;
    const response = await fetch("/api/session");
    if (response.ok) onSession(await response.json());
  }

  async function checkout(event) {
    event.preventDefault();
    setPending("checkout");
    setError("");
    const response = await fetch("/api/subscription/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, seatCount: Number(seatCount) }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "Stripe test checkout did not start.");
      return;
    }
    if (!body.url) {
      setError("Stripe did not return a test checkout link.");
      return;
    }
    window.location.assign(body.url);
  }

  async function refreshStatus() {
    setPending("refresh");
    setError("");
    const response = await fetch("/api/subscription/refresh", { method: "POST" });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "The subscription was not refreshed.");
      return;
    }
    setSubscription(body.subscription || null);
    await refreshSession();
  }

  async function openInvoice() {
    setPending("invoice");
    setError("");
    const response = await fetch("/api/subscription/invoice", { method: "POST" });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "Stripe has no open test invoice.");
      return;
    }
    if (body.url) window.location.assign(body.url);
  }

  if (!stripe) return <p className="books-note">Loading the subscription…</p>;
  const plans = stripe.plans || [];
  const blocked = subscription && !subscription.allowsWork;
  if (subscription?.status === "active" && subscription.allowsWork) {
    return (
      <div className="subscribe-gate">
        <p className="books-note">{stripe.notice}</p>
        <p className="books-note">The Stripe test subscription is active. Raising the seat count updates that test subscription.</p>
      </div>
    );
  }

  return (
    <div className="subscribe-gate">
      <p className="books-note">{stripe.notice}</p>
      {subscription ? <p className="books-note">Status: {statusLabel(subscription.status)}. Seats in use: {subscription.seatsUsed}.</p> : null}
      {blocked ? <p className="books-note">Books stay readable. New clients, journal entries, invoices, bills, and invites stay blocked until the subscription is active.</p> : null}
      {subscription?.status === "past_due" ? (
        <div className="subscription-form">
          <button className="button primary" type="button" disabled={pending === "invoice"} onClick={openInvoice}><span>{pending === "invoice" ? "Opening…" : "Open Stripe test invoice"}</span></button>
          <button className="button secondary" type="button" disabled={pending === "refresh"} onClick={refreshStatus}><span>{pending === "refresh" ? "Refreshing…" : "Refresh status"}</span></button>
        </div>
      ) : (
        <form className="subscription-form payment" onSubmit={checkout}>
          <div className="plan-choices">
            {plans.map((plan) => (
              <label key={plan.id} className={planId === plan.id ? "plan-choice selected" : "plan-choice"}>
                <input type="radio" name="ledgerly-plan" value={plan.id} checked={planId === plan.id} disabled={!plan.available || pending === "checkout"} onChange={() => setPlanId(plan.id)} />
                <span><b>{plan.name}</b><small>{plan.summary}</small></span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>Seat count</span>
            <input aria-label="Seat count" inputMode="numeric" value={seatCount} disabled={!stripe.configured || pending === "checkout"} onChange={(event) => setSeatCount(event.target.value)} />
          </label>
          <button className="button primary" type="submit" disabled={!stripe.configured || pending === "checkout" || !plans.some((plan) => plan.available)}>
            <span>{pending === "checkout" ? "Opening Stripe…" : "Continue to Stripe test checkout"}</span>
          </button>
        </form>
      )}
      {subscription?.status === "canceled" ? (
        <button className="button secondary" type="button" disabled={pending === "refresh"} onClick={refreshStatus}><span>Refresh status</span></button>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}

export function SubscribeReturn({ onSession, go }) {
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id") || "";
    if (!sessionId) {
      setError("Stripe did not return a checkout session.");
      return undefined;
    }
    let cancel = false;
    confirmCheckout(sessionId).then(async (body) => {
      if (cancel) return;
      if (!body || body.error) {
        setError(body?.error || "The test subscription was not saved.");
        return;
      }
      const response = await fetch("/api/session");
      const session = response.ok ? await response.json() : null;
      if (cancel) return;
      if (session) onSession(session);
      setDone(true);
      go(session?.onboarding ? "/onboarding" : "/");
    }).catch(() => {
      if (!cancel) setError("The test subscription was not saved.");
    });
    return () => {
      cancel = true;
    };
  }, [go, onSession]);

  return (
    <div className="sign-in">
      <div className="auth-wide gate-card">
        <h1>Ledgerly subscription</h1>
        <p className="lede">{done ? "Subscription saved. Opening the firm…" : "Confirming the Stripe test checkout…"}</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {error ? <button className="button secondary" type="button" onClick={() => go("/onboarding")}>Back to the plan</button> : null}
      </div>
    </div>
  );
}

export function SubscriptionBanner({ session, go }) {
  const subscription = session?.subscription;
  if (!subscription || subscription.billingExempt || subscription.allowsWork || session.portal) return null;
  const text = subscription.status === "past_due"
    ? "This subscription is past due. Books stay readable. New clients, journal entries, invoices, bills, and invites stay blocked until it is paid."
    : subscription.status === "canceled"
      ? "This subscription is canceled. Books stay readable. New clients, journal entries, invoices, bills, and invites stay blocked until a plan is active."
      : "Choose a plan before creating new work.";
  return (
    <div className="onboarding-banner" role="status">
      <span>{text}</span>
      <button className="button secondary" type="button" onClick={() => go("/onboarding")}>Review plan</button>
    </div>
  );
}

export function SubscriptionSetting({ session, onSession }) {
  const subscription = session.subscription;
  const owner = session.user.role === "owner" || session.user.role === "administrator";
  const exempt = Boolean(subscription?.billingExempt);
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
    const response = await fetch(exempt ? "/api/subscription" : "/api/subscription/seats", {
      method: exempt ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exempt ? { seatLimit: Number(seatLimit) } : { seatCount: Number(seatLimit) }),
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
        {exempt ? null : <div><span>Status</span><strong>{statusLabel(subscription?.status)}</strong></div>}
      </div>
      {exempt ? <p className="books-note">This sample firm stays usable without a Stripe subscription.</p> : null}
      {exempt ? <p className="books-note">{full ? "Every seat is in use, so another person cannot be invited." : "An open seat is required before another person can be invited."}</p> : null}
      {exempt || subscription?.allowsWork ? (
        <form className="subscription-form seats" onSubmit={saveSeats}>
          <label className="field">
            <span>Seat count</span>
            <input aria-label="Seat count" inputMode="numeric" value={seatLimit} disabled={!owner || pending === "seats"} onChange={(event) => setSeatLimit(event.target.value)} />
          </label>
          <button className="button primary" type="submit" disabled={!owner || pending === "seats"}><span>{pending === "seats" ? "Saving…" : exempt ? "Save seats" : "Update seats in Stripe test mode"}</span></button>
        </form>
      ) : null}
      {exempt ? (
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
      ) : <SubscribeGate onSession={onSession} />}
      <p className="books-note">A firm payment is recorded here. It does not post a journal entry, and it does not mark a client invoice paid. Stripe test checkout does not post to a client either.</p>
      {exempt && billing.length ? (
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
      ) : null}
      {exempt && !billing.length ? <p className="banking-empty">No firm payments recorded.</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {owner ? null : <p className="books-note">An owner changes the seat count and records what the firm pays Ledgerly.</p>}
    </section>
  );
}
