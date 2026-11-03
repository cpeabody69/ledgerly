import { useEffect, useState } from "react";

function Button({ children, variant = "primary", disabled = false, type = "button", onClick }) {
  return (
    <button className={`button ${variant}`} type={type} disabled={disabled} onClick={onClick}>
      <span>{children}</span>
    </button>
  );
}

async function payloadFor(file) {
  if (file.size > 48 * 1024) throw new Error("Choose a synthetic file of 48 KB or less.");
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".txt") ? "text/plain" : "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return { name: file.name, mediaType, contentBase64: btoa(binary) };
}

export function ReceiptModal({ clientName, clientId, onClose }) {
  const [file, setFile] = useState(null);
  const [target, setTarget] = useState("");
  const [requests, setRequests] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/clients").then((response) => response.json()),
      fetch("/api/transactions").then((response) => response.json()),
    ]).then(([firm, activity]) => {
      if (cancelled) return;
      setRequests((firm.requests || []).filter((request) => !clientId || request.clientId === clientId));
      setTransactions(activity.transactions || []);
    }).catch(() => {
      if (!cancelled) setError("Could not load requests and transactions.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function save(event) {
    event.preventDefault();
    if (!file || !target || pending) return;
    setPending(true);
    setError("");
    const [kind, id] = target.split(":");
    try {
      const payload = await payloadFor(file);
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...payload,
          clientId,
          requestId: kind === "request" ? id : undefined,
          transactionId: kind === "transaction" ? id : undefined,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The file was not stored.");
      onClose();
    } catch (saveError) {
      setError(saveError.message);
      setPending(false);
    }
  }

  const ready = file && target && !pending;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="receipt-title">Upload receipt</h2>
            <p>Store a synthetic file on {clientName} and attach it to a request or a transaction.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full">
            <span>Synthetic file</span>
            <input type="file" accept=".txt,.pdf,.png,.jpg,.jpeg,text/plain,application/pdf,image/png,image/jpeg" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <label className="field full">
            <span>Attach to</span>
            <select aria-label="Attach to" value={target} onChange={(event) => setTarget(event.target.value)} required>
              <option value="">Choose a request or a transaction</option>
              {requests.map((request) => <option value={`request:${request.id}`} key={request.id}>Request · {request.title}</option>)}
              {transactions.map((transaction) => <option value={`transaction:${transaction.id}`} key={transaction.id}>Transaction · {transaction.description}</option>)}
            </select>
          </label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Store file"}</Button>
        </div>
      </form>
    </div>
  );
}
