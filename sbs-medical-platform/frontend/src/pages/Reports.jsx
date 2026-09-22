import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, Table, useFetch, Empty, Stat, BarChart, Tabs, ErrorBox, PeriodFilter, periodParams } from '../components/ui.jsx';
import { gnf, num, date, dateTime, LABELS, toCSV, download, todayISO } from '../format.js';

const PRESETS = [['today', 'Quotidien'], ['week', 'Hebdomadaire'], ['month', 'Mensuel'], ['year', 'Annuel'], ['custom', 'Personnalisé']];

const Evo = ({ v, inverse }) => v == null ? null : <span className={`small ${(v >= 0) !== !!inverse ? 'money pos' : 'money neg'}`}>{v >= 0 ? '▲' : '▼'} {Math.abs(v)} %</span>;

export function Reports() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [preset, setPreset] = useState('today');
  const [range, setRange] = useState({ from: todayISO(), to: todayISO() });
  const params = preset === 'custom' ? range : { period: preset };
  const { data: r, error } = useFetch('/reports/summary', params);
  const { data: users } = useFetch(can('reports.employee') ? '/users' : null);
  const exportCsv = () => {
    const rows = [
      ...r.series.map((s) => ({ section: 'Jour', label: date(s.day), a: s.revenue, b: s.expenses, c: s.consultations })),
      ...r.revenue_by_source.map((s) => ({ section: 'Recettes par source', label: LABELS.source[s.source_type], a: s.total, b: s.discounts, c: s.count })),
      ...r.revenue_by_method.map((s) => ({ section: 'Recettes par mode', label: LABELS.method[s.method], a: s.total, b: '', c: s.count })),
      ...r.expenses_by_category.map((s) => ({ section: 'Dépenses', label: s.category, a: s.total, b: '', c: s.count })),
      ...r.acts.map((s) => ({ section: 'Actes', label: s.name, a: s.total, b: '', c: s.count })),
      ...r.exams.map((s) => ({ section: 'Examens', label: s.name, a: s.total, b: '', c: s.count })),
      ...r.pharmacy.top_products.map((s) => ({ section: 'Pharmacie', label: s.name, a: s.total, b: '', c: s.quantity })),
      ...r.cash.sessions.map((s) => ({ section: 'Caisse', label: s.number, a: s.declared_balance, b: s.discrepancy, c: s.closed_by_name })),
    ];
    download(`rapport-${preset}-${todayISO()}.csv`, toCSV(rows, [
      { label: 'Section', value: 'section' }, { label: 'Libellé', value: 'label' }, { label: 'Montant / recettes', value: 'a' },
      { label: 'Dépenses / remises / écart', value: 'b' }, { label: 'Nombre', value: 'c' },
    ]));
  };
  return (
    <>
      <PageHeader title="Rapports" subtitle={r ? `Du ${date(r.period.from)} au ${date(new Date(new Date(r.period.to) - 1))}` : ''}>
        {users && <select onChange={(e) => e.target.value && nav(`/rapports/employe/${e.target.value}`)} defaultValue="" aria-label="Rapport par employé"><option value="">👤 Rapport par employé…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>)}</select>}
        <button className="btn ghost" onClick={exportCsv} disabled={!r}>⬇ CSV</button>
        <button className="btn" onClick={() => window.print()}>🖨️ Imprimer / PDF</button>
      </PageHeader>
      <div className="toolbar no-print">
        <Tabs value={preset} onChange={setPreset} tabs={PRESETS.map(([k, l]) => ({ key: k, label: l }))} />
        {preset === 'custom' && <><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="Du" /><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="Au" /></>}
      </div>
      <ErrorBox error={error} />
      {!r ? <Empty>Chargement…</Empty> : (
        <>
          <div className="stats">
            <Stat icon="💰" label="Recettes" value={gnf(r.totals.revenue)} sub={<Evo v={r.evolution.revenue} />} />
            <Stat icon="💸" label="Dépenses" value={gnf(r.totals.expenses)} sub={<Evo v={r.evolution.expenses} inverse />} />
            <Stat icon="📊" label="Résultat" value={gnf(r.totals.net)} tone={r.totals.net < 0 ? 'danger' : ''} />
            <Stat icon="🩺" label="Consultations" value={num(r.totals.consultations)} sub={<Evo v={r.evolution.consultations} />} />
            <Stat icon="👥" label="Patients vus" value={num(r.totals.patients_seen)} sub={`${r.totals.new_patients} nouveau(x)`} />
            <Stat icon="🧪" label="Demandes labo" value={num(r.totals.lab_requests)} />
            <Stat icon="💊" label="Ventes pharmacie" value={gnf(r.totals.pharmacy_sales)} sub={`marge ${gnf(r.pharmacy.margin)}`} />
            <Stat icon="⚖️" label="Écarts de caisse" value={gnf(r.cash.total_discrepancy)} sub={`${r.cash.sessions_with_discrepancy} clôture(s) avec écart`} tone={r.cash.total_discrepancy ? 'danger' : ''} />
          </div>
          {r.series.length > 1 && (
            <Card title="Évolution">
              <BarChart data={r.series.length > 45 ? aggregateMonthly(r.series) : r.series.map((s) => ({ ...s, label: new Date(s.day).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) }))}
                series={[{ key: 'revenue', label: 'Recettes', className: 'revenue' }, { key: 'expenses', label: 'Dépenses', className: 'expenses' }]} />
            </Card>
          )}
          <div className="grid-2">
            <Card title="Recettes par activité"><Table rows={r.revenue_by_source} empty="Aucune recette" columns={[
              { key: 'source_type', label: 'Activité', render: (x) => LABELS.source[x.source_type] }, { key: 'count', label: 'Nb', align: 'right' },
              { key: 'discounts', label: 'Remises', align: 'right', render: (x) => gnf(x.discounts) }, { key: 'total', label: 'Montant', align: 'right', render: (x) => <b>{gnf(x.total)}</b> },
            ]} /></Card>
            <Card title="Recettes par mode de paiement"><Table rows={r.revenue_by_method} empty="—" columns={[
              { key: 'method', label: 'Mode', render: (x) => LABELS.method[x.method] }, { key: 'count', label: 'Nb', align: 'right' }, { key: 'total', label: 'Montant', align: 'right', render: (x) => <b>{gnf(x.total)}</b> },
            ]} />
            {r.reversals.length > 0 && <p className="small" style={{ marginTop: 10 }}>{r.reversals.map((x) => `${LABELS.pay_status[x.status]} : ${x.count} (${gnf(x.total)})`).join(' · ')}</p>}</Card>
            <Card title="Dépenses par catégorie"><Table rows={r.expenses_by_category} empty="Aucune dépense" columns={[
              { key: 'category', label: 'Catégorie' }, { key: 'count', label: 'Nb', align: 'right' }, { key: 'total', label: 'Montant', align: 'right', render: (x) => <b>{gnf(x.total)}</b> },
            ]} /></Card>
            <Card title="Activité médicale">
              <Table rows={r.consultations_by_doctor} empty="Aucune consultation" columns={[{ key: 'doctor', label: 'Médecin' }, { key: 'count', label: 'Consultations', align: 'right' }, { key: 'total', label: 'Facturé', align: 'right', render: (x) => gnf(x.total) }]} />
              <h3 className="small muted" style={{ margin: '14px 0 6px' }}>Actes</h3>
              <Table rows={r.acts} empty="—" columns={[{ key: 'name', label: 'Acte' }, { key: 'count', label: 'Nb', align: 'right' }, { key: 'total', label: 'Montant', align: 'right', render: (x) => gnf(x.total) }]} />
            </Card>
            <Card title="Laboratoire"><Table rows={r.exams} empty="Aucun examen" columns={[{ key: 'name', label: 'Examen' }, { key: 'count', label: 'Nb', align: 'right' }, { key: 'total', label: 'Montant', align: 'right', render: (x) => gnf(x.total) }]} /></Card>
            <Card title="Pharmacie — meilleures ventes"><Table rows={r.pharmacy.top_products} empty="Aucune vente" columns={[{ key: 'name', label: 'Produit' }, { key: 'quantity', label: 'Qté', align: 'right' }, { key: 'total', label: 'CA', align: 'right', render: (x) => gnf(x.total) }]} /></Card>
          </div>
          <Card title="Clôtures de caisse">
            <Table rows={r.cash.sessions} empty="Aucune clôture sur la période" columns={[
              { key: 'number', label: 'Session', render: (x) => <Link to={`/caisse/sessions/${x.id}`}>{x.number}</Link> }, { key: 'closed_at', label: 'Clôture', render: (x) => dateTime(x.closed_at) },
              { key: 'closed_by_name', label: 'Par' }, { key: 'expected_balance', label: 'Théorique', align: 'right', render: (x) => gnf(x.expected_balance) },
              { key: 'declared_balance', label: 'Déclarée', align: 'right', render: (x) => gnf(x.declared_balance) },
              { key: 'discrepancy', label: 'Écart', align: 'right', render: (x) => <span className={x.discrepancy ? 'money neg' : ''}>{gnf(x.discrepancy)}</span> },
              { key: 'justification', label: 'Justification' },
            ]} />
          </Card>
        </>
      )}
    </>
  );
}

