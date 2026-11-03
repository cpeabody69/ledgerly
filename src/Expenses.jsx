import { useEffect, useState } from "react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function chip(iso) {
  const [, month, day] = String(iso || "").split("-");
  return { day: String(Number(day || 0)).padStart(2, "0"), month: MONTHS[Number(month) - 1] || "" };
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mediaTypeFor(file) {
  if (file.type === "text/plain" || file.type === "application/pdf" || file.type === "image/png" || file.type === "image/jpeg") return file.type;
  if (/\.txt$/i.test(file.name)) return "text/plain";
  if (/\.pdf$/i.test(file.name)) return "application/pdf";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  return "";
}

export function ExpenseModal({ clientId, onClose, onSaved }) {
  const today = todayInput();
  const [vendor, setVendor] = useState("");
  const [spentOn, setSpentOn] = useState(today);
  const [dueOn, setDueOn] = useState(addDays(today, 14));
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("bill");
  const [accountCode, setAccountCode] = useState("6400");
  const [accounts, setAccounts] = useState([]);
  const [files, setFiles] = useState([]);
  const [documentId, setDocumentId] = useState("");
  const [receiptFile, setReceiptFile] = useState(null);
  const [requireReceipt, setRequireReceipt] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = vendor.trim() && amount.trim() && spentOn && accountCode && (kind === "paid" || dueOn) && !pending;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/expenses").then(readJson),
      fetch(`/api/documents?clientId=${encodeURIComponent(clientId || "")}`).then(readJson),
    ]).then(([expenses, documents]) => {
      if (cancelled) return;
      const nextAccounts = expenses.accounts || [];
      setAccounts(nextAccounts);
      if (nextAccounts.length && !nextAccounts.some((account) => account.code === "6400")) setAccountCode(nextAccounts[0].code);
      setRequireReceipt(!!expenses.requireReceipt);
      setFiles(documents.files || []);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setError("");
    if (requireReceipt && !documentId && !receiptFile) {
      setError("Attach a receipt before posting this expense.");
      return;
    }
    setPending(true);
    let attachedId = documentId;
    if (receiptFile) {
      const mediaType = mediaTypeFor(receiptFile);
      if (!mediaType) {
        setPending(false);
        setError("Use a small text, PDF, or image file.");
        return;
      }
      const uploaded = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: receiptFile.name,
          mediaType,
          contentBase64: await fileBase64(receiptFile),
        }),
      });
      const uploadedBody = await readJson(uploaded);
      if (!uploaded.ok) {
        setPending(false);
        setError(uploadedBody.error || "The receipt was not stored.");
        return;
      }
      attachedId = uploadedBody.file.id;
    }
    const response = await fetch("/api/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vendor,
        spentOn,
        dueOn: kind === "bill" ? dueOn : "",
        amount,
        accountCode,
        kind,
        documentId: attachedId,
      }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The expense was not posted.");
      return;
    }
    onSaved(body.expense);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="expense-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="expense-title">Record expense</h2>
            <p>Saving posts the expense and the payable or the cash payment.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Vendor</span><input autoFocus value={vendor} onChange={(event) => setVendor(event.target.value)} /></label>
          <label className="field"><span>Date</span><input type="date" value={spentOn} onChange={(event) => setSpentOn(event.target.value)} required /></label>
          <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
          <fieldset className="field full">
            <legend>Posting</legend>
            <label><input type="radio" name="expense-kind" value="bill" checked={kind === "bill"} onChange={() => setKind("bill")} /> Bill, accounts payable</label>
            <label><input type="radio" name="expense-kind" value="paid" checked={kind === "paid"} onChange={() => setKind("paid")} /> Paid, cash</label>
          </fieldset>
          {kind === "bill" ? <label className="field"><span>Due date</span><input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} required /></label> : null}
          <label className="field full">
            <span>Expense account</span>
            <select value={accountCode} onChange={(event) => setAccountCode(event.target.value)}>
              {accounts.map((account) => <option value={account.code} key={account.code}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label className="field full">
            <span>Receipt on file</span>
            <select aria-label="Receipt on file" value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
              <option value="">Choose a stored file</option>
              {files.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}
            </select>
          </label>
          <label className="field full">
            <span>Or store a receipt</span>
            <input aria-label="Receipt file" type="file" accept=".txt,.pdf,.png,.jpg,.jpeg,text/plain,application/pdf,image/png,image/jpeg" onChange={(event) => setReceiptFile(event.target.files?.[0] || null)} />
          </label>
        </div>
        <p className="books-note">{requireReceipt ? "This firm requires a receipt before an expense can post." : "A receipt is optional for this firm."}</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Posting…" : "Save expense"}</Button>
        </div>
      </form>
    </div>
  );
}

