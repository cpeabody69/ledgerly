import { useEffect, useState } from "react";
import { SubscribeGate } from "./Subscription.jsx";

const TERMS = "I agree to the Ledgerly Terms of Use for this workspace. This records acceptance for the account. It is not a legal opinion or a signed engagement letter.";
const PRIVACY = "I agree to the Ledgerly Privacy notice. This build stores the account in its database. It does not send the address to an email provider.";

function Brand() {
  return (
    <div className="sign-in-brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>Ledgerly</span>
    </div>
  );
}

function MailNote() {
  return (
    <p className="mail-note">
      Email delivery is not configured. Ledgerly stores the link in a local development mailbox on this machine. That mailbox is not a connected mail provider.
    </p>
  );
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function tokenFromLocation() {
  return new URLSearchParams(window.location.search).get("token") || "";
}

// React StrictMode runs the verify effect twice. One shared request keeps the single-use token intact.
const verificationRequests = new Map();

function requestEmailVerification(token) {
  if (!verificationRequests.has(token)) {
    verificationRequests.set(
      token,
      fetch("/api/email-verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }).then((response) => readJson(response)),
    );
  }
  return verificationRequests.get(token);
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ErrorText({ error }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
}

export function PublicAuth({ path, go, onSession }) {
  if (path === "/register") return <Register go={go} />;
  if (path === "/forgot-password") return <Forgot go={go} />;
  if (path === "/reset-password") return <Reset go={go} />;
  if (path === "/verify-email") return <Verify go={go} onSession={onSession} />;
  if (path === "/invitation") return <Invitation go={go} onSession={onSession} />;
  return <SignIn go={go} onSession={onSession} />;
}

export function SignIn({ go, onSession }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const { response, body } = await readJson(await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }));
      if (!response.ok) {
        setError(body.error || "Email or password is incorrect.");
        return;
      }
      onSession(body);
      go("/");
    } catch {
      setError("Could not reach Ledgerly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sign-in">
      <form onSubmit={submit}>
        <Brand />
        <h1>Sign in</h1>
        <p className="lede">Sign in to Ledgerly. Firm staff and invited clients use the same page.</p>
        <Field label="Email">
          <input name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <ErrorText error={error} />
        <button className="button primary" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
        <p className="auth-links">
          <button type="button" className="text-button" onClick={() => go("/forgot-password")}>Forgot password</button>
          <button type="button" className="text-button" onClick={() => go("/register")}>Create a firm account</button>
        </p>
        <p className="mail-note">Client portal accounts are not created here. A firm sends an invitation.</p>
      </form>
    </div>
  );
}

function Mailbox({ email }) {
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    const { response, body } = await readJson(await fetch(`/api/dev/mailbox?email=${encodeURIComponent(email)}`));
    if (!response.ok) {
      setError(body.error || "The development mailbox is not available.");
      setMessages([]);
      return;
    }
    setMessages(body.messages || []);
  }

  return (
    <div className="mailbox">
      <MailNote />
      <button className="button secondary" type="button" onClick={load}>Read the development mailbox</button>
      <ErrorText error={error} />
      {messages ? messages.map((message) => (
        <a key={message.id} href={message.linkPath}>{message.subject}</a>
      )) : null}
      {messages && !messages.length ? <p className="lede">No message is stored for that address yet.</p> : null}
    </div>
  );
}

