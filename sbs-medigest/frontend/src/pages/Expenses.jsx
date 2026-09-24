import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, Table, Pagination, useFetch, Modal, Field, ErrorBox, Badge, Empty, useToast, PeriodFilter, periodParams, Money, ReasonModal, RegisterSelect } from '../components/ui.jsx';
import { date, dateTime, gnf, todayISO } from '../format.js';

function ExpenseForm({ onClose, onSaved }) {
  const { expenseCategories, can } = useAuth();
  const { data: suppliers } = useFetch(can('suppliers.view', 'expenses.create') ? '/suppliers' : null);
  const [f, setF] = useState({ category: expenseCategories[0] || '', amount: '', reason: '', beneficiary: '', supplier_id: '', expense_date: todayISO(), pay_from_cash: false, register_id: '' });
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    const fd = new FormData();
    Object.entries(f).forEach(([k, v]) => fd.append(k, String(v)));
    if (file) fd.append('attachment', file);
    try { onSaved(await api.post('/expenses', fd)); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nouvelle dépense" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Catégorie" required><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{expenseCategories.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Montant (GNF)" required><input type="number" min="1" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
          <Field label="Date"><input type="date" value={f.expense_date} onChange={(e) => setF({ ...f, expense_date: e.target.value })} /></Field>
          <Field label="Bénéficiaire"><input value={f.beneficiary} onChange={(e) => setF({ ...f, beneficiary: e.target.value })} /></Field>
          {suppliers?.length > 0 && <Field label="Fournisseur" className="span-2"><select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
        </div>
        <Field label="Motif" required><textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} /></Field>
        <Field label="Justificatif (photo ou PDF)"><input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files[0])} /></Field>
        {(can('expenses.disburse') || can('cash.operate')) && <label className="check"><input type="checkbox" checked={f.pay_from_cash} onChange={(e) => setF({ ...f, pay_from_cash: e.target.checked })} /> Payer immédiatement en espèces depuis la caisse (si aucune validation n'est requise)</label>}
        {f.pay_from_cash && <RegisterSelect value={f.register_id} onChange={(v) => setF((x) => ({ ...x, register_id: v }))} />}
        <p className="hint">Les dépenses au-delà du seuil défini nécessitent la validation de l'administrateur.</p>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary" disabled={busy}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

function ExpenseDetail({ e, onClose, onChanged }) {
  const { can } = useAuth();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const [cancel, setCancel] = useState(false);
  const [disburseRegister, setDisburseRegister] = useState('');
  const act = async (fn, msg) => { setError(null); try { onChanged(await fn()); toast(msg); } catch (err) { setError(err); } };
  return (
    <Modal title={`Dépense ${e.number}`} onClose={onClose}>
      <dl className="kv">
        <dt>Montant</dt><dd><b>{gnf(e.amount)}</b></dd>
        <dt>Catégorie</dt><dd>{e.category}</dd>
        <dt>Motif</dt><dd>{e.reason}</dd>
        <dt>Bénéficiaire</dt><dd>{e.beneficiary || e.supplier_name || '—'}</dd>
        <dt>Date</dt><dd>{date(e.expense_date)}</dd>
        <dt>Saisie par</dt><dd>{e.created_by_name} · {dateTime(e.created_at)}</dd>
        <dt>Statut</dt><dd><Badge value={e.status} map="expense_status" /></dd>
        {e.validated_by_name && <><dt>{e.status === 'refusee' ? 'Refusée' : 'Validée'} par</dt><dd>{e.validated_by_name} · {dateTime(e.validated_at)}{e.validation_comment && ` — ${e.validation_comment}`}</dd></>}
        <dt>Décaissement</dt><dd>{e.disbursed ? `Décaissée le ${dateTime(e.disbursed_at)}` : 'Non décaissée'}</dd>
        <dt>Justificatif</dt><dd>{e.attachment_name ? <a href={`/api/expenses/${e.id}/attachment`} target="_blank" rel="noreferrer">📎 {e.attachment_name}</a> : 'Aucun'}</dd>
      </dl>
      {e.status === 'en_attente' && can('expenses.validate') && (
        <div className="form" style={{ marginTop: 16 }}>
          <Field label="Commentaire (obligatoire en cas de refus)"><input value={comment} onChange={(ev) => setComment(ev.target.value)} /></Field>
          <div className="form-actions">
            <button className="btn danger" onClick={() => act(() => api.post(`/expenses/${e.id}/validate`, { decision: 'refusee', comment }), 'Dépense refusée')}>Refuser</button>
            <button className="btn primary" onClick={() => act(() => api.post(`/expenses/${e.id}/validate`, { decision: 'validee', comment: comment || null }), 'Dépense validée')}>Valider</button>
          </div>
        </div>
      )}
      <div className="form-actions" style={{ marginTop: 12 }}>
        {e.status === 'validee' && !e.disbursed && (can('expenses.disburse') || can('cash.operate')) && <><RegisterSelect value={disburseRegister} onChange={setDisburseRegister} /><button className="btn primary" onClick={() => act(() => api.post(`/expenses/${e.id}/disburse`, { register_id: disburseRegister ? Number(disburseRegister) : null }), 'Dépense décaissée')}>💸 Décaisser de la caisse</button></>}
        {!e.disbursed && e.status !== 'annulee' && can('expenses.validate') && <button className="btn ghost" onClick={() => setCancel(true)}>Annuler la dépense</button>}
      </div>
      <ErrorBox error={error} />
      {cancel && <ReasonModal title="Annuler la dépense" danger onClose={() => setCancel(false)} onConfirm={async (reason) => onChanged(await api.post(`/expenses/${e.id}/cancel`, { reason }))} />}
    </Modal>
  );
}

export default function Expenses() {
  const { can, expenseCategories } = useAuth();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [period, setPeriod] = useState({ period: sp.get('status') || sp.get('id') ? '' : 'month' });
  const [f, setF] = useState({ status: sp.get('status') || '', category: '', q: '' });
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const { data, reload } = useFetch('/expenses', { ...periodParams(period), ...f, page });
  useEffect(() => { const id = sp.get('id'); if (id) api.get(`/expenses/${id}`).then((e) => setModal({ detail: e })).catch(() => {}); }, [sp]);
  return (
    <>
      <PageHeader title="Dépenses">{can('expenses.create') && <button className="btn primary" onClick={() => setModal('new')}>+ Nouvelle dépense</button>}</PageHeader>
      <Card>
        <div className="toolbar">
          <input type="search" placeholder="Motif, n°, bénéficiaire…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <PeriodFilter value={period} onChange={setPeriod} />
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Statut"><option value="">Tous statuts</option><option value="en_attente">En attente</option><option value="validee">Validée</option><option value="refusee">Refusée</option><option value="annulee">Annulée</option></select>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Catégorie"><option value="">Toutes catégories</option>{expenseCategories.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        {data && <p className="muted small" style={{ marginTop: 0 }}>Total validé sur la sélection : <b className="money">{gnf(data.total_validated)}</b></p>}
        <Table rows={data?.items} onRowClick={(r) => setModal({ detail: r })} columns={[
          { key: 'expense_date', label: 'Date', render: (r) => date(r.expense_date) },
          { key: 'number', label: 'N°' },
          { key: 'category', label: 'Catégorie' },
          { key: 'reason', label: 'Motif' },
          { key: 'created_by_name', label: 'Saisie par' },
          { key: 'status', label: 'Statut', render: (r) => <><Badge value={r.status} map="expense_status" />{r.disbursed && <span title="Décaissée"> 💸</span>}{r.attachment_name && <span title="Justificatif"> 📎</span>}</> },
          { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.amount} /> },
        ]} />
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
      {modal === 'new' && <ExpenseForm onClose={() => setModal(null)} onSaved={(e) => { toast(e.status === 'en_attente' ? 'Dépense soumise à validation' : 'Dépense enregistrée'); setModal(null); reload(); }} />}
      {modal?.detail && <ExpenseDetail e={modal.detail} onClose={() => setModal(null)} onChanged={(e) => { setModal({ detail: e }); reload(); }} />}
    </>
  );
}
