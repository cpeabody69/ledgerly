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

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function Billing({ clientId }) {
  const [board, setBoard] = useState(null);
  const [reports, setReports] = useState(null);
  const [time, setTime] = useState([]);
  const [work, setWork] = useState([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("Monthly books");
  const [kind, setKind] = useState("fixed");
  const [amount, setAmount] = useState("500.00");
  const [costAmount, setCostAmount] = useState("");
  const [intervalDays, setIntervalDays] = useState("30");
  const [nextOn, setNextOn] = useState(todayIso);
  const [dueOn, setDueOn] = useState(todayIso);
  const [hours, setHours] = useState("1.00");
  const [rate, setRate] = useState("100.00");
  const [workedOn, setWorkedOn] = useState(todayIso);
  const [note, setNote] = useState("");
  const [engagementId, setEngagementId] = useState("");

  async function load() {
    const [billingResponse, reportResponse, timeResponse] = await Promise.all([
      fetch("/api/billing"),
      fetch("/api/billing/reports"),
      fetch("/api/time"),
    ]);
    const billingBody = await readJson(billingResponse);
    if (!billingResponse.ok) throw new Error(billingBody.error || "Could not load billing.");
    const reportBody = await readJson(reportResponse);
    const timeBody = await readJson(timeResponse);
    setBoard(billingBody);
    setReports(reportResponse.ok ? reportBody : null);
    setTime(Array.isArray(timeBody.entries) ? timeBody.entries.filter((entry) => entry.clientId === clientId) : []);
    setWork(Array.isArray(timeBody.work) ? timeBody.work.filter((item) => item.clientId === clientId) : []);
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

  async function post(pathname, payload) {
    const response = await fetch(pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "That billing change was not saved.");
    return body;
  }

  async function refresh(message) {
    setError(message || "");
    try {
      await load();
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function saveEngagement(event) {
    event.preventDefault();
    try {
      await post("/api/billing/engagements", {
        clientId,
        name,
        kind,
        amount,
        costAmount,
        intervalDays: Number(intervalDays),
        nextOn,
      });
      await refresh();
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function draftFee(engagement) {
    try {
      await post("/api/billing/invoices", {
        clientId,
        engagementId: engagement.id,
        issueOn: todayIso(),
        dueOn,
      });
      await refresh();
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function logTime(event) {
    event.preventDefault();
    const engagement = (board?.engagements || []).find((item) => item.id === engagementId);
    if (!engagement) {
      setError("Choose an engagement for this time.");
      return;
    }
    try {
      const existing = work.find((item) => item.name.toLowerCase() === engagement.name.toLowerCase());
      const created = existing || (await post("/api/work", {
        clientId,
        name: engagement.name,
        hourlyRate: rate,
      })).work;
      await post("/api/time", {
        clientId,
        workId: created.id,
        workedOn,
        hours,
        note,
        engagementId: engagement.id,
        billable: true,
      });
      await refresh();
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function billTime(engagement) {
    const entryIds = time.filter((entry) => entry.engagementId === engagement.id && entry.billable && !entry.firmInvoiceId && !entry.invoiceId).map((entry) => entry.id);
    try {
      await post("/api/billing/invoices", {
        clientId,
        engagementId: engagement.id,
        issueOn: todayIso(),
        dueOn,
        entryIds,
      });
      await refresh();
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function act(pathname, payload) {
    try {
      await post(pathname, payload);
      await refresh();
    } catch (reason) {
      setError(reason.message);
    }
  }

  const openTime = time.filter((entry) => entry.billable && !entry.firmInvoiceId && !entry.invoiceId);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Billing</h1>
          <p>Fees this firm charges the open client. These invoices stay off the client ledger, and no card number is stored.</p>
        </div>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <p className="books-note">{board?.payments?.note}</p>
      <section className="card">
        <div className="card-header"><div><h2>Engagement</h2></div></div>
        <form className="close-status-row" onSubmit={saveEngagement}>
          <label>Name<input aria-label="Engagement name" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Kind
            <select aria-label="Engagement kind" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="fixed">Fixed fee</option>
              <option value="hourly">Hourly</option>
              <option value="recurring">Recurring</option>
            </select>
          </label>
          {kind === "hourly" ? null : <label>Fee<input aria-label="Engagement fee" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>}
          <label>Cost rate<input aria-label="Cost rate" value={costAmount} onChange={(event) => setCostAmount(event.target.value)} placeholder="per hour" /></label>
          {kind === "recurring" ? <label>Every<input aria-label="Interval days" value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} /></label> : null}
          {kind === "recurring" ? <label>Next<input aria-label="Next invoice date" type="date" value={nextOn} onChange={(event) => setNextOn(event.target.value)} /></label> : null}
          <label>Due<input aria-label="Invoice due date" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} /></label>
          <button className="button primary" type="submit">Save engagement</button>
        </form>
        <ul className="plain-list">
          {(board?.engagements || []).map((item) => (
            <li key={item.id}>
              <span>{item.clientName} · {item.name} · {item.kind} · {item.kind === "hourly" ? "Time" : dollars(item.amountCents)}{item.nextOn ? ` · next ${item.nextOn}` : ""}</span>
              {item.kind === "hourly"
                ? <button type="button" onClick={() => billTime(item)}>Bill open time for {item.name}</button>
                : <button type="button" onClick={() => draftFee(item)}>Draft invoice for {item.name}</button>}
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <div className="card-header"><div><h2>Time on an engagement</h2><p>{openTime.length} open billable {openTime.length === 1 ? "entry" : "entries"} for this client.</p></div></div>
        <form className="close-status-row" onSubmit={logTime}>
          <label>Engagement
            <select aria-label="Time engagement" value={engagementId} onChange={(event) => setEngagementId(event.target.value)}>
              <option value="">Choose</option>
              {(board?.engagements || []).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Date<input aria-label="Time date" type="date" value={workedOn} onChange={(event) => setWorkedOn(event.target.value)} /></label>
          <label>Hours<input aria-label="Time hours" value={hours} onChange={(event) => setHours(event.target.value)} /></label>
          <label>Rate<input aria-label="Hourly rate" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
          <label>Note<input aria-label="Time note" value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <button className="button" type="submit">Log time</button>
        </form>
      </section>
      <section className="card">
        <div className="card-header"><div><h2>Invoices</h2><p>Open balances by age.</p></div></div>
        {board?.aging ? <p className="books-note" data-aging="true">Current {dollars(board.aging.current)} · 1–30 {dollars(board.aging.days30)} · 31–60 {dollars(board.aging.days60)} · 61–90 {dollars(board.aging.days90)} · Over 90 {dollars(board.aging.over90)}</p> : null}
        <ul className="plain-list">
          {(board?.invoices || []).map((invoice) => (
            <li key={invoice.id}>
              <span>{invoice.number} · {invoice.clientName} · {invoice.status} · {dollars(invoice.balanceCents)} open · due {invoice.dueOn}</span>
              {invoice.status === "draft" ? <button type="button" onClick={() => act(`/api/billing/invoices/${invoice.id}/approve`)}>Approve {invoice.number}</button> : null}
              {invoice.status === "approved" || invoice.status === "partial" ? (
                <button type="button" onClick={() => act(`/api/billing/invoices/${invoice.id}/payments`, { amount: "200.00", paidOn: todayIso(), method: "check" })}>Record 200.00 on {invoice.number}</button>
              ) : null}
              {invoice.status === "approved" || invoice.status === "partial" ? (
                <button type="button" onClick={() => act(`/api/billing/invoices/${invoice.id}/credits`, { amount: dollars(invoice.balanceCents).replace(/[$,]/g, ""), reason: "Courtesy reduction for this engagement." })}>Credit the balance on {invoice.number}</button>
              ) : null}
            </li>
          ))}
        </ul>
        <button className="button" type="button" onClick={() => act("/api/billing/recurring")}>Generate due retainers</button>
      </section>
      <section className="card">
        <div className="card-header"><div><h2>Engagement profit</h2><p>Revenue is approved fees for that engagement. Hours are only the time assigned to it.</p></div></div>
        <ul className="plain-list">
          {(reports?.profitability || []).map((row) => (
            <li key={row.engagementId}>
              <span>{row.name}</span>
              <small>{dollars(row.billedCents)} billed · {(row.hoursHundredths / 100).toFixed(2)} hours · profit {dollars(row.profitCents)}</small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
