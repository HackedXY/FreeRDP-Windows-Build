import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  PageHeader, Card, Table, Pagination, useFetch, Modal, Field, useForm, ErrorBox, Badge, Empty, useToast, Money,
  PeriodFilter, periodParams, PatientPicker, ReasonModal,
} from '../components/ui.jsx';
import { dateTime, gnf, age, localInput } from '../format.js';
import { LabRequestModal } from './Lab.jsx';
import { LABELS } from '../format.js';

const CERT_TEMPLATES = {
  repos: 'Son état de santé nécessite un repos médical.',
  aptitude: 'Ne présente, à ce jour, aucune contre-indication cliniquement décelable à la pratique de l\'activité suivante : ',
  inaptitude: 'Présente, à ce jour, une contre-indication temporaire à : ',
  presence: 'S\'est présenté(e) ce jour en consultation au cabinet.',
  autre: '',
};

/** Certificats médicaux d'un patient (liste sans contenu, création, PDF, annulation par le signataire). */
export function CertificatesCard({ patientId, consultationId, editable = true }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data, reload } = useFetch('/documents/certificates', { patient_id: patientId });
  const [open, setOpen] = useState(false);
  const [cancel, setCancel] = useState(null);
  const [f, setF] = useState({ cert_type: 'repos', body: CERT_TEMPLATES.repos, rest_days: '', start_date: '', end_date: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/documents/certificates', { ...f, patient_id: patientId, consultation_id: consultationId || null, rest_days: f.rest_days ? Number(f.rest_days) : null });
      toast('Certificat établi'); setOpen(false); reload();
    } catch (err) { setError(err); }
  };
  return (
    <Card title="Certificats médicaux" actions={editable && can('certificates.create') && <button className="btn sm" onClick={() => setOpen(true)}>+ Certificat</button>}>
      {!data?.length ? <Empty>Aucun certificat</Empty> : data.map((ct) => (
        <div key={ct.id} className="row">
          <b className="small">{ct.number}</b><span className="small">{LABELS.cert_type[ct.cert_type]}</span>
          <span className="grow small muted">{dateTime(ct.issued_at)} · Dr {ct.doctor_name}</span>
          {ct.cancelled_at ? <Badge tone="muted">Annulé</Badge> : (
            can('certificates.create') && <button className="btn ghost sm" onClick={() => setCancel(ct)}>Annuler</button>
          )}
          <a className="btn ghost sm" href={`/api/documents/certificates/${ct.id}/pdf`} target="_blank" rel="noreferrer">🖨 PDF</a>
        </div>
      ))}
      {open && (
        <Modal title="Nouveau certificat médical" onClose={() => setOpen(false)}>
          <form className="form" onSubmit={submit}>
            <Field label="Type" required><select value={f.cert_type} onChange={(e) => setF({ ...f, cert_type: e.target.value, body: CERT_TEMPLATES[e.target.value] })}>{Object.entries(LABELS.cert_type).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Texte du certificat" required><textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required minLength={5} /></Field>
            {f.cert_type === 'repos' && (
              <div className="form-grid">
                <Field label="Durée du repos (jours)" required><input type="number" min="1" max="365" value={f.rest_days} onChange={(e) => setF({ ...f, rest_days: e.target.value })} required /></Field>
                <Field label="À partir du"><input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
                <Field label="Jusqu'au (inclus)"><input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
              </div>
            )}
            <p className="hint">Le contenu est chiffré ; le certificat est signé à votre nom et numéroté.</p>
            <ErrorBox error={error} />
            <div className="form-actions"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Annuler</button><button className="btn primary">Établir le certificat</button></div>
          </form>
        </Modal>
      )}
      {cancel && <ReasonModal title={`Annuler le certificat ${cancel.number}`} danger onClose={() => setCancel(null)} onConfirm={async (reason) => { await api.post(`/documents/certificates/${cancel.id}/cancel`, { reason }); reload(); }}><p className="muted">Seul le médecin signataire peut annuler un certificat. Le document reste archivé avec la mention « annulé ».</p></ReasonModal>}
    </Card>
  );
}

export function useDoctors() {
  const { data } = useFetch('/users/directory/doctors');
  return data || [];
}

