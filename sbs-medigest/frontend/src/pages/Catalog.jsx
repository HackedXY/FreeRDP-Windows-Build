import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, Table, useFetch, Modal, Field, ErrorBox, Badge, useToast, useForm, Tabs } from '../components/ui.jsx';
import { gnf } from '../format.js';

function ItemForm({ kind, item, onClose, onSaved }) {
  const { values, bind } = useForm(item ? { ...item, active: String(item.active) } : { active: 'true', category: kind === 'acts' ? 'soin' : '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = kind === 'acts'
      ? { code: values.code || null, name: values.name, category: values.category || 'soin', description: values.description || null, price: Number(values.price), duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null, active: values.active === 'true' }
      : { code: values.code || null, name: values.name, category: values.category || null, price: Number(values.price), unit: values.unit || null, reference_range: values.reference_range || null, active: values.active === 'true' };
    const base = kind === 'acts' ? '/acts' : '/lab/exams';
    try { onSaved(item ? await api.put(`${base}/${item.id}`, body) : await api.post(base, body)); } catch (err) { setError(err); }
  };
  return (
    <Modal title={item ? item.name : kind === 'acts' ? 'Nouvel acte' : 'Nouvel examen'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nom" required className="span-2"><input {...bind('name')} required /></Field>
          <Field label="Code"><input {...bind('code')} /></Field>
          <Field label="Catégorie">{kind === 'acts'
            ? <select {...bind('category')}><option value="consultation">Consultation</option><option value="soin">Soins</option><option value="petite_chirurgie">Petite chirurgie</option><option value="examen">Examen</option><option value="autre">Autre</option></select>
            : <input {...bind('category')} placeholder="Hématologie, Biochimie…" />}</Field>
          <Field label="Prix (GNF)" required><input type="number" min="0" {...bind('price')} required /></Field>
          {kind === 'acts' ? <Field label="Durée (min)"><input type="number" min="0" {...bind('duration_minutes')} /></Field> : <>
            <Field label="Unité"><input {...bind('unit')} /></Field>
            <Field label="Valeurs de référence"><input {...bind('reference_range')} /></Field>
          </>}
          <Field label="Statut"><select {...bind('active')}><option value="true">Actif</option><option value="false">Inactif</option></select></Field>
        </div>
        {kind === 'acts' && <Field label="Description"><textarea rows={2} {...bind('description')} /></Field>}
        {item && <p className="hint">Un changement de tarif est tracé et signalé à l'administrateur.</p>}
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export default function Catalog() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState(can('acts.manage') ? 'acts' : 'exams');
  const { data, reload } = useFetch(tab === 'acts' ? '/acts' : '/lab/exams', { all: '1' });
  const [modal, setModal] = useState(null);
  const editable = can(tab === 'acts' ? 'acts.manage' : 'lab.manage');
  return (
    <>
      <PageHeader title="Actes & tarifs">{editable && <button className="btn primary" onClick={() => setModal({ item: null })}>+ Ajouter</button>}</PageHeader>
      <Tabs value={tab} onChange={setTab} tabs={[can('acts.manage') && { key: 'acts', label: 'Actes médicaux' }, can('lab.manage') && { key: 'exams', label: 'Examens de laboratoire' }]} />
      <Card>
        <Table rows={data} onRowClick={editable ? (r) => setModal({ item: r }) : undefined} columns={[
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Nom', render: (r) => <b>{r.name}</b> }, { key: 'category', label: 'Catégorie' },
          ...(tab === 'acts' ? [{ key: 'duration_minutes', label: 'Durée', render: (r) => r.duration_minutes ? `${r.duration_minutes} min` : '—' }] : [{ key: 'reference_range', label: 'Référence' }]),
          { key: 'active', label: 'Statut', render: (r) => r.active ? <Badge tone="ok">Actif</Badge> : <Badge tone="muted">Inactif</Badge> },
          { key: 'price', label: 'Prix', align: 'right', render: (r) => gnf(r.price) },
        ]} />
      </Card>
      {modal && <ItemForm kind={tab} item={modal.item} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Enregistré'); reload(); }} />}
    </>
  );
}
