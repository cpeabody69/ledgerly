import { useEffect, useState } from "react";
import { PERIODS } from "../shared/activity.js";
import { formatMoney } from "../shared/money.js";
import { statementCsv } from "../shared/statements.js";

const REPORTS = [
  ["profit-and-loss", "Profit & loss", "Income and expenses"],
  ["balance-sheet", "Balance sheet", "Assets and liabilities"],
  ["cash-flow", "Cash flow statement", "Cash movement"],
];

const LATER = ["Budget vs. actuals", "Accounts receivable", "Expense summary"];

function Icon({ name }) {
  const paths = {
    chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2z" /></>,
    arrows: <><path d="M7 7h11l-3-3" /><path d="m18 7-3 3" /><path d="M17 17H6l3 3" /><path d="m6 17 3-3" /></>,
    file: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
  };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Button({ children, disabled, onClick, icon }) {
  return (
    <button className="button secondary" type="button" disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function StatementTable({ statement, report }) {
  if (!statement) return <p className="books-note">Loading this client’s ledger…</p>;
  if (report === "balance-sheet") {
    return (
      <table className="statement">
        <thead><tr><th>Account</th><th>{statement.period.label}</th></tr></thead>
        <tbody>
          <Section title="Assets" rows={statement.balanceSheet.assets} total="Total assets" totalAmount={statement.balanceSheet.assetsTotal} />
          <Section title="Liabilities" rows={statement.balanceSheet.liabilities} total="Total liabilities" totalAmount={statement.balanceSheet.liabilitiesTotal} />
          <Section title="Equity" rows={statement.balanceSheet.equity} total="Total equity" totalAmount={statement.balanceSheet.equityTotal} />
        </tbody>
      </table>
    );
  }
  if (report === "cash-flow") {
    return (
      <table className="statement">
        <thead><tr><th>Account</th><th>{statement.period.label}</th></tr></thead>
        <tbody>
          {statement.cashFlow.lines.map((row) => (
            <tr className={row.label.startsWith("Ending") || row.label.startsWith("Beginning") ? "total-row" : ""} key={row.label}>
              <td>{row.label}</td>
              <td>{row.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const prior = statement.prior?.label || "Prior period";
  return (
    <table className="statement">
      <thead><tr><th>Account</th><th>{statement.period.label}</th><th>{prior}</th><th>Change</th></tr></thead>
      <tbody>
        <Section title="Income" rows={statement.profitAndLoss.incomeRows} total="Total income" totalAmount={statement.profitAndLoss.income} compared priorAmount={formatMoney(statement.profitAndLoss.priorIncomeCents)} changeAmount={formatMoney(statement.profitAndLoss.incomeCents - statement.profitAndLoss.priorIncomeCents)} />
        <Section title="Expenses" rows={statement.profitAndLoss.expenseRows} total="Total expenses" totalAmount={statement.profitAndLoss.expenses} compared priorAmount={formatMoney(statement.profitAndLoss.priorExpenseCents)} changeAmount={formatMoney(statement.profitAndLoss.expenseCents - statement.profitAndLoss.priorExpenseCents)} />
        <tr className="total-row">
          <td>Net income</td>
          <td>{statement.profitAndLoss.netIncome}</td>
          <td>{statement.profitAndLoss.priorNetIncomeCents === null ? "—" : formatMoney(statement.profitAndLoss.priorNetIncomeCents)}</td>
          <td>{statement.profitAndLoss.priorNetIncomeCents === null ? "—" : formatMoney(statement.profitAndLoss.netIncomeCents - statement.profitAndLoss.priorNetIncomeCents)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Section({ title, rows, total, totalAmount, compared = false, priorAmount, changeAmount }) {
  return (
    <>
      <tr className="section-row"><td>{title}</td>{compared ? <><td /><td /><td /></> : <td />}</tr>
      {rows.length ? rows.map((row) => (
        <tr key={row.id || row.code || row.name}>
          <td>{row.code ? `${row.code} ${row.name}` : row.name}</td>
          <td>{row.amount}</td>
          {compared ? <><td>{row.priorAmount}</td><td>{row.change}</td></> : null}
        </tr>
      )) : (
        <tr><td>No activity</td><td>$0.00</td>{compared ? <><td>$0.00</td><td>$0.00</td></> : null}</tr>
      )}
      <tr className="total-row">
        <td>{total}</td>
        <td>{totalAmount}</td>
        {compared ? <><td>{priorAmount}</td><td>{changeAmount}</td></> : null}
      </tr>
    </>
  );
}

export function Reports({ clientId }) {
  const [report, setReport] = useState(REPORTS[0][0]);
  const [period, setPeriod] = useState(PERIODS[0]);
  const [basis, setBasis] = useState("accrual");
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState("");
  const title = REPORTS.find((item) => item[0] === report)[1];

  useEffect(() => {
    let cancelled = false;
    setStatement(null);
    setError("");
    const params = new URLSearchParams({ period, basis });
    fetch(`/api/statements?${params}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load the statement.");
        if (!cancelled) setStatement(body);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, period, basis]);

  function exportStatement() {
    if (!statement) return;
    const csv = statementCsv(statement, report);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report}-${statement.period.start}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Profit and loss, balance sheet, and cash flow from this client's books.</p>
        </div>
        <div className="header-actions">
          <Button icon="download" disabled={!statement} onClick={exportStatement}>Export</Button>
          <Button disabled>Share</Button>
        </div>
      </div>
      <div className="report-layout">
        <aside className="report-menu">
          <span>Financial statements</span>
          {REPORTS.map(([id, label, detail], index) => (
            <button className={report === id ? "active" : ""} type="button" onClick={() => setReport(id)} key={id}>
              <Icon name={["chart", "book", "arrows"][index]} />
              <div><b>{label}</b><small>{detail}</small></div>
            </button>
          ))}
          <span>Management reports</span>
          {LATER.map((label) => (
            <button type="button" disabled key={label}>
              <Icon name="file" />
              <div><b>{label}</b><small>Not computed yet</small></div>
            </button>
          ))}
        </aside>
        <section className="card report-sheet">
          <div className="report-top">
            <div>
              <span className="report-logo">L</span>
              <div>
                <h2>{statement?.client.legalName || "Ledger"}</h2>
                <p>{title}</p>
              </div>
            </div>
            <div className="report-filters">
              <select className="period-select" aria-label="Period" value={period} onChange={(event) => setPeriod(event.target.value)}>
                {PERIODS.map((name) => <option key={name}>{name}</option>)}
              </select>
              <select className="period-select" aria-label="Basis" value={basis} onChange={(event) => setBasis(event.target.value)}>
                <option value="accrual">Accrual basis</option>
                <option value="cash">Cash basis</option>
              </select>
            </div>
          </div>
          <div className="report-title">
            <h1>{title}</h1>
            <p>{statement ? `${statement.period.label} · ${basis === "cash" ? "Cash basis" : "Accrual basis"}` : "From the general ledger"}</p>
          </div>
          {error ? <p className="form-error books-error" role="alert">{error}</p> : <StatementTable statement={statement} report={report} />}
          <div className="report-note"><span>Prepared from the general ledger. A change is this period minus the prior period.</span></div>
        </section>
      </div>
    </div>
  );
}
