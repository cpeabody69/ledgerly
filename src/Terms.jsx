import { useEffect } from "react";
import { Brand } from "./AuthScreens.jsx";

export function Terms({ go }) {
  useEffect(() => {
    const previous = document.title;
    document.title = "Terms of Service · Ledgerly";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="terms-page">
      <article className="terms-card">
        <Brand />
        <h1>Terms of Service</h1>
        <p className="lede">
          These terms describe the Ledgerly workspace for a CPA firm. They are sample product language for this application. They are not legal advice, and they are not an engagement letter.
        </p>
        <p className="terms-date">Effective March 2, 2026</p>

        <h2>Accounts</h2>
        <p>
          A firm account is opened with a name, a work email, and a password. Keep the password to the people who should use that account. The firm owner is responsible for who is invited, and for removing access when someone should no longer see the books.
        </p>
        <p>
          Clients do not create their own accounts. A client portal account exists only after the firm sends an invitation and the client accepts it. Ledgerly may close an account that sits unused, or that is used to store records the firm has no right to keep.
        </p>

        <h2>Client data</h2>
        <p>
          The firm enters client books, documents, and notes so it can do its work. Those records stay with the firm that created them. Enter only information the firm is allowed to hold, and open a client only when your role includes that client.
        </p>
        <p>
          Ledgerly stores the records so the firm can retrieve them. It does not use a client’s books to offer advice, and it does not treat the workspace as a filing cabinet shared across firms.
        </p>

        <h2>No legal advice</h2>
        <p>
          Ledgerly is software. It does not practice law, tax, or accounting. Screens, checklists, reports, and these terms are tools for the firm. They are not an opinion, a return, a filing, or a signed engagement. The firm and its licensed people remain responsible for the work they deliver.
        </p>

        <h2>Sandbox integrations</h2>
        <p>
          Bank links, payment tools, and ledger connections in this application run in sandbox or test mode. They exchange sample or test records. They do not move money at a real bank, and a test subscription does not charge a real card. Treat a sandbox link as a practice connection, not as the client’s live books.
        </p>

        <h2>Acceptance</h2>
        <p>
          Creating a firm account accepts these terms for that workspace. If you do not accept them, do not create the account. Questions about a client’s work stay with the firm that owns the workspace.
        </p>

        <p className="auth-links">
          <button type="button" className="text-button" onClick={() => go("/")}>Back to sign in</button>
          <button type="button" className="text-button" onClick={() => go("/register")}>Create a firm account</button>
        </p>
      </article>
    </div>
  );
}
