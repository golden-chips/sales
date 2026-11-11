import { useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Field, Modal, errMsg, useAsync, useToast } from "../ui";

/** shows the remaining trial / grace days and lets the owner request a paid plan */
export default function TrialBanner() {
  const { tt, lang } = useI18n();
  const { me, can } = useSession();
  const { toast } = useToast();
  const show = !!me && ["trial", "past_due"].includes(me.tenant.status) && can("core.subscription.view");
  const sub = useAsync(() => (show ? api.get("/subscription") : Promise.resolve(null)), [show]);
  const reqs = useAsync(() => (show ? api.get("/subscription/upgrade-requests") : Promise.resolve([])), [show]);
  const plans = useAsync(() => (show ? api.get("/public/plans") : Promise.resolve([])), [show]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ planCode: "", billingCycle: "monthly", contactPhone: "", note: "" });
  if (!show || !sub.data?.subscription) return null;
  const end = new Date(sub.data.subscription.current_period_end);
  const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86400000));
  const pending = (reqs.data ?? []).some((r: any) => r.status === "open");
  const pastDue = me!.tenant.status === "past_due";
  const send = async () => {
    try { await api.post("/subscription/upgrade-request", { ...f, planCode: f.planCode || plans.data?.[0]?.code }); setOpen(false); reqs.reload(); toast(tt("وصل طلبك، وسيتواصل معك فريقنا", "Request received — our team will contact you")); }
    catch (e) { toast(errMsg(e, lang), true); }
  };
  return <>
    <div className={`alert ${pastDue ? "bad" : "warn"}`} style={{ margin: "0 0 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <b>{pastDue ? tt("انتهت الفترة — الحساب في مهلة السماح وسيُعلّق قريبًا", "Period ended — account is in its grace period and will be suspended soon")
        : tt(`فترة تجريبية: متبقٍ ${days} يومًا`, `Free trial: ${days} days left`)}</b>
      <span className="spacer" />
      {pending ? <span className="badge info">{tt("طلب الاشتراك قيد المعالجة", "Subscription request in progress")}</span>
        : <button className="btn sm primary" onClick={() => setOpen(true)}>{tt("اطلب الاشتراك", "Subscribe")}</button>}
    </div>
    {open && <Modal title={tt("طلب الاشتراك", "Subscription request")} onClose={() => setOpen(false)} footer={<><button className="btn" onClick={() => setOpen(false)}>{tt("إلغاء", "Cancel")}</button><button className="btn primary" onClick={send}>{tt("إرسال", "Send")}</button></>}>
      <div className="form-grid">
        <Field label={tt("الباقة", "Plan")}><select value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}>{plans.data?.map((p: any) => <option key={p.code} value={p.code}>{lang === "ar" ? p.name_ar : p.name_en}</option>)}</select></Field>
        <Field label={tt("الدفع", "Billing")}><select value={f.billingCycle} onChange={(e) => setF({ ...f, billingCycle: e.target.value })}><option value="monthly">{tt("شهري", "Monthly")}</option><option value="yearly">{tt("سنوي", "Yearly")}</option></select></Field>
        <Field label={tt("هاتف للتواصل", "Contact phone")}><input dir="ltr" value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></Field>
        <Field label={tt("ملاحظة", "Note")}><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>}
  </>;
}
