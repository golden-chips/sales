import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "./api";
import { useI18n } from "./i18n";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true, error: undefined }));
    fn().then((data) => live && set({ data, loading: false }), (error) => live && set({ error, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}

export function ErrorBox({ error }: { error: unknown }) {
  const { lang } = useI18n();
  if (!error) return null;
  const e = error as ApiError;
  const msg = e instanceof ApiError ? (lang === "ar" ? e.messageAr : e.message) : String((e as Error)?.message ?? e);
  const details = e instanceof ApiError && Array.isArray(e.details) ? e.details : null;
  return (
    <div className="alert bad" role="alert">
      <b>{msg}</b>{e instanceof ApiError && <span className="num" style={{ opacity: .7 }}> · {e.code}</span>}
      {details && <ul style={{ margin: "6px 0 0" }}>{details.map((d: any, i: number) => <li key={i}><code>{d.path}</code>: {d.message}</li>)}</ul>}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return <div className="card grid" aria-busy="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>;
}

export function Empty({ text, action }: { text?: string; action?: ReactNode }) {
  const { t } = useI18n();
  return <div className="empty"><div className="icon">◌</div><div>{text ?? t.none}</div>{action && <div style={{ marginTop: 12 }}>{action}</div>}</div>;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2 style={{ margin: 0 }}>{title}</h2><button className="btn sm" onClick={onClose} aria-label="close">✕</button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

export function StatusBadge({ s }: { s: string }) {
  const { t } = useI18n();
  const map: Record<string, [string, string]> = {
    draft: ["warn", t.draft], posted: ["ok", t.posted], reversed: ["bad", t.reversed], open: ["ok", t.open], closed: ["bad", t.closed],
    active: ["ok", t.active], trial: ["info", "trial"], trialing: ["info", "trial"], past_due: ["warn", "past due"], suspended: ["bad", "suspended"], cancelled: ["bad", "cancelled"],
    issued: ["warn", "issued"], paid: ["ok", "paid"], superseded: ["", "superseded"],
  };
  const [cls, label] = map[s] ?? ["", s];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ---- toasts + confirm
const ToastCtx = createContext<{ toast: (m: string, bad?: boolean) => void; confirm: (m: string) => Promise<boolean> }>(null as any);
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<{ id: number; m: string; bad?: boolean }[]>([]);
  const [ask, setAsk] = useState<{ m: string; resolve: (v: boolean) => void } | null>(null);
  const toast = useCallback((m: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, m, bad }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4000);
  }, []);
  const confirm = useCallback((m: string) => new Promise<boolean>((resolve) => setAsk({ m, resolve })), []);
  const done = (v: boolean) => { ask?.resolve(v); setAsk(null); };
  return (
    <ToastCtx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.bad ? "bad" : ""}`}>{i.m}</div>)}</div>
      {ask && (
        <Modal title={t.confirm} onClose={() => done(false)} footer={<><button className="btn" onClick={() => done(false)}>{t.cancel}</button><button className="btn primary" autoFocus onClick={() => done(true)}>{t.confirm}</button></>}>
          {ask.m}
        </Modal>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
export const errMsg = (e: unknown, lang: string) => (e instanceof ApiError ? (lang === "ar" ? e.messageAr : e.message) : String((e as Error)?.message ?? e));
