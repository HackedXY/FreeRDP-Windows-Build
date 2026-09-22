import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useRealtime } from '../realtime.js';
import { PageHeader, Card, Table, Pagination, useFetch, Field, ErrorBox, Badge, Empty, useToast, PeriodFilter, periodParams, Money, Stat } from '../components/ui.jsx';
import { dateTime, gnf, LABELS } from '../format.js';

const CATEGORY = { paiement: 'Paiement', depense: 'Dépense', remboursement: 'Remboursement', annulation: 'Annulation', correction: 'Correction' };

function OpenSession({ s, onClosed }) {
  const { can } = useAuth();
  const [declared, setDeclared] = useState('');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState(null);
  const diff = declared === '' ? null : Number(declared) - s.expected_balance;
  const close = async (e) => {
    e.preventDefault(); setError(null);
    try { onClosed(await api.post('/cash/close', { session_id: s.id, declared_balance: Number(declared), justification: justification || null })); } catch (err) { setError(err); }
  };
  return (
    <Card title={`${s.register_name} — ${s.number}`} actions={<Badge tone="ok">Ouverte</Badge>}>
      <p className="muted small" style={{ marginTop: 0 }}>Ouverte par {s.opened_by_name} le {dateTime(s.opened_at)}</p>
      <div className="stats">
        <Stat icon="🔓" label="Solde initial" value={gnf(s.opening_balance)} />
        <Stat icon="⬆️" label="Entrées (espèces)" value={gnf(s.total_in)} />
        <Stat icon="⬇️" label="Sorties" value={gnf(s.total_out)} sub={`Dépenses ${gnf(s.expenses_out)} · Remb. ${gnf(s.refunds_out)}`} />
        <Stat icon="🏦" label="Caisse théorique" value={gnf(s.expected_balance)} />
      </div>
      <div className="row" style={{ marginTop: 10 }}><Link to={`/caisse/sessions/${s.id}`}>Voir le détail des mouvements →</Link></div>
      {can('cash.operate') && (
        <form className="form" onSubmit={close} style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <h3 style={{ margin: 0 }}>Clôture de caisse</h3>
          <div className="form-grid">
            <Field label="Montant compté (caisse déclarée)" required><input type="number" min="0" value={declared} onChange={(e) => setDeclared(e.target.value)} required /></Field>
            {diff !== null && <Field label="Écart"><div className={`money ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''}`} style={{ fontSize: '1.3rem', paddingTop: 4 }}>{diff > 0 ? '+' : ''}{gnf(diff)}</div></Field>}
          </div>
          {diff !== null && diff !== 0 && <Field label="Justification de l'écart" required><textarea rows={2} value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} /></Field>}
          {diff !== null && diff !== 0 && <div className="alert-box warn">Un écart sera signalé à l'administrateur.</div>}
          <ErrorBox error={error} />
          <div className="form-actions"><button className="btn primary" disabled={declared === ''}>Clôturer la caisse</button></div>
        </form>
      )}
    </Card>
  );
}

