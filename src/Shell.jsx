// Preserved Ledgerly shell from the published bundle.
// Sign-in, sign-out, the client switcher, and Settings invites talk to the API.
// Accounting reads this client's books. Dashboard, Transactions, Invoices, and Reports stay the published picture.
import { createContext, useContext, useMemo, useState } from "react";
import { Accounting } from "./Accounting.jsx";

const b = { createContext, useContext, useMemo, useState };

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
  return <E className="metric-card"><div className={`metric-icon ${a}`}><C name={i} /></div><div className="metric-label">{e}<C name="more" size={16} /></div><div className="metric-value">{t}</div><div className={`metric-change ${r ? `positive` : `negative`}`}><span><C name={r ? `arrowUp` : `arrowDown`} size={13} />{n}</span><em>vs last month</em></div></E>;
}
function Cmp_ue() {
  return <div className="revenue-chart"><div className="chart-y"><span>$60k</span><span>$40k</span><span>$20k</span><span>$0</span></div><svg viewBox="0 0 700 240" preserveAspectRatio="none" role="img" aria-label="Revenue versus expenses from January to June"><defs><linearGradient id="areaBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3976D2" stopOpacity=".22" /><stop offset="1" stopColor="#3976D2" stopOpacity="0" /></linearGradient></defs><g className="grid-lines"><path d="M0 20H700M0 87H700M0 154H700M0 220H700" /></g><path className="area" d="M0 180 C45 170 75 145 115 150 S190 115 235 125 S305 93 350 103 S430 65 470 78 S545 55 585 64 S655 33 700 44 V220 H0Z" /><path className="income-line" d="M0 180 C45 170 75 145 115 150 S190 115 235 125 S305 93 350 103 S430 65 470 78 S545 55 585 64 S655 33 700 44" /><path className="expense-line" d="M0 196 C50 188 72 177 115 182 S190 166 235 171 S310 148 350 159 S425 139 470 146 S550 120 585 130 S650 112 700 121" /><g className="dots"><circle cx="700" cy="44" r="5" /><circle className="expense-dot" cx="700" cy="121" r="5" /></g></svg><div className="chart-x"><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span></div></div>;
}
function Cmp_de() {
  let {
      navigate: e,
      openComposer: t,
      notify: n,
      session
    } = O(),
    [r, i] = (0, b.useState)(`May 1 – May 31`),
    [a, o] = (0, b.useState)(`Accrual basis`),
    s = {
      "May 1 – May 31": {
        revenue: `$84,240.00`,
        expenses: `$32,684.20`,
        income: `$51,555.80`,
        cash: `$128,430.62`,
        label: `May 2025`
      },
      "Apr 1 – Apr 30": {
        revenue: `$75,260.00`,
        expenses: `$32,880.00`,
        income: `$42,380.00`,
        cash: `$113,610.10`,
        label: `April 2025`
      },
      "Q2 2025": {
        revenue: `$159,500.00`,
        expenses: `$65,564.20`,
        income: `$93,935.80`,
        cash: `$128,430.62`,
        label: `Q2 2025`
      },
      "Year to date": {
        revenue: `$386,780.00`,
        expenses: `$164,920.44`,
        income: `$221,859.56`,
        cash: `$128,430.62`,
        label: `Year to date`
      },
      "Custom range": {
        revenue: `$84,240.00`,
        expenses: `$32,684.20`,
        income: `$51,555.80`,
        cash: `$128,430.62`,
        label: `Custom period`
      }
    }[r] || {
      revenue: `$84,240.00`,
      expenses: `$32,684.20`,
      income: `$51,555.80`,
      cash: `$128,430.62`,
      label: `May 2025`
    };
  return <div className="page"><D title={`Good morning, ${session.user.name.split(" ")[0]}`} subtitle={`Here’s how ${session.client.name} is performing this month.`} actions={<><Cmp_oe value={r} onChange={i} /><Cmp_w icon="plus" onClick={() => t(`transaction`)}>New transaction</Cmp_w></>} /><div className="metrics-grid"><Cmp_le label="Total revenue" value={s.revenue} change="12.5%" positive={!0} icon="arrowUp" accent="blue" /><Cmp_le label="Total expenses" value={s.expenses} change="4.2%" positive={!1} icon="arrowDown" accent="coral" /><Cmp_le label="Net income" value={s.income} change="18.3%" positive={!0} icon="chart" accent="green" /><Cmp_le label="Cash balance" value={s.cash} change="$14,820" positive={!0} icon="wallet" accent="purple" /></div><div className="dashboard-main"><E className="chart-card"><Cmp_re title="Revenue & expenses" subtitle="Financial performance over the last 6 months" action={<div className="chart-tools"><span><i className="legend blue" />Revenue</span><span><i className="legend gray" />Expenses</span><Cmp_ae value={a} label="View" options={[`Accrual basis`, `Cash basis`]} onChange={o} /></div>} /><div className="chart-summary"><strong>$246,780</strong><span className="trend-up"><C name="arrowUp" size={13} />14.6%</span><em>total revenue</em></div><Cmp_ue /></E><E className="cash-card"><Cmp_re title="Cash flow" subtitle={s.label} action={<button className="icon-button" aria-label="Download cash flow summary" onClick={() => n(`Cash flow summary downloaded`)}><C name="more" /></button>} /><div className="cash-total"><span>Net cash flow</span><strong>+$18,420.52</strong><Cmp_ne tone="green">+8.4%</Cmp_ne></div><div className="cash-bars">{[[`Jan`, 48, 31], [`Feb`, 58, 38], [`Mar`, 67, 44], [`Apr`, 73, 51], [`May`, 82, 55]].map(([e, t, n]) => <div className="bar-group" key={e}><div className="bars"><i style={{
                height: `${t}%`
              }} /><i style={{
                height: `${n}%`
              }} /></div><span>{e}</span></div>)}</div><div className="cash-legend"><span><i className="legend blue" />Cash in <b>$42,680</b></span><span><i className="legend light" />Cash out <b>$24,259</b></span></div></E></div><div className="dashboard-lower"><E className="transactions-card"><Cmp_re title="Recent transactions" subtitle="Your latest account activity" action={<button className="text-button" onClick={() => e(`Transactions`)}>View all <C name="chevron" size={14} /></button>} /><Cmp_fe compact={!0} /></E><div className="right-stack"><E><Cmp_re title="Outstanding invoices" action={<button className="text-button" onClick={() => e(`Invoices`)}>View all</button>} /><div className="invoice-total"><div><span>Total outstanding</span><strong>$18,740.00</strong></div><div className="invoice-ring"><span>72%</span></div></div><div className="mini-list"><div><T initials="AS" color="teal" small={!0} /><span><b>Acme Studio</b><small>Due May 28</small></span><strong>$6,800</strong></div><div><T initials="LM" color="purple" small={!0} /><span><b>Lucid Media</b><small>Overdue 4 days</small></span><strong className="danger">$4,250</strong></div></div></E><E><Cmp_re title="Upcoming bills" action={<button className="text-button" onClick={() => e(`Expenses`)}>View all</button>} /><div className="bill-row"><span className="date-chip"><b>28</b>May</span><span><b>Mercury Insurance</b><small>Insurance</small></span><strong>$1,240.00</strong></div><div className="bill-row"><span className="date-chip"><b>01</b>Jun</span><span><b>WeWork</b><small>Rent & lease</small></span><strong>$1,850.00</strong></div></E></div></div><E className="quick-actions"><div><span className="sparkle"><C name="sparkle" /></span><span><b>Quick actions</b><small>Save time on everyday tasks</small></span></div><div className="quick-buttons"><Cmp_w variant="secondary" icon="invoice" onClick={() => t(`invoice`)}>Create invoice</Cmp_w><Cmp_w variant="secondary" icon="upload" onClick={() => t(`upload`)}>Upload receipt</Cmp_w><Cmp_w variant="secondary" icon="arrows" onClick={() => t(`expense`)}>Record expense</Cmp_w><Cmp_w variant="secondary" icon="chart" onClick={() => e(`Reports`)}>Run a report</Cmp_w></div></E></div>;
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
function Cmp_pe() {
  let {
      openComposer: e,
      notify: t
    } = O(),
    [n, r] = (0, b.useState)(``),
    [i, a] = (0, b.useState)(`All`),
    [o, s] = (0, b.useState)(`May 1 – May 31`),
    [c, l] = (0, b.useState)(`All statuses`),
    [u, d] = (0, b.useState)([]),
    [f, p] = (0, b.useState)(`newest`),
    [m, h] = (0, b.useState)(1),
    [g, _] = (0, b.useState)(null),
    v = (0, b.useMemo)(() => ce.filter(e => {
      let t = [e.name, e.detail, e.category, e.account, e.amount].join(` `).toLowerCase().includes(n.toLowerCase()),
        r = i === `All` || i === `Income` && e.type === `income` || i === `Expenses` && e.type === `expense` || i === `For review` && e.status === `For review`,
        a = c === `All statuses` || e.status === c;
      return t && r && a && o !== `Apr 1 – Apr 30`;
    }).sort((e, t) => {
      if (f === `oldest`) return e.date.localeCompare(t.date);
      if (f === `amount`) {
        let n = e => Number(e.replace(/[^0-9.]/g, ``));
        return n(t.amount) - n(e.amount);
      }
      return t.date.localeCompare(e.date);
    }), [o, n, f, c, i]),
    y = Math.max(1, Math.ceil(v.length / 6)),
    ee = v.slice((m - 1) * 6, m * 6);
  return <div className="page"><D title="Transactions" subtitle="Review, categorize, and reconcile all your business activity." actions={<><Cmp_w variant="secondary" icon="upload" onClick={() => t(`Import template ready — choose a CSV file`)}>Import</Cmp_w><Cmp_w icon="plus" onClick={() => e(`transaction`)}>Add transaction</Cmp_w></>} /><div className="summary-strip"><div><span>All transactions</span><strong>248</strong></div><div><span>For review</span><strong className="amber-text">12</strong></div><div><span>Uncategorized</span><strong>8</strong></div><div><span>Matched</span><strong className="green-text">186</strong></div></div><E className="table-card"><div className="toolbar"><div className="search-field"><C name="search" /><input value={n} onChange={e => {
            r(e.target.value), h(1);
          }} placeholder="Search by description, amount, or category…" /></div><Cmp_oe value={o} onChange={e => {
          s(e), h(1);
        }} /><Cmp_ae icon="filter" value={c} label={c} options={[`All statuses`, `Categorized`, `For review`]} onChange={e => {
          l(e), h(1);
        }} /></div><div className="tab-bar">{[`All`, `For review`, `Income`, `Expenses`].map(e => <button className={i === e ? `active` : ``} onClick={() => {
          a(e), h(1);
        }} key={e}>{e}{e === `All` && <span>248</span>}{e === `For review` && <span>12</span>}</button>)}</div>{u.length > 0 && <div className="bulk-bar"><b>{u.length} selected</b><button onClick={() => t(`${u.length} transactions categorized`)}>Categorize</button><button onClick={() => t(`${u.length} transactions excluded`)}>Exclude</button><button onClick={() => d([])}>Clear</button></div>}{v.length ? <Cmp_fe rows={ee} selected={u} onToggle={e => d(t => t.includes(e) ? t.filter(t => t !== e) : [...t, e])} onToggleAll={() => d(e => v.every(t => e.includes(t.name)) ? e.filter(e => !v.some(t => t.name === e)) : [...new Set([...e, ...v.map(e => e.name)])])} onOpen={_} sort={f} onSort={p} /> : <Cmp_se title="No transactions found" detail="Try a different search term, status, or transaction type." />}<div className="table-footer"><span>Showing {v.length ? (m - 1) * 6 + 1 : 0}–{Math.min(m * 6, v.length)} of {v.length} matching transactions · {o}</span><div><Cmp_w variant="secondary" disabled={m === 1} onClick={() => h(e => e - 1)}>Previous</Cmp_w><span className="page-count">Page {m} of {y}</span><Cmp_w variant="secondary" disabled={m >= y} onClick={() => h(e => e + 1)}>Next</Cmp_w></div></div></E>{g && <Cmp_me transaction={g} onClose={() => _(null)} onUpdate={e => {
      _(null), t(e);
    }} />}</div>;
}
function Cmp_me({
  transaction: e,
  onClose: t,
  onUpdate: n
}) {
  let [r, i] = (0, b.useState)(e.category),
    [a, o] = (0, b.useState)(``);
  return <div className="drawer-scrim" onMouseDown={t}><aside className="detail-drawer" aria-label={`${e.name} transaction details`} onMouseDown={e => e.stopPropagation()}><div className="drawer-header"><div><Cmp_ne tone={e.status === `For review` ? `amber` : `green`}>{e.status}</Cmp_ne><h2>{e.name}</h2><p>{e.detail}</p></div><button className="modal-close" onClick={t} aria-label="Close">×</button></div><div className="transaction-amount-block"><span>{e.type === `income` ? `Money in` : `Money out`}</span><strong className={e.type}>{e.amount}</strong><small>{e.date}, 2025</small></div><div className="drawer-section"><h3>Bank details</h3><dl><div><dt>Account</dt><dd>{e.bankDetail}</dd></div><div><dt>Statement description</dt><dd>{e.name.toUpperCase()}</dd></div><div><dt>Reference</dt><dd>TXN-{e.date.replace(/\D/g, ``)}-0482</dd></div></dl></div><div className="drawer-section"><h3>Accounting treatment</h3><label className="field"><span>Category</span><select value={r} onChange={e => i(e.target.value)}><option>Sales income</option><option>Consulting income</option><option>Software & hosting</option><option>Rent & lease</option><option>Payroll expense</option><option>Travel</option><option>Interest income</option></select></label><label className="field"><span>Internal note</span><textarea value={a} onChange={e => o(e.target.value)} placeholder="Add context for your accountant…" /></label></div><div className="reconciliation-callout"><span><C name="check" size={15} /></span><div><b>Bank feed verified</b><small>Imported from {e.bankDetail}</small></div></div><div className="drawer-footer"><Cmp_w variant="secondary" onClick={() => n(`Transaction excluded from reports`)}>Exclude</Cmp_w><Cmp_w onClick={() => n(`${e.name} saved to ${r}${a ? ` with note` : ``}`)}>Save changes</Cmp_w></div></aside></div>;
}
var ve = [[`Revenue`, ``, ``, ``], [`Sales revenue`, `$76,240`, `$68,510`, `+11.3%`], [`Consulting income`, `$8,000`, `$6,750`, `+18.5%`], [`Total revenue`, `$84,240`, `$75,260`, `+11.9%`], [`Cost of goods sold`, ``, ``, ``], [`Contractor costs`, `$8,420`, `$7,840`, `+7.4%`], [`Hosting & infrastructure`, `$4,260`, `$3,980`, `+7.0%`], [`Gross profit`, `$71,560`, `$63,440`, `+12.8%`], [`Operating expenses`, ``, ``, ``], [`Payroll`, `$12,569`, `$11,840`, `+6.2%`], [`Rent & lease`, `$3,700`, `$3,700`, `0.0%`], [`Software & subscriptions`, `$2,985`, `$2,620`, `+13.9%`], [`Marketing & advertising`, `$4,750`, `$5,110`, `−7.0%`], [`Net operating income`, `$51,556`, `$42,380`, `+21.7%`]];
function Cmp_ye() {
  let {
      notify: e,
      session
    } = O(),
    [t, n] = (0, b.useState)(`Profit & loss`),
    [r, i] = (0, b.useState)(`May 1 – May 31`),
    [a, o] = (0, b.useState)(`Monthly`);
  return <div className="page"><D title="Reports" subtitle="Analyze performance and make informed financial decisions." actions={<><Cmp_w variant="secondary" icon="download" onClick={() => e(`${t} exported as PDF`)}>Export</Cmp_w><Cmp_w variant="secondary" icon="send" onClick={() => e(`Secure sharing link copied for ${t}`)}>Share</Cmp_w></>} /><div className="report-layout"><aside className="report-menu"><span>Financial statements</span>{[`Profit & loss`, `Balance sheet`, `Cash flow statement`].map((e, r) => <button className={t === e ? `active` : ``} onClick={() => n(e)} key={e}><C name={[`chart`, `book`, `arrows`][r]} /><div><b>{e}</b><small>{[`Income and expenses`, `Assets and liabilities`, `Cash movement`][r]}</small></div><C name="chevron" size={15} /></button>)}<span>Management reports</span>{[`Budget vs. actuals`, `Accounts receivable`, `Expense summary`].map(e => <button onClick={() => n(e)} key={e}><C name="file" /><div><b>{e}</b><small>View detailed report</small></div></button>)}</aside><E className="report-sheet"><div className="report-top"><div><span className="report-logo">L</span><div><h2>{session.client.legalName}</h2><p>{t}</p></div></div><div className="report-filters"><Cmp_oe value={r} onChange={i} /><Cmp_ae value={a} options={[`Monthly`, `Quarterly`, `Yearly`]} onChange={t => {
              o(t), e(`Report grouped ${t.toLowerCase()}`);
            }} /></div></div><div className="report-title"><h1>{t}</h1><p>For the month ended May 31, 2025 · Accrual basis</p></div><table className="statement"><thead><tr><th>Account</th><th>May 2025</th><th>Apr 2025</th><th>Change</th></tr></thead><tbody>{ve.map((e, t) => <tr className={e[1] === `` ? `section-row` : e[0].startsWith(`Total`) || e[0].includes(`profit`) || e[0].includes(`income`) ? `total-row` : ``} key={`${e[0]}-${t}`}><td>{e[0]}</td><td>{e[1]}</td><td>{e[2]}</td><td className={e[3].startsWith(`+`) ? `positive` : ``}>{e[3]}</td></tr>)}</tbody></table><div className="report-note"><C name="check" size={16} /><span>Books are reconciled through May 24, 2025</span><em>Generated May 24 at 10:42 AM</em></div></E></div></div>;
}
var be = [[`INV-1084`, `Acme Studio LLC`, `AS`, `May 14, 2025`, `May 28, 2025`, `$6,800.00`, `Due soon`, `amber`], [`INV-1083`, `Lucid Media Co.`, `LM`, `May 02, 2025`, `May 20, 2025`, `$4,250.00`, `Overdue`, `red`], [`INV-1082`, `Brightline Labs`, `BL`, `Apr 28, 2025`, `May 28, 2025`, `$3,840.00`, `Sent`, `blue`], [`INV-1081`, `Mason & Finch`, `MF`, `Apr 20, 2025`, `May 20, 2025`, `$7,200.00`, `Paid`, `green`], [`INV-1080`, `Orbit Systems`, `OS`, `Apr 14, 2025`, `May 14, 2025`, `$3,850.00`, `Paid`, `green`]];
function Cmp_xe() {
  let {
      openComposer: e,
      notify: t
    } = O(),
    [n, r] = (0, b.useState)(``),
    [i, a] = (0, b.useState)(`All invoices`),
    [o, s] = (0, b.useState)(`All statuses`),
    [c, l] = (0, b.useState)(`May 1 – May 31`),
    u = be.filter(e => {
      let t = `${e[0]} ${e[1]} ${e[5]}`.toLowerCase().includes(n.toLowerCase()),
        r = i === `All invoices` || i === `Paid` && e[6] === `Paid` || i === `Outstanding` && e[6] !== `Paid` || i === `Draft` && e[6] === `Draft`,
        a = o === `All statuses` || e[6].toLowerCase() === o.toLowerCase(),
        s = c === `May 1 – May 31` ? e[3].startsWith(`May`) : c === `Apr 1 – Apr 30` ? e[3].startsWith(`Apr`) : !0;
      return t && r && a && s;
    });
  return <div className="page"><D title="Invoices" subtitle="Create invoices, track payments, and manage your customers." actions={<Cmp_w icon="plus" onClick={() => e(`invoice`)}>Create invoice</Cmp_w>} /><div className="invoice-metrics"><E><span>Outstanding</span><strong>$18,740.00</strong><small>5 open invoices</small><i className="metric-line blue-line" /></E><E><span>Overdue</span><strong>$4,250.00</strong><small>1 invoice · 4 days</small><i className="metric-line red-line" /></E><E><span>Paid this month</span><strong>$24,680.00</strong><small className="green-text">↑ 12.4% from April</small><i className="metric-line green-line" /></E><E><span>Average time to pay</span><strong>12 days</strong><small>2 days faster than April</small><i className="metric-line purple-line" /></E></div><E className="table-card"><div className="toolbar"><div className="search-field"><C name="search" /><input value={n} onChange={e => r(e.target.value)} placeholder="Search invoices or customers…" /></div><Cmp_ae icon="filter" value={o} options={[`All statuses`, `Paid`, `Sent`, `Due soon`, `Overdue`]} onChange={s} /><Cmp_oe value={c} onChange={l} /></div><div className="tab-bar">{[[`All invoices`, `42`], [`Draft`, `3`], [`Outstanding`, `5`], [`Paid`, `34`]].map(([e, t]) => <button className={i === e ? `active` : ``} onClick={() => a(e)} key={e}>{e} <span>{t}</span></button>)}</div>{u.length ? <table><thead><tr><th>Invoice</th><th>Customer</th><th>Issue date</th><th>Due date</th><th>Amount</th><th>Status</th><th /></tr></thead><tbody>{u.map((e, n) => <tr key={e[0]}><td><strong className="link">{e[0]}</strong></td><td><div className="customer"><T initials={e[2]} color={[`teal`, `purple`, `blue`, `amber`, `coral`][n]} small={!0} /><strong>{e[1]}</strong></div></td><td>{e[3]}</td><td>{e[4]}</td><td><strong>{e[5]}</strong></td><td><Cmp_ne tone={e[7]}>{e[6]}</Cmp_ne></td><td><button className="row-action" aria-label={`Open ${e[0]}`} onClick={() => t(`${e[0]} invoice preview opened`)}><C name="more" /></button></td></tr>)}</tbody></table> : <Cmp_se title="No invoices found" detail="Try changing the customer search, status, or date range." />}<div className="table-footer"><span>Showing {u.length} of 42 invoices · {c}</span><div><Cmp_w variant="secondary" disabled={!0} onClick={() => t(`You are on the first invoice page`)}>Previous</Cmp_w><Cmp_w variant="secondary" onClick={() => t(`Loaded the next invoice page`)}>Next</Cmp_w></div></div></E></div>;
}
// Published clients-screen wording. These amounts are not ledger balances and are not stored.
var preservedClientChrome = {
  "Northstar Creative": {
    revenue: `$84.2k`,
    income: `$51.6k`,
    updated: `May 24`,
    status: `Healthy`,
    tone: `green`
  },
  "Haven Coffee Roasters": {
    revenue: `$128.6k`,
    income: `$22.4k`,
    updated: `May 23`,
    status: `Review`,
    tone: `amber`
  },
  "Brightline Labs": {
    revenue: `$64.8k`,
    income: `$18.2k`,
    updated: `May 24`,
    status: `Healthy`,
    tone: `green`
  },
  "Mason & Finch": {
    revenue: `$42.1k`,
    income: `$9.7k`,
    updated: `May 20`,
    status: `Needs attention`,
    tone: `red`
  }
};
function Se() {
  let {
      notify: e,
      session,
      selectClient
    } = O(),
    names = new Set(session.clients.map(client => client.name)),
    colors = [`blue`, `amber`, `teal`, `purple`, `coral`, `navy`];
  return <div className="page"><D eyebrow="CPA PORTAL" title="Client workspace" subtitle="Monitor every client’s books, requests, and review status in one place." actions={<><Cmp_w variant="secondary" icon="upload" onClick={() => e(`New document request opened`)}>Request documents</Cmp_w><Cmp_w icon="plus" onClick={() => e(`Client onboarding opened`)}>Add client</Cmp_w></>} /><div className="portal-banner"><div><span className="round-icon inverse"><C name="building" /></span><div><h2>Your firm at a glance</h2><p>Four client books are ready for review. Two need your attention this week.</p></div></div><div className="portal-stats"><span><b>18</b>Active clients</span><span><b>4</b>Ready to review</span><span><b>7</b>Open requests</span></div></div><div className="client-layout"><E className="client-table"><Cmp_re title="Client accounts" subtitle="Financial snapshots for May 2025" action={<div className="search-mini"><C name="search" /><input placeholder="Search clients" /></div>} /><table><thead><tr><th>Client</th><th>Revenue</th><th>Net income</th><th>Books updated</th><th>Status</th><th /></tr></thead><tbody>{session.clients.map((client, t) => {
            let chrome = preservedClientChrome[client.name];
            return <tr key={client.id} onClick={() => selectClient(client.id, {
              navigateTo: `Dashboard`
            })}><td><div className="customer"><T initials={client.initials} color={colors[t % colors.length]} /><span><b>{client.name}</b><small>{client.industry}</small></span></div></td><td><strong>{chrome ? chrome.revenue : `—`}</strong></td><td>{chrome ? chrome.income : `—`}</td><td>{chrome ? chrome.updated : `—`}</td><td>{chrome ? <Cmp_ne tone={chrome.tone}>{chrome.status}</Cmp_ne> : `—`}</td><td><C name="chevron" size={15} /></td></tr>;
          })}</tbody></table></E><div className="portal-side"><E><Cmp_re title="Document requests" action={<button className="text-button">View all</button>} />{names.has(`Haven Coffee Roasters`) ? <div className="request-row"><span className="file-icon"><C name="file" /></span><span><b>May bank statements</b><small>Haven Coffee · Due tomorrow</small></span><Cmp_ne tone="amber">Pending</Cmp_ne></div> : null}{names.has(`Mason & Finch`) ? <div className="request-row"><span className="file-icon"><C name="file" /></span><span><b>Contractor W-9 forms</b><small>Mason & Finch · Due May 30</small></span><Cmp_ne tone="blue">2 of 4</Cmp_ne></div> : null}{names.has(`Brightline Labs`) ? <div className="request-row"><span className="file-icon green"><C name="check" /></span><span><b>Credit card receipts</b><small>Brightline Labs · Received</small></span><Cmp_ne tone="green">Complete</Cmp_ne></div> : null}<Cmp_w variant="secondary" icon="plus" onClick={() => e(`New document request opened`)}>New document request</Cmp_w></E><E><Cmp_re title="Review queue" action={<Cmp_ne tone="blue">4 ready</Cmp_ne>} />{names.has(`Northstar Creative`) ? <div className="review-row"><T initials="NC" color="blue" small={!0} /><span><b>Northstar Creative</b><small>May monthly close</small></span><Cmp_w variant="secondary" onClick={() => e(`Northstar monthly close opened`)}>Review</Cmp_w></div> : null}{names.has(`Brightline Labs`) ? <div className="review-row"><T initials="BL" color="teal" small={!0} /><span><b>Brightline Labs</b><small>8 items flagged</small></span><Cmp_w variant="secondary" onClick={() => e(`Brightline review queue opened`)}>Review</Cmp_w></div> : null}</E></div></div></div>;
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
      openComposer: t,
      notify: n,
      session,
      onSession
    } = O(),
    [inviteOpen, setInviteOpen] = (0, b.useState)(!1),
    owner = session.user.role === `owner`;
  return <div className="page"><D title={e} subtitle={{
      Banking: `Connect accounts and keep every balance reconciled.`,
      Expenses: `Track spending, receipts, and vendor payments.`,
      Settings: `Manage your company, team, and accounting preferences.`
    }[e]} actions={<Cmp_w icon="plus" disabled={e === `Settings` && !owner} onClick={() => e === `Expenses` ? t(`expense`) : e === `Banking` ? n(`Secure bank connection flow opened`) : owner ? setInviteOpen(!0) : undefined}>{e === `Banking` ? `Connect account` : e === `Expenses` ? `Add expense` : `Invite team member`}</Cmp_w>} /><E className="generic-card"><span className="round-icon blue"><C name={e === `Banking` ? `bank` : e === `Expenses` ? `card` : `settings`} size={26} /></span><h2>{e} workspace</h2><p>Your {e.toLowerCase()} tools are organized and ready to use.</p><div className="generic-grid">{[`Overview`, `Activity`, `Rules`].map((label, index) => <div key={label}><span><C name={[`grid`, `arrows`, `settings`][index]} /></span><b>{label}</b><small>View and manage {label.toLowerCase()}</small></div>)}</div></E>{e === `Settings` ? <E className="table-card team-card"><Cmp_re title="Team" subtitle={`People who can sign in to ${session.firm.name}.`} /><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>{session.members.map(member => <tr key={member.id}><td><strong>{member.name}</strong></td><td>{member.email}</td><td>{member.roleLabel}</td></tr>)}</tbody></table></E> : null}{inviteOpen ? <InviteModal onClose={() => setInviteOpen(!1)} onCreated={next => {
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
    m = e => {
      a(e), window.setTimeout(() => a(``), 3200);
    },
    h = e => {
      t(e), window.scrollTo({
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
      if (options.navigateTo) h(options.navigateTo);
      return !0;
    },
    g = o.trim() ? [[`Stripe Payments`, `Transaction · +$8,420.00`, `Transactions`], [`INV-1084 · Acme Studio`, `Invoice · $6,800.00`, `Invoices`], [`Profit & loss`, `Report · May 2025`, `Reports`]].filter(e => e.join(` `).toLowerCase().includes(o.toLowerCase())) : [],
    _ = e === `Dashboard` ? <Cmp_de /> : e === `Transactions` ? <Cmp_pe /> : e === `Accounting` ? <Accounting key={session.client?.id} clientId={session.client?.id} /> : e === `Reports` ? <Cmp_ye /> : e === `Invoices` ? <Cmp_xe /> : e === `Clients` ? <Se /> : <Ce name={e} />;
  return <ie.Provider value={{
    navigate: h,
    notify: m,
    openComposer: r,
    session,
    onSession,
    selectClient,
    signOut
  }}><div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>Ledgerly</span></div><button className={`workspace-switcher ${f ? `open` : ``}`} onClick={() => p(!f)}><T initials={session.client.initials} color="blue" small={!0} /><div><b>{session.client.name}</b><small>Business account</small></div><span className="rotate-chevron"><C name="chevron" size={14} /></span></button>{f && <div className="workspace-menu"><span>Switch company</span>{session.clients.map(client => <button className={client.id === session.client.id ? `selected` : ``} onClick={() => selectClient(client.id)} key={client.id}><T initials={client.initials} color="blue" small={!0} /><span><b>{client.name}</b><small>{client.id === session.client.id ? `Current company` : `Business account`}</small></span>{client.id === session.client.id ? <C name="check" size={14} /> : null}</button>)}<button onClick={() => m(`Company creation flow opened`)}><span className="add-company"><C name="plus" size={14} /></span><span><b>Add another company</b><small>Set up a new set of books</small></span></button></div>}<nav><span className="nav-label">WORKSPACE</span>{te.slice(0, 7).map(([t, n]) => <button className={e === t ? `active` : ``} onClick={() => h(t)} key={t}><C name={n} /><span>{t}</span>{t === `Transactions` && <em>12</em>}</button>)}<span className="nav-label manage">MANAGE</span>{te.slice(7).map(([t, n]) => <button className={e === t ? `active` : ``} onClick={() => h(t)} key={t}><C name={n} /><span>{t}</span></button>)}</nav><div className="advisor-card"><span><C name="sparkle" /></span><b>Meet your AI bookkeeper</b><p>Get insights and automate routine work.</p><button onClick={() => m(`Ledger AI assistant is coming soon`)}>Explore Ledger AI <C name="chevron" size={13} /></button></div><button className="sidebar-help" onClick={() => m(`Support center opened`)}><span className="help-icon">?</span><div><b>Need help?</b><small>Visit support center</small></div><C name="chevron" size={14} /></button></aside><main><header className="topbar"><div className="global-search"><C name="search" /><input value={o} onChange={e => s(e.target.value)} placeholder="Search transactions, invoices, reports…" /><kbd>⌘ K</kbd>{o && <div className="search-results"><span>Search results</span>{g.length ? g.map(([e, t, n]) => <button onClick={() => {
                h(n), s(``);
              }} key={e}><span className="search-result-icon"><C name={n === `Invoices` ? `invoice` : n === `Reports` ? `chart` : `arrows`} size={15} /></span><span><b>{e}</b><small>{t}</small></span><C name="chevron" size={13} /></button>) : <p>No results for “{o}”</p>}</div>}</div><div className="top-actions"><div className="top-menu-wrap"><button className={`notification ${c ? `active` : ``}`} onClick={() => {
                l(!c), d(!1);
              }} aria-label="Notifications"><C name="bell" /><i /></button>{c && <div className="top-menu notification-menu"><div className="menu-title"><b>Notifications</b><button onClick={() => m(`All notifications marked read`)}>Mark all read</button></div><button onClick={() => h(`Transactions`)}><span className="notice-dot amber" /><span><b>12 transactions need review</b><small>Business checking · 8 minutes ago</small></span></button><button onClick={() => h(`Invoices`)}><span className="notice-dot red" /><span><b>Invoice INV-1083 is overdue</b><small>Lucid Media · 4 days overdue</small></span></button><button onClick={() => h(`Banking`)}><span className="notice-dot blue" /><span><b>Bank reconciliation completed</b><small>Business checking · Yesterday</small></span></button></div>}</div><span className="divider" /><div className="top-menu-wrap"><button className={`profile ${u ? `active` : ``}`} onClick={() => {
                d(!u), l(!1);
              }}><T initials={session.user.name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase()} color="navy" /><span><b>{session.user.name}</b><small>{session.user.roleLabel}</small></span><C name="chevron" size={14} /></button>{u && <div className="top-menu profile-menu"><span>{session.user.email}</span><button onClick={() => h(`Settings`)}><C name="settings" size={15} />Company settings</button><button onClick={() => m(`Profile settings opened`)}><C name="users" size={15} />Personal profile</button><button onClick={signOut}>Sign out</button></div>}</div></div></header><div className="content">{_}</div></main></div>{n && <Cmp_we type={n} onClose={() => r(null)} onSave={e => {
      r(null), m(e);
    }} />}{i && <div className="toast" role="status"><span><C name="check" size={15} /></span>{i}</div>}</ie.Provider>;
}

export { Te };