function aggregateMonthly(series) {
  const m = new Map();
  for (const s of series) {
    const d = new Date(s.day); const k = `${d.getFullYear()}-${d.getMonth()}`;
    const cur = m.get(k) || { label: d.toLocaleDateString('fr-FR', { month: 'short' }), revenue: 0, expenses: 0 };
    cur.revenue += Number(s.revenue); cur.expenses += Number(s.expenses); m.set(k, cur);
  }
  return [...m.values()];
}

export function EmployeeReport() {
  const { id } = useParams();
  const [period, setPeriod] = useState({ period: 'month' });
  const { data: r, error } = useFetch(`/reports/employee/${id}`, periodParams(period));
  if (error) return <ErrorBox error={error} />;
  if (!r) return <Empty>Chargement…</Empty>;
  const e = r.employee;
  const loginCount = r.logins.find((l) => l.event === 'login')?.count || 0;
  const failed = r.logins.filter((l) => ['failed', 'locked'].includes(l.event)).reduce((s, l) => s + l.count, 0);
  return (
    <>
      <PageHeader title={`Rapport — ${e.first_name} ${e.last_name}`} subtitle={`${e.employee_number} · ${e.role_name} · historique professionnel et opérationnel`}>
        <PeriodFilter value={period} onChange={setPeriod} allowAll={false} />
        <button className="btn" onClick={() => window.print()}>🖨️ Imprimer</button>
      </PageHeader>
      <div className="stats">
        <Stat icon="🔑" label="Connexions" value={num(loginCount)} sub={failed ? `${failed} échec(s)` : null} tone={failed ? 'warn' : ''} />
        <Stat icon="💳" label="Paiements enregistrés" value={num(r.payments.count)} sub={gnf(r.payments.total)} />
        <Stat icon="🏷️" label="Remises accordées" value={gnf(r.payments.discounts)} sub={`${r.payments.with_discount} paiement(s)`} />
        <Stat icon="🩺" label="Consultations" value={num(r.consultations)} />
        <Stat icon="✏️" label="Modifications" value={num(r.modifications)} tone={r.modifications ? 'warn' : ''} />
        <Stat icon="↩️" label="Annulations / remb." value={num(r.cancellations)} tone={r.cancellations ? 'warn' : ''} />
      </div>
      <div className="grid-2">
        <Card title="Clôtures de caisse"><Table rows={r.cash_closings} empty="Aucune" columns={[
          { key: 'number', label: 'Session', render: (x) => <Link to={`/caisse/sessions/${x.id}`}>{x.number}</Link> }, { key: 'closed_at', label: 'Date', render: (x) => dateTime(x.closed_at) },
          { key: 'discrepancy', label: 'Écart', align: 'right', render: (x) => <span className={x.discrepancy ? 'money neg' : ''}>{gnf(x.discrepancy)}</span> },
        ]} /></Card>
        <Card title="Mouvements de stock"><Table rows={r.stock_movements} empty="Aucun" columns={[{ key: 'reason', label: 'Motif', render: (x) => LABELS.stock_reason[x.reason] }, { key: 'count', label: 'Opérations', align: 'right' }, { key: 'quantity', label: 'Quantité', align: 'right' }]} /></Card>
        <Card title="Opérations par type"><Table rows={r.actions} empty="Aucune" columns={[{ key: 'action', label: 'Action', render: (x) => <code className="small">{x.action}</code> }, { key: 'count', label: 'Nb', align: 'right' }]} /></Card>
        <Card title="Dernières opérations"><Table rows={r.recent} empty="Aucune" columns={[{ key: 'created_at', label: 'Date', render: (x) => dateTime(x.created_at) }, { key: 'summary', label: 'Détail', render: (x) => <>{x.summary}{x.reason && <div className="muted small">Motif : {x.reason}</div>}</> }]} /></Card>
      </div>
    </>
  );
}
