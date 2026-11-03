import { useEffect, useMemo, useState } from "react";
import { PERIODS, matchesPeriod } from "../shared/activity.js";

const PAGE_SIZE = 5;

function Icon({ name }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
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

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tone(invoice) {
  if (invoice.status === "paid") return "green";
  if (invoice.status === "void") return "red";
  if (invoice.overdue || invoice.status === "partial") return "amber";
  if (invoice.status === "sent") return "blue";
  return "";
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export function InvoiceModal({ onClose, onSaved }) {
  const today = todayInput();
  const [customerName, setCustomerName] = useState("");
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, 14));
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = customerName.trim() && description.trim() && amount.trim() && issueDate && dueDate && !pending;

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerName,
        issueDate,
        dueDate,
        memo,
        lines: [{ description, amount }],
      }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The draft was not saved.");
      return;
    }
    onSaved(body.invoice);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="invoice-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="invoice-title">Create invoice</h2>
            <p>Save a draft for this client. Sending it posts receivable and income.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Customer</span><input autoFocus value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label>
          <label className="field"><span>Issue date</span><input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required /></label>
          <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label>
          <label className="field full"><span>Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
          <label className="field full"><span>Memo</span><input value={memo} onChange={(event) => setMemo(event.target.value)} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Save draft"}</Button>
        </div>
      </form>
    </div>
  );
}

