import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { useAsync } from "../ui";

/** shows the remaining trial / grace days; "Subscribe" opens the plan comparison on the subscription page */
export default function TrialBanner() {
  const { tt } = useI18n();
  const { me, can } = useSession();
  const nav = useNavigate();
  const show = !!me && ["trial", "past_due"].includes(me.tenant.status) && can("core.subscription.view");
  const sub = useAsync(() => (show ? api.get("/subscription") : Promise.resolve(null)), [show]);
  const reqs = useAsync(() => (show ? api.get("/subscription/upgrade-requests") : Promise.resolve([])), [show]);
  if (!show || !sub.data?.subscription) return null;
  const end = new Date(sub.data.subscription.current_period_end);
  const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86400000));
  const pending = (reqs.data ?? []).some((r: any) => r.status === "open");
  const pastDue = me!.tenant.status === "past_due";
  return <div className={`alert ${pastDue ? "bad" : "warn"}`} style={{ margin: "0 0 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
    <b>{pastDue ? tt("انتهت الفترة — الحساب في مهلة السماح وسيُعلّق قريبًا", "Period ended — account is in its grace period and will be suspended soon")
      : tt(`فترة تجريبية: متبقٍ ${days} يومًا`, `Free trial: ${days} days left`)}</b>
    <span className="spacer" />
    {pending ? <span className="badge info">{tt("طلب الاشتراك قيد المعالجة", "Subscription request in progress")}</span>
      : <button className="btn sm primary" onClick={() => nav("/subscription")}>{tt("الباقات والاشتراك", "Plans & subscribe")}</button>}
  </div>;
}
