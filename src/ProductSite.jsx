import { useState } from "react";
import { Brand } from "./AuthScreens.jsx";

function Frame({ children }) {
  return (
    <div className="product-site">
      <header className="product-bar">
        <Brand />
        <nav className="product-nav" aria-label="Product">
          <a href="/pricing">Pricing</a>
          <a href="/demo">Demo</a>
          <a href="/beta">Beta</a>
          <a href="/sign-in">Sign in</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="product-foot">
        <span>Avenue Pro is a product of Avenue Software.</span>
        <nav>
          <a href="https://avenuesoftware.app">Avenue Software</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}

export function ProductSite({ path, go, onSession }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function openDemo() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/demo/enter", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || "The fictional demo could not be opened.");
        return;
      }
      onSession(body);
      go("/");
    } catch {
      setError("Could not reach Avenue Pro.");
    } finally {
      setPending(false);
    }
  }

  if (path === "/pricing") {
    return (
      <Frame>
        <h1>Avenue Pro pricing</h1>
        <p className="lede">Practice and Firm are the two plans. Checkout stays in Stripe test mode, and a live Stripe key is refused. No price is charged from this page.</p>
        <ul className="product-list">
          <li><strong>Practice</strong><span>The plan for a smaller firm. Seats are the Checkout quantity when a test price is configured.</span></li>
          <li><strong>Firm</strong><span>The plan for a larger firm. It uses its own test price id.</span></li>
        </ul>
        <p>Leave the Stripe test keys empty until checkout should open. Card numbers are not stored.</p>
      </Frame>
    );
  }

  if (path === "/demo") {
    return (
      <Frame>
        <h1>Fictional demo</h1>
        <p className="lede">The demo opens a fictional firm with fictional clients. It is not a client’s books, and the checks it runs are not an audit opinion.</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button primary" type="button" onClick={openDemo} disabled={pending}>{pending ? "Opening…" : "Open the fictional demo"}</button>
      </Frame>
    );
  }

  if (path === "/beta") {
    return (
      <Frame>
        <h1>Beta registration</h1>
        <p className="lede">A beta account is a firm account. Creating one does not enable live payments, a production bank connection, or tax filing.</p>
        <button className="button primary" type="button" onClick={() => go("/register")}>Create a firm account</button>
      </Frame>
    );
  }

  return (
    <Frame>
      <p className="eyebrow">Avenue Pro</p>
      <h1>The practice workspace for client books.</h1>
      <p className="lede">Avenue Pro keeps the ledger, close, billing, and client work for an accounting firm. It is part of Avenue Software and runs separately from Avenue Tax. It does not prepare or transmit a return.</p>
      <div className="product-actions">
        <button className="button primary" type="button" onClick={() => go("/beta")}>Join the beta</button>
        <button className="button secondary" type="button" onClick={() => go("/demo")}>Open the demo</button>
        <button className="button secondary" type="button" onClick={() => go("/sign-in")}>Sign in</button>
      </div>
    </Frame>
  );
}
