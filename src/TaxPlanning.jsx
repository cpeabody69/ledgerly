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

export function TaxPlanning({ clientId }) {
  const [year, setYear] = useState("2026");
  const [board, setBoard] = useState(null);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [entityType, setEntityType] = useState("sole_proprietor");
  const [filingStatus, setFilingStatus] = useState("single");
  const [otherWages, setOtherWages] = useState("0.00");
  const [reason, setReason] = useState("");
  const [scenario, setScenario] = useState(null);

  async function loadBoard(nextYear = year) {
    const response = await fetch(`/api/tax-intel?year=${encodeURIComponent(nextYear)}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load tax readiness.");
    setBoard(body);
    return body;
  }

  async function loadPlan(id, nextYear = year) {
    const response = await fetch(`/api/tax-intel/${encodeURIComponent(id)}?year=${encodeURIComponent(nextYear)}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not open that plan.");
    setPlan(body);
    if (body.profile) {
      setEntityType(body.profile.entityType);
      setFilingStatus(body.profile.filingStatus === "unset" ? "single" : body.profile.filingStatus);
      setOtherWages(body.profile.otherWagesCents == null ? "" : (body.profile.otherWagesCents / 100).toFixed(2));
    }
    setError("");
    return body;
  }

  useEffect(() => {
    let cancel = false;
    loadBoard().then((body) => {
      if (cancel) return null;
      const match = body.clients.find((client) => client.id === clientId) || body.clients[0];
      return match ? loadPlan(match.id) : null;
    }).catch((reason) => {
      if (!cancel) setError(reason.message);
    });
    return () => {
      cancel = true;
    };
  }, [clientId]);

  async function post(path, payload) {
    setPending(path);
    setError("");
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "That change was not saved.");
      return null;
    }
    if (body.clientId) setPlan(body);
    if (body.scenario) setScenario(body);
    await loadBoard();
    return body;
  }

  const estimate = plan?.estimate;

  return (
    <div className="tax-planning">
      <header className="page-header">
        <div>
          <h1>Tax planning</h1>
          <p>Sole-proprietor planning from the books. This is not a return and it is not transmitted.</p>
        </div>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="card close-filters">
        <label>Year<input value={year} onChange={(event) => { setYear(event.target.value); loadBoard(event.target.value).catch((reason) => setError(reason.message)); }} /></label>
        {board ? <p className="firm-progress"><b>{board.counts.ready}</b> ready · <b>{board.counts.notReady}</b> not ready · <b>{board.counts.outstanding}</b> open items</p> : null}
      </section>
      <div className="close-layout">
        <section className="card">
          <div className="card-header"><div><h2>Clients</h2></div></div>
          <ul className="plain-list">
            {(board?.clients || []).map((client) => (
              <li key={client.id}>
                <button type="button" className="text-button" onClick={() => loadPlan(client.id).catch((reason) => setError(reason.message))}>{client.name}</button>
                <small>{client.statusLabel} · {client.booksSource === "quickbooks" ? "QuickBooks sandbox" : "Avenue books"} · {client.outstanding} open</small>
              </li>
            ))}
          </ul>
        </section>
        {plan ? (
          <section className="card">
            <div className="card-header"><div><h2>{plan.clientName}</h2><p>{plan.statusLabel} · through {plan.asOf}</p></div></div>
            <p className="books-note">{plan.note} {plan.sourceNote} Rules {plan.rulesVersion || "are not loaded for this year"}.</p>
            <div className="firm-metrics">
              <div className="card firm-metric"><b>{dollars(plan.yearToDate.incomeCents)}</b><span>Year-to-date revenue</span></div>
              <div className="card firm-metric"><b>{dollars(plan.yearToDate.expenseCents)}</b><span>Year-to-date expenses</span></div>
              <div className="card firm-metric"><b>{dollars(plan.yearToDate.netCents)}</b><span>Year-to-date net</span></div>
              <div className="card firm-metric"><b>{dollars(plan.projection.projectedCents)}</b><span>Projected profit</span></div>
            </div>
            <p className="books-note">Prior-year same period {dollars(plan.history.priorSamePeriodNetCents)}. Change {dollars(plan.history.changeCents)}.</p>
            <form className="close-status-row" onSubmit={(event) => { event.preventDefault(); post(`/api/tax-intel/${plan.clientId}/profile`, { year: plan.taxYear, entityType, filingStatus, otherWages }); }}>
              <label>Entity
                <select value={entityType} onChange={(event) => setEntityType(event.target.value)}>
                  <option value="sole_proprietor">Sole proprietor</option>
                  <option value="corporation">Corporation</option>
                  <option value="partnership">Partnership</option>
                </select>
              </label>
              <label>Filing status
                <select value={filingStatus} onChange={(event) => setFilingStatus(event.target.value)}>
                  <option value="single">Single</option>
                  <option value="married_joint">Married filing jointly</option>
                  <option value="married_separate">Married filing separately</option>
                  <option value="head">Head of household</option>
                </select>
              </label>
              <label>Other wages<input value={otherWages} onChange={(event) => setOtherWages(event.target.value)} /></label>
              <button className="button primary" type="submit" disabled={pending.includes("profile")}>Save profile</button>
            </form>
            {estimate ? (
              <div>
                <h3>Estimate</h3>
                <p>{estimate.status === "calculated" ? `${dollars(estimate.totalCents)} estimated. ${dollars(estimate.paidCents)} recorded. ${dollars(estimate.remainingCents)} still open.` : estimate.missing?.join(" ") || estimate.limitations?.[0]}</p>
                <ul className="plain-list">
                  {(estimate.quarters || []).map((quarter) => (
                    <li key={quarter.quarter}><span>Quarter {quarter.quarter} due {quarter.dueOn}</span><small>{dollars(quarter.amountCents)} planned · {dollars(quarter.paidCents)} recorded</small></li>
                  ))}
                </ul>
                <ul className="plain-list">
                  {(estimate.assumptions || []).map((item) => <li key={item}><span>{item}</span></li>)}
                  {(estimate.limitations || []).map((item) => <li key={item}><span>{item}</span></li>)}
                </ul>
              </div>
            ) : null}
            <h3>Readiness</h3>
            {plan.blockers.length ? (
              <ul className="plain-list">{plan.blockers.map((item) => <li key={item.key}><span>{item.detail}</span></li>)}</ul>
            ) : <p className="books-note">The books are clear. An accountant still has to mark the client ready.</p>}
            <form onSubmit={(event) => { event.preventDefault(); post(`/api/tax-intel/${plan.clientId}/review`, { year: plan.taxYear, note: reason }); }}>
              <label>Review note<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
              <button className="button secondary" type="submit">Mark tax-ready</button>
            </form>
            <h3>Categories</h3>
            <ul className="plain-list">
              {plan.mappings.map((row) => (
                <li key={row.accountId}><span>{row.code} {row.name}</span><small>{row.lineLabel} · book {dollars(row.bookCents)} · tax {dollars(row.taxCents)}{row.needsReview ? " · needs review" : ""}</small></li>
              ))}
            </ul>
            <div className="close-actions">
              <a href={`/api/tax-intel/${plan.clientId}/workpaper.csv?year=${plan.taxYear}`}>CSV workpaper</a>
              <a href={`/api/tax-intel/${plan.clientId}/workpaper.pdf?year=${plan.taxYear}`}>PDF workpaper</a>
            </div>
            <form onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              post(`/api/tax-intel/${plan.clientId}/scenario`, {
                year: plan.taxYear,
                incomeChange: form.income.value || "0.00",
                expenseChange: form.expense.value || "0.00",
                retirementAmount: form.retirement.value || "0.00",
                retirementKind: form.kind.value,
                depreciationAmount: form.depreciation.value || "0.00",
              });
            }}>
              <h3>Scenarios</h3>
              <div className="close-status-row">
                <label>Income change<input name="income" defaultValue="0.00" /></label>
                <label>Expense change<input name="expense" defaultValue="0.00" /></label>
                <label>Retirement<input name="retirement" defaultValue="0.00" /></label>
                <label>Kind
                  <select name="kind"><option value="sep">SEP</option><option value="ira">IRA</option></select>
                </label>
                <label>Extra depreciation<input name="depreciation" defaultValue="0.00" /></label>
                <button className="button secondary" type="submit">Compare</button>
              </div>
            </form>
            {scenario?.scenario ? <p className="books-note">Scenario estimate {dollars(scenario.scenario.totalCents)}. {scenario.retirement?.note} {scenario.depreciation?.note}</p> : null}
          </section>
        ) : <section className="card"><p className="books-note">Choose a client.</p></section>}
      </div>
    </div>
  );
}