export function ActsPicker({ value, onChange }) {
  const { data: acts } = useFetch('/acts');
  const add = (id) => { if (!id) return; const ex = value.find((a) => a.act_id === Number(id)); onChange(ex ? value.map((a) => a === ex ? { ...a, quantity: a.quantity + 1 } : a) : [...value, { act_id: Number(id), quantity: 1 }]); };
  const total = value.reduce((s, a) => s + (acts?.find((x) => x.id === a.act_id)?.price || 0) * a.quantity, 0);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <select value="" onChange={(e) => add(e.target.value)} aria-label="Ajouter un acte">
        <option value="">+ Ajouter un acte…</option>
        {acts?.map((a) => <option key={a.id} value={a.id}>{a.name} — {gnf(a.price)}</option>)}
      </select>
      {value.map((a) => {
        const act = acts?.find((x) => x.id === a.act_id);
        return (
          <div key={a.act_id} className="row">
            <span className="grow">{act?.name}</span>
            <input type="number" min="1" value={a.quantity} style={{ width: 70 }} onChange={(e) => onChange(value.map((x) => x === a ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x))} aria-label="Quantité" />
            <span className="money">{gnf((act?.price || 0) * a.quantity)}</span>
            <button type="button" className="icon-btn" onClick={() => onChange(value.filter((x) => x !== a))} aria-label="Retirer">✕</button>
          </div>
        );
      })}
      {value.length > 0 && <div className="right"><b>Total : {gnf(total)}</b></div>}
    </div>
  );
}

