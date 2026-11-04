import { useEffect, useState } from "react";

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

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function badgeTone(status) {
  if (status === "posted" || status === "recorded") return "green";
  if (status === "approved") return "blue";
  if (status === "awaiting_approval") return "amber";
  if (status === "rejected" || status === "void") return "red";
  return "neutral";
}

const TABS = [
  ["dashboard", "Dashboard"],
  ["bills", "Bills"],
  ["vendors", "Vendors"],
  ["approvals", "Approvals"],
  ["payments", "Payments"],
  ["aging", "Aging"],
];

export function Payables({ clientId }) {
  const [section, setSection] = useState("dashboard");
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [vendorId, setVendorId] = useState(null);
  const [billId, setBillId] = useState(null);
  const [creating, setCreating] = useState("");

  function load() {
    return fetch("/api/payables").then(async (response) => {
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "Could not load accounts payable.");
      setPayload(body);
      setError("");
      return body;
    }).catch((reason) => {
      setError(reason.message || "Could not load accounts payable.");
    });
  }

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setVendorId(null);
    setBillId(null);
    setCreating("");
    fetch("/api/payables").then(async (response) => {
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load accounts payable.");
        return;
      }
      setPayload(body);
    }).catch(() => {
      if (!cancelled) setError("Could not load accounts payable.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const vendors = payload?.vendors || [];
  const bills = payload?.bills || [];
  const dashboard = payload?.dashboard;
  const needle = query.trim().toLowerCase();
  const visibleBills = bills.filter((bill) => [bill.vendorName, bill.invoiceNumber, bill.statusLabel, bill.total].join(" ").toLowerCase().includes(needle));
  const visibleVendors = vendors.filter((vendor) => [vendor.name, vendor.email, vendor.contactName, vendor.terms].join(" ").toLowerCase().includes(needle));
  const openVendor = vendors.find((vendor) => vendor.id === vendorId) || null;
  const openBill = bills.find((bill) => bill.id === billId) || null;

  return (
    <div className="page payables-page">
      <div className="page-header">
        <div>
          <h1>Accounts Payable</h1>
          <p>Vendors and bills for this client. A bill stays off the trial balance until it is posted.</p>
        </div>
        <div className="header-actions">
          {section === "vendors" ? <Button icon="plus" onClick={() => { setCreating("vendor"); setVendorId(null); }}>New vendor</Button> : null}
          {section === "bills" ? <Button icon="plus" onClick={() => { setCreating("bill"); setBillId(null); }} disabled={!vendors.length}>New bill</Button> : null}
          {section === "payments" ? <Button icon="plus" onClick={() => setCreating("payment")} disabled={!bills.some((bill) => bill.openCents > 0)}>Record payment</Button> : null}
          {section === "aging" ? <a className="button secondary" href="/api/payables/aging.csv">Download CSV</a> : null}
        </div>
      </div>
      <div className="tab-bar" role="tablist" aria-label="Accounts payable">
        {TABS.map(([id, label]) => (
          <button className={section === id ? "active" : ""} type="button" role="tab" aria-selected={section === id} key={id} onClick={() => { setSection(id); setBillId(null); setVendorId(null); setCreating(""); }}>{label}</button>
        ))}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {section === "dashboard" ? <Dashboard dashboard={dashboard} bills={bills} onOpen={(id) => { setBillId(id); setSection("bills"); }} /> : null}
      {section === "bills" ? (
          <BillList bills={visibleBills} total={bills.length} query={query} onQuery={setQuery} onOpen={(id) => { setVendorId(null); setBillId(id); }} />
      ) : null}
      {section === "vendors" ? (
        <VendorList vendors={visibleVendors} total={vendors.length} query={query} onQuery={setQuery} onOpen={(id) => { setBillId(null); setVendorId(id); }} />
      ) : null}
      {section === "approvals" ? (
        <ApprovalList bills={bills.filter((bill) => bill.status === "awaiting_approval" || bill.status === "approved" || bill.status === "rejected")} onOpen={(id) => { setVendorId(null); setBillId(id); }} />
      ) : null}
      {section === "payments" ? (
        <PaymentList payments={payload?.payments || []} onChanged={load} />
      ) : null}
      {section === "aging" ? <AgingReport aging={payload?.aging} onOpen={(id) => { setVendorId(null); setBillId(id); }} /> : null}
      {openVendor && !creating ? <VendorDrawer vendor={openVendor} onClose={() => setVendorId(null)} onEdit={() => setCreating("vendor")} /> : null}
      {openBill && !creating ? (
        <BillDrawer
          bill={openBill}
          canApprove={!!payload?.canApprove}
          onClose={() => setBillId(null)}
          onEdit={() => setCreating("bill")}
          onPay={() => setCreating("payment")}
          onChanged={async () => {
            const next = await load();
            if (!next?.bills?.some((bill) => bill.id === openBill.id && bill.status !== "void")) setBillId(null);
          }}
        />
      ) : null}
      {creating === "vendor" ? (
        <VendorForm
          vendor={openVendor}
          accounts={payload?.accounts || []}
          onClose={() => setCreating("")}
          onSaved={async (vendor) => {
            await load();
            setCreating("");
            setVendorId(vendor.id);
            setSection("vendors");
          }}
        />
      ) : null}
      {creating === "bill" ? (
        <BillForm
          bill={openBill}
          vendors={vendors}
          accounts={payload?.accounts || []}
          clientId={clientId}
          onClose={() => setCreating("")}
          onSaved={async (bill) => {
            await load();
            setCreating("");
            setBillId(bill.id);
            setSection("bills");
          }}
        />
      ) : null}
      {creating === "payment" ? (
        <PaymentForm
          bills={bills.filter((bill) => bill.openCents > 0)}
          cashAccounts={payload?.cashAccounts || []}
          initialBillId={openBill?.openCents > 0 ? openBill.id : ""}
          onClose={() => setCreating("")}
          onSaved={async () => {
            await load();
            setCreating("");
            setBillId(null);
            setSection("payments");
          }}
        />
      ) : null}
    </div>
  );
}

function Dashboard({ dashboard, bills, onOpen }) {
  const cards = [
    ["Outstanding", dashboard?.outstanding, "Posted bills still open"],
    ["Due this week", dashboard?.dueThisWeek, "Open bills due in the next 7 days"],
    ["Overdue", dashboard?.overdue, "Open bills past the due date"],
    ["Pending", dashboard?.awaitingApproval, "Bills waiting for approval"],
  ];
  const attention = bills.filter((bill) => bill.status === "awaiting_approval" || bill.status === "approved" || (bill.status === "posted" && bill.openCents > 0));
  return (
    <>
      <div className="invoice-metrics">
        {cards.map(([label, bucket, detail]) => (
          <section className="card" key={label}>
            <span>{label}</span>
            <strong>{bucket ? bucket.amount : "—"}</strong>
            <small>{bucket ? `${bucket.count} ${bucket.count === 1 ? "bill" : "bills"}` : detail}</small>
          </section>
        ))}
      </div>
      <section className="card table-card">
        <div className="card-header">
          <div>
            <h2>Open bills</h2>
            <p>Counts are read from stored bills. Unposted bills are not on the trial balance.</p>
          </div>
        </div>
        {!attention.length ? (
          <div className="empty-state">
            <b>No open bills</b>
            <p>Add a vendor, then save a bill. It is not posted until you approve it.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Vendor</th><th>Invoice</th><th>Due</th><th>Status</th><th>Amount</th></tr></thead>
              <tbody>
                {attention.map((bill) => (
                  <tr key={bill.id} onClick={() => onOpen(bill.id)}>
                    <td><b>{bill.vendorName}</b></td>
                    <td>{bill.invoiceNumber}</td>
                    <td>{bill.dueDateLabel}</td>
                    <td><span className={`badge ${badgeTone(bill.status)}`}>{bill.statusLabel}</span></td>
                    <td><strong>{bill.status === "posted" ? bill.open : bill.total}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function BillList({ bills, total, query, onQuery, onOpen }) {
  return (
    <section className="card table-card">
      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" />
          <input aria-label="Search bills" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search bills…" />
        </div>
      </div>
      {!bills.length ? (
        <div className="empty-state">
          <b>{total ? "No matching bills" : "No bills yet"}</b>
          <p>{total ? "Try a different search." : "A new bill starts as a draft and can be edited until it is posted."}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vendor</th><th>Invoice</th><th>Bill date</th><th>Due</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {bills.map((bill) => (
                <tr key={bill.id} onClick={() => onOpen(bill.id)}>
                  <td><b>{bill.vendorName}</b></td>
                  <td>{bill.invoiceNumber}</td>
                  <td>{bill.billDateLabel}</td>
                  <td>{bill.dueDateLabel}</td>
                  <td><span className={`badge ${badgeTone(bill.status)}`}>{bill.statusLabel}</span></td>
                  <td><strong>{bill.total}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-footer"><span>Showing {bills.length} of {total} bills</span></div>
    </section>
  );
}

function VendorList({ vendors, total, query, onQuery, onOpen }) {
  return (
    <section className="card table-card">
      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" />
          <input aria-label="Search vendors" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search vendors…" />
        </div>
      </div>
      {!vendors.length ? (
        <div className="empty-state">
          <b>{total ? "No matching vendors" : "No vendors yet"}</b>
          <p>{total ? "Try a different search." : "Add a vendor before entering a bill."}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vendor</th><th>Contact</th><th>Terms</th><th>Outstanding</th></tr></thead>
            <tbody>
              {vendors.map((vendor) => (
                <tr key={vendor.id} onClick={() => onOpen(vendor.id)}>
                  <td><b>{vendor.name}</b><small style={{ display: "block", color: "#8794a4" }}>{vendor.email || "No email"}</small></td>
                  <td>{vendor.contactName || "—"}</td>
                  <td>{vendor.terms || "—"}</td>
                  <td><strong>{vendor.outstanding}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-footer"><span>Showing {vendors.length} of {total} vendors</span></div>
    </section>
  );
}

function VendorDrawer({ vendor, onClose, onEdit }) {
  return (
    <>
    <div className="drawer-scrim" onMouseDown={onClose} />
    <aside className="detail-drawer" aria-label={vendor.name}>
      <div className="drawer-header">
        <div>
          <h2>{vendor.name}</h2>
          <p>{vendor.terms || "No terms"} · {vendor.outstanding} outstanding</p>
        </div>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="drawer-section">
        <h3>Contact</h3>
        <dl>
          <div><dt>Contact</dt><dd>{vendor.contactName || "—"}</dd></div>
          <div><dt>Email</dt><dd>{vendor.email || "—"}</dd></div>
          <div><dt>Phone</dt><dd>{vendor.phone || "—"}</dd></div>
          <div><dt>Address</dt><dd>{vendor.address || "—"}</dd></div>
          <div><dt>Default account</dt><dd>{vendor.defaultAccountCode ? `${vendor.defaultAccountCode} ${vendor.defaultAccountName}` : "—"}</dd></div>
          <div><dt>Notes</dt><dd>{vendor.notes || "—"}</dd></div>
        </dl>
        <div className="modal-footer" style={{ padding: "14px 0 0" }}>
          <Button variant="secondary" onClick={onEdit}>Edit vendor</Button>
        </div>
      </div>
      <div className="drawer-section">
        <h3>Invoice history</h3>
        {!vendor.invoiceHistory.length ? <p className="books-note">No bills for this vendor.</p> : (
          <ul className="plain-list">
            {vendor.invoiceHistory.map((bill) => (
              <li key={bill.id}><b>{bill.invoiceNumber}</b> · {bill.billDateLabel} · {bill.statusLabel} · {bill.total}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="drawer-section">
        <h3>Payment history</h3>
        {!vendor.payments.length ? <p className="books-note">No payments recorded. A payment credits cash or a bank account. It does not start a transfer.</p> : (
          <ul className="plain-list">
            {vendor.payments.map((payment) => (
              <li key={payment.id}><b>{payment.reference}</b> · {payment.paidOnLabel} · {payment.amount} · {payment.statusLabel}</li>
            ))}
          </ul>
        )}
      </div>
    </aside>
    </>
  );
}

function BillDrawer({ bill, canApprove, onClose, onEdit, onPay, onChanged }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const editable = bill.status === "draft" || bill.status === "awaiting_approval";

  async function act(pathname) {
    setPending(true);
    setError("");
    const response = await fetch(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "That action was not saved.");
      return;
    }
    onChanged();
  }

  return (
    <>
    <div className="drawer-scrim" onMouseDown={onClose} />
    <aside className="detail-drawer" aria-label={bill.invoiceNumber}>
      <div className="drawer-header">
        <div>
          <span className={`badge ${badgeTone(bill.status)}`}>{bill.statusLabel}</span>
          <h2>{bill.vendorName}</h2>
          <p>{bill.invoiceNumber} · {bill.total}</p>
        </div>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="drawer-section">
        <h3>Bill</h3>
        <dl>
          <div><dt>Bill date</dt><dd>{bill.billDateLabel}</dd></div>
          <div><dt>Due</dt><dd>{bill.dueDateLabel}</dd></div>
          <div><dt>Tax</dt><dd>{bill.tax}</dd></div>
          <div><dt>File</dt><dd>{bill.documentName || "None"}</dd></div>
          <div><dt>Open</dt><dd>{bill.status === "posted" ? bill.open : "—"}</dd></div>
          <div><dt>Journal</dt><dd>{bill.journalReference || "Not posted"}</dd></div>
          <div><dt>Notes</dt><dd>{bill.notes || "—"}</dd></div>
        </dl>
      </div>
      <div className="drawer-section">
        <h3>Lines</h3>
        {bill.lines.map((line) => (
          <p key={line.id} className="books-note">{line.description} · {line.accountCode} {line.accountName} · {line.amount} + tax {line.tax}</p>
        ))}
      </div>
      <div className="drawer-section">
        <h3>Approval history</h3>
        {!bill.approvals?.length ? <p className="books-note">No approval decisions yet.</p> : (
          <ul className="plain-list">
            {bill.approvals.map((decision) => (
              <li key={decision.id}><b>{decision.actionLabel}</b> · {decision.actorName} · {decision.createdAtLabel}{decision.note ? ` · ${decision.note}` : ""}</li>
            ))}
          </ul>
        )}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!canApprove && (bill.status === "awaiting_approval" || bill.status === "approved") ? <p className="books-note">An owner or a manager approves and posts bills.</p> : null}
      <div className="modal-footer">
        {editable ? <Button variant="secondary" onClick={onEdit} disabled={pending}>Edit</Button> : null}
        {bill.status === "draft" ? <Button onClick={() => act(`/api/payables/bills/${bill.id}/submit`)} disabled={pending}>Submit for approval</Button> : null}
        {canApprove && bill.status === "awaiting_approval" ? <Button onClick={() => act(`/api/payables/bills/${bill.id}/approve`)} disabled={pending}>Approve</Button> : null}
        {canApprove && bill.status === "awaiting_approval" ? <Button variant="secondary" onClick={() => act(`/api/payables/bills/${bill.id}/reject`)} disabled={pending}>Reject</Button> : null}
        {canApprove && bill.status === "approved" ? <Button onClick={() => act(`/api/payables/bills/${bill.id}/post`)} disabled={pending}>Post bill</Button> : null}
        {bill.openCents > 0 ? <Button variant="secondary" onClick={onPay} disabled={pending}>Record payment</Button> : null}
        {bill.status !== "void" && bill.status !== "rejected" ? <Button variant="secondary" onClick={() => act(`/api/payables/bills/${bill.id}/void`)} disabled={pending}>Void</Button> : null}
      </div>
    </aside>
    </>
  );
}

function VendorForm({ vendor, accounts, onClose, onSaved }) {
  const [name, setName] = useState(vendor?.name || "");
  const [contactName, setContactName] = useState(vendor?.contactName || "");
  const [address, setAddress] = useState(vendor?.address || "");
  const [email, setEmail] = useState(vendor?.email || "");
  const [phone, setPhone] = useState(vendor?.phone || "");
  const [terms, setTerms] = useState(vendor?.terms || "Net 30");
  const [defaultAccountId, setDefaultAccountId] = useState(vendor?.defaultAccountId || "");
  const [notes, setNotes] = useState(vendor?.notes || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = name.trim() && !pending;

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const response = await fetch(vendor ? `/api/payables/vendors/${vendor.id}` : "/api/payables/vendors", {
      method: vendor ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, contactName, address, email, phone, terms, defaultAccountId, notes }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The vendor was not saved.");
      return;
    }
    onSaved(body.vendor);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="vendor-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="vendor-title">{vendor ? "Edit vendor" : "New vendor"}</h2>
            <p>This vendor belongs to the open client.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Contact</span><input value={contactName} onChange={(event) => setContactName(event.target.value)} /></label>
          <label className="field"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="field"><span>Phone</span><input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
          <label className="field"><span>Terms</span>
            <select value={terms} onChange={(event) => setTerms(event.target.value)}>
              {["Due on receipt", "Net 15", "Net 30", "Net 45"].map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <label className="field full"><span>Address</span><input value={address} onChange={(event) => setAddress(event.target.value)} /></label>
          <label className="field full"><span>Default account</span>
            <select value={defaultAccountId || ""} onChange={(event) => setDefaultAccountId(event.target.value)}>
              <option value="">No default</option>
              {accounts.map((account) => <option value={account.id} key={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
          <label className="field full"><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Save vendor"}</Button>
        </div>
      </form>
    </div>
  );
}

function emptyLine(accountId) {
  return { description: "", accountId: accountId || "", amount: "", tax: "" };
}

function BillForm({ bill, vendors, accounts, clientId, onClose, onSaved }) {
  const today = todayInput();
  const [vendorId, setVendorId] = useState(bill?.vendorId || vendors[0]?.id || "");
  const [invoiceNumber, setInvoiceNumber] = useState(bill?.invoiceNumber || "");
  const [billDate, setBillDate] = useState(bill?.billDate || today);
  const [dueDate, setDueDate] = useState(bill?.dueDate || addDays(today, 30));
  const [notes, setNotes] = useState(bill?.notes || "");
  const [documentId, setDocumentId] = useState(bill?.documentId || "");
  const [files, setFiles] = useState([]);
  const [lines, setLines] = useState(bill?.lines?.length
    ? bill.lines.map((line) => ({
      description: line.description,
      accountId: line.accountId,
      amount: (line.amountCents / 100).toFixed(2),
      tax: line.taxCents ? (line.taxCents / 100).toFixed(2) : "",
    }))
    : [emptyLine(vendors.find((vendor) => vendor.id === (bill?.vendorId || vendors[0]?.id))?.defaultAccountId || accounts[0]?.id)]);
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents?clientId=${encodeURIComponent(clientId || "")}`).then(readJson).then((body) => {
      if (!cancelled) setFiles(body.files || []);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  function chooseVendor(nextId) {
    setVendorId(nextId);
    const vendor = vendors.find((item) => item.id === nextId);
    if (!vendor?.defaultAccountId) return;
    setLines((current) => current.map((line, index) => index === 0 && !line.accountId ? { ...line, accountId: vendor.defaultAccountId } : line));
  }

  function updateLine(index, patch) {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  }

  async function save(confirmDuplicate = false) {
    setPending(true);
    setError("");
    const response = await fetch(bill ? `/api/payables/bills/${bill.id}` : "/api/payables/bills", {
      method: bill ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vendorId,
        invoiceNumber,
        billDate,
        dueDate,
        notes,
        documentId,
        confirmDuplicate,
        lines: lines.map((line) => ({ ...line, tax: line.tax || "0.00" })),
      }),
    });
    const body = await readJson(response);
    setPending(false);
    if (response.status === 409 && body.duplicate) {
      setDuplicate(body.duplicate);
      setError(body.error);
      return;
    }
    if (!response.ok) {
      setDuplicate(null);
      setError(body.error || "The bill was not saved.");
      return;
    }
    onSaved(body.bill);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal wide" role="dialog" aria-modal="true" aria-labelledby="bill-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); save(false); }}>
        <div className="modal-header">
          <div>
            <h2 id="bill-title">{bill ? "Edit bill" : "New bill"}</h2>
            <p>Saving keeps the bill unposted. Posting credits accounts payable.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field"><span>Vendor</span>
            <select value={vendorId} onChange={(event) => chooseVendor(event.target.value)}>
              {vendors.map((vendor) => <option value={vendor.id} key={vendor.id}>{vendor.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Invoice number</span><input value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /></label>
          <label className="field"><span>Bill date</span><input type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} required /></label>
          <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label>
          <label className="field full"><span>File already stored</span>
            <select aria-label="Stored file" value={documentId || ""} onChange={(event) => setDocumentId(event.target.value)}>
              <option value="">No file</option>
              {files.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}
            </select>
          </label>
          <div className="field full">
            <span>Lines</span>
            <div className="bill-lines">
              {lines.map((line, index) => (
                <div className="bill-line" key={index}>
                  <input aria-label={`Line ${index + 1} description`} value={line.description} placeholder="Description" onChange={(event) => updateLine(index, { description: event.target.value })} />
                  <select aria-label={`Line ${index + 1} account`} value={line.accountId} onChange={(event) => updateLine(index, { accountId: event.target.value })}>
                    <option value="">Account</option>
                    {accounts.map((account) => <option value={account.id} key={account.id}>{account.code} {account.name}</option>)}
                  </select>
                  <input aria-label={`Line ${index + 1} amount`} inputMode="decimal" value={line.amount} placeholder="0.00" onChange={(event) => updateLine(index, { amount: event.target.value })} />
                  <input aria-label={`Line ${index + 1} tax`} inputMode="decimal" value={line.tax} placeholder="Tax" onChange={(event) => updateLine(index, { tax: event.target.value })} />
                  <button className="modal-close" type="button" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.length === 1 ? current : current.filter((_, lineIndex) => lineIndex !== index))}>×</button>
                </div>
              ))}
            </div>
            <button className="text-button" type="button" onClick={() => setLines((current) => [...current, emptyLine(accounts[0]?.id)])}>Add line</button>
          </div>
          <label className="field full"><span>Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {duplicate ? <Button type="button" variant="secondary" disabled={pending} onClick={() => save(true)}>Save anyway</Button> : null}
          <Button type="submit" disabled={pending || !invoiceNumber.trim()}>{pending ? "Saving…" : "Save draft"}</Button>
        </div>
      </form>
    </div>
  );
}

function ApprovalList({ bills, onOpen }) {
  const groups = [
    ["awaiting_approval", "Pending"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
  ];
  return (
    <section className="card table-card">
      <div className="card-header">
        <div>
          <h2>Approvals</h2>
          <p>Pending, approved, and rejected bills. Each decision keeps the person and the time.</p>
        </div>
      </div>
      {!bills.length ? (
        <div className="empty-state">
          <b>No bills have been submitted</b>
          <p>Submit a draft when it is ready for an owner or a manager.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vendor</th><th>Invoice</th><th>Status</th><th>Latest decision</th><th>When</th><th>Amount</th></tr></thead>
            <tbody>
              {groups.flatMap(([status]) => bills.filter((bill) => bill.status === status)).map((bill) => {
                const latest = bill.approvals?.[bill.approvals.length - 1];
                return (
                  <tr key={bill.id} onClick={() => onOpen(bill.id)}>
                    <td><b>{bill.vendorName}</b></td>
                    <td>{bill.invoiceNumber}</td>
                    <td><span className={`badge ${badgeTone(bill.status)}`}>{bill.statusLabel}</span></td>
                    <td>{latest ? `${latest.actionLabel} · ${latest.actorName}` : "—"}</td>
                    <td>{latest?.createdAtLabel || "—"}</td>
                    <td><strong>{bill.total}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentList({ payments, onChanged }) {
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState("");

  async function voidPayment(payment) {
    setPendingId(payment.id);
    setError("");
    const response = await fetch(`/api/payables/payments/${payment.id}/void`, { method: "POST" });
    const body = await readJson(response);
    setPendingId("");
    if (!response.ok) {
      setError(body.error || "The payment was not voided.");
      return;
    }
    onChanged();
  }

  return (
    <section className="card table-card">
      <div className="card-header">
        <div>
          <h2>Payments</h2>
          <p>A payment debits accounts payable and credits the cash or bank account you choose. Nothing is sent to a bank.</p>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!payments.length ? (
        <div className="empty-state">
          <b>No payments yet</b>
          <p>Record a payment against a posted bill. A partial payment leaves the rest outstanding.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vendor</th><th>Invoice</th><th>Date</th><th>Reference</th><th>Account</th><th>Status</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td><b>{payment.vendorName}</b></td>
                  <td>{payment.invoiceNumber}</td>
                  <td>{payment.paidOnLabel}</td>
                  <td>{payment.reference}</td>
                  <td>{payment.accountCode} {payment.accountName}</td>
                  <td><span className={`badge ${badgeTone(payment.status)}`}>{payment.statusLabel}</span></td>
                  <td><strong>{payment.amount}</strong></td>
                  <td>{payment.status === "recorded" ? <button className="text-button" type="button" disabled={pendingId === payment.id} onClick={() => voidPayment(payment)}>Void</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentForm({ bills, cashAccounts, initialBillId, onClose, onSaved }) {
  const [billId, setBillId] = useState(initialBillId || bills[0]?.id || "");
  const [paidOn, setPaidOn] = useState(todayInput());
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [accountId, setAccountId] = useState(cashAccounts[0]?.id || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const bill = bills.find((item) => item.id === billId);

  async function save(event) {
    event.preventDefault();
    if (!bill || pending) return;
    setPending(true);
    setError("");
    const response = await fetch(`/api/payables/bills/${bill.id}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paidOn, amount, reference, accountId }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The payment was not recorded.");
      return;
    }
    onSaved(body.payment);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="payment-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="payment-title">Record payment</h2>
            <p>This credits cash or a bank account in the journal. It does not start a transfer.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Bill</span>
            <select value={billId} onChange={(event) => setBillId(event.target.value)}>
              {bills.map((item) => <option value={item.id} key={item.id}>{item.vendorName} · {item.invoiceNumber} · {item.open} open</option>)}
            </select>
          </label>
          <label className="field"><span>Date</span><input type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} required /></label>
          <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={bill ? bill.open.replace("$", "") : "0.00"} /></label>
          <label className="field"><span>Reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Check or confirmation" /></label>
          <label className="field"><span>Cash or bank account</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {cashAccounts.map((account) => <option value={account.id} key={account.id}>{account.code} {account.name}</option>)}
            </select>
          </label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !reference.trim() || !amount.trim() || !accountId}>{pending ? "Saving…" : "Record payment"}</Button>
        </div>
      </form>
    </div>
  );
}

function AgingReport({ aging, onOpen }) {
  const buckets = aging?.buckets || [];
  const vendors = aging?.vendors || [];
  const total = aging?.total;
  return (
    <>
      <div className="invoice-metrics aging-metrics">
        {buckets.map((bucket) => (
          <section className="card" key={bucket.id}>
            <span>{bucket.label}</span>
            <strong>{bucket.amount}</strong>
            <small>{bucket.count} {bucket.count === 1 ? "bill" : "bills"}</small>
          </section>
        ))}
      </div>
      <section className="card table-card">
        <div className="card-header">
          <div>
            <h2>Vendor totals</h2>
            <p>Open posted bills as of {aging?.asOfLabel || "today"}, grouped from the due date and the unpaid balance.</p>
          </div>
        </div>
        {!vendors.length ? (
          <div className="empty-state">
            <b>No open payables</b>
            <p>Posted bills with a remaining balance appear here. Drafts and paid bills do not.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  {buckets.map((bucket) => <th key={bucket.id}>{bucket.label}</th>)}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.vendorId}>
                    <td><b>{vendor.vendorName}</b></td>
                    <td>{vendor.current}</td>
                    <td>{vendor.days1to30}</td>
                    <td>{vendor.days31to60}</td>
                    <td>{vendor.days61to90}</td>
                    <td>{vendor.days90plus}</td>
                    <td><strong>{vendor.total}</strong></td>
                  </tr>
                ))}
              </tbody>
              {total ? (
                <tfoot>
                  <tr>
                    <td><b>Total</b></td>
                    <td>{total.current}</td>
                    <td>{total.days1to30}</td>
                    <td>{total.days31to60}</td>
                    <td>{total.days61to90}</td>
                    <td>{total.days90plus}</td>
                    <td><strong>{total.total}</strong></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        )}
      </section>
      {vendors.some((vendor) => vendor.bills.length) ? (
        <section className="card table-card">
          <div className="card-header">
            <div>
              <h2>Open bills</h2>
              <p>Each amount is the bill total minus recorded payments.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Vendor</th><th>Invoice</th><th>Due</th><th>Days past due</th><th>Bucket</th><th>Open</th></tr></thead>
              <tbody>
                {vendors.flatMap((vendor) => vendor.bills.map((bill) => (
                  <tr key={bill.id} onClick={() => onOpen(bill.id)}>
                    <td><b>{vendor.vendorName}</b></td>
                    <td>{bill.invoiceNumber}</td>
                    <td>{bill.dueDateLabel}</td>
                    <td>{bill.daysPastDue}</td>
                    <td>{bill.bucketLabel}</td>
                    <td><strong>{bill.open}</strong></td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
