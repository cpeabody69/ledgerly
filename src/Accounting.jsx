import { Fragment, useEffect, useMemo, useState } from "react";
import { formatMoney, parseCents } from "../shared/money.js";

const TABS = ["Chart of accounts", "General ledger", "Journal entries", "Trial balance"];

const icons = {
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2z" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h3" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

function Button({ children, variant = "primary", icon, onClick, disabled = false, type = "button" }) {
  return (
    <button className={`button ${variant}`} onClick={onClick} disabled={disabled} type={type}>
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

function todayInput() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function blankLine() {
  return { key: crypto.randomUUID(), accountId: "", debit: "", credit: "" };
}

function includes(query, parts) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.join(" ").toLowerCase().includes(needle);
}

function safeCents(value) {
  try {
    return parseCents(value, { blank: true });
  } catch {
    return null;
  }
}

function sumCents(lines, side) {
  let total = 0;
  for (const line of lines) {
    const cents = safeCents(line[side]);
    if (cents === null) return null;
    total += cents;
  }
  return total;
}

function postedLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function JournalFormTotals({ lines }) {
  const debit = sumCents(lines, "debit");
  const credit = sumCents(lines, "credit");
  const mismatch = debit === null || credit === null || debit !== credit;
  return (
    <p className={mismatch ? "journal-totals out" : "journal-totals"}>
      <span>Debits {debit === null ? "—" : formatMoney(debit)}</span>
      <span>Credits {credit === null ? "—" : formatMoney(credit)}</span>
    </p>
  );
}

function JournalEntryForm({ ledger, onClose, onPosted, initial }) {
  const [entryDate, setEntryDate] = useState(initial?.entryDate || todayInput);
  const [memo, setMemo] = useState(initial?.memo || "");
  const [lines, setLines] = useState(() => (
    initial?.lines?.length
      ? initial.lines.map((line) => ({ key: crypto.randomUUID(), accountId: line.accountId, debit: line.debit || "", credit: line.credit || "" }))
      : [blankLine(), blankLine()]
  ));
  const [error, setError] = useState("");
  const [posting, setPosting] = useState(false);

  function updateLine(key, patch) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    setPosting(true);
    try {
      const response = await fetch("/api/journal-entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entryDate,
          memo,
          lines: lines.map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || "The entry was not posted.");
        return;
      }
      onPosted(body.ledger);
    } catch {
      setError("The entry was not posted.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal wide" aria-labelledby="journal-form-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <div className="modal-header">
          <div>
            <h2 id="journal-form-title">New journal entry</h2>
            <p>{initial ? "This draft was suggested. Posting it is your entry." : `Post a balanced entry to ${ledger.client.name}. Debits must equal credits.`}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Date</span>
            <input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
          </label>
          <label className="field">
            <span>Memo</span>
            <input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="What this entry records" maxLength={200} required />
          </label>
        </div>
        <table className="journal-lines">
          <thead>
            <tr>
              <th>Account</th>
              <th>Debit</th>
              <th>Credit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td>
                  <label className="field">
                    <select aria-label={`Line ${index + 1} account`} value={line.accountId} onChange={(event) => updateLine(line.key, { accountId: event.target.value })} required>
                      <option value="">Choose an account</option>
                      {ledger.accounts.map((account) => (
                        <option value={account.id} key={account.id}>{account.code} {account.name}</option>
                      ))}
                    </select>
                  </label>
                </td>
                <td>
                  <label className="field">
                    <input aria-label={`Line ${index + 1} debit`} inputMode="decimal" value={line.debit} onChange={(event) => updateLine(line.key, { debit: event.target.value })} placeholder="0.00" />
                  </label>
                </td>
                <td>
                  <label className="field">
                    <input aria-label={`Line ${index + 1} credit`} inputMode="decimal" value={line.credit} onChange={(event) => updateLine(line.key, { credit: event.target.value })} placeholder="0.00" />
                  </label>
                </td>
                <td>
                  {lines.length > 2 ? (
                    <button type="button" className="text-button" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>Remove</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <JournalFormTotals lines={lines} />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <button type="button" className="text-button journal-add" onClick={() => setLines((current) => [...current, blankLine()])}>Add line</button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={posting}>{posting ? "Posting…" : "Post entry"}</Button>
        </div>
      </form>
    </div>
  );
}

export function Accounting({ clientId, draft = null, onDraftUsed }) {
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(TABS[0]);
  const [query, setQuery] = useState("");
  const [journalOpen, setJournalOpen] = useState(Boolean(draft));

  useEffect(() => {
    if (draft) setJournalOpen(true);
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    setLedger(null);
    setError("");
    setQuery("");
    fetch("/api/ledger")
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load the books.");
        if (!cancelled) setLedger(body);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const visibleAccounts = useMemo(
    () => (ledger ? ledger.accounts.filter((account) => includes(query, [account.code, account.name, account.typeLabel, account.detailType])) : []),
    [ledger, query],
  );
  const visibleActivity = useMemo(
    () => (ledger ? ledger.activity.filter((line) => includes(query, [line.accountCode, line.accountName, line.memo, line.reference, line.entryDateLabel])) : []),
    [ledger, query],
  );
  const visibleEntries = useMemo(
    () => (ledger ? ledger.entries.filter((entry) => includes(query, [entry.reference, entry.memo, entry.postedBy, entry.entryDateLabel, ...entry.lines.flatMap((line) => [line.accountCode, line.accountName])])) : []),
    [ledger, query],
  );
  const visibleTrial = useMemo(
    () => (ledger ? ledger.trialBalance.rows.filter((row) => includes(query, [row.code, row.name, row.typeLabel])) : []),
    [ledger, query],
  );

  let footer = "Loading the books…";
  if (ledger && tab === "Chart of accounts") {
    footer = `${visibleAccounts.length} of ${ledger.accounts.length} accounts · ${ledger.client.name} · Small service template, not GAAP guidance.`;
  } else if (ledger && tab === "General ledger") {
    footer = `${visibleActivity.length} lines · ${ledger.client.name}`;
  } else if (ledger && tab === "Journal entries") {
    footer = `${visibleEntries.length} journal entries · ${ledger.client.name}`;
  } else if (ledger && tab === "Trial balance") {
    footer = `Debits ${ledger.trialBalance.debitTotal} · Credits ${ledger.trialBalance.creditTotal}${ledger.trialBalance.foots ? " · Trial balance foots" : ""} · ${ledger.client.name}`;
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Accounting</h1>
          <p>Manage your books, accounts, and financial records.</p>
        </div>
        <div className="header-actions">
          <Button icon="plus" disabled={!ledger} onClick={() => setJournalOpen(true)}>New journal entry</Button>
        </div>
      </div>
      <div className="accounting-cards">
        <section className="card">
          <span className="round-icon blue"><Icon name="book" /></span>
          <div>
            <small>Total assets</small>
            <strong>{ledger ? ledger.cards.assets : "—"}</strong>
            <em>{ledger ? ledger.cards.assetsNote : "Loading the books"}</em>
          </div>
        </section>
        <section className="card">
          <span className="round-icon coral"><Icon name="card" /></span>
          <div>
            <small>Total liabilities</small>
            <strong>{ledger ? ledger.cards.liabilities : "—"}</strong>
            <em>{ledger ? ledger.cards.liabilitiesNote : "Loading the books"}</em>
          </div>
        </section>
        <section className="card">
          <span className="round-icon green"><Icon name="chart" /></span>
          <div>
            <small>Owner’s equity</small>
            <strong>{ledger ? ledger.cards.equity : "—"}</strong>
            <em>{ledger ? ledger.cards.equityNote : "Loading the books"}</em>
          </div>
        </section>
      </div>
      <section className="card table-card">
        <div className="wide-tabs">
          {TABS.map((name) => (
            <button className={tab === name ? "active" : ""} onClick={() => setTab(name)} key={name} type="button">{name}</button>
          ))}
        </div>
        <div className="toolbar">
          <div className="search-field">
            <Icon name="search" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab.toLowerCase()}…`} />
          </div>
          <Button variant="secondary" icon="download" disabled>Export</Button>
          <Button variant="secondary" icon="filter" disabled>Filter</Button>
        </div>
        {error ? <p className="form-error books-error" role="alert">{error}</p> : null}
        {ledger && tab === "Chart of accounts" ? (
          <table className="books-table">
            <thead>
              <tr><th>Account</th><th>Type</th><th>Detail type</th><th className="num">Balance</th><th>Last activity</th></tr>
            </thead>
            <tbody>
              {visibleAccounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <div className="account-name">
                      <span className={`account-mark ${account.mark}`} />
                      <span><b>{account.name}</b><small>{account.code}</small></span>
                    </div>
                  </td>
                  <td>{account.typeLabel}</td>
                  <td>{account.detailType}</td>
                  <td className="num"><strong>{account.balance}</strong></td>
                  <td>{account.lastActivity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {ledger && tab === "General ledger" ? (
          visibleActivity.length ? (
            <table className="books-table">
              <thead>
                <tr><th>Account</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                {visibleActivity.map((line) => (
                  <tr key={line.id}>
                    <td><div className="account-name"><span><b>{line.accountName}</b><small>{line.accountCode}</small></span></div></td>
                    <td>{line.entryDateLabel}</td>
                    <td>{line.reference} · {line.memo}</td>
                    <td className="num">{line.debit}</td>
                    <td className="num">{line.credit}</td>
                    <td className="num"><strong>{line.balance}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <b>{ledger.activity.length ? "No matching activity" : "No journal entries yet"}</b>
              <p>{ledger.activity.length ? "Try a different search." : "Post a balanced entry to see activity by account."}</p>
            </div>
          )
        ) : null}
        {ledger && tab === "Journal entries" ? (
          visibleEntries.length ? (
            <table className="books-table">
              <thead>
                <tr><th>Entry</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th>Posted</th></tr>
              </thead>
              <tbody>
                {visibleEntries.map((entry) => (
                  <Fragment key={entry.id}>
                    <tr className="journal-group">
                      <td><strong>{entry.reference}</strong></td>
                      <td>{entry.entryDateLabel}</td>
                      <td>{entry.memo}</td>
                      <td className="num"><strong>{entry.debitTotal}</strong></td>
                      <td className="num"><strong>{entry.creditTotal}</strong></td>
                      <td>{entry.postedBy}<small className="posted-at">{postedLabel(entry.postedAt)}</small></td>
                    </tr>
                    {entry.lines.map((line) => (
                      <tr key={line.id}>
                        <td />
                        <td><div className="account-name"><span><b>{line.accountName}</b><small>{line.accountCode}</small></span></div></td>
                        <td>{entry.memo}</td>
                        <td className="num">{line.debit}</td>
                        <td className="num">{line.credit}</td>
                        <td />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <b>{ledger.entries.length ? "No matching journal entries" : "No journal entries yet"}</b>
              <p>{ledger.entries.length ? "Try a different search." : "A journal entry is a balanced set of lines for this client."}</p>
            </div>
          )
        ) : null}
        {ledger && tab === "Trial balance" ? (
          <table className="books-table">
            <thead>
              <tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr>
            </thead>
            <tbody>
              {visibleTrial.map((row) => (
                <tr key={row.accountId}>
                  <td><div className="account-name"><span><b>{row.name}</b><small>{row.code} · {row.typeLabel}</small></span></div></td>
                  <td className="num">{row.debit}</td>
                  <td className="num">{row.credit}</td>
                </tr>
              ))}
              <tr className="trial-total">
                <td>Totals</td>
                <td className="num"><strong>{ledger.trialBalance.debitTotal}</strong></td>
                <td className="num"><strong>{ledger.trialBalance.creditTotal}</strong></td>
              </tr>
            </tbody>
          </table>
        ) : null}
        <div className="table-footer"><span>{footer}</span></div>
      </section>
      {journalOpen && ledger ? (
        <JournalEntryForm
          ledger={ledger}
          initial={draft}
          onClose={() => {
            setJournalOpen(false);
            onDraftUsed?.();
          }}
          onPosted={(next) => {
            setLedger(next);
            setJournalOpen(false);
            onDraftUsed?.();
            setTab("Trial balance");
            setQuery("");
          }}
        />
      ) : null}
    </div>
  );
}
