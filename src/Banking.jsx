import { useEffect, useMemo, useState } from "react";
import { formatSigned, reconciliationMath } from "../shared/activity.js";
import { formatMoney, parseCents } from "../shared/money.js";

function Button({ children, variant = "primary", disabled = false, type = "button", onClick }) {
  return <button className={`button ${variant}`} type={type} disabled={disabled} onClick={onClick}><span>{children}</span></button>;
}

function todayInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function endingCents(value) {
  const text = value.trim();
  if (!text) return null;
  if (text === "0" || text === "0.00" || text === "$0.00") return 0;
  try {
    const negative = text.startsWith("-");
    const cents = parseCents(negative ? text.slice(1) : text.replace(/^\$/, ""));
    return negative ? -cents : cents;
  } catch {
    return null;
  }
}

export function Banking({ clientId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("bank");
  const [selectedId, setSelectedId] = useState("");
  const [statementDate, setStatementDate] = useState(todayInput);
  const [statementEnding, setStatementEnding] = useState("");
  const [checked, setChecked] = useState([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    setNotice("");
    setChecked([]);
    fetch("/api/banking")
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load banking.");
        if (!cancelled) {
          setData(body);
          setSelectedId(body.accounts[0]?.id || "");
        }
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const selected = data?.accounts.find((account) => account.id === selectedId) || null;
  const lines = useMemo(
    () => (data && selected ? data.lines.filter((line) => line.bankAccountId === selected.id) : []),
    [data, selected],
  );
  const openLines = lines.filter((line) => !line.cleared);
  const prior = data?.reconciliations.find((row) => row.bankAccountId === selectedId);
  const beginning = prior ? prior.statementEndingCents : 0;
  const parsedEnding = endingCents(statementEnding);
  const math = parsedEnding === null ? null : reconciliationMath(beginning, parsedEnding, openLines.filter((line) => checked.includes(line.id)).map((line) => line.amountCents));

  async function addAccount(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/bank-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, kind }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || "The account was not added.");
        return;
      }
      setData(body);
      setSelectedId(body.accounts.at(-1)?.id || "");
      setName("");
      setNotice("Account added. It is not a live bank connection.");
    } finally {
      setPending(false);
    }
  }

  async function complete() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/reconciliations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bankAccountId: selected.id, statementDate, statementEnding, transactionIds: checked }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.reconciliation?.status !== "complete") {
        setError(body.error || "The reconciliation is not complete.");
        return;
      }
      setData(body);
      setChecked([]);
      setStatementEnding("");
      setNotice(`Reconciliation completed for ${body.reconciliation.statementDateLabel}. Statement lines were cleared and left unchanged.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Banking</h1>
          <p>Accounts, statement lines, and reconciliation for this client.</p>
        </div>
      </div>
      {error ? <p className="form-error books-error" role="alert">{error}</p> : null}
      {notice ? <p className="books-note">{notice}</p> : null}
      <div className="banking-layout">
        <section className="card">
          <div className="card-header"><div><h2>Accounts</h2><p>Not a live bank connection.</p></div></div>
          <form className="banking-add" onSubmit={addAccount}>
            <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Operating checking" required /></label>
            <label className="field">
              <span>Kind</span>
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="bank">Bank</option>
                <option value="card">Card</option>
              </select>
            </label>
            <Button type="submit" disabled={pending}>Add account</Button>
          </form>
          {data?.accounts.length ? (
            <div className="account-list">
              {data.accounts.map((account) => (
                <button className={account.id === selectedId ? "selected" : ""} type="button" key={account.id} onClick={() => { setSelectedId(account.id); setChecked([]); }}>
                  <b>{account.name}</b>
                  <small>{account.kindLabel} · ledger {account.ledgerCode} · Not a live bank connection</small>
                </button>
              ))}
            </div>
          ) : <p className="banking-empty">No accounts yet.</p>}
        </section>
        <section className="card table-card">
          <div className="card-header"><div><h2>{selected ? selected.name : "Statement lines"}</h2><p>{selected ? "Clear lines only when the statement difference is zero." : "Add an account to import activity."}</p></div></div>
          {lines.length ? (
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.postedOnLabel}</td>
                    <td><b>{line.description}</b></td>
                    <td>{formatSigned(line.amountCents)}</td>
                    <td>{line.cleared ? "Cleared" : line.statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty-state"><b>No statement lines</b><p>Import a CSV on the Transactions screen.</p></div>}
          {selected ? (
            <div className="reconcile">
              <h3>Reconcile</h3>
              <div className="form-grid">
                <label className="field"><span>Statement date</span><input type="date" value={statementDate} onChange={(event) => setStatementDate(event.target.value)} /></label>
                <label className="field"><span>Statement ending balance</span><input value={statementEnding} onChange={(event) => setStatementEnding(event.target.value)} placeholder="457.50" /></label>
              </div>
              {openLines.length ? (
                <ul className="clear-list">
                  {openLines.map((line) => (
                    <li key={line.id}>
                      <label>
                        <input type="checkbox" checked={checked.includes(line.id)} onChange={() => setChecked((current) => current.includes(line.id) ? current.filter((id) => id !== line.id) : [...current, line.id])} />
                        <span>{line.postedOnLabel} · {line.description}</span>
                        <b>{formatSigned(line.amountCents)}</b>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : <p className="banking-empty">Every line on this account is cleared.</p>}
              <dl className="reconcile-math">
                <div><dt>Beginning</dt><dd>{formatMoney(beginning)}</dd></div>
                <div><dt>Cleared</dt><dd>{math ? formatSigned(math.clearedCents) : "—"}</dd></div>
                <div><dt>Computed ending</dt><dd>{math ? formatMoney(math.computedEndingCents) : "—"}</dd></div>
                <div><dt>Difference</dt><dd className={math && math.differenceCents !== 0 ? "danger" : ""}>{math ? formatMoney(math.differenceCents) : "—"}</dd></div>
              </dl>
              <Button disabled={pending || !selected} onClick={complete}>Complete reconciliation</Button>
            </div>
          ) : null}
          {data?.reconciliations.length ? (
            <div className="reconcile-history">
              <h3>Completed reconciliations</h3>
              <ul>
                {data.reconciliations.map((row) => (
                  <li key={row.id}>{row.accountName} · {row.statementDateLabel} · ending {formatMoney(row.statementEndingCents)} · Complete</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
