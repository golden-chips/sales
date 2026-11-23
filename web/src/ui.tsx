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

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
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
  const { t, tt } = useI18n();
  const map: Record<string, [string, string]> = {
    draft: ["warn", t.draft], posted: ["ok", t.posted], reversed: ["bad", t.reversed], open: ["ok", t.open], closed: ["bad", t.closed],
    active: ["ok", t.active], trial: ["info", tt("تجريبي", "trial")], trialing: ["info", tt("تجريبي", "trial")], past_due: ["warn", tt("متأخر السداد", "past due")],
    suspended: ["bad", tt("موقوف", "suspended")], cancelled: ["bad", tt("ملغى", "cancelled")],
    issued: ["warn", tt("صادرة", "issued")], paid: ["ok", tt("مدفوع", "paid")], superseded: ["", tt("مستبدل", "superseded")],
  };
  const [cls, label] = map[s] ?? ["", s];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ---- toasts + confirm
type AskOpts = { label?: string; placeholder?: string; initial?: string; minLength?: number; multiline?: boolean };
const ToastCtx = createContext<{ toast: (m: string, bad?: boolean) => void; confirm: (m: string) => Promise<boolean>; ask: (title: string, o?: AskOpts) => Promise<string | null> }>(null as any);
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
  // in-app text dialog (reasons, numbers…) instead of the browser's prompt()
  const [text, setText] = useState<{ title: string; o: AskOpts; resolve: (v: string | null) => void } | null>(null);
  const [value, setValue] = useState("");
  const askText = useCallback((title: string, o: AskOpts = {}) => new Promise<string | null>((resolve) => { setValue(o.initial ?? ""); setText({ title, o, resolve }); }), []);
  const finish = (v: string | null) => { text?.resolve(v); setText(null); };
  const minLen = text?.o.minLength ?? 1;
  return (
    <ToastCtx.Provider value={{ toast, confirm, ask: askText }}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.bad ? "bad" : ""}`}>{i.m}</div>)}</div>
      {ask && (
        <Modal title={t.confirm} onClose={() => done(false)} footer={<><button className="btn" onClick={() => done(false)}>{t.cancel}</button><button className="btn primary" autoFocus onClick={() => done(true)}>{t.confirm}</button></>}>
          {ask.m}
        </Modal>
      )}
      {text && (
        <Modal title={text.title} onClose={() => finish(null)} footer={<><button className="btn" onClick={() => finish(null)}>{t.cancel}</button>
          <button className="btn primary" disabled={value.trim().length < minLen} onClick={() => finish(value.trim())}>{t.confirm}</button></>}>
          <Field label={text.o.label ?? ""}>{text.o.multiline
            ? <textarea autoFocus rows={3} value={value} placeholder={text.o.placeholder} onChange={(e) => setValue(e.target.value)} />
            : <input autoFocus value={value} placeholder={text.o.placeholder} onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && value.trim().length >= minLen) finish(value.trim()); }} />}</Field>
        </Modal>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
export const errMsg = (e: unknown, lang: string) => (e instanceof ApiError ? (lang === "ar" ? e.messageAr : e.message) : String((e as Error)?.message ?? e));
