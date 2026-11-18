import { useState } from "react";
import { Brand } from "./AuthScreens.jsx";
import { InterestDialog } from "./DemoMode.jsx";

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
  const [dialog, setDialog] = useState("");

  async function openDemo() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/public-demo", { method: "POST" });
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
        <p className="lede">Three proposed plans. Checkout stays in Stripe test mode, and a live Stripe key is refused. This page does not charge a card. Avenue Pro subscriptions are separate from invoices a firm sends to its clients.</p>
        <ul className="product-list">
          <li><strong>Solo · $39/month</strong><span>One person. The seat count is fixed at one.</span></li>
          <li><strong>Practice · $79/month</strong><span>Up to three people.</span></li>
          <li><strong>Firm · $149/month</strong><span>Up to ten people.</span></li>
        </ul>
        <p>A signed-in test firm chooses a plan from the subscription screen. Payment failures in test mode mark the subscription past due and keep the books readable. Card numbers are not stored.</p>
      </Frame>
    );
  }

  if (path === "/demo") {
    return (
      <Frame>
        <p className="eyebrow">In development</p>
        <h1>Try Avenue Pro with a fictional firm</h1>
        <p className="lede">The demo opens immediately. It does not ask for an account, a card, or a bank connection. Avenue Pro is in development, and this firm is fictional.</p>
        <ul className="product-list">
          <li><strong>Isolated session</strong><span>Your visit gets its own temporary copy. It expires and is deleted.</span></li>
          <li><strong>Fictional books</strong><span>Twenty-five clients, three accountants, and statements calculated from those journals.</span></li>
          <li><strong>No production actions</strong><span>Uploads, payments, bank connections, external email, and production integrations stay off.</span></li>
        </ul>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="product-actions">
          <button className="button primary demo-cta" type="button" onClick={openDemo} disabled={pending}>{pending ? "Opening…" : "Try Free Demo"}</button>
          <button className="button secondary" type="button" onClick={() => setDialog("beta")}>Join the beta</button>
          <button className="button secondary" type="button" onClick={() => setDialog("personal")}>Request a personal demo</button>
        </div>
        {dialog ? <InterestDialog kind={dialog} onClose={() => setDialog("")} /> : null}
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
        <button className="button primary demo-cta" type="button" onClick={() => go("/demo")}>Try Free Demo</button>
        <button className="button secondary" type="button" onClick={() => go("/beta")}>Join the beta</button>
        <button className="button secondary" type="button" onClick={() => go("/sign-in")}>Sign in</button>
      </div>
      <p>Avenue Pro is in development. The demo uses a fictional firm and does not file a return or move money.</p>
    </Frame>
  );
}
