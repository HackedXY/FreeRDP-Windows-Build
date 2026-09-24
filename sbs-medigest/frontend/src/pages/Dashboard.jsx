import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useRealtime } from '../realtime.js';
import { Card, Stat, BarChart, Empty, Badge, useToast } from '../components/ui.jsx';
import { gnf, num, time, LABELS } from '../format.js';

/** Volet médical / opérationnel : aucune donnée financière (recettes, caisse, dépenses). */
export function MedicalDashboard({ d }) {
  const series = (d.series || []).map((s) => ({ ...s, label: new Date(s.day).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) }));
  const byStatus = d.consultations_by_status || {};
  return (
    <>
      <div className="page-header"><div><h1>Activité médicale du jour</h1>
        <p className="muted">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · mis à jour à {time(d.generated_at)}</p></div></div>
      <div className="stats">
        <Stat icon="👥" label="Patients aujourd'hui" value={num(d.patients_today)} sub={`${d.new_patients} nouveau(x)`} to="/patients" />
        <Stat icon="🩺" label="Consultations" value={num(d.consultations)} sub={`${byStatus.terminee || 0} terminée(s) · ${byStatus.en_attente || 0} en attente`} to="/consultations" />
        <Stat icon="🧪" label="Examens en attente" value={num(d.pending?.lab_pending)} to="/laboratoire" />
        <Stat icon="📅" label="Rendez-vous aujourd'hui" value={num(d.appointments)} to="/rendez-vous" />
        <Stat icon="📦" label="Produits sous le seuil" value={num(d.pending?.low_stock)} tone={d.pending?.low_stock ? 'warn' : ''} to="/pharmacie" />
      </div>
      <Card title="Consultations — 7 derniers jours">
        <BarChart data={series} series={[{ key: 'consultations', label: 'Consultations', className: 'consults' }]} format={num} />
      </Card>
    </>
  );
}

export default function Dashboard() {
  const { clinic } = useAuth();
  const toast = useToast();
  const [d, setD] = useState(null);
  const [feed, setFeed] = useState([]);
  const [flash, setFlash] = useState({});
  const timer = useRef(null);

  // background : actualisation automatique, qui ne prolonge pas la session (expiration d'inactivité)
  const load = (background = true) => api.get('/dashboard', null, { background })
    .then((r) => { setD(r); setFeed(r.activity || []); }).catch(() => {});
  useEffect(() => { load(false); const t = setInterval(load, 120000); return () => clearInterval(t); }, []);

  // Actualisation automatique : aucun rechargement manuel nécessaire
  useRealtime((event, p) => {
    if (event === 'activity') {
      setFeed((f) => [{ ...p, isNew: true }, ...f.filter((x) => x.id !== p.id)].slice(0, 25));
      if (p.kind === 'payment' && p.amount > 0) {
        toast(`💰 Nouvelle recette : +${gnf(p.amount)}`, 'ok');
        setFlash({ revenue: true, cash: true });
        setTimeout(() => setFlash({}), 3000);
      }
    }
    if (event === 'stats' || event === 'alert' || event === 'connect') {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 400);
    }
  });

  if (!d) return <Empty>Chargement du tableau de bord…</Empty>;
  if (!d.finance) return <MedicalDashboard d={d} />;
  return <FinanceDashboard d={d} clinic={clinic} feed={feed} flash={flash} />;
}

/**
 * Volet financier. Les blocs optionnels (alertes, personnel) ne sont renvoyés par l'API
 * que si l'utilisateur a la permission correspondante (alerts.view, users.view…) :
 * ils sont masqués lorsqu'ils sont absents.
 */
