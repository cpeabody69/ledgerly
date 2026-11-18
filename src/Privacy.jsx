import { useEffect } from "react";
import { Brand } from "./AuthScreens.jsx";

export function Privacy({ go }) {
  useEffect(() => {
    const previous = document.title;
    document.title = "Privacy Policy · Avenue";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="terms-page">
      <article className="terms-card">
        <Brand />
        <h1>Privacy Policy</h1>
        <p className="lede">
          This notice describes what a Avenue workspace keeps for a CPA firm. It is sample product language. It is not a real legal policy, and it is not legal advice.
        </p>
        <p className="terms-date">Sample notice · March 2, 2026</p>

        <h2>What the firm stores</h2>
        <p>
          A firm account stores a name, a work email, and a password. The workspace also stores the client books, documents, notes, and the bank or ledger records that firm enters, so the firm can open them again.
        </p>
        <p>
          Avenue keeps those records in its database for that account. This build does not send the work email to an outside email provider.
        </p>

        <h2>Client data stays in that firm</h2>
        <p>
          Client records stay with the firm that created them. Avenue does not open one firm’s clients to another firm. A person sees a client only when their role includes that client.
        </p>

        <h2>Sandbox bank and QuickBooks connections</h2>
        <p>
          Bank links and QuickBooks connections in this application run in sandbox or test mode. They exchange sample or test records. They do not move money at a real bank, and they are not the client’s live books.
        </p>

        <h2>Not a legal policy</h2>
        <p>
          This page is sample language for the product. It was not written as a privacy policy for a lawyer to rely on, and it does not change the firm’s duties to its clients. If you do not accept it, do not create the account.
        </p>

        <p className="auth-links">
          <button type="button" className="text-button" onClick={() => go("/")}>Back to sign in</button>
          <button type="button" className="text-button" onClick={() => go("/register")}>Create a firm account</button>
        </p>
      </article>
    </div>
  );
}
