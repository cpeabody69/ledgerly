// Preserved Ledgerly shell from the published bundle.
// Sign-in, sign-out, the client switcher, and Settings invites talk to the API.
// Accounting is the client's books. Transactions and Banking are this client's statement activity.
// Dashboard metrics, the revenue chart, outstanding invoices, and upcoming bills use the ledger. The Clients screen is this firm's books and review queue. Invoices are this client's drafts, receivables, and payments. Expenses are this client's bills and paid expenses.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PERIODS } from "../shared/activity.js";
import { formatMoney } from "../shared/money.js";
import { Accounting } from "./Accounting.jsx";
import { Banking } from "./Banking.jsx";
import { Clients } from "./Clients.jsx";
import { ExpenseModal, Expenses, ReceiptSetting, UpcomingBills } from "./Expenses.jsx";
import { InvoiceModal, Invoices, OutstandingInvoices } from "./Invoices.jsx";
import { ReceiptModal } from "./Receipt.jsx";
import { Reports } from "./Reports.jsx";
import { Transactions } from "./Transactions.jsx";

const b = { createContext, useContext, useEffect, useMemo, useState };

var ee = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  arrows: <><path d="M7 7h11l-3-3" /><path d="m18 7-3 3" /><path d="M17 17H6l3 3" /><path d="m6 17 3-3" /></>,
  bank: <><path d="m3 10 9-6 9 6" /><path d="M5 10h14" /><path d="M6 10v7m4-7v7m4-7v7m4-7v7" /><path d="M3 20h18" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2z" /></>,
  invoice: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h3" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9v-.1A1.7 1.7 0 0 0 7.9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-1.5-1H2V10h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 20.4 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  arrowUp: <><path d="m18 15-6-6-6 6" /><path d="M12 9v10" /></>,
  arrowDown: <><path d="m6 9 6 6 6-6" /><path d="M12 15V5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 20h14" /></>,
  file: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  sparkle: <><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z" /></>,
  wallet: <><path d="M4 6h14a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12" /><path d="M15 11h7v5h-7a2.5 2.5 0 0 1 0-5" /></>,
  building: <><path d="M4 21V5l8-3 8 3v16M8 8h2m4 0h2M8 12h2m4 0h2M8 16h2m4 0h2M2 21h20" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>
};
function C({
  name: e,
  size: t = 18
}) {
  return <svg width={t} height={t} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ee[e]}</svg>;
}
var te = [[`Dashboard`, `grid`], [`Transactions`, `arrows`], [`Banking`, `bank`], [`Accounting`, `book`], [`Invoices`, `invoice`], [`Expenses`, `card`], [`Reports`, `chart`], [`Clients`, `users`], [`Settings`, `settings`]];
function Cmp_w({
  children: e,
  variant: t = `primary`,
  icon: n,
  onClick: r,
  disabled: i = !1,
  active: a = !1
}) {
  return <button className={`button ${t} ${a ? `active` : ``}`} onClick={r} disabled={i}>{n && <C name={n} size={16} />}<span>{e}</span></button>;
}
function Cmp_ne({
  children: e,
  tone: t = `neutral`
}) {
  return <span className={`badge ${t}`}>{e}</span>;
}
function T({
  initials: e,
  color: t = `blue`,
  small: n = !1
}) {
  return <span className={`avatar ${t} ${n ? `small` : ``}`}>{e}</span>;
}
function E({
  children: e,
  className: t = ``
}) {
  return <section className={`card ${t}`}>{e}</section>;
}
function D({
  eyebrow: e,
  title: t,
  subtitle: n,
  actions: r
}) {
  return <div className="page-header"><div>{e && <div className="eyebrow">{e}</div>}<h1>{t}</h1><p>{n}</p></div>{r && <div className="header-actions">{r}</div>}</div>;
}
function Cmp_re({
  title: e,
  subtitle: t,
  action: n
}) {
  return <div className="card-header"><div><h2>{e}</h2>{t && <p>{t}</p>}</div>{n}</div>;
}
var ie = (0, b.createContext)(null);
function O() {
  let e = (0, b.useContext)(ie);
  if (!e) throw Error(`App actions are unavailable`);
  return e;
}
function Cmp_ae({
  label: e,
  icon: t,
  options: n,
  value: r,
  onChange: i
}) {
  let [a, o] = (0, b.useState)(!1);
  return <div className="dropdown"><Cmp_w variant="secondary" icon={t} active={a} onClick={() => o(!a)}>{e || r}<span className={`dropdown-arrow ${a ? `open` : ``}`}>⌄</span></Cmp_w>{a && <><button className="dropdown-scrim" aria-label="Close menu" onClick={() => o(!1)} /><div className="dropdown-menu">{n.map(e => <button className={e === r ? `selected` : ``} onClick={() => {
          i(e), o(!1);
        }} key={e}><span>{e}</span>{e === r && <C name="check" size={14} />}</button>)}</div></>}</div>;
}
function Cmp_oe({
  value: e,
  onChange: t
}) {
  return <Cmp_ae icon="calendar" value={e} options={[`May 1 – May 31`, `Apr 1 – Apr 30`, `Q2 2025`, `Year to date`, `Custom range`]} onChange={t} />;
}
function Cmp_se({
  title: e,
  detail: t
}) {
  return <div className="empty-state"><span><C name="search" /></span><b>{e}</b><p>{t}</p></div>;
}
var ce = [{
  date: `May 24`,
  name: `Stripe Payments`,
  detail: `Payout · #ST-80421`,
  category: `Sales income`,
  account: `Business checking`,
  amount: `+$8,420.00`,
  type: `income`,
  status: `Categorized`,
  bankDetail: `Mercury · Operating 8842`
}, {
  date: `May 23`,
  name: `Amazon Web Services`,
  detail: `Cloud infrastructure`,
  category: `Software & hosting`,
  account: `Amex ·· 1042`,
  amount: `−$642.18`,
  type: `expense`,
  status: `For review`,
  bankDetail: `American Express · 1042`
}, {
  date: `May 23`,
  name: `WeWork`,
  detail: `Monthly membership`,
  category: `Rent & lease`,
  account: `Business checking`,
  amount: `−$1,850.00`,
  type: `expense`,
  status: `Categorized`,
  bankDetail: `Mercury · Operating 8842`
}, {
  date: `May 22`,
  name: `Acme Studio LLC`,
  detail: `Invoice #INV-1084`,
  category: `Consulting income`,
  account: `Business checking`,
  amount: `+$4,750.00`,
  type: `income`,
  status: `Matched`,
  bankDetail: `Mercury · Operating 8842`
}, {
  date: `May 21`,
  name: `Adobe`,
  detail: `Creative Cloud`,
  category: `Software & hosting`,
  account: `Visa ·· 4831`,
  amount: `−$89.99`,
  type: `expense`,
  status: `Categorized`,
  bankDetail: `Chase Visa · 4831`
}, {
  date: `May 20`,
  name: `Gusto`,
  detail: `Payroll · May`,
  category: `Payroll expense`,
  account: `Business checking`,
  amount: `−$6,284.50`,
  type: `expense`,
  status: `Matched`,
  bankDetail: `Mercury · Operating 8842`
}, {
  date: `May 19`,
  name: `Figma`,
  detail: `Professional plan · 8 seats`,
  category: `Software & hosting`,
  account: `Amex ·· 1042`,
  amount: `−$128.00`,
  type: `expense`,
  status: `Categorized`,
  bankDetail: `American Express · 1042`
}, {
  date: `May 18`,
  name: `Brightline Labs`,
  detail: `Invoice #INV-1079`,
  category: `Consulting income`,
  account: `Business checking`,
  amount: `+$3,840.00`,
  type: `income`,
  status: `Matched`,
  bankDetail: `Mercury · Operating 8842`
}, {
  date: `May 17`,
  name: `Delta Air Lines`,
  detail: `Client travel · SFO to JFK`,
  category: `Travel`,
  account: `Visa ·· 4831`,
  amount: `−$486.42`,
  type: `expense`,
  status: `For review`,
  bankDetail: `Chase Visa · 4831`
}, {
  date: `May 16`,
  name: `Mercury Treasury`,
  detail: `Monthly interest payment`,
  category: `Interest income`,
  account: `Business savings`,
  amount: `+$184.72`,
  type: `income`,
  status: `Categorized`,
  bankDetail: `Mercury · Treasury 2091`
}];
function Cmp_le({
  label: e,
  value: t,
  change: n,
  positive: r,
  icon: i,
  accent: a
}) {
  return <E className="metric-card"><div className={`metric-icon ${a}`}><C name={i} /></div><div className="metric-label">{e}<C name="more" size={16} /></div><div className="metric-value">{t}</div>{n ? <div className={`metric-change ${r ? `positive` : `negative`}`}><span><C name={r ? `arrowUp` : `arrowDown`} size={13} />{n}</span><em>vs prior period</em></div> : null}</E>;
}
function Cmp_ue({ months = [] }) {
  const peak = Math.max(0, ...months.map((month) => Math.max(month.revenueCents, month.expenseCents)));
  const max = Math.max(peak, 1);
  const x = (index) => months.length <= 1 ? 0 : index * 700 / (months.length - 1);
  const y = (cents) => 220 - cents / max * 200;
  const line = (key) => months.map((month, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(month[key]).toFixed(1)}`).join(" ");
  const ticks = peak === 0 ? [0] : [peak, Math.round(peak * 2 / 3), Math.round(peak / 3), 0];
  return <div className="revenue-chart"><div className="chart-y">{ticks.map((tick, index) => <span style={{ top: `${y(tick) / 240 * 100}%` }} key={`${index}-${tick}`}>{formatMoney(tick)}</span>)}</div><svg viewBox="0 0 700 240" preserveAspectRatio="none" role="img" aria-label="Revenue versus expenses"><g className="grid-lines"><path d="M0 20H700M0 87H700M0 154H700M0 220H700" /></g>{months.length ? <><path className="income-line" d={line("revenueCents")} /><path className="expense-line" d={line("expenseCents")} /></> : null}</svg><div className="chart-x">{months.map((month) => <span key={`${month.year}-${month.month}`}>{month.label}</span>)}</div></div>;
}
function Cmp_de() {
  let {
      navigate: e,
      openComposer: t,
      session
    } = O(),
    [period, setPeriod] = (0, b.useState)(`May 1 – May 31`),
    [basisLabel, setBasisLabel] = (0, b.useState)(`Accrual basis`),
    [figures, setFigures] = (0, b.useState)(null),
    basis = basisLabel === `Cash basis` ? `cash` : `accrual`;
  (0, b.useEffect)(() => {
    let cancelled = false;
    setFigures(null);
    let params = new URLSearchParams({ period, basis });
    fetch(`/api/statements?${params}`).then(async (response) => {
      let body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load the dashboard.");
      if (!cancelled) setFigures(body);
    }).catch(() => {
      if (!cancelled) setFigures(null);
    });
    return () => {
      cancelled = true;
    };
  }, [session.client?.id, period, basis]);
  let metrics = figures?.metrics;
  let chart = figures?.chart;
  return <div className="page"><D title={`Good morning, ${session.user.name.split(" ")[0]}`} subtitle={`Here’s how ${session.client.name} is performing for ${figures?.period.label || period}.`} actions={<><Cmp_oe value={period} onChange={setPeriod} /><Cmp_w icon="plus" onClick={() => t(`transaction`)}>New transaction</Cmp_w></>} /><div className="metrics-grid"><Cmp_le label="Total revenue" value={metrics ? metrics.revenue : `—`} change={metrics?.revenueChange?.text} positive={metrics?.revenueChange?.positive} icon="arrowUp" accent="blue" /><Cmp_le label="Total expenses" value={metrics ? metrics.expenses : `—`} change={metrics?.expenseChange?.text} positive={metrics?.expenseChange?.positive} icon="arrowDown" accent="coral" /><Cmp_le label="Net income" value={metrics ? metrics.netIncome : `—`} change={metrics?.netIncomeChange?.text} positive={metrics?.netIncomeChange?.positive} icon="chart" accent="green" /><Cmp_le label="Cash balance" value={metrics ? metrics.cash : `—`} change={metrics?.cashChange} positive={metrics?.cashChangePositive} icon="wallet" accent="purple" /></div><div className="dashboard-main"><E className="chart-card"><Cmp_re title="Revenue & expenses" subtitle="Monthly totals from the same ledger" action={<div className="chart-tools"><span><i className="legend blue" />Revenue</span><span><i className="legend gray" />Expenses</span><Cmp_ae value={basisLabel} label="View" options={[`Accrual basis`, `Cash basis`]} onChange={setBasisLabel} /></div>} /><div className="chart-summary"><strong>{chart ? chart.revenue : `—`}</strong>{chart?.change ? <span className={chart.change.positive ? `trend-up` : `trend-down`}><C name={chart.change.positive ? `arrowUp` : `arrowDown`} size={13} />{chart.change.text}</span> : null}<em>total revenue</em></div><Cmp_ue months={chart?.months || []} /></E><E className="cash-card"><Cmp_re title="Cash flow" subtitle={figures?.period.label || period} /><div className="cash-total"><span>Net cash flow</span><strong>+$18,420.52</strong></div><div className="cash-bars">{[[`Jan`, 48, 31], [`Feb`, 58, 38], [`Mar`, 67, 44], [`Apr`, 73, 51], [`May`, 82, 55]].map(([label, incoming, outgoing]) => <div className="bar-group" key={label}><div className="bars"><i style={{
                height: `${incoming}%`
              }} /><i style={{
                height: `${outgoing}%`
              }} /></div><span>{label}</span></div>)}</div><div className="cash-legend"><span><i className="legend blue" />Cash in <b>$42,680</b></span><span><i className="legend light" />Cash out <b>$24,259</b></span></div></E></div>
<div className="dashboard-lower"><E className="transactions-card"><Cmp_re title="Recent transactions" subtitle="Your latest account activity" action={<button className="text-button" onClick={() => e(`Transactions`)}>View all <C name="chevron" size={14} /></button>} /><Cmp_fe compact={!0} /></E><div className="right-stack"><OutstandingInvoices clientId={session.client?.id} onOpen={() => e(`Invoices`)} /><UpcomingBills clientId={session.client?.id} onOpen={() => e(`Expenses`)} /></div></div><E className="quick-actions"><div><span className="sparkle"><C name="sparkle" /></span><span><b>Quick actions</b><small>Save time on everyday tasks</small></span></div><div className="quick-buttons"><Cmp_w variant="secondary" icon="invoice" onClick={() => t(`invoice`)}>Create invoice</Cmp_w><Cmp_w variant="secondary" icon="upload" onClick={() => t(`upload`)}>Upload receipt</Cmp_w><Cmp_w variant="secondary" icon="arrows" onClick={() => t(`expense`)}>Record expense</Cmp_w><Cmp_w variant="secondary" icon="chart" onClick={() => e(`Reports`)}>Run a report</Cmp_w></div></E></div>;
}

function Cmp_fe({
  compact: e = !1,
  rows: t = ce,
  selected: n = [],
  onToggle: r,
  onToggleAll: i,
  onOpen: a,
  sort: o,
  onSort: s
}) {
  let c = e ? t.slice(0, 4) : t;
  return <div className={e ? `transaction-list` : `table-wrap`}>{e ? c.map(e => <div className="transaction-row" key={e.name}><span className={`transaction-icon ${e.type}`}><C name={e.type === `income` ? `arrowDown` : `arrowUp`} size={16} /></span><span className="transaction-name"><b>{e.name}</b><small>{e.date} · {e.category}</small></span><strong className={e.type}>{e.amount}</strong></div>) : <table><thead><tr><th><input type="checkbox" aria-label="Select all" checked={c.length > 0 && c.every(e => n.includes(e.name))} onChange={i} /></th><th><button className={`sort-button ${o === `newest` || o === `oldest` ? `active` : ``}`} onClick={() => s?.(o === `newest` ? `oldest` : `newest`)}>Date<C name={o === `oldest` ? `arrowUp` : `arrowDown`} size={11} /></button></th><th>Description</th><th>Category</th><th>Account</th><th><button className={`sort-button ${o === `amount` ? `active` : ``}`} onClick={() => s?.(`amount`)}>Amount <C name="arrowDown" size={11} /></button></th><th>Status</th><th /></tr></thead><tbody>{c.map(e => <tr className={n.includes(e.name) ? `selected-row` : ``} onDoubleClick={() => a?.(e)} key={e.name}><td><input type="checkbox" aria-label={`Select ${e.name}`} checked={n.includes(e.name)} onChange={() => r?.(e.name)} /></td><td>{e.date}, 2025</td><td><div className="table-primary"><span className={`transaction-icon ${e.type}`}><C name={e.type === `income` ? `arrowDown` : `arrowUp`} size={15} /></span><span><b>{e.name}</b><small>{e.detail}</small></span></div></td><td><Cmp_ne>{e.category}</Cmp_ne></td><td>{e.account}</td><td><strong className={e.type}>{e.amount}</strong></td><td><Cmp_ne tone={e.status === `For review` ? `amber` : e.status === `Matched` ? `blue` : `green`}>{e.status}</Cmp_ne></td><td><button className="row-action" aria-label={`Open ${e.name} transaction`} onClick={() => a?.(e)}><C name="more" /></button></td></tr>)}</tbody></table>}</div>;
}
function InviteModal({
  onClose,
  onCreated
}) {
  let [name, setName] = (0, b.useState)(``),
    [email, setEmail] = (0, b.useState)(``),
    [role, setRole] = (0, b.useState)(`staff`),
    [password, setPassword] = (0, b.useState)(``),
    [error, setError] = (0, b.useState)(``),
    [pending, setPending] = (0, b.useState)(!1),
    ready = name.trim() && email.trim() && password.length >= 8 && !pending;
  async function save() {
    if (!ready) return;
    setPending(!0);
    setError(``);
    let response = await fetch(`/api/members`, {
      method: `POST`,
      headers: {
        "content-type": `application/json`
      },
      body: JSON.stringify({
        name,
        email,
        role,
        password
      })
    });
    let body = await response.json().catch(() => ({}));
    setPending(!1);
    if (!response.ok) {
      setError(body.error || `Could not invite that person.`);
      return;
    }
    onCreated(body);
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title" onMouseDown={event => event.stopPropagation()}><div className="modal-header"><div><h2 id="invite-title">Invite team member</h2><p>Create a sign-in for this firm. Nothing is emailed.</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><div className="form-grid"><label className="field full"><span>Name</span><input autoFocus={!0} value={name} onChange={event => setName(event.target.value)} /></label><label className="field full"><span>Email</span><input type="email" autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} /></label><label className="field full"><span>Role</span><select value={role} onChange={event => setRole(event.target.value)}><option value="staff">Staff</option><option value="manager">Manager</option></select></label><label className="field full"><span>Password</span><input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label></div>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="modal-footer"><Cmp_w variant="secondary" onClick={onClose}>Cancel</Cmp_w><Cmp_w disabled={!ready} onClick={save}>{pending ? `Saving…` : `Invite team member`}</Cmp_w></div></section></div>;
}
function Ce({
  name: e
}) {
  let {
      notify: n,
      session,
      onSession
    } = O(),
    [inviteOpen, setInviteOpen] = (0, b.useState)(!1),
    owner = session.user.role === `owner`;
  return <div className="page"><D title={e} subtitle={{
      Banking: `Connect accounts and keep every balance reconciled.`,
      Settings: `Manage your company, team, and accounting preferences.`
    }[e]} actions={<Cmp_w icon="plus" disabled={e === `Settings` && !owner} onClick={() => e === `Banking` ? n(`Secure bank connection flow opened`) : owner ? setInviteOpen(!0) : undefined}>{e === `Banking` ? `Connect account` : `Invite team member`}</Cmp_w>} /><E className="generic-card"><span className="round-icon blue"><C name={e === `Banking` ? `bank` : `settings`} size={26} /></span><h2>{e} workspace</h2><p>Your {e.toLowerCase()} tools are organized and ready to use.</p><div className="generic-grid">{[`Overview`, `Activity`, `Rules`].map((label, index) => <div key={label}><span><C name={[`grid`, `arrows`, `settings`][index]} /></span><b>{label}</b><small>View and manage {label.toLowerCase()}</small></div>)}</div></E>{e === `Settings` ? <E className="table-card team-card"><Cmp_re title="Team" subtitle={`People who can sign in to ${session.firm.name}.`} /><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>{session.members.map(member => <tr key={member.id}><td><strong>{member.name}</strong></td><td>{member.email}</td><td>{member.roleLabel}</td></tr>)}</tbody></table></E> : null}{e === `Settings` ? <ReceiptSetting session={session} onSession={onSession} /> : null}{inviteOpen ? <InviteModal onClose={() => setInviteOpen(!1)} onCreated={next => {
        setInviteOpen(!1);
        onSession(next);
      }} /> : null}</div>;
}

function Cmp_we({
  type: e,
  onClose: t,
  onSave: n
}) {
  let r = {
      transaction: {
        title: `Add transaction`,
        subtitle: `Record money in or money out`,
        action: `Save transaction`
      },
      invoice: {
        title: `Create invoice`,
        subtitle: `Bill a customer for products or services`,
        action: `Create draft`
      },
      expense: {
        title: `Record expense`,
        subtitle: `Add a business purchase to your books`,
        action: `Save expense`
      },
      upload: {
        title: `Upload receipt`,
        subtitle: `Attach source documents to a transaction`,
        action: `Upload document`
      }
    }[e],
    [i, a] = (0, b.useState)(``),
    [o, s] = (0, b.useState)(``),
    c = e === `upload` || i.trim() && o.trim();
  return <div className="modal-backdrop" role="presentation" onMouseDown={t}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="composer-title" onMouseDown={e => e.stopPropagation()}><div className="modal-header"><div><h2 id="composer-title">{r.title}</h2><p>{r.subtitle}</p></div><button className="modal-close" onClick={t} aria-label="Close">×</button></div>{e === `upload` ? <label className="upload-zone"><input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => s(e.target.files?.[0]?.name || ``)} /><span><C name="upload" /></span><b>{o || `Choose a receipt or drag it here`}</b><small>PDF, PNG, or JPG · up to 10 MB</small></label> : <div className="form-grid"><label className="field full"><span>{e === `invoice` ? `Customer` : e === `expense` ? `Merchant` : `Description`}</span><input autoFocus={!0} value={o} onChange={e => s(e.target.value)} placeholder={e === `invoice` ? `Select or enter customer` : `e.g. Office supplies`} /></label><label className="field"><span>Amount</span><div className="amount-input"><b>$</b><input inputMode="decimal" value={i} onChange={e => a(e.target.value)} placeholder="0.00" /></div></label><label className="field"><span>Date</span><input type="date" defaultValue="2025-05-24" /></label><label className="field full"><span>Category</span><select defaultValue=""><option value="" disabled={!0}>Select an accounting category</option><option>Sales income</option><option>Software & hosting</option><option>Office expenses</option><option>Professional services</option></select></label></div>}<div className="modal-footer"><Cmp_w variant="secondary" onClick={t}>Cancel</Cmp_w><Cmp_w disabled={!c} onClick={() => n(e === `upload` ? `Receipt uploaded and ready to match` : `${r.title} saved successfully`)}>{r.action}</Cmp_w></div></section></div>;
}
function Te({ session, onSession }) {
  let [e, t] = (0, b.useState)(`Dashboard`),
    [n, r] = (0, b.useState)(null),
    [i, a] = (0, b.useState)(``),
    [o, s] = (0, b.useState)(``),
    [c, l] = (0, b.useState)(!1),
    [u, d] = (0, b.useState)(!1),
    [f, p] = (0, b.useState)(!1),
    [transactionTab, setTransactionTab] = (0, b.useState)(`all`),
    [transactionPeriod, setTransactionPeriod] = (0, b.useState)(PERIODS[0]),
    [invoiceVersion, setInvoiceVersion] = (0, b.useState)(0),
    [expenseVersion, setExpenseVersion] = (0, b.useState)(0),
    m = e => {
      a(e), window.setTimeout(() => a(``), 3200);
    },
    h = (screen, extras = {}) => {
      setTransactionTab(extras.transactionTab || `all`);
      setTransactionPeriod(extras.transactionPeriod || PERIODS[0]);
      t(screen), window.scrollTo({
        top: 0,
        behavior: `smooth`
      });
    },
    signOut = async () => {
      await fetch(`/api/session`, {
        method: `DELETE`
      });
      onSession(null);
    },
    selectClient = async (id, options = {}) => {
      let lookup = await fetch(`/api/clients/${encodeURIComponent(id)}`);
      if (!lookup.ok) return !1;
      let response = await fetch(`/api/session`, {
        method: `PATCH`,
        headers: {
          "content-type": `application/json`
        },
        body: JSON.stringify({
          clientId: id
        })
      });
      if (!response.ok) return !1;
      onSession(await response.json());
      p(!1);
      if (options.navigateTo) h(options.navigateTo, {
        transactionTab: options.transactionTab,
        transactionPeriod: options.transactionPeriod
      });
      return !0;
    },
    g = o.trim() ? [[`Stripe Payments`, `Transaction · +$8,420.00`, `Transactions`], [`Profit & loss`, `Report · May 2025`, `Reports`]].filter(e => e.join(` `).toLowerCase().includes(o.toLowerCase())) : [],
    _ = e === `Dashboard` ? <Cmp_de /> : e === `Transactions` ? <Transactions key={`${session.client?.id}:${transactionTab}:${transactionPeriod}`} clientId={session.client?.id} initialTab={transactionTab} initialPeriod={transactionPeriod} /> : e === `Banking` ? <Banking key={session.client?.id} clientId={session.client?.id} /> : e === `Accounting` ? <Accounting key={session.client?.id} clientId={session.client?.id} /> : e === `Reports` ? <Reports key={session.client?.id} clientId={session.client?.id} /> : e === `Invoices` ? <Invoices key={`${session.client?.id}:${invoiceVersion}`} clientId={session.client?.id} onCreate={() => r(`invoice`)} /> : e === `Expenses` ? <Expenses key={`${session.client?.id}:${expenseVersion}`} clientId={session.client?.id} onCreate={() => r(`expense`)} /> : e === `Clients` ? <Clients selectedClientId={session.client?.id} onOpenClient={id => selectClient(id, { navigateTo: `Dashboard` })} onReview={client => selectClient(client.id, client.uncategorized > 0 ? { navigateTo: `Transactions`, transactionTab: `for_review`, transactionPeriod: `Custom range` } : { navigateTo: `Banking` })} onSession={onSession} /> : <Ce name={e} />;
  return <ie.Provider value={{
    navigate: h,
    notify: m,
    openComposer: r,
    session,
    onSession,
    selectClient,
    signOut
  }}><div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>Ledgerly</span></div><button className={`workspace-switcher ${f ? `open` : ``}`} onClick={() => p(!f)}><T initials={session.client.initials} color="blue" small={!0} /><div><b>{session.client.name}</b><small>Business account</small></div><span className="rotate-chevron"><C name="chevron" size={14} /></span></button>{f && <div className="workspace-menu"><span>Switch company</span>{session.clients.map(client => <button className={client.id === session.client.id ? `selected` : ``} onClick={() => selectClient(client.id)} key={client.id}><T initials={client.initials} color="blue" small={!0} /><span><b>{client.name}</b><small>{client.id === session.client.id ? `Current company` : `Business account`}</small></span>{client.id === session.client.id ? <C name="check" size={14} /> : null}</button>)}<button onClick={() => m(`Company creation flow opened`)}><span className="add-company"><C name="plus" size={14} /></span><span><b>Add another company</b><small>Set up a new set of books</small></span></button></div>}<nav><span className="nav-label">WORKSPACE</span>{te.slice(0, 7).map(([t, n]) => <button className={e === t ? `active` : ``} onClick={() => h(t)} key={t}><C name={n} /><span>{t}</span></button>)}<span className="nav-label manage">MANAGE</span>{te.slice(7).map(([t, n]) => <button className={e === t ? `active` : ``} onClick={() => h(t)} key={t}><C name={n} /><span>{t}</span></button>)}</nav><div className="advisor-card"><span><C name="sparkle" /></span><b>Meet your AI bookkeeper</b><p>Get insights and automate routine work.</p><button onClick={() => m(`Ledger AI assistant is coming soon`)}>Explore Ledger AI <C name="chevron" size={13} /></button></div><button className="sidebar-help" onClick={() => m(`Support center opened`)}><span className="help-icon">?</span><div><b>Need help?</b><small>Visit support center</small></div><C name="chevron" size={14} /></button></aside><main><header className="topbar"><div className="global-search"><C name="search" /><input value={o} onChange={e => s(e.target.value)} placeholder="Search transactions, invoices, reports…" /><kbd>⌘ K</kbd>{o && <div className="search-results"><span>Search results</span>{g.length ? g.map(([e, t, n]) => <button onClick={() => {
                h(n), s(``);
              }} key={e}><span className="search-result-icon"><C name={n === `Invoices` ? `invoice` : n === `Reports` ? `chart` : `arrows`} size={15} /></span><span><b>{e}</b><small>{t}</small></span><C name="chevron" size={13} /></button>) : <p>No results for “{o}”</p>}</div>}</div><div className="top-actions"><div className="top-menu-wrap"><button className={`notification ${c ? `active` : ``}`} onClick={() => {
                l(!c), d(!1);
              }} aria-label="Notifications"><C name="bell" /><i /></button>{c && <div className="top-menu notification-menu"><div className="menu-title"><b>Notifications</b><button onClick={() => m(`All notifications marked read`)}>Mark all read</button></div><button onClick={() => h(`Transactions`)}><span className="notice-dot amber" /><span><b>12 transactions need review</b><small>Business checking · 8 minutes ago</small></span></button><button onClick={() => h(`Banking`)}><span className="notice-dot blue" /><span><b>Bank reconciliation completed</b><small>Business checking · Yesterday</small></span></button></div>}</div><span className="divider" /><div className="top-menu-wrap"><button className={`profile ${u ? `active` : ``}`} onClick={() => {
                d(!u), l(!1);
              }}><T initials={session.user.name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase()} color="navy" /><span><b>{session.user.name}</b><small>{session.user.roleLabel}</small></span><C name="chevron" size={14} /></button>{u && <div className="top-menu profile-menu"><span>{session.user.email}</span><button onClick={() => h(`Settings`)}><C name="settings" size={15} />Company settings</button><button onClick={() => m(`Profile settings opened`)}><C name="users" size={15} />Personal profile</button><button onClick={signOut}>Sign out</button></div>}</div></div></header><div className="content">{_}</div></main></div>{n === `upload` ? <ReceiptModal clientName={session.client?.name} clientId={session.client?.id} onClose={() => r(null)} /> : n === `invoice` ? <InvoiceModal onClose={() => r(null)} onSaved={() => { r(null); setInvoiceVersion(version => version + 1); h(`Invoices`); }} /> : n === `expense` ? <ExpenseModal clientId={session.client?.id} onClose={() => r(null)} onSaved={() => { r(null); setExpenseVersion(version => version + 1); h(`Expenses`); }} /> : n ? <Cmp_we type={n} onClose={() => r(null)} onSave={e => {
      r(null), m(e);
    }} /> : null}{i && <div className="toast" role="status"><span><C name="check" size={15} /></span>{i}</div>}</ie.Provider>;
}

export { Te };