export function NewConsultationModal({ patient: initialPatient, onClose, onSaved }) {
  const { can, user } = useAuth();
  const doctors = useDoctors();
  const [patient, setPatient] = useState(initialPatient || null);
  const [acts, setActs] = useState([]);
  const { data: catalog } = useFetch('/acts');
  const { values, bind } = useForm({ consulted_at: localInput(), doctor_id: user.role.code === 'medecin' ? String(user.id) : '', status: 'en_attente' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const def = catalog?.find((a) => a.code === 'CONS');
    if (def && !acts.length) setActs([{ act_id: def.id, quantity: 1 }]);
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e) => {
    e.preventDefault();
    if (!patient) return setError(new Error('Choisissez un patient.'));
    setBusy(true); setError(null);
    const body = { patient_id: patient.id, doctor_id: values.doctor_id || null, reason: values.reason, status: values.status, consulted_at: new Date(values.consulted_at).toISOString(), acts };
    if (can('consultations.vitals')) for (const k of ['weight_kg', 'temperature_c', 'bp_systolic', 'bp_diastolic', 'heart_rate', 'spo2']) if (values[k]) body[k] = values[k];
    try { onSaved(await api.post('/consultations', body)); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nouvelle consultation" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field as="div" label="Patient" required className="span-2"><PatientPicker value={patient} onChange={setPatient} autoFocus={!initialPatient} /></Field>
          <Field label="Médecin"><select {...bind('doctor_id')}><option value="">— À assigner —</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Date et heure"><input type="datetime-local" {...bind('consulted_at')} /></Field>
          <Field label="Motif" className="span-2"><input {...bind('reason')} placeholder="Fièvre, douleurs, contrôle…" /></Field>
          <Field label="Statut"><select {...bind('status')}><option value="en_attente">En attente</option><option value="en_cours">En cours</option></select></Field>
        </div>
        {can('consultations.vitals') && (
          <fieldset className="card" style={{ padding: 12 }}>
            <legend className="small muted">Constantes</legend>
            <div className="form-grid">
              <Field label="Poids (kg)"><input type="number" step="0.1" {...bind('weight_kg')} /></Field>
              <Field label="Température (°C)"><input type="number" step="0.1" {...bind('temperature_c')} /></Field>
              <Field label="TA systolique"><input type="number" {...bind('bp_systolic')} /></Field>
              <Field label="TA diastolique"><input type="number" {...bind('bp_diastolic')} /></Field>
              <Field label="Fréquence cardiaque"><input type="number" {...bind('heart_rate')} /></Field>
              <Field label="Saturation SpO₂ (%)"><input type="number" {...bind('spo2')} /></Field>
            </div>
          </fieldset>
        )}
        <Field as="div" label="Actes facturés"><ActsPicker value={acts} onChange={setActs} /></Field>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary" disabled={busy}>Créer la consultation</button></div>
      </form>
    </Modal>
  );
}

export function ConsultationList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [period, setPeriod] = useState({ period: sp.get('payment_status') ? '' : 'today' });
  const [status, setStatus] = useState('');
  const [payment, setPayment] = useState(sp.get('payment_status') || '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data } = useFetch('/consultations', { ...periodParams(period), status, payment_status: payment, q, page });
  return (
    <>
      <PageHeader title="Consultations">{can('consultations.create') && <button className="btn primary" onClick={() => setCreating(true)}>+ Nouvelle consultation</button>}</PageHeader>
      <Card>
        <div className="toolbar">
          <input type="search" placeholder="Patient, n° consultation…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <PeriodFilter value={period} onChange={(p) => { setPeriod(p); setPage(1); }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut"><option value="">Tous statuts</option><option value="en_attente">En attente</option><option value="en_cours">En cours</option><option value="terminee">Terminée</option><option value="annulee">Annulée</option></select>
          <select value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Paiement"><option value="">Tous paiements</option><option value="non_payee">Non payée</option><option value="partielle">Partielle</option><option value="payee">Payée</option></select>
        </div>
        <Table rows={data?.items} onRowClick={(r) => nav(`/consultations/${r.id}`)} columns={[
          { key: 'number', label: 'N°', render: (r) => <b>{r.number}</b> },
          { key: 'consulted_at', label: 'Date', render: (r) => dateTime(r.consulted_at) },
          { key: 'patient_name', label: 'Patient' },
          { key: 'doctor_name', label: 'Médecin', render: (r) => r.doctor_name || '—' },
          { key: 'reason', label: 'Motif' },
          { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="consultation_status" /> },
          { key: 'payment_status', label: 'Paiement', render: (r) => <Badge value={r.payment_status} map="payment_status" /> },
          { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.amount} /> },
        ]} />
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
      {creating && <NewConsultationModal onClose={() => setCreating(false)} onSaved={(c) => nav(`/consultations/${c.id}`)} />}
    </>
  );
}

function PrescriptionModal({ consultation, onClose, onSaved }) {
  const [items, setItems] = useState([{ drug_name: '', dosage: '', frequency: '', duration: '', quantity: '' }]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const { data: products } = useFetch('/pharmacy/products');
  const upd = (i, k, v) => setItems(items.map((it, j) => j === i ? { ...it, [k]: v } : it));
  const submit = async (e) => {
    e.preventDefault();
    try {
      const clean = items.filter((i) => i.drug_name.trim()).map((i) => ({ ...i, quantity: i.quantity ? Number(i.quantity) : null, product_id: products?.find((p) => p.name === i.drug_name)?.id || null }));
      onSaved(await api.post(`/consultations/${consultation.id}/prescriptions`, { items: clean, notes }));
    } catch (err) { setError(err); }
  };
  return (
    <Modal title="Prescription" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <datalist id="drugs">{products?.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        {items.map((it, i) => (
          <div key={i} className="form-grid" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
            <Field label="Médicament" className="span-2"><input list="drugs" value={it.drug_name} onChange={(e) => upd(i, 'drug_name', e.target.value)} required={i === 0} /></Field>
            <Field label="Dosage"><input value={it.dosage} onChange={(e) => upd(i, 'dosage', e.target.value)} /></Field>
            <Field label="Posologie"><input value={it.frequency} onChange={(e) => upd(i, 'frequency', e.target.value)} placeholder="2 fois / jour" /></Field>
            <Field label="Durée"><input value={it.duration} onChange={(e) => upd(i, 'duration', e.target.value)} placeholder="5 jours" /></Field>
            <Field label="Quantité"><input type="number" min="0" value={it.quantity} onChange={(e) => upd(i, 'quantity', e.target.value)} /></Field>
            <Field label="Instructions" className="span-2"><input value={it.instructions || ''} onChange={(e) => upd(i, 'instructions', e.target.value)} placeholder="Pendant les repas…" /></Field>
          </div>
        ))}
        <button type="button" className="btn ghost" onClick={() => setItems([...items, { drug_name: '', dosage: '', frequency: '', duration: '', quantity: '' }])}>+ Ajouter une ligne</button>
        <Field label="Consignes"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export function ConsultationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: c, setData, error } = useFetch(`/consultations/${id}`);
  const [modal, setModal] = useState(null);
  const [acts, setActs] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (c) setForm({ ...c }); }, [c]);
  if (error) return <ErrorBox error={error} />;
  if (!c || !form) return <Empty>Chargement…</Empty>;
  const editable = c.status !== 'annulee';
  const save = async (fields, msg = 'Enregistré') => {
    setErr(null);
    try { setData(await api.put(`/consultations/${id}`, fields)); toast(msg); } catch (e) { setErr(e); }
  };
  const f = (k) => ({ value: form[k] ?? '', onChange: (e) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <>
      <PageHeader title={`Consultation ${c.number}`} subtitle={<><Link to={`/patients/${c.patient_id}`}>{c.patient_name}</Link> · {c.patient_number} · {age(c.patient_birth_date)} · {dateTime(c.consulted_at)} · {c.doctor_name || 'médecin non assigné'}</>}>
        <Badge value={c.status} map="consultation_status" /> <Badge value={c.payment_status} map="payment_status" />
        {editable && can('consultations.update') && c.status === 'en_attente' && <button className="btn primary" onClick={() => save({ status: 'en_cours' }, 'Consultation démarrée')}>▶ Démarrer</button>}
        {editable && can('consultations.update') && c.status !== 'terminee' && <button className="btn primary" onClick={() => save({ status: 'terminee' }, 'Consultation terminée')}>✔ Terminer</button>}
        {can('payments.create') && c.payment_status !== 'payee' && c.amount > 0 && editable && <Link className="btn" to={`/paiements/nouveau?source=consultation&id=${c.id}`}>💳 Encaisser</Link>}
        {editable && can('consultations.cancel') && c.paid_amount === 0 && <button className="btn ghost" onClick={() => setModal('cancel')}>Annuler</button>}
      </PageHeader>
      {c.status === 'annulee' && <div className="alert-box warn">Consultation annulée — motif : {c.cancel_reason}</div>}
      <ErrorBox error={err} />
      <div className="grid-2">
        <Card title="Constantes" actions={editable && can('consultations.vitals') && <button className="btn sm" onClick={() => save({ weight_kg: form.weight_kg || null, temperature_c: form.temperature_c || null, bp_systolic: form.bp_systolic || null, bp_diastolic: form.bp_diastolic || null, heart_rate: form.heart_rate || null, spo2: form.spo2 || null })}>Enregistrer</button>}>
          <div className="form-grid">
            <Field label="Poids (kg)"><input type="number" step="0.1" {...f('weight_kg')} disabled={!can('consultations.vitals')} /></Field>
            <Field label="Température (°C)"><input type="number" step="0.1" {...f('temperature_c')} disabled={!can('consultations.vitals')} /></Field>
            <Field label="TA (mmHg)"><div className="row" style={{ flexWrap: 'nowrap' }}><input type="number" {...f('bp_systolic')} disabled={!can('consultations.vitals')} aria-label="Systolique" />/<input type="number" {...f('bp_diastolic')} disabled={!can('consultations.vitals')} aria-label="Diastolique" /></div></Field>
            <Field label="Fréq. cardiaque"><input type="number" {...f('heart_rate')} disabled={!can('consultations.vitals')} /></Field>
            <Field label="SpO₂ (%)"><input type="number" {...f('spo2')} disabled={!can('consultations.vitals')} /></Field>
          </div>
        </Card>
        <Card title="Examen clinique" actions={editable && can('consultations.diagnose') && <button className="btn sm primary" onClick={() => save({ reason: form.reason, observations: form.observations, diagnosis: form.diagnosis, treatment: form.treatment })}>Enregistrer</button>}>
          {c.clinical_restricted ? <p className="muted">🔒 Informations cliniques réservées au personnel soignant.</p> : (
            <div className="form">
              <Field label="Motif"><input {...f('reason')} disabled={!can('consultations.diagnose')} /></Field>
              <Field label="Observations"><textarea rows={3} {...f('observations')} disabled={!can('consultations.diagnose')} /></Field>
              <Field label="Diagnostic"><textarea rows={2} {...f('diagnosis')} disabled={!can('consultations.diagnose')} /></Field>
              <Field label="Traitement"><textarea rows={2} {...f('treatment')} disabled={!can('consultations.diagnose')} /></Field>
            </div>
          )}
        </Card>
      </div>
      <div className="grid-2">
        <Card title="Actes & facturation" actions={<b>{gnf(c.amount)}</b>}>
          <Table rows={c.acts} empty="Aucun acte" columns={[
            { key: 'name', label: 'Acte' }, { key: 'quantity', label: 'Qté' },
            { key: 'total', label: 'Montant', align: 'right', render: (r) => gnf(r.quantity * r.unit_price) },
            { key: 'performed_by_name', label: 'Par' },
            ...(editable && can('acts.perform') && c.paid_amount === 0 ? [{ key: 'x', label: '', render: (r) => <button className="btn ghost sm" onClick={() => setModal({ removeAct: r })}>Retirer</button> }] : []),
          ]} />
          {editable && can('acts.perform') && (
            <div className="stack" style={{ marginTop: 12 }}>
              <ActsPicker value={acts} onChange={setActs} />
              {acts.length > 0 && <button className="btn primary" onClick={async () => { try { setData(await api.post(`/consultations/${id}/acts`, { acts })); setActs([]); toast('Actes ajoutés'); } catch (e) { setErr(e); } }}>Ajouter ces actes</button>}
            </div>
          )}
          {c.payments?.length > 0 && (
            <>
              <h3 className="small muted" style={{ margin: '14px 0 6px' }}>Paiements</h3>
              {c.payments.map((p) => <div key={p.id} className="row"><Link to={`/paiements/${p.id}`}>{p.receipt_number}</Link><span className="grow" /><Badge value={p.status} map="pay_status" /><Money value={p.amount} /></div>)}
            </>
          )}
        </Card>
        <div className="stack">
          {c.prescriptions && (
            <Card title="Prescriptions" actions={editable && can('prescriptions.create') && <button className="btn sm" onClick={() => setModal('rx')}>+ Prescrire</button>}>
              {!c.prescriptions.length ? <Empty>Aucune prescription</Empty> : c.prescriptions.map((pr) => (
                <div key={pr.id} style={{ marginBottom: 10 }}>
                  <div className="row">
                    <b className="small">{pr.number}</b><Badge value={pr.status} map="prescription_status" /><span className="grow" />
                    <a className="btn ghost sm" href={`/api/consultations/prescriptions/${pr.id}/pdf`} target="_blank" rel="noreferrer">🖨 Ordonnance PDF</a>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {pr.items.map((it) => <li key={it.id}><b>{it.drug_name}</b> {it.dosage} {it.frequency && `· ${it.frequency}`} {it.duration && `· ${it.duration}`} {it.quantity ? `· qté ${it.quantity}` : ''}{it.instructions ? ` · ${it.instructions}` : ''}</li>)}
                    {pr.notes && <li className="muted">{pr.notes}</li>}
                  </ul>
                </div>
              ))}
            </Card>
          )}
          {can('certificates.create', 'patients.view_medical') && <CertificatesCard patientId={c.patient_id} consultationId={c.id} editable={editable} />}
          {c.lab_requests && (
            <Card title="Examens demandés" actions={editable && can('lab.request') && <button className="btn sm" onClick={() => setModal('lab')}>+ Demander</button>}>
              {!c.lab_requests.length ? <Empty>Aucun examen</Empty> : c.lab_requests.map((l) => (
                <div key={l.id} className="row"><Link to={`/laboratoire/${l.id}`}>{l.number}</Link><span className="grow small">{l.exams}</span><Badge value={l.status} map="lab_status" /></div>
              ))}
            </Card>
          )}
        </div>
      </div>
      {modal === 'rx' && <PrescriptionModal consultation={c} onClose={() => setModal(null)} onSaved={(d) => { setData(d); setModal(null); toast('Prescription enregistrée'); }} />}
      {modal === 'lab' && <LabRequestModal patient={{ id: c.patient_id, first_name: c.patient_name, last_name: '' }} consultationId={c.id} onClose={() => setModal(null)} onSaved={async () => { setModal(null); setData(await api.get(`/consultations/${id}`)); toast('Examens demandés'); }} />}
      {modal === 'cancel' && <ReasonModal title="Annuler la consultation" danger confirmLabel="Annuler la consultation" onClose={() => setModal(null)} onConfirm={async (reason) => { await api.post(`/consultations/${id}/cancel`, { reason }); setData(await api.get(`/consultations/${id}`)); }} />}
      {modal?.removeAct && <ReasonModal title={`Retirer « ${modal.removeAct.name} »`} onClose={() => setModal(null)} onConfirm={async (reason) => setData(await api.del(`/consultations/${id}/acts/${modal.removeAct.id}`, { reason }))} />}
    </>
  );
}
