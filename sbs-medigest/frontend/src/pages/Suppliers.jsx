import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, Table, useFetch, Modal, Field, ErrorBox, Badge, useToast, useForm, Tabs, Money } from '../components/ui.jsx';
import { date, dateTime, gnf, LABELS } from '../format.js';

function SupplierForm({ supplier, onClose, onSaved }) {
  const { values, bind } = useForm(supplier || {});
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const body = { name: values.name, phone: values.phone || null, email: values.email || null, address: values.address || null, products: values.products || null, notes: values.notes || null };
    if (supplier) body.active = values.active !== false && values.active !== 'false';
    try { onSaved(supplier ? await api.put(`/suppliers/${supplier.id}`, body) : await api.post('/suppliers', body)); } catch (err) { setError(err); }
  };
  return (
    <Modal title={supplier ? supplier.name : 'Nouveau fournisseur'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nom" required className="span-2"><input {...bind('name')} required /></Field>
          <Field label="Téléphone"><input {...bind('phone')} /></Field>
          <Field label="E-mail"><input type="email" {...bind('email')} /></Field>
          <Field label="Adresse" className="span-2"><input {...bind('address')} /></Field>
          {supplier && <Field label="Statut"><select {...bind('active')}><option value="true">Actif</option><option value="false">Inactif</option></select></Field>}
        </div>
        <Field label="Produits fournis / conditions de prix"><textarea rows={2} {...bind('products')} /></Field>
        <Field label="Notes"><textarea rows={2} {...bind('notes')} /></Field>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

function SupplierDetail({ id, onClose, onEdit }) {
  const { data: s } = useFetch(`/suppliers/${id}`);
  const [tab, setTab] = useState('purchases');
  if (!s) return null;
  return (
    <Modal title={s.name} onClose={onClose} wide footer={onEdit && <button className="btn" onClick={() => onEdit(s)}>✏️ Modifier</button>}>
      <dl className="kv"><dt>Téléphone</dt><dd>{s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : '—'}</dd><dt>Adresse</dt><dd>{s.address || '—'}</dd><dt>Produits</dt><dd>{s.products || '—'}</dd></dl>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'purchases', label: 'Historique des achats', count: s.purchases.length },
        { key: 'payments', label: 'Paiements / factures', count: s.payments.length },
        { key: 'products', label: 'Produits', count: s.product_list.length },
      ]} />
      {tab === 'purchases' && <Table rows={s.purchases} columns={[
        { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) }, { key: 'product_name', label: 'Produit' },
        { key: 'quantity', label: 'Qté', align: 'right' }, { key: 'unit_cost', label: 'Coût unit.', align: 'right', render: (r) => gnf(r.unit_cost) },
        { key: 'document_ref', label: 'Facture / BL' }, { key: 'reason', label: 'Type', render: (r) => LABELS.stock_reason[r.reason] },
      ]} />}
      {tab === 'payments' && <Table rows={s.payments} columns={[
        { key: 'expense_date', label: 'Date', render: (r) => date(r.expense_date) }, { key: 'number', label: 'N°' }, { key: 'reason', label: 'Motif' },
        { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="expense_status" /> },
        { key: 'attachment_name', label: 'Facture', render: (r) => r.attachment_name ? <a href={`/api/expenses/${r.id}/attachment`} target="_blank" rel="noreferrer">📎</a> : '—' },
        { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.amount} /> },
      ]} />}
      {tab === 'products' && <Table rows={s.product_list} columns={[{ key: 'reference', label: 'Réf.' }, { key: 'name', label: 'Produit' }, { key: 'purchase_price', label: 'Prix d\'achat', align: 'right', render: (r) => gnf(r.purchase_price) }, { key: 'quantity', label: 'Stock', align: 'right' }]} />}
    </Modal>
  );
}

export default function Suppliers() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, reload } = useFetch('/suppliers');
  const [modal, setModal] = useState(null);
  return (
    <>
      <PageHeader title="Fournisseurs">{can('suppliers.manage') && <button className="btn primary" onClick={() => setModal({ form: null })}>+ Fournisseur</button>}</PageHeader>
      <Card>
        <Table rows={data} onRowClick={(r) => setModal({ detail: r.id })} columns={[
          { key: 'name', label: 'Fournisseur', render: (r) => <><b>{r.name}</b>{!r.active && <Badge tone="muted">inactif</Badge>}</> },
          { key: 'phone', label: 'Téléphone' }, { key: 'address', label: 'Adresse' },
          { key: 'product_count', label: 'Produits', align: 'right' },
          { key: 'purchases_total', label: 'Achats (stock)', align: 'right', render: (r) => gnf(r.purchases_total) },
          { key: 'paid_total', label: 'Payé', align: 'right', render: (r) => gnf(r.paid_total) },
        ]} />
      </Card>
      {modal?.detail && <SupplierDetail id={modal.detail} onClose={() => setModal(null)} onEdit={can('suppliers.manage') ? (s) => setModal({ form: s }) : null} />}
      {modal && 'form' in modal && <SupplierForm supplier={modal.form} onClose={() => setModal(null)} onSaved={() => { toast('Fournisseur enregistré'); setModal(null); reload(); }} />}
    </>
  );
}
