import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, useFetch, Modal, Field, useForm, ErrorBox, Badge, Empty, PatientPicker, ReasonModal, useToast } from '../components/ui.jsx';
import { time, localInput, todayISO } from '../format.js';
import { useDoctors } from './Consultations.jsx';

export function AppointmentModal({ patient: initial, appointment, onClose, onSaved }) {
  const doctors = useDoctors();
  const [patient, setPatient] = useState(initial || (appointment ? { id: appointment.patient_id, first_name: appointment.patient_name, last_name: '', patient_number: appointment.patient_number } : null));
  const { values, bind } = useForm(appointment
    ? { ...appointment, scheduled_at: localInput(new Date(appointment.scheduled_at)), doctor_id: appointment.doctor_id || '' }
    : { scheduled_at: localInput(new Date(Date.now() + 86400000)), duration_minutes: 20, doctor_id: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    if (!patient) return setError(new Error('Choisissez un patient.'));
    const body = { doctor_id: values.doctor_id || null, scheduled_at: new Date(values.scheduled_at).toISOString(), duration_minutes: Number(values.duration_minutes), reason: values.reason, notes: values.notes };
    try {
      onSaved(appointment ? await api.put(`/appointments/${appointment.id}`, { ...body, status: values.status }) : await api.post('/appointments', { ...body, patient_id: patient.id }));
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={appointment ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field as="div" label="Patient" required>{appointment ? <b>{appointment.patient_name}</b> : <PatientPicker value={patient} onChange={setPatient} autoFocus={!initial} />}</Field>
        <div className="form-grid">
          <Field label="Date et heure" required><input type="datetime-local" {...bind('scheduled_at')} required /></Field>
          <Field label="Durée (min)"><input type="number" min="5" step="5" {...bind('duration_minutes')} /></Field>
          <Field label="Médecin"><select {...bind('doctor_id')}><option value="">—</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          {appointment && <Field label="Statut"><select {...bind('status')}><option value="planifie">Planifié</option><option value="confirme">Confirmé</option><option value="honore">Honoré</option><option value="absent">Absent</option></select></Field>}
        </div>
        <Field label="Motif"><input {...bind('reason')} /></Field>
        <Field label="Notes"><textarea rows={2} {...bind('notes')} /></Field>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Fermer</button><button className="btn primary">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

export default function Appointments() {
  const { can } = useAuth();
  const toast = useToast();
  const [start, setStart] = useState(todayISO());
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const end = addDays(start, 6);
  const { data, reload } = useFetch('/appointments', { from: start, to: end, q });
  const { data: reminders, reload: reloadR } = useFetch('/appointments/reminders');
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const byDay = (d) => (data || []).filter((a) => new Date(a.scheduled_at).toDateString() === new Date(`${d}T00:00:00`).toDateString());
  const refresh = () => { setModal(null); reload(); reloadR(); };
  return (
    <>
      <PageHeader title="Rendez-vous" subtitle="Calendrier sur 7 jours">
        {can('appointments.manage') && <button className="btn primary" onClick={() => setModal('new')}>+ Nouveau rendez-vous</button>}
      </PageHeader>
      {reminders?.length > 0 && (
        <Card title={`🔔 Rappels à effectuer (${reminders.length})`}>
          {reminders.map((a) => (
            <div key={a.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="grow"><b>{a.patient_name}</b> — {new Date(a.scheduled_at).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} {a.doctor_name && `avec ${a.doctor_name}`}</span>
              {a.patient_phone && <a className="btn sm" href={`tel:${a.patient_phone}`}>📞 {a.patient_phone}</a>}
              {a.patient_phone && <a className="btn sm" href={`sms:${a.patient_phone}?body=${encodeURIComponent(`Cabinet Médical SBS : rappel de votre rendez-vous le ${new Date(a.scheduled_at).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`)}`}>✉️ SMS</a>}
              {can('appointments.manage') && <button className="btn sm ghost" onClick={async () => { await api.post(`/appointments/${a.id}/reminded`); toast('Rappel noté'); reloadR(); }}>Rappel fait</button>}
            </div>
          ))}
        </Card>
      )}
      <Card>
        <div className="toolbar">
          <button className="btn ghost" onClick={() => setStart(addDays(start, -7))}>‹</button>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Début" />
          <button className="btn ghost" onClick={() => setStart(addDays(start, 7))}>›</button>
          <button className="btn ghost" onClick={() => setStart(todayISO())}>Aujourd'hui</button>
          <input type="search" placeholder="Rechercher patient, motif…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="stack" style={{ gap: 10 }}>
          {days.map((d) => {
            const items = byDay(d);
            return (
              <div key={d}>
                <h3 className="small" style={{ margin: '6px 0', textTransform: 'capitalize' }}>{new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} <span className="muted">({items.length})</span></h3>
                {!items.length ? <div className="muted small" style={{ paddingLeft: 8 }}>—</div> : items.map((a) => (
                  <div key={a.id} className="row" style={{ padding: '6px 8px', borderLeft: '3px solid var(--primary)', background: 'var(--surface-2)', borderRadius: 6, marginBottom: 4 }}>
                    <b style={{ width: 50 }}>{time(a.scheduled_at)}</b>
                    <span className="grow"><Link to={`/patients/${a.patient_id}`}>{a.patient_name}</Link> <span className="muted small">{a.reason}{a.doctor_name && ` · ${a.doctor_name}`}</span></span>
                    <Badge value={a.status} map="appt_status" />
                    {can('appointments.manage') && a.status !== 'annule' && <>
                      <button className="btn sm ghost" onClick={() => setModal({ edit: a })}>Modifier</button>
                      <button className="btn sm ghost" onClick={() => setModal({ cancel: a })}>Annuler</button>
                    </>}
                  </div>
                ))}
              </div>
            );
          })}
          {!data && <Empty>Chargement…</Empty>}
        </div>
      </Card>
      {modal === 'new' && <AppointmentModal onClose={() => setModal(null)} onSaved={() => { toast('Rendez-vous enregistré'); refresh(); }} />}
      {modal?.edit && <AppointmentModal appointment={modal.edit} onClose={() => setModal(null)} onSaved={() => { toast('Rendez-vous modifié'); refresh(); }} />}
      {modal?.cancel && <ReasonModal title="Annuler le rendez-vous" danger onClose={() => setModal(null)} onConfirm={async (reason) => { await api.post(`/appointments/${modal.cancel.id}/cancel`, { reason }); refresh(); }} />}
    </>
  );
}
