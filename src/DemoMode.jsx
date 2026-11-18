import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

const STEPS = [
  ["dashboard", "Firm", "Firm dashboard", "Counts on this screen are calculated from the fictional books."],
  ["clients", "Clients", "Clients", "Twenty-five fictional clients. A change stays in this temporary firm."],
  ["queue", "Work Queue", "Work queue", "Bookkeeping tasks created from those books."],
  ["transactions", "Transactions", "Transactions", "Statement lines for the open fictional client."],
  ["statements", "Reports", "Reports", "Financial statements are calculated from the journals."],
  ["close", "Close", "Monthly close", "Close status for the fictional firm. Nothing here is filed."],
  ["tax", "Tax Planning", "Tax planning", "An illustrative projection. It is not a filed return."],
  ["invoices", "Invoices", "Invoices", "Fictional client invoices. No payment is collected."],
];

const TOUR_KEY = "avenue-pro-demo-tour";

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

export function InterestDialog({ kind, onClose }) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const title = kind === "beta" ? "Join the beta" : "Request a personal demo";

  async function submit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    const { response, payload } = await postJson("/api/public-demo/interest", {
      kind,
      name,
      email,
      note,
      acknowledged,
    });
    if (!response.ok) {
      setError(payload.error || "Could not save that request.");
      return;
    }
    setMessage(payload.message || "Saved.");
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal demo-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>This does not create an account or take a payment.</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={submit}>
          <div className="form-grid">
            <p className="field full demo-privacy">Avenue Software stores your name, email, and note in the demo registry on this server so the request can be reviewed. It is not emailed, it is not copied into a customer firm's books, and it does not open a bank connection or a live charge. The fictional demo session stays separate and expires on its own.</p>
            <label className="field full demo-ack">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I understand this request is saved for review on the demo server.</span>
            </label>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
            </label>
            <label className="field">
              <span>Email</span>
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
            </label>
            <label className="field full">
              <span>Note</span>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
            </label>
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {message ? <p className="demo-saved" role="status">{message}</p> : null}
          <div className="modal-footer">
            <button className="button secondary" type="button" onClick={onClose}>Close</button>
            <button className="button primary" type="submit" disabled={!acknowledged || Boolean(message)}>Save request</button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}

function placeTip(rect) {
  const width = Math.min(320, window.innerWidth - 24);
  let left = rect.right + 12;
  let top = rect.top;
  if (left + width > window.innerWidth - 12) left = Math.max(12, rect.left);
  if (left === rect.left) top = rect.bottom + 12;
  if (top + 180 > window.innerHeight - 12) top = Math.max(12, window.innerHeight - 192);
  return { top, left, width };
}

export function DemoMode({ session, onSession, onOpenScreen, onToggleNav, onRequestNav }) {
  const [tourIndex, setTourIndex] = useState(null);
  const [spot, setSpot] = useState(null);
  const [dialog, setDialog] = useState("");
  const [message, setMessage] = useState("");
  const touring = Number.isInteger(tourIndex);

  useEffect(() => {
    if (session?.publicDemo && !session.portal && sessionStorage.getItem(TOUR_KEY) === "1") {
      sessionStorage.removeItem(TOUR_KEY);
      setTourIndex(0);
      onOpenScreen?.(STEPS[0][1]);
    }
  }, [session?.publicDemo, session?.portal, onOpenScreen]);

  useEffect(() => {
    if (!touring) {
      setSpot(null);
      return undefined;
    }
    const step = STEPS[tourIndex];
    let frame = 0;
    const measure = () => {
      const target = document.querySelector(`[data-tour="${CSS.escape(step[1])}"]`);
      if (!target) {
        setSpot(null);
        return;
      }
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = target.getBoundingClientRect();
      setSpot({ rect, tip: placeTip(rect) });
    };
    if (window.innerWidth <= 900) onRequestNav?.(true);
    measure();
    frame = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [touring, tourIndex, onRequestNav]);

  if (!session?.publicDemo) return null;
  const step = touring ? STEPS[tourIndex] : null;

  async function resetDemo() {
    setMessage("");
    setTourIndex(null);
    const { response, payload } = await postJson("/api/public-demo/reset");
    if (!response.ok) {
      setMessage(payload.error || "The demo could not be reset.");
      return;
    }
    onSession(payload);
    onOpenScreen?.("Firm");
    setMessage("This fictional firm was restored.");
  }

  async function exitDemo() {
    setMessage("");
    await fetch("/api/session", { method: "DELETE" });
    onSession(null);
    window.history.pushState({}, "", "/demo");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  async function openPortal() {
    const { response, payload } = await postJson("/api/public-demo/portal");
    if (response.ok) onSession(payload);
  }

  async function returnToFirm() {
    const { response, payload } = await postJson("/api/public-demo/firm");
    if (response.ok) onSession(payload);
  }

  function showStep(index) {
    const next = STEPS[index];
    setTourIndex(index);
    setMessage("");
    onOpenScreen?.(next[1]);
    postJson("/api/public-demo/event", { feature: next[0] });
  }

  function startTour() {
    if (session.portal) {
      sessionStorage.setItem(TOUR_KEY, "1");
      returnToFirm();
      return;
    }
    postJson("/api/public-demo/event", { feature: "tour" });
    showStep(0);
  }

  return (
    <>
      <div className="demo-banner" role="region" aria-label="Demo mode">
        <button className="button secondary demo-menu" type="button" onClick={onToggleNav}>Menu</button>
        <p className="demo-banner-copy">
          <strong>Demo mode</strong>
          <span title={`${session.demoNotice} No bank connection, file upload, payment, or external email runs from this session.`}>{session.demoNotice}</span>
        </p>
        <div className="demo-banner-actions">
          <button className="button secondary" type="button" onClick={resetDemo}>Reset demo</button>
          <button className="button secondary" type="button" onClick={startTour}>Guided tour</button>
          {session.portal ? <button className="button secondary" type="button" onClick={returnToFirm}>Back to firm</button> : <button className="button secondary" type="button" onClick={openPortal}>Client portal</button>}
          <button className="button secondary" type="button" onClick={() => setDialog("beta")}>Join the beta</button>
          <button className="button secondary" type="button" onClick={() => setDialog("personal")}>Personal demo</button>
          <button className="button primary" type="button" onClick={exitDemo}>Exit demo</button>
        </div>
        {message ? <p className="demo-banner-status" role="status">{message}</p> : null}
      </div>
      {step && spot ? (
        <div className="tour-layer">
          <div className="tour-hole" style={{ top: spot.rect.top - 4, left: spot.rect.left - 4, width: spot.rect.width + 8, height: spot.rect.height + 8 }} />
          <div className="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tour-title" style={{ top: spot.tip.top, left: spot.tip.left, width: spot.tip.width }}>
            <p className="tour-progress">Step {tourIndex + 1} of {STEPS.length}</p>
            <h2 id="tour-title">{step[2]}</h2>
            <p>{step[3]}</p>
            <div className="tour-actions">
              <button className="button ghost" type="button" onClick={() => setTourIndex(null)}>Skip</button>
              <span>
                <button className="button secondary" type="button" onClick={() => showStep(tourIndex - 1)} disabled={tourIndex === 0}>Back</button>
                <button className="button primary" type="button" onClick={() => (tourIndex === STEPS.length - 1 ? setTourIndex(null) : showStep(tourIndex + 1))}>{tourIndex === STEPS.length - 1 ? "Done" : "Next"}</button>
              </span>
            </div>
          </div>
        </div>
      ) : null}
      {dialog ? <InterestDialog kind={dialog} onClose={() => setDialog("")} /> : null}
    </>
  );
}
