import { ArrowRight, Check, Mail, RotateCcw, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/auth-context";
import { LoadingState } from "../components/route-states";
import { ApiError } from "../lib/api";

export const LOGIN_EMAIL_KEY = "agency-workload:login-email";
const genericMessage = "If an active account exists, a code will be sent.";

function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429)
    return "Too many attempts. Wait a minute and try again.";
  if (error instanceof ApiError && error.code === "invalid_code")
    return "That code is invalid or expired. Request a new one.";
  return "We could not complete that request. Please try again.";
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (auth.status === "loading") return <LoadingState />;
  if (auth.status === "authenticated") return <Navigate to="/schedule" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await auth.requestCode(email);
      window.sessionStorage.setItem(LOGIN_EMAIL_KEY, email.trim().toLowerCase());
      setMessage(response || genericMessage);
      navigate("/verify", { state: { requested: true } });
    } catch (requestError) {
      setError(authErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-layout">
      <section className="auth-editorial" aria-labelledby="login-title">
        <p className="eyebrow">Resource planning / private preview</p>
        <h1 id="login-title">Sign in to Agency Workload</h1>
        <p className="auth-lede">
          See who can start, when capacity opens, and where confirmed work creates pressure. No
          timesheets, payroll, or project accounting.
        </p>
        <dl className="auth-notes">
          <div>
            <dt>Invite only</dt>
            <dd>Your organization controls access. There is no public registration.</dd>
          </div>
          <div>
            <dt>Email ownership</dt>
            <dd>A short code proves access. Agency Workload keeps its own opaque session.</dd>
          </div>
        </dl>
      </section>
      <section className="auth-panel" aria-label="Email sign in">
        <div className="auth-panel-heading">
          <Mail aria-hidden="true" />
          <div>
            <p className="eyebrow">Step 1 of 2</p>
            <h2>Request a private code</h2>
          </div>
        </div>
        <form onSubmit={submit} className="stack-form">
          <label htmlFor="login-email">Work email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Requesting code..." : "Continue with email"}
            <ArrowRight aria-hidden="true" />
          </button>
        </form>
        {message ? <p className="form-notice">{message}</p> : null}
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <p className="privacy-note">
          <ShieldCheck aria-hidden="true" /> We do not reveal whether an address belongs to an
          account.
        </p>
      </section>
    </main>
  );
}

export function VerifyPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const email = window.sessionStorage.getItem(LOGIN_EMAIL_KEY);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(genericMessage);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(60);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  if (auth.status === "loading") return <LoadingState />;
  if (!email) return <Navigate to="/login" replace />;
  if (auth.status === "authenticated") return <Navigate to="/schedule" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== 6) {
      setError("Enter all six digits.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.verifyCode(email, code);
      window.sessionStorage.removeItem(LOGIN_EMAIL_KEY);
      navigate("/schedule", { replace: true });
    } catch (verifyError) {
      setError(authErrorMessage(verifyError));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      setNotice(await auth.requestCode(email));
      setCooldown(60);
    } catch (resendError) {
      setError(authErrorMessage(resendError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-layout verify-layout">
      <section className="auth-editorial" aria-labelledby="verify-title">
        <p className="eyebrow">Resource planning / private preview</p>
        <h1 id="verify-title">Enter your code</h1>
        <p className="auth-lede">
          Use the six digits from the latest Agency Workload message. Codes expire in ten minutes.
        </p>
        <p className="security-line">
          <Check aria-hidden="true" /> No sign-in links for email scanners to consume.
        </p>
      </section>
      <section className="auth-panel" aria-label="Verify email code">
        <p className="eyebrow">Step 2 of 2</p>
        <h2>Confirm email access</h2>
        <p className="form-notice">{notice}</p>
        <form onSubmit={submit} className="stack-form">
          <label htmlFor="login-code">Six-digit code</label>
          <input
            className="code-input"
            id="login-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Verifying..." : "Open workspace"}
            <ArrowRight aria-hidden="true" />
          </button>
        </form>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void resend()}
          disabled={busy || cooldown > 0}
        >
          <RotateCcw aria-hidden="true" />{" "}
          {cooldown > 0 ? `Resend available in ${cooldown}s` : "Request another code"}
        </button>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
