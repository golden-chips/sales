import { useEffect, useState, type FormEvent } from "react";
import { api, fmt } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { ErrorBox, Field } from "../ui";
import { TopControls } from "../App";

const MOD_AR: Record<string, string> = { accounting: "المحاسبة", sales: "المبيعات", purchasing: "المشتريات", inventory: "المخازن", manufacturing: "التصنيع", quality: "الجودة",
  distribution: "المناديب", fleet: "الأسطول", hr: "الموارد البشرية", payroll: "الرواتب", crm: "العملاء", pos: "نقاط البيع", bi: "التقارير", core: "الأساسيات" };

export default function Signup() {
  const { tt, lang } = useI18n();
  const { signIn } = useSession();
  const [plans, setPlans] = useState<any[]>([]);
  const [f, setF] = useState({ companyName: "", code: "", ownerName: "", email: "", phone: "", password: "", acceptTerms: false });
  const [codeFree, setCodeFree] = useState<boolean | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/public/plans").then(setPlans, () => setPlans([])); }, []);
  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(f.code)) return setCodeFree(null);
    const t = setTimeout(() => api.get(`/public/code-available?code=${f.code}`).then((r) => setCodeFree(r.available), () => setCodeFree(null)), 350);
    return () => clearTimeout(t);
  }, [f.code]);
  const trial = plans.find((p) => p.is_trial_default);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api.post("/public/signup", f);
      try { localStorage.setItem("ge.tenant", r.tenantCode); } catch { /* not persisted */ }
      history.replaceState(null, "", "/");
      await signIn({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login-wrap" style={{ alignItems: "start", paddingTop: 32 }}>
      <div className="grid" style={{ width: "min(980px, 100%)", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", alignItems: "start" }}>
        <div className="card grid">
          <div className="row"><div className="brand" style={{ padding: 0 }}><div className="logo">G</div><div><b>GOLDEN ERP</b><small>{tt("نظام متكامل للمصانع والتجارة والتوزيع", "ERP for manufacturing, trading & distribution")}</small></div></div><span className="spacer" /><TopControls /></div>
          <h1>{trial ? tt(`جرّب مجانًا ${trial.trial_days} يومًا`, `Try free for ${trial.trial_days} days`) : tt("التجربة المجانية", "Free trial")}</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>{tt("بدون بطاقة دفع. تبدأ فورًا بدليل حسابات وسنة مالية جاهزين، وبياناتك معزولة تمامًا عن الشركات الأخرى.", "No card needed. Start right away with a ready chart of accounts and fiscal year; your data is fully isolated.")}</p>
          {trial && <div className="row">{trial.modules.filter((m: string) => m !== "core").map((m: string) => <span key={m} className="badge info">{lang === "ar" ? MOD_AR[m] ?? m : m}</span>)}</div>}
          <h3 style={{ marginTop: 8 }}>{tt("الباقات", "Plans")}</h3>
          <div className="table-wrap"><table><thead><tr><th>{tt("الباقة", "Plan")}</th><th className="end">{tt("شهريًا", "Monthly")}</th><th>{tt("مستخدمون", "Users")}</th><th>{tt("فروع", "Branches")}</th></tr></thead>
            <tbody>{plans.map((p) => <tr key={p.code}><td>{lang === "ar" ? p.name_ar : p.name_en} {p.is_trial_default && <span className="badge ok">{tt("التجربة", "trial")}</span>}</td>
              <td className="end num">{Number(p.price_monthly) ? `${fmt(p.price_monthly)} ${p.currency}` : tt("حسب الاتفاق", "On request")}</td><td className="num">{p.max_users}</td><td className="num">{p.max_branches}</td></tr>)}</tbody></table></div>
        </div>
        <form className="card grid" onSubmit={submit}>
          <h2 style={{ margin: 0 }}>{tt("إنشاء حساب شركتك", "Create your company account")}</h2>
          <ErrorBox error={err} />
          <Field label={tt("اسم الشركة", "Company name")}><input required value={f.companyName} onChange={s("companyName")} /></Field>
          <Field label={tt("رمز الشركة (يُستخدم عند الدخول)", "Company code (used to sign in)")}>
            <input required dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="my-company" />
            {codeFree !== null && <small style={{ color: codeFree ? "var(--ok)" : "var(--bad)" }}>{codeFree ? tt("✔ متاح", "✔ available") : tt("✗ مستخدم، اختر غيره", "✗ taken")}</small>}</Field>
          <Field label={tt("اسمك", "Your name")}><input required value={f.ownerName} onChange={s("ownerName")} /></Field>
          <Field label={tt("البريد الإلكتروني", "Email")}><input required type="email" dir="ltr" value={f.email} onChange={s("email")} autoComplete="username" /></Field>
          <Field label={tt("رقم الهاتف", "Phone")}><input required dir="ltr" inputMode="tel" value={f.phone} onChange={s("phone")} placeholder="+218 9x xxx xxxx" /></Field>
          <Field label={tt("كلمة المرور (10 أحرف على الأقل، حروف كبيرة وصغيرة وأرقام أو رموز)", "Password (10+ chars, mixed case, digits or symbols)")}>
            <input required type="password" dir="ltr" value={f.password} onChange={s("password")} autoComplete="new-password" /></Field>
          <label className="row"><input type="checkbox" checked={f.acceptTerms} onChange={(e) => setF({ ...f, acceptTerms: e.target.checked })} style={{ width: "auto" }} />
            {tt("أوافق على شروط الاستخدام وسياسة الخصوصية", "I accept the terms of use and privacy policy")}</label>
          <button className="btn primary" disabled={busy || !f.acceptTerms || codeFree === false}>{busy ? tt("جارٍ إنشاء الحساب…", "Creating…") : tt("ابدأ التجربة المجانية", "Start free trial")}</button>
          <a href="/" style={{ fontSize: 12, textAlign: "center" }}>{tt("لديك حساب؟ تسجيل الدخول", "Have an account? Sign in")}</a>
        </form>
      </div>
    </div>
  );
}
