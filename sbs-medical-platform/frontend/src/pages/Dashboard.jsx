import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useRealtime } from '../realtime.js';
import { Card, Stat, BarChart, Empty, Badge, useToast } from '../components/ui.jsx';
import { gnf, num, time, LABELS } from '../format.js';

export default function Dashboard() {
  const { clinic } = useAuth();
  const toast = useToast();
  const [d, setD] = useState(null);
  const [feed, setFeed] = useState([]);
  const [flash, setFlash] = useState({});
  const timer = useRef(null);

  const load = () => api.get('/dashboard').then((r) => { setD(r); setFeed(r.activity); }).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 120000); return () => clearInterval(t); }, []);

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
  const series = d.series.map((s) => ({ ...s, label: new Date(s.day).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) }));
  const openCash = d.cash.open_sessions.length > 0;
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
        <Stat icon="🩺" label="Consultations" value={num(d.consultations)} sub={`${d.consultations_by_status.terminee || 0} terminée(s) · ${d.consultations_by_status.en_attente || 0} en attente`} to="/consultations" />
        <Stat icon="💰" label="Recettes" value={gnf(d.revenue)} sub={`${d.payment_count} paiement(s)`} to="/paiements" flash={flash.revenue} />
        <Stat icon="💸" label="Dépenses" value={gnf(d.expenses)} to="/depenses" tone={d.expenses > d.revenue ? 'warn' : ''} />
        <Stat icon="🏦" label="Caisse théorique" value={gnf(openCash ? d.cash.theoretical : d.cash.last_closed?.declared_balance || 0)}
          sub={openCash ? `${d.cash.open_sessions.length} caisse(s) ouverte(s)` : 'Caisse fermée'} to="/caisse" flash={flash.cash} />
        <Stat icon="💊" label="Ventes pharmacie" value={gnf(d.pharmacy_sales)} to="/pharmacie" />
        <Stat icon="👨‍⚕️" label="Personnel actif" value={`${d.employees.logged_today} / ${d.employees.active}`} sub={`${d.employees.online} en ligne`} to="/employes" />
        <Stat icon="📦" label="Alertes stock" value={num(d.alerts.stock)} tone={d.alerts.stock ? 'warn' : ''} to="/alertes?category=stock" />
        <Stat icon="⚠️" label="Alertes à vérifier" value={num(d.alerts.to_check)} sub={d.alerts.high ? `${d.alerts.high} priorité haute` : null} tone={d.alerts.high ? 'danger' : d.alerts.to_check ? 'warn' : ''} to="/alertes" />
      </div>

      <div className="grid-3">
        <Card title="Activité récente" className="span-feed" actions={<span className="live on small"><i />En direct</span>}>
          {!feed.length ? <Empty /> : (
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
            <li><span className="what"><Link to="/depenses?status=en_attente">Dépenses en attente de validation</Link></span><Badge tone={d.pending.expenses_to_validate ? 'warn' : 'ok'}>{d.pending.expenses_to_validate}</Badge></li>
            <li><span className="what"><Link to="/consultations?payment_status=non_payee">Consultations non soldées</Link></span><Badge tone={d.pending.unpaid_consultations ? 'warn' : 'ok'}>{d.pending.unpaid_consultations}</Badge></li>
            <li><span className="what"><Link to="/laboratoire">Examens en attente de résultat</Link></span><Badge tone="info">{d.pending.lab_pending}</Badge></li>
            <li><span className="what"><Link to="/pharmacie?low=1">Produits sous le seuil</Link></span><Badge tone={d.pending.low_stock ? 'danger' : 'ok'}>{d.pending.low_stock}</Badge></li>
            <li><span className="what"><Link to="/rendez-vous">Rendez-vous aujourd'hui</Link></span><Badge tone="info">{d.appointments}</Badge></li>
          </ul>
          <h3 className="small muted" style={{ margin: '16px 0 6px' }}>Encaissements du jour par mode</h3>
          {!d.revenue_by_method.length ? <p className="muted small">Aucun encaissement.</p> : (
            <dl className="kv">{d.revenue_by_method.flatMap((m) => [<dt key={`k${m.method}`}>{LABELS.method[m.method]}</dt>, <dd key={`v${m.method}`}>{gnf(m.total)} <span className="muted small">({m.count})</span></dd>])}</dl>
          )}
          {d.cash.last_closed && (
            <p className="small muted" style={{ marginTop: 12 }}>
              Dernière clôture {d.cash.last_closed.number} : écart <b className={d.cash.last_closed.discrepancy ? 'money neg' : ''}>{gnf(d.cash.last_closed.discrepancy)}</b>
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
