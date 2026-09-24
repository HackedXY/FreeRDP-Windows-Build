import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  PageHeader, Card, Table, Pagination, useFetch, Modal, Field, useForm, ErrorBox, Badge, Tabs, Empty, useToast, Money,
} from '../components/ui.jsx';
import { date, dateTime, age, gnf, LABELS } from '../format.js';
import { NewConsultationModal } from './Consultations.jsx';
import { AppointmentModal } from './Appointments.jsx';
import { LabRequestModal } from './Lab.jsx';

export function PatientForm({ patient, onClose, onSaved }) {
  const { can } = useAuth();
  const medical = can('patients.view_medical');
  const { values, bind } = useForm(patient || { sex: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    const body = { ...values, sex: values.sex || null };
    for (const k of ['id', 'patient_number', 'created_at', 'updated_at', 'created_by', 'archived_at', 'site_id', 'medical_restricted']) delete body[k];
    if (!medical) for (const k of ['medical_history', 'allergies', 'blood_group', 'notes']) delete body[k];
    try {
      const saved = patient ? await api.put(`/patients/${patient.id}`, body) : await api.post('/patients', body);
      onSaved(saved);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={patient ? `Modifier ${patient.patient_number}` : 'Nouveau patient'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nom" required><input {...bind('last_name')} required /></Field>
          <Field label="Prénom" required><input {...bind('first_name')} required /></Field>
          <Field label="Sexe"><select {...bind('sex')}><option value="">—</option><option value="F">Féminin</option><option value="M">Masculin</option></select></Field>
          <Field label="Date de naissance"><input type="date" {...bind('birth_date')} /></Field>
          <Field label="Téléphone"><input type="tel" {...bind('phone')} /></Field>
          <Field label="Adresse"><input {...bind('address')} /></Field>
          <Field label="Personne à contacter" className="span-2"><input {...bind('emergency_contact')} placeholder="Nom — lien — téléphone" /></Field>
          {medical && <>
            <Field label="Groupe sanguin"><select {...bind('blood_group')}><option value="">—</option>{['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => <option key={g}>{g}</option>)}</select></Field>
            <Field label="Allergies" className="span-2"><input {...bind('allergies')} /></Field>
            <Field label="Antécédents" className="span-all"><textarea rows={3} {...bind('medical_history')} /></Field>
            <Field label="Observations" className="span-all"><textarea rows={2} {...bind('notes')} /></Field>
          </>}
        </div>
        {medical && <p className="hint">🔒 Les données médicales sont chiffrées et visibles uniquement par le personnel soignant autorisé.</p>}
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary" disabled={busy}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export function PatientList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data } = useFetch('/patients', { q, page });
  return (
    <>
      <PageHeader title="Patients" subtitle="Dossiers numériques des patients">
        {can('patients.create') && <button className="btn primary" onClick={() => setCreating(true)}>+ Nouveau patient</button>}
      </PageHeader>
      <Card>
        <div className="toolbar"><input type="search" placeholder="Rechercher par nom, n° dossier, téléphone…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        <Table rows={data?.items} onRowClick={(r) => nav(`/patients/${r.id}`)} empty="Aucun patient trouvé." columns={[
          { key: 'patient_number', label: 'N° dossier', render: (r) => <b>{r.patient_number}</b> },
          { key: 'name', label: 'Nom', render: (r) => `${r.last_name} ${r.first_name}` },
          { key: 'sex', label: 'Sexe', render: (r) => r.sex || '—' },
          { key: 'age', label: 'Âge', render: (r) => age(r.birth_date) || '—' },
          { key: 'phone', label: 'Téléphone' },
          { key: 'last_visit', label: 'Dernière visite', render: (r) => date(r.last_visit) },
        ]} />
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
      {creating && <PatientForm onClose={() => setCreating(false)} onSaved={(p) => nav(`/patients/${p.id}`)} />}
    </>
  );
}

export function PatientDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const { data: p, reload, error } = useFetch(`/patients/${id}`);
  const { data: h, reload: reloadH } = useFetch(`/patients/${id}/history`);
  const [tab, setTab] = useState('infos');
  const [modal, setModal] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Empty>Chargement…</Empty>;
  const done = () => { setModal(null); reload(); reloadH(); };
  return (
    <>
      <PageHeader title={`${p.last_name} ${p.first_name}`} subtitle={`${p.patient_number} · ${p.sex === 'F' ? 'Femme' : p.sex === 'M' ? 'Homme' : ''} ${age(p.birth_date)} · ${p.phone || 'pas de téléphone'}`}>
        {can('consultations.create') && <button className="btn primary" onClick={() => setModal('consult')}>🩺 Consultation</button>}
        {can('appointments.manage') && <button className="btn" onClick={() => setModal('appt')}>📅 Rendez-vous</button>}
        {can('lab.request') && <button className="btn" onClick={() => setModal('lab')}>🧪 Examens</button>}
        {can('payments.create') && <Link className="btn" to={`/paiements/nouveau?patient=${p.id}`}>💳 Encaisser</Link>}
        {can('patients.update') && <button className="btn ghost" onClick={() => setModal('edit')}>✏️ Modifier</button>}
      </PageHeader>
      {p.allergies && <div className="alert-box danger">⚠️ Allergies : <b>{p.allergies}</b></div>}
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'infos', label: 'Dossier' },
        h?.consultations && { key: 'consultations', label: 'Consultations', count: h.consultations.length },
        h?.prescriptions && { key: 'prescriptions', label: 'Prescriptions', count: h.prescriptions.length },
        h?.lab_requests && { key: 'lab', label: 'Examens', count: h.lab_requests.length },
        h?.acts && { key: 'acts', label: 'Actes', count: h.acts.length },
        h?.payments && { key: 'payments', label: 'Paiements', count: h.payments.length },
        h?.appointments && { key: 'appointments', label: 'Rendez-vous', count: h.appointments.length },
      ]} />
      {tab === 'infos' && (
        <div className="grid-2">
          <Card title="Identité">
            <dl className="kv">
              <dt>N° dossier</dt><dd>{p.patient_number}</dd>
              <dt>Naissance</dt><dd>{date(p.birth_date)} {p.birth_date && `(${age(p.birth_date)})`}</dd>
              <dt>Téléphone</dt><dd>{p.phone || '—'}</dd>
              <dt>Adresse</dt><dd>{p.address || '—'}</dd>
              <dt>Personne à contacter</dt><dd>{p.emergency_contact || '—'}</dd>
              <dt>Créé le</dt><dd>{dateTime(p.created_at)}</dd>
            </dl>
          </Card>
          <Card title="Informations médicales">
            {p.medical_restricted ? <p className="muted">🔒 Accès restreint : votre fonction ne nécessite pas l'accès au dossier médical.</p> : (
              <dl className="kv">
                <dt>Groupe sanguin</dt><dd>{p.blood_group || '—'}</dd>
                <dt>Allergies</dt><dd>{p.allergies || '—'}</dd>
                <dt>Antécédents</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.medical_history || '—'}</dd>
                <dt>Observations</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.notes || '—'}</dd>
              </dl>
            )}
          </Card>
        </div>
      )}
      {tab === 'consultations' && <Card><Table rows={h.consultations} onRowClick={(r) => nav(`/consultations/${r.id}`)} columns={[
        { key: 'number', label: 'N°' }, { key: 'consulted_at', label: 'Date', render: (r) => dateTime(r.consulted_at) },
        { key: 'doctor', label: 'Médecin' }, { key: 'reason', label: 'Motif' },
        { key: 'diagnosis', label: 'Diagnostic', render: (r) => r.diagnosis ?? '—' },
        { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="consultation_status" /> },
        { key: 'amount', label: 'Montant', align: 'right', render: (r) => <><Money value={r.amount} /> <Badge value={r.payment_status} map="payment_status" /></> },
      ]} /></Card>}
      {tab === 'prescriptions' && <Card>{!h.prescriptions.length ? <Empty /> : h.prescriptions.map((pr) => (
        <div key={pr.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
          <b>{dateTime(pr.created_at)}</b> <span className="muted">— {pr.prescriber}</span>
          <ul>{pr.items.map((it) => <li key={it.id}><b>{it.drug_name}</b> {it.dosage} {it.frequency && `· ${it.frequency}`} {it.duration && `· ${it.duration}`} {it.instructions && <span className="muted">({it.instructions})</span>}</li>)}</ul>
        </div>
      ))}</Card>}
      {tab === 'lab' && <Card><Table rows={h.lab_requests} onRowClick={(r) => nav(`/laboratoire/${r.id}`)} columns={[
        { key: 'number', label: 'N°' }, { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
        { key: 'items', label: 'Examens / résultats', render: (r) => r.items.map((i) => <div key={i.name}>{i.name} : <b className={i.abnormal ? 'money neg' : ''}>{i.result_value || i.result_text || '…'}</b> {i.unit}</div>) },
        { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="lab_status" /> },
      ]} /></Card>}
      {tab === 'acts' && <Card><Table rows={h.acts} columns={[
        { key: 'performed_at', label: 'Date', render: (r) => dateTime(r.performed_at) }, { key: 'name', label: 'Acte' },
        { key: 'quantity', label: 'Qté' }, { key: 'consultation_number', label: 'Consultation' },
        { key: 'total', label: 'Montant', align: 'right', render: (r) => gnf(r.unit_price * r.quantity) },
      ]} /></Card>}
      {tab === 'payments' && <Card><Table rows={h.payments} onRowClick={(r) => nav(`/paiements/${r.id}`)} columns={[
        { key: 'receipt_number', label: 'Reçu' }, { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
        { key: 'description', label: 'Prestation' }, { key: 'method', label: 'Mode', render: (r) => LABELS.method[r.method] },
        { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="pay_status" /> },
        { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.amount} /> },
      ]} /></Card>}
      {tab === 'appointments' && <Card><Table rows={h.appointments} columns={[
        { key: 'scheduled_at', label: 'Date', render: (r) => dateTime(r.scheduled_at) }, { key: 'doctor', label: 'Médecin' },
        { key: 'reason', label: 'Motif' }, { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="appt_status" /> },
      ]} /></Card>}

      {modal === 'edit' && <PatientForm patient={p} onClose={() => setModal(null)} onSaved={() => { toast('Dossier mis à jour'); done(); }} />}
      {modal === 'consult' && <NewConsultationModal patient={p} onClose={() => setModal(null)} onSaved={(c) => nav(`/consultations/${c.id}`)} />}
      {modal === 'appt' && <AppointmentModal patient={p} onClose={() => setModal(null)} onSaved={() => { toast('Rendez-vous enregistré'); done(); }} />}
      {modal === 'lab' && <LabRequestModal patient={p} onClose={() => setModal(null)} onSaved={() => { toast('Examens demandés'); done(); }} />}
    </>
  );
}