function Register({ go }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    acceptTerms: false,
    acceptPrivacy: false,
  });
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [pending, setPending] = useState(false);

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const { response, body } = await readJson(await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, accountType: "firm" }),
      }));
      if (!response.ok) {
        setError(body.error || "The account could not be created.");
        return;
      }
      setDone(body);
    } catch {
      setError("Could not reach Ledgerly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sign-in">
      <form className="auth-wide" onSubmit={submit}>
        <Brand />
        <h1>Create a firm account</h1>
        <p className="lede">This registration is for an accounting firm. Clients join only from an invitation.</p>
        {done ? (
          <>
            <p>{done.message}</p>
            {done.devMailbox ? <Mailbox email={done.email} /> : <MailNote />}
            <button className="button secondary" type="button" onClick={() => go("/")}>Back to sign in</button>
          </>
        ) : (
          <>
            <Field label="Full name">
              <input value={form.name} onChange={(event) => set("name", event.target.value)} autoComplete="name" required />
            </Field>
            <Field label="Work email">
              <input type="email" value={form.email} onChange={(event) => set("email", event.target.value)} autoComplete="username" required />
            </Field>
            <Field label="Password">
              <input type="password" value={form.password} onChange={(event) => set("password", event.target.value)} autoComplete="new-password" required />
            </Field>
            <Field label="Confirm password">
              <input type="password" value={form.confirmPassword} onChange={(event) => set("confirmPassword", event.target.value)} autoComplete="new-password" required />
            </Field>
            <label className="auth-check">
              <input type="checkbox" checked={form.acceptTerms} onChange={(event) => set("acceptTerms", event.target.checked)} />
              <span>{TERMS}</span>
            </label>
            <label className="auth-check">
              <input type="checkbox" checked={form.acceptPrivacy} onChange={(event) => set("acceptPrivacy", event.target.checked)} />
              <span>{PRIVACY}</span>
            </label>
            <ErrorText error={error} />
            <button className="button primary" type="submit" disabled={pending}>{pending ? "Creating account…" : "Create account"}</button>
            <p className="auth-links">
              <button type="button" className="text-button" onClick={() => go("/")}>Already have an account</button>
            </p>
          </>
        )}
      </form>
    </div>
  );
}

function Verify({ onSession, go }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);

  useEffect(() => {
    const token = tokenFromLocation();
    if (!token) {
      setError("This verification link is not valid.");
      setPending(false);
      return;
    }
    let cancel = false;
    requestEmailVerification(token)
      .then(({ response, body }) => {
        if (cancel) return;
        if (!response.ok) {
          setError(body.error || "This verification link is not valid.");
          return;
        }
        if (body.needsSignIn) {
          go("/");
          return;
        }
        onSession(body);
        go("/onboarding");
      })
      .catch(() => {
        if (!cancel) setError("Could not reach Ledgerly.");
      })
      .finally(() => {
        if (!cancel) setPending(false);
      });
    return () => {
      cancel = true;
    };
  }, [go, onSession]);

  return (
    <div className="sign-in">
      <form>
        <Brand />
        <h1>Verify email</h1>
        <p className="lede">{pending ? "Checking the verification link." : error || "Email verified."}</p>
        <ErrorText error={error} />
      </form>
    </div>
  );
}

function Forgot({ go }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [showMailbox, setShowMailbox] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const { response, body } = await readJson(await fetch("/api/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }));
      if (!response.ok) {
        setError(body.error || "The reset could not be started.");
        return;
      }
      setMessage(body.message);
      setShowMailbox(Boolean(body.devMailbox));
    } catch {
      setError("Could not reach Ledgerly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sign-in">
      <form onSubmit={submit}>
        <Brand />
        <h1>Reset password</h1>
        <p className="lede">Enter the email on the account. The reply is the same whether or not that account exists.</p>
        <Field label="Email">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <ErrorText error={error} />
        {message ? <p>{message}</p> : null}
        {showMailbox ? <Mailbox email={email} /> : null}
        <button className="button primary" type="submit" disabled={pending}>{pending ? "Sending…" : "Create reset link"}</button>
        <p className="auth-links">
          <button type="button" className="text-button" onClick={() => go("/")}>Back to sign in</button>
        </p>
      </form>
    </div>
  );
}

function Reset({ go }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const { response, body } = await readJson(await fetch("/api/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokenFromLocation(), password, confirmPassword }),
      }));
      if (!response.ok) {
        setError(body.error || "The password was not changed.");
        return;
      }
      setMessage(body.message);
    } catch {
      setError("Could not reach Ledgerly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sign-in">
      <form onSubmit={submit}>
        <Brand />
        <h1>Choose a new password</h1>
        <Field label="New password">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password">
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorText error={error} />
        {message ? <p>{message}</p> : null}
        <button className="button primary" type="submit" disabled={pending || Boolean(message)}>Update password</button>
        <p className="auth-links">
          <button type="button" className="text-button" onClick={() => go("/")}>Sign in</button>
        </p>
      </form>
    </div>
  );
}

function Invitation({ onSession }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const token = tokenFromLocation();
    if (!token) {
      setError("This invitation is not valid.");
      return;
    }
    fetch("/api/invitations/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((response) => readJson(response))
      .then(({ response, body }) => {
        if (!response.ok) {
          setError(body.error || "This invitation is not valid.");
          return;
        }
        setPreview(body);
        setName(body.name || "");
      })
      .catch(() => setError("Could not reach Ledgerly."));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const { response, body } = await readJson(await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokenFromLocation(), name, password, confirmPassword }),
      }));
      if (!response.ok) {
        setError(body.error || "The invitation could not be accepted.");
        return;
      }
      onSession(body);
      window.history.pushState({}, "", "/");
      window.location.assign("/");
    } catch {
      setError("Could not reach Ledgerly.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="sign-in">
      <form className="auth-wide" onSubmit={submit}>
        <Brand />
        <h1>Client invitation</h1>
        {preview ? (
          <p className="lede">{preview.firmName} invited {preview.email} to the portal for {preview.clientName}.</p>
        ) : (
          <p className="lede">Opening the invitation.</p>
        )}
        <Field label="Your name">
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password">
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorText error={error} />
        <button className="button primary" type="submit" disabled={pending || !preview}>{pending ? "Joining…" : "Accept and open the portal"}</button>
      </form>
    </div>
  );
}

