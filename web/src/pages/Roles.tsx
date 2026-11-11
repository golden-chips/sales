import { useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { ErrorBox, Loading, useAsync } from "../ui";

export default function Roles() {
  const { t, pick } = useI18n();
  const roles = useAsync(() => api.get("/roles"), []);
  const perms = useAsync(() => api.get("/permissions"), []);
  const [sel, setSel] = useState<string | null>(null);
  if (roles.loading || perms.loading) return <Loading />;
  const role = roles.data?.find((r: any) => r.id === sel) ?? roles.data?.[0];
  const byModule: Record<string, any[]> = {};
  perms.data?.forEach((p: any) => (byModule[p.module_code] ??= []).push(p));
  return (
    <>
      <div className="page-head"><h1>{t.roles}</h1></div>
      <ErrorBox error={roles.error || perms.error} />
      <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 300px) 1fr" }}>
        <div className="card" style={{ padding: 8 }}>
          <nav className="nav">{roles.data?.map((r: any) => (
            <a key={r.id} href="#" className={r.id === role?.id ? "active" : ""} onClick={(e) => { e.preventDefault(); setSel(r.id); }}>
              {pick(r.name_ar, r.name_en)} <span className="spacer" /><span className="badge num">{r.user_count}</span>
            </a>))}</nav>
        </div>
        <div className="card">
          <h2>{pick(role?.name_ar, role?.name_en)} <code style={{ fontSize: 12, color: "var(--muted)" }}>{role?.code}</code></h2>
          {Object.entries(byModule).map(([m, ps]) => (
            <div key={m} style={{ marginBottom: 12 }}>
              <h3>{m}</h3>
              {ps.map((p) => {
                const on = role?.permissions.includes(p.code);
                return <div key={p.code} className="row" style={{ opacity: on ? 1 : .45 }}><span>{on ? "✔" : "—"}</span><span>{pick(p.name_ar, p.name_en)}</span><code style={{ fontSize: 11, color: "var(--muted)" }}>{p.code}</code>{p.is_sensitive && <span className="badge warn">sensitive</span>}</div>;
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
