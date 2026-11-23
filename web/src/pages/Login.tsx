import { useState, type FormEvent } from "react";
import { Building2, UserRound, Lock, ShieldCheck, Factory, Truck, BarChart3, WifiOff, ArrowLeft, ArrowRight } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox } from "../ui";
import { Logo, TopControls } from "../shell";

/** the brand panel shared by login and signup */
export function AuthHero() {
  const { tt } = useI18n();
  const features = [
    { icon: Factory, t: tt("التصنيع والجودة وتتبع التشغيلات", "Manufacturing, quality & lot tracing") },
    { icon: Truck, t: tt("المناديب والتوزيع حتى بدون إنترنت", "Field sales, even offline") },
    { icon: BarChart3, t: tt("تقارير ولوحات تحليل لحظية", "Live reports & dashboards") },
    { icon: ShieldCheck, t: tt("محاسبة محمية وصلاحيات دقيقة", "Protected accounting & precise roles") },
  ];
  return <section className="auth-hero">
    <div className="row" style={{ gap: 12 }}><Logo size={46} /><div><b style={{ fontSize: 17, color: "#fff", letterSpacing: ".03em" }}>GOLDEN ERP</b>
      <div style={{ color: "#D9C7B4", fontSize: 13 }}>{tt("شركة الرقائق الذهبية لصناعة المواد الغذائية", "Golden Chips Food Industries")}</div></div></div>
    <div>
      <h1>{tt("إدارة شركتك ", "Run your whole company ")}<em>{tt("من مكان واحد", "from one place")}</em></h1>
      <p>{tt("المبيعات، المخازن، الإنتاج، المناديب، الرواتب والحسابات — مترابطة ودقيقة، على الكمبيوتر والجوال.",
        "Sales, inventory, production, field reps, payroll and accounting — connected and accurate, on desktop and mobile.")}</p>
      <div className="hero-features">{features.map((f) => <div key={f.t} className="hero-feature"><f.icon size={19} />{f.t}</div>)}</div>
    </div>
    <div className="hero-foot row" style={{ color: "#B9A48F", fontSize: 12.5, gap: 6 }}><WifiOff size={14} />{tt("تطبيق المندوب يعمل حتى مع ضعف الشبكة", "The rep app works even with a weak network")}</div>
  </section>;
}

const f0 = () => { try { return localStorage.getItem("ge.tenant") ?? ""; } catch { return ""; } };

export default function Login() {
  const { t, tt, lang } = useI18n();
  const { signIn } = useSession();
  const [f, setF] = useState(() => ({ tenant: ((import.meta as any).env?.VITE_DEFAULT_TENANT ?? "").trim().toLowerCase() || f0(), email: "", password: "", otp: "" }));
  const [needOtp, setNeedOtp] = useState(false);
  // the company code: fixed by the server (one-company installation) or remembered on this device after the first sign-in
  const fixedTenant = ((import.meta as any).env?.VITE_DEFAULT_TENANT ?? "").trim().toLowerCase();
  const [editTenant, setEditTenant] = useState(() => !fixedTenant && !f0());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api.post("/auth/login", { tenant: f.tenant.trim().toLowerCase(), login: f.email.trim(), password: f.password, ...(f.otp ? { otp: f.otp } : {}) });
      try { localStorage.setItem("ge.tenant", f.tenant.trim().toLowerCase()); } catch { /* remembered only as a convenience */ }
      await signIn(r);
    } catch (x: any) {
      if (x?.code === "MFA_REQUIRED") setNeedOtp(true);
      setErr(x);
    } finally { setBusy(false); }
  };
  const Go = lang === "ar" ? ArrowLeft : ArrowRight;
  const input = (icon: any, el: JSX.Element) => <div className="input-icon">{icon}{el}</div>;
  return <div className="auth">
    <AuthHero />
    <section className="auth-form">
      <div className="auth-card">
        <div className="auth-top"><span className="spacer" /><TopControls /></div>
        <h2>{tt("أهلًا بك", "Welcome back")}</h2>
        <p className="sub">{tt("سجّل الدخول لمتابعة عملك", "Sign in to continue")}</p>
        <form onSubmit={submit}>
          <ErrorBox error={err} />
          {editTenant ? <div className="field"><label>{t.tenant}</label>{input(<Building2 size={18} />, <input required value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })}
            placeholder="golden-chips" dir="ltr" autoComplete="organization" autoCapitalize="none" />)}</div>
            : !fixedTenant && <div className="tenant-chip"><Building2 size={16} /><span>{tt("الشركة:", "Company:")} <b dir="ltr">{f.tenant}</b></span>
              <button type="button" className="muted-link" onClick={() => setEditTenant(true)}>{tt("تغيير", "Change")}</button></div>}
          <div className="field"><label>{tt("اسم المستخدم", "Username")}</label>{input(<UserRound size={18} />, <input required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })}
            dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="cashier" />)}</div>
          <div className="field"><label>{t.password}</label>{input(<Lock size={18} />, <input required type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} dir="ltr" autoComplete="current-password" />)}</div>
          {needOtp && <div className="field"><label>{t.otp}</label>{input(<ShieldCheck size={18} />, <input inputMode="numeric" pattern="\d{6}" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value })} dir="ltr" autoFocus autoComplete="one-time-code" />)}</div>}
          <button className="btn primary" disabled={busy}>{busy ? t.signingIn : <>{t.login}<Go size={18} /></>}</button>
        </form>
        <div className="auth-alt">
          <a href="/signup" className="btn" style={{ width: "100%", textDecoration: "none" }}>{tt("جرّب مجانًا — أنشئ حساب شركتك", "Start a free trial")}</a>
          <a href="/platform" className="muted-link">{t.platform}</a>
        </div>
      </div>
    </section>
  </div>;
}