export function Cash() {
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const { data: current, reload } = useFetch('/cash/current');
  const { data: registers } = useFetch('/cash/registers');
  const [period, setPeriod] = useState({ period: 'month' });
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [page, setPage] = useState(1);
  const { data: sessions, reload: reloadS } = useFetch('/cash/sessions', { ...periodParams(period), discrepancy: onlyDiff ? '1' : '', page });
  const [open, setOpen] = useState({ register_id: '', opening_balance: '' });
  const [error, setError] = useState(null);
  useRealtime((e) => { if (e === 'stats') reload(); });
  const openRegisters = new Set((current || []).map((s) => s.register_id));
  const closedRegisters = (registers || []).filter((r) => !openRegisters.has(r.id));
  const doOpen = async (e) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/cash/open', { register_id: Number(open.register_id || closedRegisters[0]?.id), opening_balance: Number(open.opening_balance) });
      toast('Caisse ouverte'); setOpen({ register_id: '', opening_balance: '' }); reload(); reloadS();
    } catch (err) { setError(err); }
  };
  return (
    <>
      <PageHeader title="Caisse" subtitle="Ouverture, contrôle et clôture quotidienne" />
      {current?.map((s) => <OpenSession key={s.id} s={s} onClosed={(r) => { toast(r.discrepancy ? `Caisse clôturée — écart ${gnf(r.discrepancy)}` : 'Caisse clôturée sans écart', r.discrepancy ? 'warn' : 'ok'); reload(); reloadS(); }} />)}
      {can('cash.operate') && closedRegisters.length > 0 && (
        <Card title="Ouvrir une caisse">
          <form className="form-grid" onSubmit={doOpen}>
            {closedRegisters.length > 1 && <Field label="Caisse"><select value={open.register_id} onChange={(e) => setOpen({ ...open, register_id: e.target.value })}>{closedRegisters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
            <Field label="Solde initial (fond de caisse)" required><input type="number" min="0" value={open.opening_balance} onChange={(e) => setOpen({ ...open, opening_balance: e.target.value })} required /></Field>
            <div className="field" style={{ justifyContent: 'flex-end' }}><button className="btn primary">Ouvrir la caisse</button></div>
          </form>
          <ErrorBox error={error} />
        </Card>
      )}
      <Card title="Historique des clôtures">
        <div className="toolbar">
          <PeriodFilter value={period} onChange={setPeriod} />
          <label className="check"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Avec écart uniquement</label>
        </div>
        <Table rows={sessions?.items} onRowClick={(r) => nav(`/caisse/sessions/${r.id}`)} columns={[
          { key: 'number', label: 'Session', render: (r) => <b>{r.number}</b> },
          { key: 'opened_at', label: 'Ouverture', render: (r) => <>{dateTime(r.opened_at)}<div className="muted small">{r.opened_by_name}</div></> },
          { key: 'closed_at', label: 'Clôture', render: (r) => r.closed_at ? <>{dateTime(r.closed_at)}<div className="muted small">{r.closed_by_name}</div></> : <Badge tone="ok">Ouverte</Badge> },
          { key: 'opening_balance', label: 'Initial', align: 'right', render: (r) => gnf(r.opening_balance) },
          { key: 'expected_balance', label: 'Théorique', align: 'right', render: (r) => r.expected_balance != null ? gnf(r.expected_balance) : '—' },
          { key: 'declared_balance', label: 'Déclarée', align: 'right', render: (r) => r.declared_balance != null ? gnf(r.declared_balance) : '—' },
          { key: 'discrepancy', label: 'Écart', align: 'right', render: (r) => r.discrepancy == null ? '—' : <span className={`money ${r.discrepancy < 0 ? 'neg' : r.discrepancy > 0 ? 'pos' : ''}`}>{gnf(r.discrepancy)}</span> },
        ]} />
        <Pagination page={page} total={sessions?.total} onChange={setPage} />
      </Card>
    </>
  );
}

export function CashSession() {
  const { id } = useParams();
  const { data: s, error } = useFetch(`/cash/sessions/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!s) return <Empty>Chargement…</Empty>;
  return (
    <>
      <PageHeader title={`Session de caisse ${s.number}`} subtitle={`${s.register_name} · ouverte par ${s.opened_by_name} le ${dateTime(s.opened_at)}${s.closed_at ? ` · clôturée par ${s.closed_by_name} le ${dateTime(s.closed_at)}` : ''}`}>
        <Badge tone={s.status === 'ouverte' ? 'ok' : 'muted'}>{s.status === 'ouverte' ? 'Ouverte' : 'Clôturée'}</Badge>
        <button className="btn ghost" onClick={() => window.print()}>🖨️ Imprimer</button>
      </PageHeader>
      <div className="stats">
        <Stat icon="🔓" label="Solde initial" value={gnf(s.opening_balance)} />
        <Stat icon="⬆️" label="Paiements espèces" value={gnf(s.payments_in)} />
        <Stat icon="⬇️" label="Dépenses" value={gnf(s.expenses_out)} />
        <Stat icon="↩️" label="Remboursements / annulations" value={gnf(s.refunds_out + s.cancellations_out)} />
        <Stat icon="🏦" label="Caisse théorique" value={gnf(s.expected_balance)} />
        {s.declared_balance != null && <Stat icon="🧮" label="Caisse déclarée" value={gnf(s.declared_balance)} />}
        {s.discrepancy != null && <Stat icon="⚖️" label="Écart" value={gnf(s.discrepancy)} tone={s.discrepancy ? 'danger' : ''} sub={s.justification} />}
      </div>
      {s.payments_by_method?.length > 0 && (
        <Card title="Encaissements par mode (tous modes)">
          <dl className="kv">{s.payments_by_method.flatMap((m) => [<dt key={`a${m.method}`}>{LABELS.method[m.method]}</dt>, <dd key={`b${m.method}`}>{gnf(m.total)} <span className="muted small">({m.count})</span></dd>])}</dl>
        </Card>
      )}
      <Card title="Mouvements d'espèces">
        <Table rows={s.movements} columns={[
          { key: 'created_at', label: 'Heure', render: (r) => dateTime(r.created_at) },
          { key: 'category', label: 'Type', render: (r) => CATEGORY[r.category] },
          { key: 'ref', label: 'Référence', render: (r) => r.ref_type === 'payment' ? <Link to={`/paiements/${r.ref_id}`}>{r.ref_number}</Link> : r.ref_number || '—' },
          { key: 'note', label: 'Note', render: (r) => r.note || '' },
          { key: 'user_name', label: 'Par' },
          { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.direction === 'in' ? r.amount : -r.amount} tone={r.direction === 'in' ? 'pos' : 'neg'} /> },
        ]} />
      </Card>
    </>
  );
}
