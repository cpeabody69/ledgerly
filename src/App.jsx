import { useEffect, useState } from "react";
import { Te } from "./Shell.jsx";

export function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    let cancel = false;
    fetch("/api/session")
      .then(async (response) => {
        if (cancel) return;
        if (!response.ok) {
          setSession(null);
          return;
        }
        setSession(await response.json());
      })
      .catch(() => {
        if (!cancel) setSession(null);
      });
    return () => {
      cancel = true;
    };
  }, []);

  if (session === undefined) return <div className="sign-in" />;
  if (!session) return <SignIn onSession={setSession} />;
  return <Te session={session} onSession={setSession} />;
}

function SignIn({ onSession }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextEmail = String(data.get("email") || email);
    const nextPassword = String(data.get("password") || password);
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: nextEmail, password: nextPassword }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || "Email or password is incorrect.");
        return;
      }
      onSession(body);
    } catch {
      setError("Could not reach Ledgerly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sign-in">
      <form onSubmit={submit}>
        <div className="sign-in-brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>Ledgerly</span>
        </div>
        <h1>Sign in</h1>
        <p className="lede">Open your firm and the client books you work on.</p>
        <label className="field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="button primary" type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
