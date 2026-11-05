import { useEffect, useState } from "react";

const CATEGORIES = ["", "Receipt", "Bank statement", "Tax", "Invoice", "Other"];
const TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};

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

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function mediaTypeFor(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  return TYPES[extension] || file.type || "";
}

async function contentBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

export function Documents({ clientId }) {
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [taxYear, setTaxYear] = useState("");
  const [status, setStatus] = useState("stored");
  const [folderId, setFolderId] = useState("");
  const [fileId, setFileId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [reviews, setReviews] = useState(null);

  function load(next = {}) {
    const params = new URLSearchParams();
    const q = next.q ?? query;
    const nextCategory = next.category ?? category;
    const nextYear = next.taxYear ?? taxYear;
    const nextStatus = next.status ?? status;
    const nextFolder = next.folderId ?? folderId;
    if (q.trim()) params.set("q", q.trim());
    if (nextCategory) params.set("category", nextCategory);
    if (nextYear) params.set("taxYear", nextYear);
    if (nextStatus) params.set("status", nextStatus);
    if (nextFolder) params.set("folderId", nextFolder);
    return fetch(`/api/documents/library?${params.toString()}`).then(async (response) => {
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "Could not load documents.");
      setLibrary(body);
      setError("");
      return body;
    }).catch((reason) => {
      setError(reason.message || "Could not load documents.");
    });
  }

  useEffect(() => {
    let cancelled = false;
    setReviews(null);
    fetch("/api/documents/reviews").then(async (response) => {
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load the review queue.");
        return;
      }
      setReviews(body);
    }).catch(() => {
      if (!cancelled) setError("Could not load the review queue.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    setLibrary(null);
    setFileId(null);
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (category) params.set("category", category);
    if (taxYear) params.set("taxYear", taxYear);
    if (status) params.set("status", status);
    if (folderId) params.set("folderId", folderId);
    fetch(`/api/documents/library?${params.toString()}`).then(async (response) => {
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error || "Could not load documents.");
        return;
      }
      setLibrary(body);
    }).catch(() => {
      if (!cancelled) setError("Could not load documents.");
    });
    return () => {
      cancelled = true;
    };
  }, [clientId, query, category, taxYear, status, folderId]);

  const files = library?.files || [];
  const folders = library?.folders || [];
  const open = files.find((file) => file.id === fileId) || null;

  return (
    <div className="page documents-page">
      <div className="page-header">
        <div>
          <h1>Documents</h1>
          <p>Stored files for this client. Avenue keeps the bytes and does not extract them.</p>
        </div>
        <div className="header-actions">
          <Button variant="secondary" onClick={() => setFolderId("new")}>New folder</Button>
          <Button icon="plus" onClick={() => setUploading(true)}>Upload</Button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <ReviewQueue reviews={reviews} onChanged={async () => {
        const response = await fetch("/api/documents/reviews");
        const body = await readJson(response);
        if (response.ok) setReviews(body);
      }} />
      <section className="card table-card">
        <div className="card-header">
          <div>
            <h2>Library</h2>
            <p>Search uses the stored file name.</p>
          </div>
          <div className="client-filters">
            <label className="field"><span>Folder</span>
              <select aria-label="Folder" value={folderId === "new" ? "" : folderId} onChange={(event) => setFolderId(event.target.value)}>
                <option value="">All folders</option>
                <option value="root">No folder</option>
                {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Category</span>
              <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">Any</option>
                {CATEGORIES.filter(Boolean).map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="field"><span>Tax year</span>
              <input aria-label="Tax year" value={taxYear} onChange={(event) => setTaxYear(event.target.value)} placeholder="2026" />
            </label>
            <label className="field"><span>Status</span>
              <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">Any</option>
                <option value="stored">Stored</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <div className="search-mini">
              <Icon name="search" />
              <input aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" />
            </div>
          </div>
        </div>
        {!files.length ? (
          <div className="empty-state">
            <b>{library ? "No files match" : "Loading documents…"}</b>
            <p>{library ? "No stored file matches this folder, category, tax year, status, or name. Upload accepts PDF, PNG, JPG, DOCX, XLSX, and CSV." : ""}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Category</th><th>Tax year</th><th>Uploaded</th><th>Status</th></tr></thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id} onClick={() => setFileId(file.id)}>
                    <td><b>{file.name}</b><small>{file.folderName ? ` · ${file.folderName}` : ""}</small></td>
                    <td>{file.category || "—"}</td>
                    <td>{file.taxYear || "—"}</td>
                    <td>{file.uploadedAtLabel}</td>
                    <td><span className={`badge ${file.status === "archived" ? "neutral" : "green"}`}>{file.statusLabel}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open ? (
        <FileDrawer
          file={open}
          folders={folders}
          onClose={() => setFileId(null)}
          onChanged={async () => {
            const next = await load();
            if (next && !next.files.some((file) => file.id === open.id)) setFileId(null);
          }}
        />
      ) : null}
      {uploading ? (
        <UploadForm
          folders={folders}
          onClose={() => setUploading(false)}
          onSaved={async () => {
            setUploading(false);
            setStatus("stored");
            await load({ status: "stored" });
          }}
        />
      ) : null}
      {folderId === "new" ? (
        <FolderForm
          onClose={() => setFolderId("")}
          onSaved={async (folder) => {
            setFolderId(folder.id);
            await load({ folderId: folder.id });
          }}
        />
      ) : null}
    </div>
  );
}

const KINDS = ["bank statement", "receipt", "vendor invoice", "customer invoice", "W-2", "1099", "payroll report", "financial statement", "tax document", "contract"];

function Confidence({ suggestion }) {
  const width = `${Math.round((suggestion.confidence || 0) * 100)}%`;
  return (
    <span className="confidence" title={`${suggestion.confidenceLabel} confidence`}>
      <i><b style={{ width }} /></i>
      <span>{suggestion.confidenceLabel} · {width}</span>
    </span>
  );
}

function ReviewQueue({ reviews, onChanged }) {
  const queue = reviews?.queue || [];
  const reviewed = reviews?.reviewed || [];
  return (
    <section className="card review-card">
      <div className="card-header">
        <div>
          <h2>File suggestions</h2>
          <p>Suggestions are labeled AI-generated. Accepting stores the review. It does not post a journal, create a bill, or choose a tax treatment.</p>
        </div>
      </div>
      {reviews?.notice ? <p className="assistant-banner">{reviews.notice}</p> : null}
      {reviewed.length ? (
        <div className="review-list">
          {reviewed.map((review) => (
            <article className="review-row" key={review.id}>
              <div className="review-title">
                <b>{review.fileName}</b>
                <span className="badge green">{review.statusLabel}</span>
                <span className="badge amber">{review.label}</span>
              </div>
              <p>{review.kind}{review.party ? ` · ${review.party}` : ""}{review.date ? ` · ${review.date}` : ""}{review.amount ? ` · ${review.amount}` : ""}</p>
            </article>
          ))}
        </div>
      ) : null}
      {!reviews ? <p className="books-note">Loading suggestions…</p> : null}
      {reviews && !queue.length && !reviewed.length ? <p className="books-note">No stored files are waiting for review.</p> : null}
      <div className="review-list">
        {queue.map((item) => <ReviewItem item={item} key={item.fileId} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function ReviewItem({ item, onChanged }) {
  const suggestion = item.suggestion;
  const [kind, setKind] = useState(suggestion.kind === "unknown" ? "receipt" : suggestion.kind);
  const [party, setParty] = useState(suggestion.party || "");
  const [date, setDate] = useState(suggestion.date || "");
  const [amount, setAmount] = useState(suggestion.amount || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [correcting, setCorrecting] = useState(false);

  async function accept() {
    setPending(true);
    setError("");
    const response = await fetch(`/api/documents/${item.fileId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The review was not stored.");
      return;
    }
    onChanged();
  }

  async function correct(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch(`/api/documents/${item.fileId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "correct", kind, party, date, amount }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The correction was not stored.");
      return;
    }
    onChanged();
  }

  return (
    <article className="review-row">
      <div className="review-title">
        <b>{item.name}</b>
        <span className="badge amber">{suggestion.label}</span>
        <Confidence suggestion={suggestion} />
      </div>
      <dl className="review-fields">
        <div><dt>Kind</dt><dd>{suggestion.kind}</dd></div>
        <div><dt>Vendor or payer</dt><dd>{suggestion.party || "—"}</dd></div>
        <div><dt>Date</dt><dd>{suggestion.date || "—"}</dd></div>
        <div><dt>Amount</dt><dd>{suggestion.amount || "—"}</dd></div>
      </dl>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="header-actions">
        <Button onClick={accept} disabled={pending}>Accept suggestion</Button>
        <Button variant="secondary" onClick={() => setCorrecting((open) => !open)}>Correct</Button>
      </div>
      {correcting ? (
        <form className="review-correct" onSubmit={correct}>
          <label className="field"><span>Kind</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              {KINDS.map((itemKind) => <option key={itemKind}>{itemKind}</option>)}
            </select>
          </label>
          <label className="field"><span>Vendor or payer</span><input value={party} onChange={(event) => setParty(event.target.value)} /></label>
          <label className="field"><span>Date</span><input value={date} onChange={(event) => setDate(event.target.value)} placeholder="2026-03-04" /></label>
          <label className="field"><span>Amount</span><input value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <Button type="submit" disabled={pending}>Save correction</Button>
        </form>
      ) : null}
    </article>
  );
}

function FileDrawer({ file, folders, onClose, onChanged }) {
  const [name, setName] = useState(file.name);
  const [category, setCategory] = useState(file.category || "");
  const [taxYear, setTaxYear] = useState(file.taxYear || "");
  const [nextFolder, setNextFolder] = useState(file.folderId || "");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setName(file.name);
    setCategory(file.category || "");
    setTaxYear(file.taxYear || "");
    setNextFolder(file.folderId || "");
  }, [file]);

  async function saveDetails(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch(`/api/documents/${file.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, category, taxYear, folderId: nextFolder }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The file was not updated.");
      return;
    }
    onChanged();
  }

  async function add(kind) {
    setPending(true);
    setError("");
    const response = await fetch(`/api/documents/${file.id}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(kind === "tags" ? { name: tag } : { body: note }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "That was not saved.");
      return;
    }
    if (kind === "tags") setTag("");
    else setNote("");
    onChanged();
  }

  async function archive() {
    setPending(true);
    setError("");
    const response = await fetch(`/api/documents/${file.id}/archive`, { method: "POST" });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The file was not archived.");
      return;
    }
    onChanged();
  }

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} />
      <aside className="detail-drawer" aria-label={file.name}>
        <div className="drawer-header">
          <div>
            <span className={`badge ${file.status === "archived" ? "neutral" : "green"}`}>{file.statusLabel}</span>
            <h2>{file.name}</h2>
            <p>{file.uploadedAtLabel}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {file.preview === "image" ? <img className="document-preview" alt="" src={`/api/documents/${file.id}`} /> : null}
        {file.preview === "pdf" ? <iframe className="document-preview" title={`Preview ${file.name}`} src={`/api/documents/${file.id}`} /> : null}
        {file.preview ? null : <p className="books-note">Download this file. Preview is available for PDF and image files.</p>}
        <form className="drawer-section" onSubmit={saveDetails}>
          <h3>File</h3>
          <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">None</option>
              {CATEGORIES.filter(Boolean).map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="field"><span>Tax year</span><input value={taxYear} onChange={(event) => setTaxYear(event.target.value)} /></label>
          <label className="field"><span>Folder</span>
            <select value={nextFolder} onChange={(event) => setNextFolder(event.target.value)}>
              <option value="">No folder</option>
              {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={pending}>Save</Button>
        </form>
        <div className="drawer-section">
          <h3>Tags</h3>
          {file.tags.length ? <ul className="plain-list">{file.tags.map((item) => <li key={item.id}>{item.name}</li>)}</ul> : <p className="books-note">No tags.</p>}
          <div className="assistant-form">
            <input aria-label="Tag" value={tag} onChange={(event) => setTag(event.target.value)} placeholder="Tag" />
            <Button variant="secondary" onClick={() => add("tags")} disabled={pending || !tag.trim()}>Add tag</Button>
          </div>
        </div>
        <div className="drawer-section">
          <h3>Notes</h3>
          {file.notes.length ? <ul className="plain-list">{file.notes.map((item) => <li key={item.id}>{item.body}</li>)}</ul> : <p className="books-note">No notes.</p>}
          <div className="assistant-form">
            <input aria-label="Note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note" />
            <Button variant="secondary" onClick={() => add("notes")} disabled={pending || !note.trim()}>Add note</Button>
          </div>
        </div>
        <div className="drawer-section">
          <h3>Version history</h3>
          {file.versions.length ? (
            <ul className="plain-list">{file.versions.map((version) => <li key={version.id}>{version.name} · {version.note} · {version.createdAtLabel}</li>)}</ul>
          ) : <p className="books-note">No earlier versions.</p>}
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <a className="button secondary" href={`/api/documents/${file.id}`}>Download</a>
          {file.status !== "archived" ? <Button variant="secondary" onClick={archive} disabled={pending}>Archive</Button> : null}
        </div>
      </aside>
    </>
  );
}

function UploadForm({ folders, onClose, onSaved }) {
  const [category, setCategory] = useState("");
  const [taxYear, setTaxYear] = useState("");
  const [folderId, setFolderId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function save(event) {
    event.preventDefault();
    const file = event.target.elements.file.files?.[0];
    if (!file || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          mediaType: mediaTypeFor(file),
          contentBase64: await contentBase64(file),
          category,
          taxYear,
          folderId,
        }),
      });
      const body = await readJson(response);
      setPending(false);
      if (!response.ok) {
        setError(body.error || "The file was not stored.");
        return;
      }
      onSaved(body.file);
    } catch (reason) {
      setPending(false);
      setError(reason.message || "The file was not stored.");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="upload-title">Upload file</h2>
            <p>The stored bytes are kept as uploaded. Nothing in the file is run.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="form-grid">
          <label className="field full"><span>File</span><input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,.txt,application/pdf,image/png,image/jpeg,text/csv,text/plain" required /></label>
          <label className="field"><span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">None</option>
              {CATEGORIES.filter(Boolean).map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="field"><span>Tax year</span><input value={taxYear} onChange={(event) => setTaxYear(event.target.value)} placeholder="2026" /></label>
          <label className="field full"><span>Folder</span>
            <select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
              <option value="">No folder</option>
              {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
            </select>
          </label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>{pending ? "Uploading…" : "Upload"}</Button>
        </div>
      </form>
    </div>
  );
}

function FolderForm({ onClose, onSaved }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function save(event) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/documents/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await readJson(response);
    setPending(false);
    if (!response.ok) {
      setError(body.error || "The folder was not created.");
      return;
    }
    onSaved(body.folder);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="folder-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
        <div className="modal-header">
          <div>
            <h2 id="folder-title">New folder</h2>
            <p>This folder is stored for the open client.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <label className="field"><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Create folder"}</Button>
        </div>
      </form>
    </div>
  );
}
