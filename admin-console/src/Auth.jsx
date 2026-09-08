import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react";
import { api } from "./api";

const shell =
  "min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-white via-slate-50 to-[#eef0f8]";
const cardCls =
  "w-full max-w-md bg-white rounded-3xl px-9 py-10 shadow-[0_20px_60px_-20px_rgba(15,23,41,0.18)]";
const fieldLabel = "eyebrow text-slate-400";
const fieldWrap = "relative mt-2";
const fieldIcon = "absolute left-4 top-1/2 -translate-y-1/2 text-slate-400";
const fieldInput =
  "w-full bg-slate-100/80 rounded-xl border border-transparent pl-11 pr-4 py-3.5 text-[15px] font-semibold text-ink placeholder:text-slate-400 placeholder:font-semibold outline-none focus:bg-white focus:border-brand-500 transition";
const bigButton =
  "w-full mt-7 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-[15px] font-bold rounded-xl py-4 flex items-center justify-center gap-2 shadow-[0_10px_25px_-8px_rgba(91,61,245,0.7)] transition";

function ErrorNote({ children }) {
  return (
    <div className="mb-5 text-xs font-semibold bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3">
      {children}
    </div>
  );
}

function Crest({ emoji, logo }) {
  return (
    <div className="w-[104px] h-[104px] rounded-[28px] bg-white border border-slate-100 shadow-[0_8px_24px_-10px_rgba(15,23,41,0.25)] grid place-items-center text-[46px] leading-none overflow-hidden">
      {logo
        ? <img src={logo} alt="School logo" className="w-full h-full object-contain p-2" />
        : <span role="img" aria-hidden="true">{emoji}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Login({ onLogin, onSetupClick }) {
  const [mode, setMode] = useState("login"); // "login" | "forgot"
  const [schoolId, setSchoolId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // {name, logo_key} once a real match is found
  const debounceRef = useRef(null);

  // Debounced, not live-per-keystroke: a lookup fires 400ms after typing
  // stops, and only for a plausible School ID shape, so the office isn't
  // hammering the (rate-limited, but still) public endpoint on every
  // keystroke while typing "vidya-mandir" out one letter at a time.
  useEffect(() => {
    clearTimeout(debounceRef.current);
    const code = schoolId.trim().toLowerCase();
    if (code.length < 2) { setPreview(null); return; }

    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.get(`/auth/schools/${encodeURIComponent(code)}`);
        setPreview(result);
      } catch {
        setPreview(null);
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [schoolId]);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onLogin(schoolId.trim().toLowerCase(), email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "forgot") {
    return <ForgotPasswordForm onBack={() => setMode("login")} />;
  }

  return (
    <div className={shell}>
      <div className={cardCls}>
        <div className="flex flex-col items-center mb-8">
          <Crest emoji="🎓" logo={preview?.logo_data_url || null} />
          <h1 className="text-[28px] font-extrabold tracking-tight mt-5 text-center leading-tight">
            {preview ? preview.name : "School Portal"}
          </h1>
          <p className="text-sm text-slate-500 mt-1">Secure Fee Administration Gateway</p>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        <form onSubmit={submit}>
          <div className="mb-5">
            <label className={fieldLabel}>School ID</label>
            <div className={fieldWrap}>
              <Building2 className={fieldIcon} size={17} />
              <input required value={schoolId} onChange={(e) => setSchoolId(e.target.value)}
                placeholder="e.g. school-id" className={fieldInput} />
            </div>
          </div>

          <div className="mb-5">
            <label className={fieldLabel}>Admin Username</label>
            <div className={fieldWrap}>
              <UserIcon className={fieldIcon} size={17} />
              <input required value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="Mail ID" className={fieldInput} />
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <label className={fieldLabel}>Password</label>
              <button type="button" className="eyebrow text-brand-600 hover:text-brand-700"
                onClick={() => setMode("forgot")}>
                Forgot?
              </button>
            </div>
            <div className={fieldWrap}>
              <Lock className={fieldIcon} size={17} />
              <input required type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" className={fieldInput} />
            </div>
          </div>

          <button type="submit" disabled={busy} className={bigButton}>
            {busy ? <Loader2 className="animate-spin" size={17} /> : null}
            Enter Portal
            {!busy && <ArrowRight size={17} />}
          </button>
        </form>

        <div className="border-t border-slate-100 mt-8 pt-6 text-center">
          <button onClick={onSetupClick} className="eyebrow text-brand-600 hover:text-brand-700">
            Platform Setup
          </button>
          <p className="eyebrow text-emerald-600 flex items-center justify-center gap-1.5 mt-4">
            <ShieldCheck size={13} /> AES-256 cloud encryption active
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ForgotPasswordForm({ onBack }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/password-reset", { email: email.trim() });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={shell}>
      <div className={cardCls}>
        <button onClick={onBack}
          className="flex items-center gap-1.5 eyebrow text-slate-400 hover:text-slate-600 mb-5">
          <ArrowLeft size={13} /> Back to sign in
        </button>

        <div className="flex flex-col items-center mb-8">
          <Crest emoji="🔑" />
          <h1 className="text-[26px] font-extrabold tracking-tight mt-5 text-center">Reset your password</h1>
          <p className="text-sm text-slate-500 mt-1 text-center">
            Enter the email your account uses. If it has an account here, we'll send a reset link.
          </p>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {done ? (
          <div className="text-sm font-semibold bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-4 py-4 text-center">
            If that email has an account, a reset link is on its way. It works for 24 hours.
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="mb-5">
              <label className={fieldLabel}>Email</label>
              <div className={fieldWrap}>
                <Mail className={fieldIcon} size={17} />
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@school.edu.in" className={fieldInput} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={bigButton}>
              {busy ? <Loader2 className="animate-spin" size={17} /> : null}
              Send reset link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Rendered when the URL is /reset-password?uid=...&token=..., the link
 * a reset email actually points at — see makeAndSendCredentialEmail in
 * server/routes/auth.ts. App.jsx checks for this path before anything
 * else, including the signed-in-session check, since resetting a
 * password is exactly the thing someone does when they can't sign in.
 */
export function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) return setError("Password must be at least 12 characters.");
    if (password !== confirm) return setError("The two passwords do not match.");

    const params = new URLSearchParams(window.location.search);
    setBusy(true);
    try {
      await api.post("/auth/password-reset/confirm", {
        uid: params.get("uid"), token: params.get("token"), new_password: password,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={shell}>
      <div className={cardCls}>
        <div className="flex flex-col items-center mb-8">
          <Crest emoji="🔒" />
          <h1 className="text-[26px] font-extrabold tracking-tight mt-5 text-center">Set a new password</h1>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {done ? (
          <div className="text-center">
            <div className="text-sm font-semibold bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-4 py-4 mb-6">
              Password updated. You can sign in now.
            </div>
            <button onClick={onDone} className={bigButton}>Go to sign in</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="mb-4">
              <label className={fieldLabel}>New password</label>
              <div className={fieldWrap}>
                <Lock className={fieldIcon} size={17} />
                <input required type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 12 characters" className={fieldInput} />
              </div>
            </div>
            <div>
              <label className={fieldLabel}>Confirm password</label>
              <div className={fieldWrap}>
                <Lock className={fieldIcon} size={17} />
                <input required type="password" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••" className={fieldInput} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={bigButton}>
              {busy ? <Loader2 className="animate-spin" size={17} /> : null}
              Set new password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Setup({ onDone, onBack, canGoBack }) {
  const [f, setF] = useState({
    name: "", code: "", address: "", adminName: "",
    email: "", password: "", confirm: "", setupKey: "",
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!/^[a-z0-9-]{2,}$/.test(f.code.trim().toLowerCase()))
      return setError("School ID needs at least 2 characters: lowercase letters, numbers, or hyphens.");
    if (f.password.length < 12) return setError("Password must be at least 12 characters.");
    if (f.password !== f.confirm) return setError("The two passwords do not match.");
    if (!f.setupKey.trim()) return setError("Enter the setup key.");

    setBusy(true);
    try {
      await onDone({
        school_name: f.name.trim(), short_code: f.code.trim().toLowerCase(),
        address: f.address.trim(), owner_full_name: f.adminName.trim(),
        owner_email: f.email.trim(), owner_password: f.password,
        setup_key: f.setupKey.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the school.");
      setBusy(false);
    }
  }

  const row = (lbl, key, Icon, props = {}) => (
    <div className="mb-4">
      <label className={fieldLabel}>{lbl}</label>
      <div className={fieldWrap}>
        <Icon className={fieldIcon} size={17} />
        <input value={f[key]} onChange={set(key)} className={fieldInput} {...props} />
      </div>
    </div>
  );

  return (
    <div className={shell}>
      <div className={cardCls}>
        {canGoBack && (
          <button onClick={onBack}
            className="flex items-center gap-1.5 eyebrow text-slate-400 hover:text-slate-600 mb-5">
            <ArrowLeft size={13} /> Back to login
          </button>
        )}

        <div className="flex flex-col items-center mb-8">
          <Crest emoji="🏫" />
          <h1 className="text-[26px] font-extrabold tracking-tight mt-5">Platform Setup</h1>
          <p className="text-sm text-slate-500 mt-1 text-center">
            Creates the school and its first administrator.
          </p>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        <form onSubmit={submit}>
          {row("School Name", "name", Building2, { required: true, placeholder: "Vidya Mandir Public School" })}
          {row("School ID", "code", KeyRound, { required: true, placeholder: "vidya-mandir" })}
          {row("Address", "address", Building2, { placeholder: "48, 4th Cross, Jayanagar" })}
          {row("Administrator Name", "adminName", UserIcon, { required: true, placeholder: "R. Krishnamurthy" })}
          {row("Admin Mail ID", "email", Mail, { required: true, type: "email", placeholder: "principal@school.edu.in" })}
          {row("Password", "password", Lock, { required: true, type: "password", placeholder: "••••••••" })}
          {row("Confirm Password", "confirm", Lock, { required: true, type: "password", placeholder: "••••••••" })}

          <div className="mb-1">
            <label className={fieldLabel}>Setup Key</label>
            <div className={fieldWrap}>
              <ShieldCheck className={fieldIcon} size={17} />
              <input required type="password" value={f.setupKey} onChange={set("setupKey")}
                placeholder="Provided by whoever manages this deployment" className={fieldInput} />
            </div>
            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
              Checked against the server's own ADMIN_SETUP_TOKEN — never reaches this
              screen from anywhere but you typing it in. Ask whoever set up this
              deployment for it.
            </p>
          </div>

          <button type="submit" disabled={busy} className={bigButton}>
            {busy ? <Loader2 className="animate-spin" size={17} /> : null}
            Create School Workspace
            {!busy && <ArrowRight size={17} />}
          </button>
        </form>
      </div>
    </div>
  );
}
