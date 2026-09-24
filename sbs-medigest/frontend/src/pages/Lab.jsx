import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useRealtime } from '../realtime.js';
import { PageHeader, Card, Table, Pagination, useFetch, Modal, Field, ErrorBox, Badge, Empty, PatientPicker, ReasonModal, useToast, PeriodFilter, periodParams } from '../components/ui.jsx';
import { dateTime, gnf, age, LABELS } from '../format.js';

export function LabRequestModal({ patient: initial, consultationId, onClose, onSaved }) {
  const { data: exams } = useFetch('/lab/exams');
  const [patient, setPatient] = useState(initial?.id ? initial : null);
  const [sel, setSel] = useState([]);
  const [priority, setPriority] = useState('normale');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const total = (exams || []).filter((e) => sel.includes(e.id)).reduce((s, e) => s + e.price, 0);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    try { onSaved(await api.post('/lab/requests', { patient_id: patient.id, consultation_id: consultationId || null, exam_type_ids: sel, priority, notes })); } catch (err) { setError(err); }
  };
  const groups = (exams || []).reduce((g, e) => { (g[e.category || 'Autres'] ||= []).push(e); return g; }, {});
  return (
    <Modal title="Demande d'examens" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <Field as="div" label="Patient" required>{initial?.id ? <b>{initial.first_name} {initial.last_name}</b> : <PatientPicker value={patient} onChange={setPatient} autoFocus />}</Field>
        <div className="perm-grid">
          {Object.entries(groups).map(([cat, list]) => (
            <div key={cat} className="perm-group"><h3>{cat}</h3>
              {list.map((e) => <label key={e.id}><input type="checkbox" checked={sel.includes(e.id)} onChange={(ev) => setSel(ev.target.checked ? [...sel, e.id] : sel.filter((x) => x !== e.id))} />{e.name} <span className="muted small">{gnf(e.price)}</span></label>)}
            </div>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Priorité"><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="normale">Normale</option><option value="urgente">Urgente</option></select></Field>
          <Field label="Renseignements cliniques" className="span-2"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions"><span className="grow"><b>Total : {gnf(total)}</b></span><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary" disabled={!sel.length || !patient}>Envoyer au laboratoire</button></div>
      </form>
    </Modal>
  );
}

export function LabList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState({ period: '' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const { data, reload } = useFetch('/lab/requests', { status, q, page, ...periodParams(period) });
  useRealtime((e, p) => { if (e === 'notification' && p.type === 'lab') reload(); });
  return (
    <>
      <PageHeader title="Laboratoire" subtitle="Médecin → Demande → Laboratoire → Résultat → Patient">
        {can('lab.request') && <button className="btn primary" onClick={() => setModal(true)}>+ Demande d'examens</button>}
      </PageHeader>
      <Card>
        <div className="toolbar">
          <input type="search" placeholder="Patient, n° demande…" value={q} onChange={(e) => setQ(e.target.value)} />
          <PeriodFilter value={period} onChange={setPeriod} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut"><option value="">Tous statuts</option><option value="demandee">Demandée</option><option value="en_cours">En cours</option><option value="terminee">Terminée</option><option value="annulee">Annulée</option></select>
        </div>
        <Table rows={data?.items} onRowClick={(r) => nav(`/laboratoire/${r.id}`)} columns={[
          { key: 'number', label: 'N°', render: (r) => <b>{r.number}</b> },
          { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
          { key: 'patient_name', label: 'Patient' },
          { key: 'exams', label: 'Examens' },
          { key: 'priority', label: 'Priorité', render: (r) => r.priority === 'urgente' ? <Badge tone="danger">Urgente</Badge> : 'Normale' },
          { key: 'requested_by_name', label: 'Prescripteur' },
          { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="lab_status" /> },
          { key: 'payment_status', label: 'Paiement', render: (r) => <Badge value={r.payment_status} map="payment_status" /> },
        ]} />
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
      {modal && <LabRequestModal onClose={() => setModal(false)} onSaved={(r) => nav(`/laboratoire/${r.id}`)} />}
    </>
  );
}

export function LabDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: r, setData, error } = useFetch(`/lab/requests/${id}`);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [cancel, setCancel] = useState(false);
  // anomalie : « auto » = calculée d'après les valeurs de référence ; oui / non = forcée par le laboratoire
  useEffect(() => { if (r) setItems(r.items.map((i) => ({ ...i, abnormal_mode: i.abnormal_manual ? (i.abnormal ? 'oui' : 'non') : 'auto' }))); }, [r]);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <Empty>Chargement…</Empty>;
  const editable = can('lab.results') && r.status !== 'annulee' && (!r.validated_at || can('lab.validate'));
  const upd = (i, k, v) => setItems(items.map((it, j) => j === i ? { ...it, [k]: v } : it));
  const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')));
  const save = async (complete) => {
    setErr(null);
    try {
      setData(await api.put(`/lab/requests/${id}/results`, {
        complete,
        items: items.map((i) => ({
          id: i.id, result_value: i.result_value || null, result_text: i.result_text || null, unit: i.unit || null,
          reference_range: i.reference_range || null, ref_min: numOrNull(i.ref_min), ref_max: numOrNull(i.ref_max),
          abnormal: i.abnormal_mode === 'auto' ? null : i.abnormal_mode === 'oui',
        })),
      }));
      toast(complete ? 'Résultats enregistrés — prescripteur notifié' : 'Résultats enregistrés');
    } catch (e) { setErr(e); }
  };
  const validate = async () => {
    setErr(null);
    try { setData(await api.post(`/lab/requests/${id}/validate`)); toast('Résultats validés'); } catch (e) { setErr(e); }
  };
  const refText = (it) => (it.ref_min != null || it.ref_max != null ? `${it.ref_min ?? '…'} – ${it.ref_max ?? '…'}` : it.reference_range || '—');
  return (
    <>
      <PageHeader title={`Examens ${r.number}`} subtitle={<><Link to={`/patients/${r.patient_id}`}>{r.patient_name}</Link> · {r.patient_number} · {r.patient_sex || ''} {age(r.patient_birth_date)} · demandé par {r.requested_by_name} le {dateTime(r.created_at)}</>}>
        <Badge value={r.status} map="lab_status" /> <Badge value={r.payment_status} map="payment_status" />
        {r.priority === 'urgente' && <Badge tone="danger">URGENT</Badge>}
        {can('payments.create') && r.payment_status !== 'payee' && r.status !== 'annulee' && <Link className="btn" to={`/paiements/nouveau?source=lab_request&id=${r.id}`}>💳 Encaisser {gnf(r.amount - r.paid_amount)}</Link>}
        {r.validated_at ? <Badge tone="ok">Validé</Badge> : r.status === 'terminee' && <Badge tone="warn">Non validé</Badge>}
        {r.status === 'terminee' && !r.results_restricted && <a className="btn ghost" href={`/api/lab/requests/${r.id}/report.pdf`} target="_blank" rel="noreferrer">🖨️ Compte rendu PDF</a>}
        {r.status === 'terminee' && !r.validated_at && can('lab.validate') && <button className="btn primary" onClick={validate}>✔ Valider les résultats</button>}
        {r.status !== 'terminee' && r.status !== 'annulee' && r.paid_amount === 0 && (can('lab.request') || can('lab.results')) && <button className="btn ghost" onClick={() => setCancel(true)}>Annuler</button>}
      </PageHeader>
      {r.notes && <div className="alert-box info">Renseignements cliniques : {r.notes}</div>}
      {r.validated_at && <div className="alert-box ok">Résultats validés par {r.validated_by_name} le {dateTime(r.validated_at)}.{editable ? ' Toute correction lèvera la validation (nouvelle validation nécessaire).' : ''}</div>}
      <Card title="Résultats">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Examen</th><th>Résultat</th><th>Unité</th><th>Valeurs de référence</th><th>Anormal</th><th>Commentaire</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.id}>
                  <td data-label="Examen"><b>{it.name}</b><div className="muted small">{it.technician_name && `${it.technician_name} · ${dateTime(it.result_at)}`}</div></td>
                  <td data-label="Résultat">{editable ? <input value={it.result_value || ''} onChange={(e) => upd(i, 'result_value', e.target.value)} /> : <b className={it.abnormal ? 'money neg' : ''}>{it.result_value || '—'}</b>}
                    {it.flag && <div className="small money neg">{LABELS.lab_flag[it.flag]}</div>}</td>
                  <td data-label="Unité">{editable ? <input value={it.unit || ''} onChange={(e) => upd(i, 'unit', e.target.value)} style={{ width: 80 }} /> : it.unit}</td>
                  <td data-label="Référence">{editable ? (
                    <div className="stack" style={{ gap: 4 }}>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <input inputMode="decimal" placeholder="min" aria-label="Minimum" value={it.ref_min ?? ''} onChange={(e) => upd(i, 'ref_min', e.target.value)} style={{ width: 70 }} />–
                        <input inputMode="decimal" placeholder="max" aria-label="Maximum" value={it.ref_max ?? ''} onChange={(e) => upd(i, 'ref_max', e.target.value)} style={{ width: 70 }} />
                      </div>
                      <input placeholder="texte (ex. Négatif)" aria-label="Référence textuelle" value={it.reference_range || ''} onChange={(e) => upd(i, 'reference_range', e.target.value)} />
                    </div>
                  ) : refText(it)}</td>
                  <td data-label="Anormal">{editable ? (
                    <select value={it.abnormal_mode} onChange={(e) => upd(i, 'abnormal_mode', e.target.value)} aria-label="Anomalie">
                      <option value="auto">Auto{it.abnormal != null ? ` (${it.abnormal ? 'oui' : 'non'})` : ''}</option><option value="oui">Oui</option><option value="non">Non</option>
                    </select>
                  ) : it.abnormal ? '⚠️ Oui' : it.abnormal === false ? 'Non' : '—'}</td>
                  <td data-label="Commentaire">{editable ? <input value={it.result_text || ''} onChange={(e) => upd(i, 'result_text', e.target.value)} /> : it.result_text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorBox error={err} />
        {editable && <div className="form-actions" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => save(false)}>Enregistrer (en cours)</button>
          <button className="btn primary" onClick={() => save(true)}>✔ Terminer la saisie</button>
        </div>}
      </Card>
      {cancel && <ReasonModal title="Annuler la demande" danger onClose={() => setCancel(false)} onConfirm={async (reason) => { await api.post(`/lab/requests/${id}/cancel`, { reason }); setData(await api.get(`/lab/requests/${id}`)); }} />}
    </>
  );
}
