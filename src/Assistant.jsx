import { useEffect, useState } from "react";

function confidenceLabel(value) {
  if (value === "high") return "High confidence";
  if (value === "medium") return "Medium confidence";
  if (value === "low") return "Low confidence";
  return "";
}

export function Assistant({ clientId, clientName, onClose, onUseDraft }) {
  const [meta, setMeta] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetch(`/api/assistant?clientId=${encodeURIComponent(clientId || "")}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not open the assistant.");
        if (!cancel) {
          setMeta(body);
          setTurns(body.recommendations || []);
        }
      })
      .catch((loadError) => {
        if (!cancel) setError(loadError.message);
      });
    return () => {
      cancel = true;
    };
  }, [clientId]);

  async function ask(text) {
    const question = text.trim();
    if (!question || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, prompt: question }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The assistant did not answer.");
      setMeta(body);
      setTurns((current) => [...current, body]);
      setPrompt("");
    } catch (askError) {
      setError(askError.message);
    } finally {
      setPending(false);
    }
  }

  async function useDraft(turn) {
    setError("");
    const response = await fetch("/api/assistant/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, recommendationId: turn.draft.recommendationId || turn.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || "The draft was not recorded.");
      return;
    }
    onUseDraft(turn.draft);
  }

  const prompts = [
    "Explain the statements",
    "List uncategorized transactions",
    "Draft a journal",
    "List missing documents",
    "What looks unusual?",
  ];

  return (
    <div className="assistant-scrim" onMouseDown={onClose}>
      <aside className="assistant-panel" role="dialog" aria-label="Assistant" onMouseDown={(event) => event.stopPropagation()}>
        <header className="assistant-header">
          <div>
            <div className="eyebrow">ASSISTANT</div>
            <h2>{clientName || "This client"}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close assistant">×</button>
        </header>
        <p className="assistant-banner">{meta?.notice || "The external model is not configured."}</p>
        <p className="books-note">Suggestions are labeled AI-generated. A person posts any journal. This build uses synthetic clients and does not train on them.</p>
        <div className="assistant-prompts">
          {prompts.map((item) => (
            <button type="button" className="text-button" key={item} onClick={() => ask(item)}>{item}</button>
          ))}
        </div>
        <div className="assistant-log">
          {turns.map((turn) => (
            <article key={turn.id}>
              {turn.prompt ? <p className="assistant-ask">{turn.prompt}</p> : null}
              <p>{turn.answer}</p>
              {turn.label ? <span className={`badge ${turn.label === "AI-generated" ? "amber" : "green"}`}>{turn.label}</span> : null}
              {turn.confidence ? <span className="badge">{confidenceLabel(turn.confidence)}</span> : null}
              {turn.suggestions?.length ? (
                <ul className="assistant-suggestions">
                  {turn.suggestions.map((suggestion) => (
                    <li key={`${suggestion.transactionId || suggestion.description}`}>
                      <span className="badge amber">{suggestion.label || "AI-generated"}</span>
                      <span className="badge">{confidenceLabel(suggestion.confidence)}</span>
                      <span>{suggestion.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {turn.draft ? (
                <div className="assistant-draft">
                  <div>
                    <span className="badge amber">{turn.draft.label}</span>
                    <span className="badge">{confidenceLabel(turn.draft.confidence)}</span>
                  </div>
                  <p>{turn.draft.memo}</p>
                  <ul>
                    {turn.draft.lines.map((line) => (
                      <li key={`${line.accountId}-${line.debit}-${line.credit}`}>
                        {line.debit ? `Debit ${line.debit}` : `Credit ${line.credit}`} {line.accountCode} {line.accountName}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="button primary" onClick={() => useDraft(turn)}><span>Use this draft</span></button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <form className="assistant-form" onSubmit={(event) => { event.preventDefault(); ask(prompt); }}>
          <label className="field">
            <span>Question</span>
            <input aria-label="Question for the assistant" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button className="button primary" type="submit" disabled={pending || !prompt.trim()}><span>{pending ? "Asking…" : "Ask"}</span></button>
        </form>
      </aside>
    </div>
  );
}
