import { useEffect, useState } from "react";

function Icon({ name }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
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

function money(cents) {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}$${Math.trunc(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`;
}

function hoursLabel(hundredths) {
  return `${Math.trunc(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

export function Time({ clientId, clients, onSession, onOpenInvoices }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState("");
  const [openId, setOpenId] = useState(null);

  async function load() {
    const response = await fetch("/api/time");
    const body = await readJson(response);
    if (!response.ok) {
      setError(body.error || "Could not load time.");
      return;
    }
    setPayload(body);
    setError("");
  }

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    fetch("/api/time").then(async (response) => {
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load time.");
        return;
      }
      setPayload(body);
    }).catch(() => {
      if (!cancelled) setError("Could not load time.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const entries = payload?.entries || [];
  const chosen = entries.filter((entry) => selected.includes(entry.id));
  const chosenHours = chosen.reduce((sum, entry) => sum + entry.hoursHundredths, 0);
  const chosenCents = chosen.reduce((sum, entry) => sum + entry.amountCents, 0);
  const open = entries.find((entry) => entry.id === openId) || null;
  const firmWide = payload?.viewer?.firmWide;

  function toggle(id) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Time</h1>
          <p>Log time against a client and a piece of work. The firm can see it by client.</p>
        </div>
        <div className="header-actions">
          <Button variant="secondary" onClick={() => setMode("work")}>Add work</Button>
          <Button icon="plus" onClick={() => setMode("time")}>Log time</Button>
        </div>
      </div>
      <p className="books-note">Time stays off the ledger until the invoice is sent. Wages are not posted.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="card table-card">
        <div className="card-header"><div><h2>People</h2><p>Firm users and their staff records.</p></div></div>
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Staff record</th></tr></thead>
          <tbody>
            {(payload?.staff || []).map((person) => (
              <tr key={person.id}><td><b>{person.name}</b></td><td>{person.role}</td><td>{person.title}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card table-card">
        <div className="card-header"><div><h2>Work</h2><p>Pieces of work and the hourly rate used when time becomes an invoice.</p></div></div>
        {payload && !(payload.work || []).length ? <div className="empty-state"><b>No work yet</b><p>Add a piece of work before logging time.</p></div> : (
          <table>
            <thead><tr><th>Work</th><th>Client</th><th>Hourly rate</th></tr></thead>
            <tbody>
              {(payload?.work || []).map((item) => (
                <tr key={item.id}><td><b>{item.name}</b></td><td>{item.clientName}</td><td>{item.hourlyRate}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card table-card">
        <div className="card-header"><div><h2>Time by client</h2><p>{firmWide ? "Everyone’s time in this firm." : "Your time, grouped by client."}</p></div></div>
        {payload && !(payload.byClient || []).length ? <div className="empty-state"><b>No time is logged yet</b><p>Log time against a client and a piece of work.</p></div> : (
          <table>
            <thead><tr><th>Client</th><th>Hours</th><th>Amount</th><th>People</th></tr></thead>
            <tbody>
              {(payload?.byClient || []).map((group) => (
                <tr key={group.clientId}>
                  <td><b>{group.clientName}</b></td>
                  <td>{group.hours}</td>
                  <td>{group.amount}</td>
                  <td>{group.people.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card table-card">
        <div className="toolbar">
          <Button disabled={!chosen.length} onClick={() => setMode("invoice")}>Create invoice from selected time</Button>
          {chosen.length ? <span>{hoursLabel(chosenHours)} hours · {money(chosenCents)}</span> : null}
        </div>
        {payload && !entries.length ? <div className="empty-state"><b>No time entries</b><p>A saved entry does not post a journal.</p></div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th /><th>Person</th><th>Client</th><th>Work</th><th>Date</th><th>Hours</th><th>Amount</th><th>Invoice</th></tr></thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} onClick={() => setOpenId(entry.id)}>
                    <td><input type="checkbox" aria-label={`Select ${entry.personName} ${entry.hours} hours`} checked={selected.includes(entry.id)} onChange={() => toggle(entry.id)} onClick={(event) => event.stopPropagation()} /></td>
                    <td>{entry.personName}</td>
                    <td>{entry.clientName}</td>
                    <td>{entry.workName}</td>
                    <td>{entry.workedOnLabel}</td>
                    <td>{entry.hours}</td>
                    <td><strong>{entry.amount}</strong></td>
                    <td>{entry.billed ? entry.invoiceNumber : "Not billed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open ? (
        <aside className="detail-drawer" aria-label={`${open.personName} time`}>
          <div className="drawer-header">
            <div><h2>{open.personName}</h2><p>{open.hours} hours · {open.amount}</p></div>
            <button className="modal-close" type="button" onClick={() => setOpenId(null)} aria-label="Close">×</button>
          </div>
          <div className="drawer-section">
            <h3>Entry</h3>
            <dl>
              <div><dt>Client</dt><dd>{open.clientName}</dd></div>
              <div><dt>Work</dt><dd>{open.workName}</dd></div>
              <div><dt>Hours</dt><dd>{open.hours}</dd></div>
              <div><dt>Amount</dt><dd>{open.amount}</dd></div>
              <div><dt>Note</dt><dd>{open.note || "None"}</dd></div>
            </dl>
          </div>
        </aside>
      ) : null}
      {mode === "work" ? <WorkModal clients={clients} openClientId={clientId} onClose={() => setMode("")} onSaved={async () => { setMode(""); await load(); }} /> : null}
      {mode === "time" ? <LogModal clients={clients} openClientId={clientId} work={payload?.work || []} onClose={() => setMode("")} onSaved={async () => { setMode(""); await load(); }} /> : null}
      {mode === "invoice" ? (
        <InvoiceTimeModal
          entries={chosen}
          hours={hoursLabel(chosenHours)}
          amount={money(chosenCents)}
          openClientId={clientId}
          onSession={onSession}
          onClose={() => setMode("")}
          onSaved={async () => {
            setMode("");
            setSelected([]);
            await load();
            onOpenInvoices();
          }}
        />
      ) : null}
    </div>
  );
}

function WorkModal({ clients, openClientId, onClose, onSaved }) {
  const [clientId, setClientId] = useState(openClientId || clients[0]?.id || "");
  const [name, setName] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ready = clientId && name.trim() && hourlyRate.trim() && !pending;

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, name, hourlyRate }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The work was not saved.");
      return;
    }
    onSaved(body.work);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="work-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div><h2 id="work-title">Add work</h2><p>A piece of work belongs to one client and has an hourly rate.</p></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Client</span>
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              {clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
            </select>
          </label>
          <label className="field full"><span>Work</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Hourly rate</span><input inputMode="decimal" value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} placeholder="0.00" /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Save work"}</Button>
        </div>
      </form>
    </div>
  );
}

function LogModal({ clients, openClientId, work, onClose, onSaved }) {
  const today = todayInput();
  const [clientId, setClientId] = useState(openClientId || clients[0]?.id || "");
  const [workId, setWorkId] = useState("");
  const [workedOn, setWorkedOn] = useState(today);
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const available = work.filter((item) => item.clientId === clientId);
  const ready = clientId && workId && workedOn && hours.trim() && !pending;

  useEffect(() => {
    if (!available.some((item) => item.id === workId)) setWorkId(available[0]?.id || "");
  }, [clientId, work]);

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/time", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, workId, workedOn, hours, note }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The time was not saved.");
      return;
    }
    onSaved(body.entry);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="time-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div><h2 id="time-title">Log time</h2><p>This is your time. It does not post a journal.</p></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>Client</span>
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              {clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
            </select>
          </label>
          <label className="field full"><span>Work</span>
            <select aria-label="Work" value={workId} onChange={(event) => setWorkId(event.target.value)}>
              {available.length ? null : <option value="">Add work for this client first</option>}
              {available.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.hourlyRate}</option>)}
            </select>
          </label>
          <label className="field"><span>Date</span><input type="date" value={workedOn} onChange={(event) => setWorkedOn(event.target.value)} required /></label>
          <label className="field"><span>Hours</span><input inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} placeholder="1.50" /></label>
          <label className="field full"><span>Note</span><input value={note} onChange={(event) => setNote(event.target.value)} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Save time"}</Button>
        </div>
      </form>
    </div>
  );
}

function InvoiceTimeModal({ entries, hours, amount, openClientId, onSession, onClose, onSaved }) {
  const today = todayInput();
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, 14));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const clientId = entries[0]?.clientId;
  const clientName = entries[0]?.clientName || "this client";
  const ready = entries.length && issueDate && dueDate && !pending && entries.every((entry) => entry.clientId === clientId && !entry.billed);

  async function save(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError("");
    if (clientId !== openClientId) {
      const switched = await fetch("/api/session", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      const session = await readJson(switched);
      if (!switched.ok) {
        setPending(false);
        setError(session.error || "Open that client before creating the invoice.");
        return;
      }
      onSession(session);
    }
    const response = await fetch("/api/time/invoice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryIds: entries.map((entry) => entry.id), issueDate, dueDate }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The invoice was not created.");
      return;
    }
    onSaved(body.invoice);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="bill-time-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="bill-time-title">Create invoice from time</h2>
            <p>{hours} hours for {clientName} become one draft for {amount}. Sending it posts the ledger.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field"><span>Issue date</span><input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required /></label>
          <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></label>
        </div>
        <ul className="books-note">
          {entries.map((entry) => <li key={entry.id}>{entry.personName} · {entry.workName} · {entry.hours} hours · {entry.amount}</li>)}
        </ul>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Save draft"}</Button>
        </div>
      </form>
    </div>
  );
}