function InvoiceDrawer({ invoice, onClose, onChange }) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayInput());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const payable = invoice.status === "sent" || invoice.status === "partial";

  async function act(path, body) {
    setPending(true);
    setError("");
    const response = await fetch(path, {
      method: path.endsWith("/payments") || !body ? "POST" : "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(payload.error || "That change was not saved.");
      return;
    }
    onChange();
  }

  return (
    <div className="drawer-scrim" onMouseDown={onClose}>
      <aside className="detail-drawer" aria-label={`${invoice.number} invoice`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <span className={`badge ${tone(invoice)}`}>{invoice.statusLabel}</span>
            <h2>{invoice.number}</h2>
            <p>{invoice.customerName}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="transaction-amount-block">
          <span>{payable || invoice.status === "draft" ? "Balance" : "Invoice total"}</span>
          <strong>{invoice.status === "paid" || invoice.status === "void" ? invoice.total : invoice.balance}</strong>
          <small>Due {invoice.dueDateLabel}</small>
        </div>
        <div className="drawer-section">
          <h3>Invoice</h3>
          <dl>
            <div><dt>Issued</dt><dd>{invoice.issueDateLabel}</dd></div>
            <div><dt>Total</dt><dd>{invoice.total}</dd></div>
            <div><dt>Payments</dt><dd>{invoice.paid}</dd></div>
            {invoice.memo ? <div><dt>Memo</dt><dd>{invoice.memo}</dd></div> : null}
          </dl>
          {invoice.lines.map((line) => <p key={line.id}>{line.description} · {line.amount}</p>)}
        </div>
        {invoice.payments.length ? (
          <div className="drawer-section">
            <h3>Payments</h3>
            {invoice.payments.map((payment) => <p key={payment.id}>{payment.paidOnLabel} · {payment.amount}</p>)}
          </div>
        ) : null}
        {payable ? (
          <form className="drawer-section" onSubmit={(event) => { event.preventDefault(); act(`/api/invoices/${invoice.id}/payments`, { amount, paidOn }); }}>
            <h3>Record payment</h3>
            <p>Posts cash and clears receivable. This does not charge a card.</p>
            <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
            <label className="field"><span>Date</span><input type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} required /></label>
            <Button type="submit" disabled={pending || !amount.trim()}>Record payment</Button>
          </form>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="drawer-footer">
          {invoice.status === "draft" ? <Button disabled={pending} onClick={() => act(`/api/invoices/${invoice.id}/send`)}>Send invoice</Button> : null}
          {invoice.status === "draft" ? <Button variant="secondary" disabled={pending} onClick={() => fetch(`/api/invoices/${invoice.id}`, { method: "DELETE" }).then(() => onChange())}>Discard draft</Button> : null}
          {invoice.status !== "draft" && invoice.status !== "void" ? <Button variant="secondary" disabled={pending} onClick={() => act(`/api/invoices/${invoice.id}/void`)}>Void invoice</Button> : null}
        </div>
      </aside>
    </div>
  );
}

export function OutstandingInvoices({ clientId, onOpen }) {
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    fetch("/api/invoices").then(async (response) => {
      const body = await readJson(response);
      if (!cancelled && response.ok) setPayload(body);
    }).catch(() => {
      if (!cancelled) setPayload(null);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const metrics = payload?.metrics;
  const rows = (payload?.invoices || []).filter((invoice) => invoice.status === "sent" || invoice.status === "partial").slice(0, 3);
  const percent = metrics?.collectedPercent;
  return (
    <section className="card">
      <div className="card-header">
        <div><h2>Outstanding invoices</h2></div>
        <button className="text-button" type="button" onClick={onOpen}>View all</button>
      </div>
      <div className="invoice-total">
        <div><span>Total outstanding</span><strong>{metrics ? metrics.outstanding : "—"}</strong></div>
        <div className="invoice-ring" style={{ background: `conic-gradient(var(--blue) ${percent ?? 0}%, #dfe8f3 0)` }}>
          <span>{percent == null ? "—" : `${percent}%`}</span>
        </div>
      </div>
      <div className="mini-list">
        {payload && !rows.length ? <p className="books-note">No invoices are outstanding.</p> : null}
        {rows.map((invoice) => (
          <div key={invoice.id}>
            <span className="avatar blue small">{invoice.initials}</span>
            <span><b>{invoice.customerName}</b><small>{invoice.overdue ? `Overdue ${invoice.daysOverdue} days` : `Due ${invoice.dueDateLabel}`}</small></span>
            <strong className={invoice.overdue ? "danger" : ""}>{invoice.balance}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Invoices({ clientId, onCreate }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [status, setStatus] = useState("All statuses");
  const [period, setPeriod] = useState("Custom range");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);

  async function load() {
    const response = await fetch("/api/invoices");
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || "Could not load invoices.");
    setPayload(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError("");
    setPage(1);
    setOpenId(null);
    load().catch((loadError) => {
      if (!cancelled) setError(loadError.message);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const invoices = payload?.invoices || [];
  const metrics = payload?.metrics;
  const today = payload?.today || todayInput();
  const filtered = useMemo(() => invoices.filter((invoice) => {
    const haystack = `${invoice.number} ${invoice.customerName} ${invoice.total} ${invoice.memo}`.toLowerCase();
    if (query.trim() && !haystack.includes(query.trim().toLowerCase())) return false;
    if (!matchesPeriod(invoice.issueDate, period, today)) return false;
    if (tab === "draft" && invoice.status !== "draft") return false;
    if (tab === "outstanding" && invoice.status !== "sent" && invoice.status !== "partial") return false;
    if (tab === "paid" && invoice.status !== "paid") return false;
    if (status === "Draft" && invoice.status !== "draft") return false;
    if (status === "Sent" && invoice.status !== "sent") return false;
    if (status === "Partial" && invoice.status !== "partial") return false;
    if (status === "Paid" && invoice.status !== "paid") return false;
    if (status === "Void" && invoice.status !== "void") return false;
    if (status === "Overdue" && !invoice.overdue) return false;
    return true;
  }), [invoices, query, period, today, tab, status]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const open = invoices.find((invoice) => invoice.id === openId) || null;
  const counts = {
    all: invoices.length,
    draft: invoices.filter((invoice) => invoice.status === "draft").length,
    outstanding: invoices.filter((invoice) => invoice.status === "sent" || invoice.status === "partial").length,
    paid: invoices.filter((invoice) => invoice.status === "paid").length,
  };
  const from = filtered.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(safePage * PAGE_SIZE, filtered.length);

  async function refresh(nextId = openId) {
    const body = await load();
    if (nextId && !body.invoices.some((invoice) => invoice.id === nextId)) setOpenId(null);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Invoices</h1>
          <p>Create invoices, track payments, and manage your customers.</p>
        </div>
        <div className="header-actions">
          <Button icon="plus" onClick={onCreate}>Create invoice</Button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="invoice-metrics">
        <section className="card"><span>Outstanding</span><strong>{metrics ? metrics.outstanding : "—"}</strong><small>{metrics ? `${metrics.outstandingCount} open ${metrics.outstandingCount === 1 ? "invoice" : "invoices"}` : "—"}</small><i className="metric-line blue-line" /></section>
        <section className="card"><span>Overdue</span><strong>{metrics ? metrics.overdue : "—"}</strong><small>{metrics?.overdueCount ? `${metrics.overdueCount} ${metrics.overdueCount === 1 ? "invoice" : "invoices"} · ${metrics.overdueDays} days` : "None past due"}</small><i className="metric-line red-line" /></section>
        <section className="card"><span>Paid this month</span><strong>{metrics ? metrics.paidThisMonth : "—"}</strong><small className={metrics?.paidChange?.positive ? "green-text" : ""}>{metrics?.paidChange ? `${metrics.paidChange.positive ? "↑" : "↓"} ${metrics.paidChange.text} from last month` : "No prior month to compare"}</small><i className="metric-line green-line" /></section>
        <section className="card"><span>Average time to pay</span><strong>{metrics?.averageDaysToPay == null ? "—" : `${metrics.averageDaysToPay} days`}</strong><small>{metrics?.averageDaysToPay == null ? "No paid invoices yet" : "From paid invoices"}</small><i className="metric-line purple-line" /></section>
      </div>
      <section className="card table-card">
        <div className="toolbar">
          <div className="search-field">
            <Icon name="search" />
            <input aria-label="Search invoices" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search invoices or customers…" />
          </div>
          <select aria-label="Status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
            {["All statuses", "Draft", "Sent", "Partial", "Paid", "Overdue", "Void"].map((name) => <option key={name}>{name}</option>)}
          </select>
          <select aria-label="Period" value={period} onChange={(event) => { setPeriod(event.target.value); setPage(1); }}>
            {PERIODS.map((name) => <option key={name}>{name}</option>)}
          </select>
        </div>
        <div className="tab-bar">
          {[["all", "All invoices", counts.all], ["draft", "Draft", counts.draft], ["outstanding", "Outstanding", counts.outstanding], ["paid", "Paid", counts.paid]].map(([id, label, count]) => (
            <button className={tab === id ? "active" : ""} type="button" key={id} onClick={() => { setTab(id); setPage(1); }}>{label} <span>{count}</span></button>
          ))}
        </div>
        {pageRows.length ? (
          <table>
            <thead>
              <tr><th>Invoice</th><th>Customer</th><th>Issue date</th><th>Due date</th><th>Amount</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {pageRows.map((invoice) => (
                <tr key={invoice.id}>
                  <td><strong>{invoice.number}</strong></td>
                  <td>
                    <div className="customer">
                      <span className="avatar blue small">{invoice.initials}</span>
                      <strong>{invoice.customerName}</strong>
                    </div>
                  </td>
                  <td>{invoice.issueDateLabel}</td>
                  <td>{invoice.dueDateLabel}</td>
                  <td><strong>{invoice.total}</strong></td>
                  <td><span className={`badge ${tone(invoice)}`}>{invoice.statusLabel}</span></td>
                  <td><button className="row-action" type="button" aria-label={`Open ${invoice.number}`} onClick={() => setOpenId(invoice.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state"><b>{payload ? "No invoices found" : "Loading invoices…"}</b><p>{payload ? "Save a draft, or change the search, status, or date range." : ""}</p></div>
        )}
        <div className="table-footer">
          <span>Showing {from}–{to} of {filtered.length} invoices</span>
          <div>
            <Button variant="secondary" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</Button>
            <Button variant="secondary" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next</Button>
          </div>
        </div>
      </section>
      {open ? <InvoiceDrawer invoice={open} onClose={() => setOpenId(null)} onChange={() => refresh(open.id)} /> : null}
    </div>
  );
}