export function FinanceDashboard({ d, clinic, feed = [], flash = {} }) {
  const series = (d.series || []).map((s) => ({ ...s, label: new Date(s.day).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) }));
  const cash = d.cash || { open_sessions: [], theoretical: 0, last_closed: null };
  const openCash = cash.open_sessions.length > 0;
  const alerts = d.alerts || null;
  const employees = d.employees || null;
  const pending = d.pending || {};
  const byStatus = d.consultations_by_status || {};
  return (
    <>
      <div className="page-header">
        <div>
          <h1>{clinic?.name} — Suivi en temps réel</h1>
          <p className="muted">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · mis à jour à {time(d.generated_at)}</p>
        </div>
      </div>

      <div className="stats">
        <Stat icon="👥" label="Patients aujourd'hui" value={num(d.patients_today)} sub={`${d.new_patients} nouveau(x)`} to="/patients" />
        <Stat icon="🩺" label="Consultations" value={num(d.consultations)} sub={`${byStatus.terminee || 0} terminée(s) · ${byStatus.en_attente || 0} en attente`} to="/consultations" />
        <Stat icon="💰" label="Recettes" value={gnf(d.revenue)} sub={`${d.payment_count} paiement(s)`} to="/paiements" flash={flash.revenue} />
        <Stat icon="💸" label="Dépenses" value={gnf(d.expenses)} to="/depenses" tone={d.expenses > d.revenue ? 'warn' : ''} />
        <Stat icon="🏦" label="Caisse théorique" value={gnf(openCash ? cash.theoretical : cash.last_closed?.declared_balance || 0)}
          sub={openCash ? `${cash.open_sessions.length} caisse(s) ouverte(s)` : 'Caisse fermée'} to="/caisse" flash={flash.cash} />
        <Stat icon="💊" label="Ventes pharmacie" value={gnf(d.pharmacy_sales)} to="/pharmacie" />
        {employees && <Stat icon="👨‍⚕️" label="Personnel actif" value={`${employees.logged_today} / ${employees.active}`} sub={`${employees.online} en ligne`} to="/employes" />}
        {alerts && <Stat icon="📦" label="Alertes stock" value={num(alerts.stock)} tone={alerts.stock ? 'warn' : ''} to="/alertes?category=stock" />}
        {alerts && <Stat icon="⚠️" label="Alertes à vérifier" value={num(alerts.to_check)} sub={alerts.high ? `${alerts.high} priorité haute` : null} tone={alerts.high ? 'danger' : alerts.to_check ? 'warn' : ''} to="/alertes" />}
      </div>

      <div className="grid-3">
        <Card title="Activité récente" className="span-feed" actions={<span className="live on small"><i />En direct</span>}>
          {!feed?.length ? <Empty /> : (
            <ul className="feed">
              {feed.slice(0, 15).map((a) => (
                <li key={a.id} className={a.isNew ? 'new' : ''}>
                  <span className="when">{time(a.at)}</span>
                  <span className="what">{a.summary}<div className="who">{a.user}{a.role ? ` — ${a.role}` : ''}</div></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="7 derniers jours">
          <BarChart data={series} series={[{ key: 'revenue', label: 'Recettes', className: 'revenue' }, { key: 'expenses', label: 'Dépenses', className: 'expenses' }]} />
        </Card>
        <Card title="À traiter">
          <ul className="feed">
            <li><span className="what"><Link to="/depenses?status=en_attente">Dépenses en attente de validation</Link></span><Badge tone={pending.expenses_to_validate ? 'warn' : 'ok'}>{pending.expenses_to_validate ?? 0}</Badge></li>
            <li><span className="what"><Link to="/consultations?payment_status=non_payee">Consultations non soldées</Link></span><Badge tone={pending.unpaid_consultations ? 'warn' : 'ok'}>{pending.unpaid_consultations ?? 0}</Badge></li>
            <li><span className="what"><Link to="/laboratoire">Examens en attente de résultat</Link></span><Badge tone="info">{pending.lab_pending ?? 0}</Badge></li>
            <li><span className="what"><Link to="/pharmacie?low=1">Produits sous le seuil</Link></span><Badge tone={pending.low_stock ? 'danger' : 'ok'}>{pending.low_stock ?? 0}</Badge></li>
            <li><span className="what"><Link to="/rendez-vous">Rendez-vous aujourd'hui</Link></span><Badge tone="info">{d.appointments}</Badge></li>
          </ul>
          <h3 className="small muted" style={{ margin: '16px 0 6px' }}>Encaissements du jour par mode</h3>
          {!d.revenue_by_method?.length ? <p className="muted small">Aucun encaissement.</p> : (
            <dl className="kv">{d.revenue_by_method.flatMap((m) => [<dt key={`k${m.method}`}>{LABELS.method[m.method]}</dt>, <dd key={`v${m.method}`}>{gnf(m.total)} <span className="muted small">({m.count})</span></dd>])}</dl>
          )}
          {cash.last_closed && (
            <p className="small muted" style={{ marginTop: 12 }}>
              Dernière clôture {cash.last_closed.number} : écart <b className={cash.last_closed.discrepancy ? 'money neg' : ''}>{gnf(cash.last_closed.discrepancy)}</b>
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
