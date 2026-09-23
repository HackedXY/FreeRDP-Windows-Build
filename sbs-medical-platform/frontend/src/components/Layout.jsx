import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { connectRealtime, disconnectRealtime, useRealtime, isConnected } from '../realtime.js';
import { useToast } from './ui.jsx';
import { gnf, dateTime } from '../format.js';

const NAV = [
  { section: 'Pilotage' },
  { to: '/', label: 'Tableau de bord', icon: '📊', perm: ['dashboard.view', 'dashboard.finance'], end: true },
  { to: '/alertes', label: 'Alertes', icon: '⚠️', perm: ['alerts.view'], badge: 'alerts' },
  { to: '/rapports', label: 'Rapports', icon: '📈', perm: ['reports.view'] },
  { section: 'Médical' },
  { to: '/patients', label: 'Patients', icon: '👥', perm: ['patients.view'] },
  { to: '/consultations', label: 'Consultations', icon: '🩺', perm: ['consultations.view'] },
  { to: '/rendez-vous', label: 'Rendez-vous', icon: '📅', perm: ['appointments.view'] },
  { to: '/laboratoire', label: 'Laboratoire', icon: '🧪', perm: ['lab.view', 'lab.request', 'lab.results'] },
  { section: 'Finances' },
  { to: '/paiements', label: 'Paiements', icon: '💳', perm: ['payments.view', 'payments.create'] },
  { to: '/caisse', label: 'Caisse', icon: '🏦', perm: ['cash.operate', 'cash.view_all'] },
  { to: '/depenses', label: 'Dépenses', icon: '💸', perm: ['expenses.view'] },
  { section: 'Pharmacie & stock' },
  { to: '/pharmacie', label: 'Pharmacie', icon: '💊', perm: ['pharmacy.view', 'pharmacy.sell'] },
  { to: '/fournisseurs', label: 'Fournisseurs', icon: '🚚', perm: ['suppliers.view'] },
  { section: 'Administration' },
  { to: '/employes', label: 'Employés', icon: '👨‍⚕️', perm: ['users.view', 'users.manage'] },
  { to: '/roles', label: 'Rôles & permissions', icon: '🔐', perm: ['roles.manage'] },
  { to: '/audit', label: "Journal d'audit", icon: '📜', perm: ['audit.view'] },
  { to: '/actes', label: 'Actes & tarifs', icon: '🏷️', perm: ['acts.manage', 'lab.manage'] },
  { to: '/parametres', label: 'Paramètres', icon: '⚙️', perm: ['settings.manage'] },
];

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const nav = useNavigate();
  const box = useRef(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => api.get('/search', { q }).then(setRes).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setRes(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const groups = [
    ['patients', 'Patients', (r) => `/patients/${r.id}`],
    ['consultations', 'Consultations', (r) => `/consultations/${r.id}`],
    ['payments', 'Paiements / reçus', (r) => `/paiements/${r.id}`],
    ['products', 'Médicaments', (r) => `/pharmacie/produits/${r.id}`],
    ['lab_requests', 'Examens', (r) => `/laboratoire/${r.id}`],
    ['employees', 'Employés', (r) => `/employes/${r.id}`],
    ['expenses', 'Dépenses', (r) => `/depenses?id=${r.id}`],
  ];
  const any = res && groups.some(([k]) => res[k]?.length);
  const go = (to) => { setRes(null); setQ(''); nav(to); };
  return (
    <div className="global-search" ref={box}>
      <input type="search" placeholder="Rechercher patient, reçu, médicament, employé…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Recherche globale" />
      {res && (
        <div className="search-results">
          {!any && <div className="empty">Aucun résultat</div>}
          {groups.map(([k, label, to]) => res[k]?.length ? (
            <div key={k}>
              <h4>{label}</h4>
              {res[k].map((r) => (
                <a key={r.id} href={to(r)} onClick={(e) => { e.preventDefault(); go(to(r)); }}>
                  <span><b>{r.label}</b></span>
                  <span className="muted small">{r.ref}{k === 'payments' || k === 'expenses' ? ` · ${gnf(r.detail)}` : ''}</span>
                </a>
              ))}
            </div>
          ) : null)}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ items: [], unread: 0 });
  const toast = useToast();
  const nav = useNavigate();
  const load = () => api.get('/notifications').then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  useRealtime((event, p) => {
    if (event === 'notification') {
      load();
      toast(`${p.icon || '🔔'} ${p.title}${p.body ? ` — ${p.body}` : ''}`, p.type === 'alert' ? 'warn' : 'ok');
    }
  });
  const markAll = async () => { await api.post('/notifications/read'); load(); };
  const openItem = async (n) => {
    setOpen(false);
    if (!n.read_at) api.post('/notifications/read', { ids: [n.id] }).then(load);
    if (n.link) nav(n.link);
  };
  return (
    <div className="dropdown">
      <button className="icon-btn bell" onClick={() => setOpen(!open)} aria-label="Notifications">
        🔔{data.unread > 0 && <span className="count">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="dropdown-panel">
          <div className="head"><b>Notifications</b>{data.unread > 0 && <button className="btn ghost sm" onClick={markAll}>Tout marquer lu</button>}</div>
          <div className="notif-list">
            {!data.items.length && <div className="empty">Aucune notification</div>}
            {data.items.map((n) => (
              <a key={n.id} href={n.link || '#'} className={`notif ${n.read_at ? '' : 'unread'}`} onClick={(e) => { e.preventDefault(); openItem(n); }}>
                <span aria-hidden>{n.icon || '🔔'}</span>
                <span><div className="t">{n.title}</div>{n.body && <div className="b">{n.body}</div>}<div className="b">{dateTime(n.created_at)}</div></span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const initials = `${user.firstName[0] || ''}${user.lastName[0] || ''}`.toUpperCase();
  return (
    <div className="dropdown">
      <button className="icon-btn user-chip" onClick={() => setOpen(!open)} aria-label="Menu utilisateur">
        <span className="avatar">{initials}</span>
        <span className="name small" style={{ textAlign: 'left' }}><b>{user.fullName}</b><br /><span className="muted">{user.role.name}</span></span>
      </button>
      {open && (
        <div className="dropdown-panel" style={{ width: 240 }} onClick={() => setOpen(false)}>
          <div className="head"><span className="small">{user.username} · {user.employeeNumber}</span></div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Link className="btn ghost" to="/mot-de-passe">🔑 Changer mon mot de passe</Link>
            <button className="btn ghost" onClick={logout}>🚪 Se déconnecter</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { can, clinic } = useAuth();
  const [menu, setMenu] = useState(false);
  const [live, setLive] = useState(false);
  const [openAlerts, setOpenAlerts] = useState(0);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    connectRealtime();
    setLive(isConnected());
    return () => disconnectRealtime();
  }, []);
  const loadAlerts = () => can('alerts.view') && api.get('/alerts', { status: 'open', limit: 1 }).then((r) => setOpenAlerts(r.total)).catch(() => {});
  useEffect(() => { loadAlerts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime((event) => {
    if (event === 'connect') setLive(true);
    if (event === 'disconnect') setLive(false);
    if (event === 'alert' || event === 'alert_update') loadAlerts();
  });

  const items = NAV.filter((n) => n.section || can(...n.perm));
  const visible = items.filter((n, i) => !n.section || (items[i + 1] && !items[i + 1].section));
  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand"><img src="/icon.svg" alt="" /><div><b>{clinic?.name || 'Cabinet SBS'}</b><span>Siguiri · Guinée</span></div></div>
        <nav className="nav">
          {visible.map((n, i) => n.section
            ? <div key={i} className="nav-section">{n.section}</div>
            : <NavLink key={n.to} to={n.to} end={n.end}><span className="ico">{n.icon}</span>{n.label}
                {n.badge === 'alerts' && openAlerts > 0 && <span className="pill">{openAlerts}</span>}</NavLink>)}
        </nav>
      </aside>
      {menu && <div className="backdrop" onClick={() => setMenu(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenu(true)} aria-label="Menu">☰</button>
          <GlobalSearch />
          <span className={`live ${live ? 'on' : ''}`} title={live ? 'Temps réel connecté' : 'Temps réel déconnecté'}><i /><span className="txt">{live ? 'En direct' : 'Hors ligne'}</span></span>
          <Notifications />
          <UserMenu />
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
