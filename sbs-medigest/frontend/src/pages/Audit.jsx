import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Pagination, useFetch, Modal, Empty, Table, PeriodFilter, periodParams, useToast } from '../components/ui.jsx';
import { useAuth } from '../auth.jsx';
import { dateTime, toCSV, download } from '../format.js';

const pretty = (v) => (v == null ? '—' : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k} : ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n') : String(v));

export default function Audit() {
  const toast = useToast();
  const [period, setPeriod] = useState({ period: 'week' });
  const [f, setF] = useState({ user_id: '', action: '', q: '' });
  const [page, setPage] = useState(1);
  const params = { ...periodParams(period), ...f, page, limit: 100 };
  const { data } = useFetch('/audit', params);
  const { can } = useAuth();
  const { data: users } = useFetch(can('users.view') ? '/users' : null);
  const { data: actions } = useFetch('/audit/actions');
  const [detail, setDetail] = useState(null);
  const [verify, setVerify] = useState(null);
  const check = async () => { const r = await api.get('/audit/verify'); setVerify(r); toast(r.ok ? `Journal intègre (${r.entries} entrées)` : 'Anomalie détectée dans le journal !', r.ok ? 'ok' : 'danger'); };
  const exportCsv = async () => {
    const all = await api.get('/audit', { ...params, page: 1, limit: 500 });
    download(`journal-audit-${Date.now()}.csv`, toCSV(all.items, [
      { label: 'Date', value: (r) => dateTime(r.created_at) }, { label: 'Utilisateur', value: 'user_name' }, { label: 'Action', value: 'action' },
      { label: 'Élément', value: (r) => `${r.entity_type || ''} ${r.entity_id || ''}` }, { label: 'Résumé', value: 'summary' },
      { label: 'Ancienne valeur', value: (r) => JSON.stringify(r.old_value ?? '') }, { label: 'Nouvelle valeur', value: (r) => JSON.stringify(r.new_value ?? '') },
      { label: 'Motif', value: 'reason' }, { label: 'IP', value: 'ip' },
    ]));
  };
  return (
    <>
      <PageHeader title="Journal d'audit" subtitle="Journal en ajout seul pour l'application, chaîné et signé : toute altération est détectée par la vérification">
        <button className="btn ghost" onClick={exportCsv}>⬇ Export CSV</button>
        <button className="btn" onClick={check}>🔏 Vérifier l'intégrité</button>
      </PageHeader>
      {verify && <div className={`alert-box ${verify.ok ? 'ok' : 'danger'}`}>{verify.ok ? `✔ Journal intègre (chaîne et signatures) — ${verify.entries} entrées vérifiées le ${dateTime(verify.checked_at)}.` : `✖ Altération détectée — chaîne rompue : ${verify.chain_broken_ids.join(', ') || 'aucune'} ; signature invalide : ${verify.signature_invalid_ids.join(', ') || 'aucune'} ; signature absente : ${verify.signature_missing_ids.join(', ') || 'aucune'}.`}</div>}
      <Card>
        <div className="toolbar">
          <input type="search" placeholder="Rechercher dans les résumés et motifs…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <PeriodFilter value={period} onChange={setPeriod} />
          <select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} aria-label="Utilisateur"><option value="">Tous les utilisateurs</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>)}</select>
          <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} aria-label="Action"><option value="">Toutes les actions</option>{actions?.map((a) => <option key={a}>{a}</option>)}</select>
        </div>
        {!data ? <Empty>Chargement…</Empty> : (
          <Table rows={data.items} onRowClick={setDetail} columns={[
            { key: 'created_at', label: 'Date / heure', render: (r) => <span className="nowrap">{dateTime(r.created_at)}</span> },
            { key: 'user_name', label: 'Utilisateur', render: (r) => <>{r.user_name || 'Système'}<div className="muted small">{r.role_name}</div></> },
            { key: 'action', label: 'Action', render: (r) => <code className="small">{r.action}</code> },
            { key: 'summary', label: 'Détail', render: (r) => <>{r.summary}{r.reason && <div className="muted small">Motif : {r.reason}</div>}</> },
          ]} />
        )}
        <Pagination page={page} total={data?.total} limit={100} onChange={setPage} />
      </Card>
      {detail && (
        <Modal title={`Entrée #${detail.id}`} onClose={() => setDetail(null)} wide>
          <dl className="kv">
            <dt>Date</dt><dd>{dateTime(detail.created_at)}</dd>
            <dt>Utilisateur</dt><dd>{detail.user_name || 'Système'} {detail.role_name && `(${detail.role_name})`}</dd>
            <dt>Action</dt><dd><code>{detail.action}</code></dd>
            <dt>Élément concerné</dt><dd>{detail.entity_type} {detail.entity_id}</dd>
            <dt>Résumé</dt><dd>{detail.summary}</dd>
            <dt>Ancienne valeur</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{pretty(detail.old_value)}</dd>
            <dt>Nouvelle valeur</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{pretty(detail.new_value)}</dd>
            <dt>Motif</dt><dd>{detail.reason || '—'}</dd>
            <dt>Adresse IP</dt><dd>{detail.ip || '—'}</dd>
          </dl>
        </Modal>
      )}
    </>
  );
}
