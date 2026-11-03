import { useEffect, useMemo, useState } from "react";
import { PERIODS, formatSigned, matchesPeriod, summarize } from "../shared/activity.js";

const TABS = [
  ["all", "All"],
  ["for_review", "For review"],
  ["income", "Income"],
  ["expense", "Expenses"],
];

function Icon({ name }) {
  const paths = {
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 20h14" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    down: <path d="m6 9 6 6 6-6" />,
    up: <path d="m18 15-6-6-6 6" />,
  };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Button({ children, variant = "primary", icon, disabled = false, type = "button", onClick }) {
  return (
    <button className={`button ${variant}`} type={type} disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function todayInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function badgeTone(status) {
  if (status === "for_review") return "amber";
  if (status === "categorized") return "green";
  return "neutral";
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export function Transactions({ clientId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState(PERIODS[0]);
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const response = await fetch("/api/transactions");
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load transactions.");
    setData(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    setNotice("");
    setSelected([]);
    setPage(1);
    load().catch((loadError) => {
      if (!cancelled) setError(loadError.message);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const rows = data?.transactions || [];
  const today = todayInput();
  const periodRows = useMemo(
    () => rows.filter((row) => matchesPeriod(row.postedOn, period, today) && `${row.description} ${row.category} ${row.accountName} ${row.note}`.toLowerCase().includes(query.trim().toLowerCase())),
    [rows, period, query, today],
  );
  const counts = summarize(periodRows);
  const visible = periodRows.filter((row) => tab === "all" || (tab === "income" || tab === "expense" ? row.type === tab : row.status === tab));
  const pageCount = Math.max(1, Math.ceil(visible.length / 6));
  const safePage = Math.min(page, pageCount);
  const pageRows = visible.slice((safePage - 1) * 6, safePage * 6);
  const accounts = data?.accounts || [];
  const bankAccounts = data?.bankAccounts || [];

  function replace(next, message) {
    setData(next);
    setNotice(message);
    setError("");
    setDrawer(null);
    setSelected([]);
  }

  async function categorize(row, accountId, note) {
    const response = await fetch(`/api/transactions/${row.id}/categorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, note }),
    });
    const body = await readJson(response);
    if (!response.ok || !body.entry) {
      setError(body.error || "Nothing was posted.");
      return;
    }
    replace(body, `Posted ${body.entry.reference}.`);
  }

  async function exclude(row, note) {
    const response = await fetch(`/api/transactions/${row.id}/exclude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const body = await readJson(response);
    if (!response.ok || !body.entry) {
      setError(body.error || "Nothing was posted.");
      return;
    }
    replace(body, `Posted ${body.entry.reference}.`);
  }

  async function bulk(action) {
    const response = await fetch("/api/transactions/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ids: selected, accountId: bulkAccountId }),
    });
    const body = await readJson(response);
    if (!response.ok || !body.entries?.length) {
      setError(body.error || "Nothing was posted.");
      return;
    }
    replace(body, `Posted ${body.entries.length} ${body.entries.length === 1 ? "journal entry" : "journal entries"}.`);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Transactions</h1>
          <p>Review, categorize, and reconcile all your business activity.</p>
        </div>
        <div className="header-actions">
          <Button variant="secondary" icon="upload" disabled={!bankAccounts.length} onClick={() => setImportOpen(true)}>Import</Button>
          <Button icon="plus" disabled={!bankAccounts.length} onClick={() => setAddOpen(true)}>Add transaction</Button>
        </div>
      </div>
      <div className="summary-strip">
        <div><span>All transactions</span><strong>{data ? counts.all : "—"}</strong></div>
        <div><span>For review</span><strong className="amber-text">{data ? counts.forReview : "—"}</strong></div>
        <div><span>Excluded</span><strong>{data ? counts.excluded : "—"}</strong></div>
        <div><span>Categorized</span><strong className="green-text">{data ? counts.categorized : "—"}</strong></div>
      </div>
      <section className="card table-card">
        <div className="toolbar">
          <div className="search-field">
            <Icon name="search" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search by description, amount, or category…" />
          </div>
          <select className="period-select" aria-label="Period" value={period} onChange={(event) => { setPeriod(event.target.value); setPage(1); }}>
            {PERIODS.map((name) => <option key={name}>{name}</option>)}
          </select>
        </div>
        <div className="tab-bar">
          {TABS.map(([id, label]) => (
            <button className={tab === id ? "active" : ""} type="button" key={id} onClick={() => { setTab(id); setPage(1); }}>
              {label}
              {id === "all" ? <span>{counts.all}</span> : null}
              {id === "for_review" ? <span>{counts.forReview}</span> : null}
            </button>
          ))}
        </div>
        {selected.length > 0 ? (
          <div className="bulk-bar">
            <b>{selected.length} selected</b>
            <select aria-label="Bulk category" value={bulkAccountId} onChange={(event) => setBulkAccountId(event.target.value)}>
              <option value="">Category</option>
              {accounts.map((account) => <option value={account.id} key={account.id}>{account.code} {account.name}</option>)}
            </select>
            <button type="button" onClick={() => bulk("categorize")}>Categorize</button>
            <button type="button" onClick={() => bulk("exclude")}>Exclude</button>
            <button type="button" onClick={() => setSelected([])}>Clear</button>
          </div>
        ) : null}
        {error ? <p className="form-error books-error" role="alert">{error}</p> : null}
        {notice ? <p className="books-note">{notice}</p> : null}
        {pageRows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Select all" checked={pageRows.every((row) => selected.includes(row.id))} onChange={() => setSelected((current) => pageRows.every((row) => current.includes(row.id)) ? current.filter((id) => !pageRows.some((row) => row.id === id)) : [...new Set([...current, ...pageRows.map((row) => row.id)])])} /></th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Account</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr key={row.id} className={selected.includes(row.id) ? "selected-row" : ""}>
                    <td><input type="checkbox" aria-label={`Select ${row.description}`} checked={selected.includes(row.id)} onChange={() => setSelected((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])} /></td>
                    <td>{row.postedOnLabel}</td>
                    <td><div className="table-primary"><span className={`transaction-icon ${row.type}`}><Icon name={row.type === "income" ? "down" : "up"} /></span><span><b>{row.description}</b><small>{row.journalReference || "No journal yet"}</small></span></div></td>
                    <td>{row.category ? <span className="badge">{row.category}</span> : "—"}</td>
                    <td>{row.accountName}</td>
                    <td><strong className={row.type}>{formatSigned(row.amountCents)}</strong></td>
                    <td><span className={`badge ${badgeTone(row.status)}`}>{row.statusLabel}</span></td>
                    <td><button className="row-action" type="button" aria-label={`Open ${row.description}`} onClick={() => setDrawer(row)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <b>{rows.length ? "No transactions in this period" : "No transactions yet"}</b>
            <p>{period === "Apr 1 – Apr 30" && !rows.some((row) => matchesPeriod(row.postedOn, period, today)) ? "April is empty because this client has no April activity." : "Import a CSV of synthetic activity, or add a line."}</p>
          </div>
        )}
        <div className="table-footer">
          <span>Showing {visible.length ? (safePage - 1) * 6 + 1 : 0}–{Math.min(safePage * 6, visible.length)} of {visible.length} matching transactions · {period}</span>
          <div>
            <Button variant="secondary" disabled={safePage === 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
            <span className="page-count">Page {safePage} of {pageCount}</span>
            <Button variant="secondary" disabled={safePage >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</Button>
          </div>
        </div>
      </section>
      {drawer ? (
        <TransactionDrawer
          transaction={drawer}
          accounts={accounts}
          onClose={() => setDrawer(null)}
          onCategorize={categorize}
          onExclude={exclude}
        />
      ) : null}
      {importOpen ? <ImportModal accounts={bankAccounts} onClose={() => setImportOpen(false)} onImported={(body) => { setImportOpen(false); replace(body, `Imported ${body.imported} ${body.imported === 1 ? "line" : "lines"}.`); }} /> : null}
      {addOpen ? <AddModal accounts={bankAccounts} onClose={() => setAddOpen(false)} onCreated={(body) => { setAddOpen(false); replace(body, "Added a line for review. It is not posted until you categorize it."); }} /> : null}
    </div>
  );
}

function TransactionDrawer({ transaction, accounts, onClose, onCategorize, onExclude }) {
  const [accountId, setAccountId] = useState(transaction.categoryAccountId || "");
  const [note, setNote] = useState(transaction.note || "");
  const [pending, setPending] = useState(false);
  const choices = accounts.filter((account) => account.code !== (transaction.accountKind === "card" ? "2100" : "1000"));

  async function save(event) {
    event.preventDefault();
    setPending(true);
    try {
      await onCategorize(transaction, accountId, note);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="drawer-scrim" onMouseDown={onClose}>
      <aside className="detail-drawer" aria-label={`${transaction.description} transaction details`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <span className={`badge ${badgeTone(transaction.status)}`}>{transaction.statusLabel}</span>
            <h2>{transaction.description}</h2>
            <p>{transaction.accountName}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="transaction-amount-block">
          <span>{transaction.type === "income" ? "Money in" : "Money out"}</span>
          <strong className={transaction.type}>{formatSigned(transaction.amountCents)}</strong>
          <small>{transaction.postedOnLabel}</small>
        </div>
        <form onSubmit={save}>
          <div className="drawer-section">
            <h3>Statement line</h3>
            <dl>
              <div><dt>Account</dt><dd>{transaction.accountName}</dd></div>
              <div><dt>Source</dt><dd>{transaction.source === "csv" ? "Imported from a CSV" : "Entered in Ledgerly"}</dd></div>
              <div><dt>Journal</dt><dd>{transaction.journalReference || "Not posted"}</dd></div>
            </dl>
          </div>
          <div className="drawer-section">
            <h3>Proposed coding</h3>
            <label className="field">
              <span>Category</span>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
                <option value="">Choose an account</option>
                {choices.map((account) => <option value={account.id} key={account.id}>{account.code} {account.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Note</span>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note for the journal" />
            </label>
          </div>
          <div className="drawer-footer">
            <Button variant="secondary" disabled={pending || transaction.cleared} onClick={() => onExclude(transaction, note)}>Exclude</Button>
            <Button type="submit" disabled={pending || transaction.cleared}>{pending ? "Posting…" : "Save changes"}</Button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function ImportModal({ accounts, onClose, onImported }) {
  const [bankAccountId, setBankAccountId] = useState(accounts[0]?.id || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || !file.size) {
      setError("Choose a CSV file.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const csv = await file.text();
      const response = await fetch("/api/transactions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bankAccountId, csv }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setError(body.error || "The file was not imported.");
        return;
      }
      onImported(body);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <div className="modal-header">
          <div>
            <h2 id="import-title">Import activity</h2>
            <p>CSV columns: date, description, amount. A negative amount is money out.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full">
            <span>Account</span>
            <select name="account" value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)} required>
              {accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
            </select>
          </label>
          <label className="field full">
            <span>CSV file</span>
            <input name="file" type="file" accept=".csv,text/csv" required />
          </label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>{pending ? "Importing…" : "Import"}</Button>
        </div>
      </form>
    </div>
  );
}

function AddModal({ accounts, onClose, onCreated }) {
  const [bankAccountId, setBankAccountId] = useState(accounts[0]?.id || "");
  const [postedOn, setPostedOn] = useState(todayInput);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bankAccountId, postedOn, description, amount }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setError(body.error || "The line was not added.");
        return;
      }
      onCreated(body);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" aria-labelledby="add-line-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <div className="modal-header">
          <div>
            <h2 id="add-line-title">Add transaction</h2>
            <p>This stores a statement line. It posts a journal when you categorize it.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field"><span>Date</span><input type="date" value={postedOn} onChange={(event) => setPostedOn(event.target.value)} required /></label>
          <label className="field"><span>Amount</span><input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="-42.50 or 500.00" required /></label>
          <label className="field full"><span>Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} required /></label>
          <label className="field full">
            <span>Account</span>
            <select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>
              {accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
            </select>
          </label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Add line"}</Button>
        </div>
      </form>
    </div>
  );
}