function monthName(index) {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][(Number(index) || 1) - 1] || "January";
}

export function OnboardingScreen({ session, onSession, go }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [firm, setFirm] = useState({
    firmName: "",
    businessType: "cpa_firm",
    country: "US",
    timeZone: "America/New_York",
    accountingMethod: "accrual",
    fiscalYearStart: 1,
  });
  const [client, setClient] = useState({ name: "", legalName: "", industry: "" });
  const [invite, setInvite] = useState({ name: "", email: "" });
  const [fileName, setFileName] = useState("sample-note.txt");

  useEffect(() => {
    fetch("/api/auth/config")
      .then((response) => response.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const checklist = session.checklist;
  const firmReady = Boolean(session.firm);

  async function post(url, body) {
    const { response, payload } = await readJson(await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    })).then(({ response, body: payload }) => ({ response, payload }));
    if (!response.ok) throw new Error(payload.error || "That could not be saved.");
    return payload;
  }

  async function saveFirm(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const payload = await post("/api/onboarding/firm", firm);
      onSession(payload);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  async function addClient(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const payload = await post("/api/clients", {
        name: client.name,
        legalName: client.legalName || client.name,
        industry: client.industry,
        businessType: "LLC",
        accountingMethod: session.firm?.accountingMethod || "accrual",
        fiscalYearStart: monthName(session.firm?.fiscalYearStart),
      });
      onSession(payload.session);
      setClient({ name: "", legalName: "", industry: "" });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  async function sendInvite(event) {
    event.preventDefault();
    const clientId = session.clients?.[0]?.id;
    if (!clientId) return;
    setPending(true);
    setError("");
    try {
      await post(`/api/clients/${clientId}/invitations`, invite);
      setInvite({ name: "", email: "" });
      setError("");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  async function setStep(step, status) {
    setError("");
    try {
      const payload = await post("/api/onboarding/step", { step, status });
      if (payload.checklist && !payload.onboarding) onSession({ ...session, checklist: payload.checklist });
      else if (payload.user) onSession(payload);
      else {
        const refreshed = await readJson(await fetch("/api/session"));
        if (refreshed.response.ok) onSession(refreshed.body);
      }
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function uploadSample() {
    const clientId = session.clients?.[0]?.id;
    if (!clientId) return;
    setError("");
    try {
      await post("/api/documents", {
        clientId,
        name: fileName || "sample-note.txt",
        mediaType: "text/plain",
        contentBase64: btoa("Synthetic sample document for onboarding."),
      });
      const refreshed = await readJson(await fetch("/api/session"));
      if (refreshed.response.ok) onSession(refreshed.body);
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function enter() {
    setPending(true);
    setError("");
    try {
      const payload = await post("/api/onboarding/enter", {});
      onSession(payload);
      go("/");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  const needsPlan = firmReady && session.subscription && !session.subscription.allowsWork;
  if (needsPlan) {
    return (
      <div className="sign-in onboarding-page">
        <div className="auth-wide gate-card">
          <Brand />
          <h1>{session.firm.name}</h1>
          <p className="lede">Choose a plan and a seat count. New work stays closed until the Stripe test subscription is active. No real charge is made.</p>
          <SubscribeGate onSession={onSession} />
          {!session.onboarding ? <button className="button ghost" type="button" onClick={() => go("/")}>Back to the books</button> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="sign-in onboarding-page">
      <form className="auth-wide" onSubmit={firmReady ? (event) => event.preventDefault() : saveFirm}>
        <Brand />
        <h1>{firmReady ? session.firm.name : "Set up the firm"}</h1>
        <p className="lede">You are the organization owner. Optional checklist steps can be skipped and resumed later.</p>
        {!firmReady ? (
          <>
            <Field label="Firm name">
              <input value={firm.firmName} onChange={(event) => setFirm({ ...firm, firmName: event.target.value })} required />
            </Field>
            <Field label="Business type">
              <select value={firm.businessType} onChange={(event) => setFirm({ ...firm, businessType: event.target.value })}>
                {(config?.businessTypes || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Country">
              <select value={firm.country} onChange={(event) => setFirm({ ...firm, country: event.target.value })}>
                {(config?.countries || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Time zone">
              <select value={firm.timeZone} onChange={(event) => setFirm({ ...firm, timeZone: event.target.value })}>
                {(config?.timeZones || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Accounting method">
              <select value={firm.accountingMethod} onChange={(event) => setFirm({ ...firm, accountingMethod: event.target.value })}>
                {(config?.accountingMethods || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Fiscal year starts">
              <select value={firm.fiscalYearStart} onChange={(event) => setFirm({ ...firm, fiscalYearStart: Number(event.target.value) })}>
                {(config?.fiscalYearMonths || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
            <button className="button primary" type="submit" disabled={pending || !config}>Create organization</button>
          </>
        ) : (
          <ol className="checklist">
            {(checklist?.steps || []).map((step) => (
              <li key={step.id} className={`check-step ${step.status}`}>
                <div>
                  <b>{step.label}</b>
                  <small>{step.status === "complete" ? "Complete" : step.status === "skipped" ? "Skipped" : "Not done"}{step.optional ? " · Optional" : ""}</small>
                </div>
                {step.optional && step.status !== "complete" ? (
                  <button className="button secondary" type="button" onClick={() => setStep(step.id, step.status === "skipped" ? "pending" : "skipped")}>
                    {step.status === "skipped" ? "Resume" : "Skip"}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {firmReady ? (
          <div className="checklist-actions">
            <h2>Add a client</h2>
            <Field label="Client name">
              <input value={client.name} onChange={(event) => setClient({ ...client, name: event.target.value })} />
            </Field>
            <Field label="Legal name">
              <input value={client.legalName} onChange={(event) => setClient({ ...client, legalName: event.target.value })} />
            </Field>
            <Field label="Industry">
              <input value={client.industry} onChange={(event) => setClient({ ...client, industry: event.target.value })} />
            </Field>
            <button className="button secondary" type="button" onClick={addClient} disabled={pending || !client.name.trim()}>Add client</button>
            {session.clients?.length ? (
              <>
                <h2>Invite the client portal</h2>
                <Field label="Contact name">
                  <input value={invite.name} onChange={(event) => setInvite({ ...invite, name: event.target.value })} />
                </Field>
                <Field label="Contact email">
                  <input type="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} />
                </Field>
                <button className="button secondary" type="button" onClick={sendInvite} disabled={pending}>Send invitation</button>
                {invite.email.includes("@") ? <Mailbox email={invite.email} /> : <MailNote />}
                <h2>Sample document</h2>
                <Field label="File name">
                  <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
                </Field>
                <button className="button secondary" type="button" onClick={uploadSample}>Upload sample</button>
              </>
            ) : null}
            <button className="button primary" type="button" onClick={enter} disabled={pending || !session.clients?.length}>Open the workspace</button>
            {!session.onboarding ? <button className="button ghost" type="button" onClick={() => go("/")}>Back to workspace</button> : null}
          </div>
        ) : null}
        <ErrorText error={error} />
      </form>
    </div>
  );
}

export function ChecklistBanner({ session, go }) {
  const steps = session.checklist?.steps || [];
  const open = steps.filter((step) => step.status !== "complete");
  if (!open.length) return null;
  return (
    <div className="onboarding-banner">
      <span>{open.length} onboarding {open.length === 1 ? "step" : "steps"} still open. Skipped steps can be resumed.</span>
      <button className="button secondary" type="button" onClick={() => go("/onboarding")}>Resume checklist</button>
    </div>
  );
}
