import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Field } from "../ui";
import { TopControls } from "../App";

export default function Login() {
  const { t, tt } = useI18n();
  const { signIn } = useSession();
  const [f, setF] = useState(() => ({ tenant: (() => { try { return localStorage.getItem("ge.tenant") ?? ""; } catch { return ""; } })(), email: "", password: "", otp: "" }));
  const [needOtp, setNeedOtp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api.post("/auth/login", { tenant: f.tenant.trim().toLowerCase(), email: f.email.trim(), password: f.password, ...(f.otp ? { otp: f.otp } : {}) });
      try { localStorage.setItem("ge.tenant", f.tenant.trim().toLowerCase()); } catch { /* not persisted */ }
      await signIn(r);
    } catch (x: any) {
      if (x?.code === "MFA_REQUIRED") setNeedOtp(true);
      setErr(x);
    } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="card login grid" onSubmit={submit}>
        <div className="row"><div className="brand" style={{ padding: 0 }}><div className="logo">G</div><div><b>{t.app}</b><small>{t.tagline}</small></div></div><span className="spacer" /><TopControls /></div>
        <h1>{t.login}</h1>
        <ErrorBox error={err} />
        <Field label={t.tenant}><input required value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} placeholder="golden-chips" dir="ltr" autoComplete="organization" /></Field>
        <Field label={t.email}><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} dir="ltr" autoComplete="username" /></Field>
        <Field label={t.password}><input required type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} dir="ltr" autoComplete="current-password" /></Field>
        {needOtp && <Field label={t.otp}><input inputMode="numeric" pattern="\d{6}" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value })} dir="ltr" autoFocus autoComplete="one-time-code" /></Field>}
        <button className="btn primary" disabled={busy}>{busy ? t.signingIn : t.login}</button>
        <a href="/signup" className="btn" style={{ justifyContent: "center", textDecoration: "none" }}>{tt("جرّب مجانًا — أنشئ حساب شركتك", "Start a free trial")}</a>
        <a href="/platform" style={{ fontSize: 12, textAlign: "center" }}>{t.platform}</a>
      </form>
    </div>
  );
}
