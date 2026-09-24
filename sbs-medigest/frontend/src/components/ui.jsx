import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { LABELS, TONE, gnf, num, todayISO } from '../format.js';

// ------------------------------------------------------------------ données
export function useFetch(url, params, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const key = url ? url + JSON.stringify(params || {}) : null;
  const load = useCallback(async () => {
    if (!url) return;
    setState((s) => ({ ...s, loading: true }));
    try { setState({ data: await api.get(url, params), loading: false, error: null }); }
    catch (e) { setState({ data: null, loading: false, error: e }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}

// ------------------------------------------------------------------ toasts
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, tone = 'ok') => {
    const id = Math.random();
    setItems((l) => [...l.slice(-3), { id, msg, tone }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ mise en page
export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-header">
      <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export const Card = ({ title, actions, children, className = '' }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <div className="card-head"><h2>{title}</h2>{actions}</div>}
    {children}
  </section>
);

export function Badge({ value, map, tone, children }) {
  const label = children ?? (map ? LABELS[map]?.[value] : null) ?? value;
  return <span className={`badge ${tone || TONE[value] || 'muted'}`}>{label}</span>;
}

export function Stat({ icon, label, value, sub, tone, to, flash }) {
  const body = (
    <>
      <div className="stat-icon" aria-hidden>{icon}</div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </>
  );
  const cls = `stat ${tone || ''} ${flash ? 'flash' : ''}`;
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

export const Empty = ({ children = 'Aucun élément.' }) => <div className="empty">{children}</div>;
export const Loading = () => <div className="empty">Chargement…</div>;
export const ErrorBox = ({ error }) => (error ? <div className="alert-box danger">{error.message}</div> : null);

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.filter(Boolean).map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}{t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ tableaux
/**
 * columns : [{ key, label, render?(row), className?, align? }]
 * Sur mobile, chaque ligne devient une carte (libellés via data-label).
 */
export function Table({ columns, rows, onRowClick, empty, footer }) {
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.align === 'right' ? 'right' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? 'clickable' : ''}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={`${c.align === 'right' ? 'right' : ''} ${c.className || ''}`}>
                  {c.render ? c.render(r) : r[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Pagination({ page, total, limit = 50, onChange }) {
  const pages = Math.max(1, Math.ceil((total || 0) / limit));
  if (pages <= 1) return null;
  return (
    <div className="pagination">
      <button className="btn ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>‹ Précédent</button>
      <span>Page {page} / {pages} · {num(total)} éléments</span>
      <button className="btn ghost" disabled={page >= pages} onClick={() => onChange(page + 1)}>Suivant ›</button>
    </div>
  );
}

// ------------------------------------------------------------------ filtres
export const PERIODS = [
  ['today', "Aujourd'hui"], ['yesterday', 'Hier'], ['week', '7 jours'], ['month', 'Mois'], ['year', 'Année'], ['custom', 'Période…'], ['', 'Tout'],
];

export function PeriodFilter({ value, onChange, allowAll = true }) {
  const v = value || {};
  return (
    <div className="period">
      <select value={v.period ?? ''} onChange={(e) => onChange({ period: e.target.value, from: v.from || todayISO(), to: v.to || todayISO() })} aria-label="Période">
        {PERIODS.filter(([k]) => allowAll || k !== '').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {v.period === 'custom' && (
        <>
          <input type="date" value={v.from} onChange={(e) => onChange({ ...v, from: e.target.value })} aria-label="Du" />
          <input type="date" value={v.to} onChange={(e) => onChange({ ...v, to: e.target.value })} aria-label="Au" />
        </>
      )}
    </div>
  );
}
export const periodParams = (p) => (!p?.period ? {} : p.period === 'custom' ? { from: p.from, to: p.to } : { period: p.period });

// ------------------------------------------------------------------ formulaires
export function Field({ label, children, hint, required, className = '', as }) {
  // « as="div" » pour les widgets composés (boutons internes) : un <label> relaierait les clics
  const Tag = as || 'label';
  return (
    <Tag className={`field ${className}`}>
      <span className="field-label">{label}{required && <b className="req"> *</b>}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </Tag>
  );
}

/** Gestion simple d'un formulaire contrôlé. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const bind = (name, type) => ({
    name,
    value: type === 'checkbox' ? undefined : values[name] ?? '',
    checked: type === 'checkbox' ? !!values[name] : undefined,
    onChange: (e) => {
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setValues((s) => ({ ...s, [name]: v }));
    },
  });
  return { values, setValues, bind, set: (k, v) => setValues((s) => ({ ...s, [k]: v })) };
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Fermer">✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Action sensible nécessitant un motif (annulation, remboursement…). */
export function ReasonModal({ title, label = 'Motif', confirmLabel = 'Confirmer', danger, onConfirm, onClose, children }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onConfirm(reason); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="form">
        {children}
        <Field label={label} required>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required minLength={3} autoFocus />
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || reason.trim().length < 3}>{busy ? '…' : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Sélecteur de patient avec recherche. */
export function PatientPicker({ value, onChange, autoFocus }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (q.length < 2) { setItems([]); return; }
    const t = setTimeout(() => api.get('/patients', { q, limit: 8 }).then((r) => setItems(r.items)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  if (value) {
    return (
      <div className="picked">
        <span><b>{value.first_name} {value.last_name}</b> <span className="muted">{value.patient_number}</span></span>
        <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>Changer</button>
      </div>
    );
  }
  return (
    <div className="picker">
      <input placeholder="Nom, n° dossier ou téléphone…" value={q} autoFocus={autoFocus}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && items.length > 0 && (
        <ul className="picker-list">
          {items.map((p) => (
            <li key={p.id}><button type="button" onClick={() => { onChange(p); setOpen(false); setQ(''); }}>
              <b>{p.first_name} {p.last_name}</b> <span className="muted">{p.patient_number} · {p.phone || ''}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ graphique
export function BarChart({ data, series, height = 180, format = gnf }) {
  if (!data?.length) return <Empty>Pas de données</Empty>;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const w = 100 / data.length;
  const bw = (w * 0.7) / series.length;
  return (
    <div className="chart">
      <svg viewBox={`0 0 100 ${height / 3}`} preserveAspectRatio="none" role="img" aria-label="Graphique">
        {data.map((d, i) => series.map((s, j) => {
          const h = ((Number(d[s.key]) || 0) / max) * (height / 3 - 2);
          return <rect key={`${i}-${j}`} x={i * w + w * 0.15 + j * bw} y={height / 3 - h} width={bw} height={h} rx="0.6" className={`bar ${s.className}`}>
            <title>{`${d.label}: ${s.label} ${format(d[s.key])}`}</title>
          </rect>;
        }))}
      </svg>
      <div className="chart-x">{data.map((d, i) => <span key={i} style={{ width: `${w}%` }}>{d.label}</span>)}</div>
      <div className="chart-legend">{series.map((s) => <span key={s.key}><i className={`dot ${s.className}`} />{s.label}</span>)}</div>
    </div>
  );
}

export function Money({ value, tone }) {
  return <span className={`money ${tone || ''}`}>{gnf(value)}</span>;
}

/**
 * Sélection explicite de la caisse lorsque plusieurs caisses sont ouvertes
 * (paiements, remboursements, dépenses, ventes). Avec une seule caisse ouverte,
 * rien n'est affiché : le serveur utilise cette caisse.
 */
export function RegisterSelect({ value, onChange, required = true, label = 'Caisse' }) {
  const { data: registers } = useFetch('/cash/open-registers');
  const list = registers || [];
  useEffect(() => {
    if (value && list.length && !list.some((r) => String(r.register_id) === String(value))) onChange('');
  }, [registers]); // eslint-disable-line react-hooks/exhaustive-deps
  if (list.length < 2) return null;
  return (
    <Field label={label} required={required} hint="Plusieurs caisses sont ouvertes : choisissez celle qui est concernée.">
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">— Choisir la caisse —</option>
        {list.map((r) => <option key={r.session_id} value={r.register_id}>{r.register_name} ({r.number} · {r.opened_by_name})</option>)}
      </select>
    </Field>
  );
}
