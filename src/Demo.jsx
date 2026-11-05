import { useEffect, useState } from "react";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export function Demo({ onSession }) {
  const [page, setPage] = useState(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/demo");
    const body = await readJson(response);
    if (!response.ok) {
      setError(body.error || "The demo could not be loaded.");
      return;
    }
    setPage(body);
    setError("");
  }

  useEffect(() => {
    load().catch(() => setError("The demo could not be loaded."));
  }, []);

  async function run(path) {
    setPending(path);
    setError("");
    try {
      const response = await fetch(path, { method: "POST" });
      const body = await readJson(response);
      if (!response.ok) {
        setError(body.error || "That action did not finish.");
        return;
      }
      if (body.session) onSession?.(body.session);
      setPage(body);
    } catch {
      setError("That action did not finish.");
    } finally {
      setPending("");
    }
  }

  return (
    <div className="demo-page">
      <header className="demo-heading">
        <h1>Fictional demo</h1>
        <p>{page?.notice || "These businesses are fictional."}</p>
      </header>
      <section className="queue-cards">
        <div className="queue-card">
          <span>Scenarios</span>
          <strong>{page ? page.scenarioCount : "…"}</strong>
        </div>
        <div className="queue-card">
          <span>Last result</span>
          <strong>{page?.lastResult ? (page.lastResult.passed ? "Pass" : "Fail") : "Not run"}</strong>
        </div>
      </section>
      <div className="demo-actions">
        <button className="button secondary" type="button" disabled={Boolean(pending)} onClick={() => run("/api/demo/reset")}>
          {pending === "/api/demo/reset" ? "Restoring…" : "Reset demo data"}
        </button>
        <button className="button primary" type="button" disabled={Boolean(pending)} onClick={() => run("/api/demo/checks")}>
          {pending === "/api/demo/checks" ? "Running…" : "Run accounting checks"}
        </button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {page?.lastResult ? (
        <section className="card demo-result">
          <h2>{page.lastResult.passed ? "Pass" : "Fail"}</h2>
          <p>{page.lastResult.summary} · {page.lastResult.createdAtLabel}</p>
          <ul>
            {page.lastResult.checks.map((check) => (
              <li key={check.name}>
                <b>{check.passed ? "Pass" : "Fail"}</b>
                <span>{check.name}</span>
                <small>{check.detail}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : <p className="demo-note">No checks have been stored yet.</p>}
      <div className="demo-scenarios">
        {(page?.scenarios || []).map((scenario) => (
          <section className="card" key={scenario.id}>
            <h2>{scenario.name}</h2>
            <p>{scenario.model} · {scenario.summary}</p>
            <p className="demo-note">
              {scenario.customers} customers · {scenario.vendors} vendors · {scenario.invoices} invoices · {scenario.bills} bills · {scenario.expenses} expenses · {scenario.bankLines} bank lines ({scenario.reconciled} reconciled, {scenario.unreconciled} open) · {scenario.documents} documents ({scenario.needsReview} need review) · {scenario.openRequests} open requests
            </p>
          </section>
        ))}
      </div>
      {page ? (
        <p className="demo-note">
          Sign in as {page.signIn.email} / {page.signIn.password} to open these books. The accounts are not live bank connections.
        </p>
      ) : null}
    </div>
  );
}