export function UpcomingBills({ clientId, onOpen }) {
  const [expenses, setExpenses] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setExpenses(null);
    fetch("/api/expenses").then(async (response) => {
      const body = await readJson(response);
      if (!cancelled && response.ok) setExpenses(body.expenses || []);
    }).catch(() => {
      if (!cancelled) setExpenses([]);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const bills = (expenses || [])
    .filter((expense) => expense.kind === "bill")
    .slice()
    .sort((left, right) => (left.dueOn || left.spentOn).localeCompare(right.dueOn || right.spentOn))
    .slice(0, 4);

  return (
    <section className="card">
      <div className="card-header">
        <div><h2>Upcoming bills</h2></div>
        <button className="text-button" type="button" onClick={onOpen}>View all</button>
      </div>
      {expenses && !bills.length ? <p className="books-note">No bills are waiting.</p> : null}
      {bills.map((bill) => {
        const date = chip(bill.dueOn || bill.spentOn);
        return (
          <div className="bill-row" key={bill.id}>
            <span className="date-chip"><b>{date.day}</b>{date.month}</span>
            <span><b>{bill.vendor}</b><small>{bill.accountName}</small></span>
            <strong>{bill.amount}</strong>
          </div>
        );
      })}
    </section>
  );
}

export function ReceiptSetting({ session, onSession }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const owner = session.user.role === "owner";

  async function change(event) {
    const requireReceipt = event.target.checked;
    setPending(true);
    setError("");
    const response = await fetch("/api/firm", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireReceipt }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The setting was not saved.");
      return;
    }
    onSession({ ...session, firm: { ...session.firm, ...body.firm } });
  }

  return (
    <section className="card table-card">
      <div className="card-header">
        <div>
          <h2>Expense receipts</h2>
          <p>A firm setting. It is checked when an expense is posted.</p>
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={!!session.firm.requireReceipt} disabled={!owner || pending} onChange={change} />
        <span>Require a receipt before posting an expense</span>
      </label>
      <p className="books-note">{session.firm.requireReceipt ? "An expense without a stored receipt is refused and does not post." : "Posting is allowed without a receipt."}</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}

export function Expenses({ clientId, onCreate }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError("");
    fetch("/api/expenses").then(async (response) => {
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load expenses.");
        return;
      }
      setPayload(body);
    }).catch(() => {
      if (!cancelled) setError("Could not load expenses.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const expenses = payload?.expenses || [];
  const filtered = expenses.filter((expense) => {
    if (tab === "bill" && expense.kind !== "bill") return false;
    if (tab === "paid" && expense.kind !== "paid") return false;
    const haystack = [expense.vendor, expense.accountName, expense.amount, expense.receiptName, expense.reference].join(" ").toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const open = expenses.find((expense) => expense.id === openId) || null;
  const totals = payload?.totals;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Expenses</h1>
          <p>Bills and receipts for this client. Each saved expense is posted to the ledger.</p>
        </div>
        <div className="header-actions">
          <Button icon="plus" onClick={onCreate}>Add expense</Button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <p className="books-note">{payload?.requireReceipt ? "This firm requires a receipt before an expense can post." : "A receipt is optional for this firm."}</p>
      <div className="invoice-metrics">
        <section className="card"><span>Unpaid bills</span><strong>{totals ? totals.bills : "—"}</strong><small>{expenses.filter((expense) => expense.kind === "bill").length} open</small></section>
        <section className="card"><span>Paid expenses</span><strong>{totals ? totals.paid : "—"}</strong><small>{expenses.filter((expense) => expense.kind === "paid").length} posted to cash</small></section>
      </div>
      <section className="card table-card">
        <div className="toolbar">
          <div className="search-field">
            <Icon name="search" />
            <input aria-label="Search expenses" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search vendors…" />
          </div>
        </div>
        <div className="tab-bar">
          {[["all", "All", expenses.length], ["bill", "Bills", expenses.filter((expense) => expense.kind === "bill").length], ["paid", "Paid", expenses.filter((expense) => expense.kind === "paid").length]].map(([id, label, count]) => (
            <button className={tab === id ? "active" : ""} type="button" key={id} onClick={() => setTab(id)}>{label} <span>{count}</span></button>
          ))}
        </div>
        {payload && !filtered.length ? (
          <div className="empty-state">
            <b>{expenses.length ? "No matching expenses" : "No bills or payments yet"}</b>
            <p>{expenses.length ? "Try a different search." : "Save an expense to post it for this client."}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Vendor</th><th>Date</th><th>Account</th><th>Receipt</th><th>Type</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {filtered.map((expense) => (
                  <tr key={expense.id} onClick={() => setOpenId(expense.id)}>
                    <td><b>{expense.vendor}</b></td>
                    <td>{expense.spentOnLabel}</td>
                    <td>{expense.accountCode} {expense.accountName}</td>
                    <td>{expense.receiptName || "—"}</td>
                    <td>{expense.kindLabel}</td>
                    <td><strong>{expense.amount}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer"><span>Showing {filtered.length} of {expenses.length} expenses</span></div>
      </section>
      {open ? (
        <aside className="detail-drawer" aria-label={open.vendor}>
          <div className="drawer-header">
            <div>
              <h2>{open.vendor}</h2>
              <p>{open.reference} · {open.amount}</p>
            </div>
            <button className="modal-close" type="button" onClick={() => setOpenId(null)} aria-label="Close">×</button>
          </div>
          <div className="drawer-section">
            <h3>Ledger</h3>
            <dl>
              <div><dt>Vendor</dt><dd>{open.vendor}</dd></div>
              <div><dt>Amount</dt><dd>{open.amount}</dd></div>
              <div><dt>Posting</dt><dd>{open.kind === "bill" ? "Expense and accounts payable" : "Expense and cash"}</dd></div>
              <div><dt>Account</dt><dd>{open.accountCode} {open.accountName}</dd></div>
              <div><dt>Receipt</dt><dd>{open.receiptName || "None"}</dd></div>
              <div><dt>Ledger memo</dt><dd>{open.vendor}</dd></div>
            </dl>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
