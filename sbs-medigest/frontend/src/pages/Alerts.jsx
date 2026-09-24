import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useRealtime } from '../realtime.js';
import { PageHeader, Card, Pagination, useFetch, Modal, Field, ErrorBox, Badge, Empty, useToast } from '../components/ui.jsx';
import { dateTime, LABELS } from '../format.js';

const CAT = { financiere: '💰 Financière', stock: '📦 Stock', systeme: '🔐 Système' };
const refLink = (a) => ({
  payment: `/paiements/${a.ref_id}`, cash_session: `/caisse/sessions/${a.ref_id}`, expense: `/depenses?id=${a.ref_id}`, product: `/pharmacie/produits/${a.ref_id}`,
  user: `/employes/${a.ref_id}`, inventory: `/pharmacie/inventaires/${a.ref_id}`,
}[a.ref_type]);

export default function Alerts() {
  const { can } = useAuth();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [f, setF] = useState({ status: 'open', category: sp.get('category') || '', severity: '' });
  const [page, setPage] = useState(1);
  const { data, reload } = useFetch('/alerts', { ...f, page });
  const [treat, setTreat] = useState(null);
  useRealtime((e) => { if (e === 'alert' || e === 'alert_update') reload(); });
  useEffect(() => { const id = Number(sp.get('id')); if (id && data) { const a = data.items.find((x) => x.id === id); if (a) setTreat(a); } }, [data, sp]);
  return (
    <>
      <PageHeader title="Alertes" subtitle="Signaux à vérifier — une alerte n'est pas une preuve de fraude" />
      <Card>
        <div className="toolbar">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Statut"><option value="open">À traiter</option><option value="">Toutes</option><option value="resolue">Résolues</option><option value="ignoree">Classées</option></select>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Catégorie"><option value="">Toutes catégories</option>{Object.entries(CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} aria-label="Gravité"><option value="">Toutes gravités</option><option value="haute">🔴 Haute</option><option value="moyenne">🟠 Moyenne</option></select>
        </div>
        {!data ? <Empty>Chargement…</Empty> : !data.items.length ? <Empty>✅ Aucune alerte.</Empty> : (
          <ul className="feed">
            {data.items.map((a) => (
              <li key={a.id}>
                <span style={{ fontSize: '1.2rem' }}>{a.severity === 'haute' ? '🔴' : '🟠'}</span>
                <span className="what">
                  <b>{a.title}</b> <Badge value={a.status} map="alert_status" />
                  {a.details?.message && <div className="small">{a.details.message}</div>}
                  <div className="who">{CAT[a.category]} · {dateTime(a.created_at)}{a.user_name && ` · ${a.user_name}`}{refLink(a) && <> · <Link to={refLink(a)}>voir l'élément</Link></>}</div>
                  {a.resolution_note && <div className="who">✔ {a.resolved_by_name} : {a.resolution_note}</div>}
                </span>
                {can('alerts.manage') && ['nouvelle', 'en_verification'].includes(a.status) && <button className="btn sm" onClick={() => setTreat(a)}>Traiter</button>}
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
      {treat && <TreatModal alert={treat} onClose={() => setTreat(null)} onDone={() => { setTreat(null); toast('Alerte mise à jour'); reload(); }} />}
    </>
  );
}

function TreatModal({ alert: a, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const go = async (status) => { try { await api.put(`/alerts/${a.id}`, { status, resolution_note: note || null }); onDone(); } catch (e) { setError(e); } };
  return (
    <Modal title={a.title} onClose={onClose}>
      <div className="form">
        {a.details?.message && <p>{a.details.message}</p>}
        <p className="muted small">{dateTime(a.created_at)} · {LABELS.alert_status[a.status]}</p>
        <Field label="Note de vérification"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ce qui a été vérifié, conclusion…" /></Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          {a.status === 'nouvelle' && <button className="btn" onClick={() => go('en_verification')}>En cours de vérification</button>}
          <button className="btn ghost" onClick={() => go('ignoree')} disabled={!note}>Classer sans suite</button>
          <button className="btn primary" onClick={() => go('resolue')} disabled={!note}>Marquer résolue</button>
        </div>
      </div>
    </Modal>
  );
}
