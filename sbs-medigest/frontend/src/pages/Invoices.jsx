import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  PageHeader, Card, Table, Pagination, useFetch, Modal, Field, ErrorBox, Badge, Empty, useToast, Money, PatientPicker,
  ReasonModal, RegisterSelect,
} from '../components/ui.jsx';
import { dateTime, gnf, LABELS } from '../format.js';

const METHODS = Object.entries(LABELS.method);

function InvoiceNew({ onClose, onSaved }) {
  const [patient, setPatient] = useState(null);
  const [selected, setSelected] = useState({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: billable } = useFetch(patient ? '/invoices/billable' : null, patient ? { patient_id: patient.id } : {});
  const chosen = (billable || []).filter((b) => selected[`${b.source_type}:${b.source_id}`]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      onSaved(await api.post('/invoices', { patient_id: patient.id, notes: notes || null, items: chosen.map((b) => ({ source_type: b.source_type, source_id: b.source_id })) }));
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nouvelle facture" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <Field as="div" label="Patient" required><PatientPicker value={patient} onChange={(p) => { setPatient(p); setSelected({}); }} autoFocus /></Field>
        {patient && (!billable ? <Empty>Chargement…</Empty> : !billable.length ? <Empty>Aucun élément facturable pour ce patient (ou déjà facturé).</Empty> : (
          <Table rows={billable} columns={[
            { key: 'sel', label: '', render: (b) => <input type="checkbox" aria-label={b.label} checked={!!selected[`${b.source_type}:${b.source_id}`]} onChange={(e) => setSelected({ ...selected, [`${b.source_type}:${b.source_id}`]: e.target.checked })} /> },
            { key: 'label', label: 'Élément' },
            { key: 'date', label: 'Date', render: (b) => dateTime(b.date) },
            { key: 'amount', label: 'Montant', align: 'right', render: (b) => gnf(b.amount) },
            { key: 'remaining', label: 'Reste à payer', align: 'right', render: (b) => <Money value={b.remaining} /> },
          ]} />
        ))}
        <Field label="Notes"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <p className="hint">Total : <b>{gnf(chosen.reduce((s, b) => s + b.amount, 0))}</b> — les paiements déjà effectués sur ces éléments sont repris.</p>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary" disabled={!chosen.length || busy}>Créer la facture</button></div>
      </form>
    </Modal>
  );
}

export function InvoiceList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const { data } = useFetch('/invoices', { q, status, page });
  return (
    <>
      <PageHeader title="Factures">
        <Link className="btn ghost" to="/verification">🔎 Vérifier un document</Link>
        {can('payments.create') && <button className="btn primary" onClick={() => setModal(true)}>+ Nouvelle facture</button>}
      </PageHeader>
      <Card>
        <div className="toolbar">
          <input type="search" placeholder="N° de facture, patient…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut"><option value="">Tous statuts</option>{Object.entries(LABELS.invoice_status).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <Table rows={data?.items} onRowClick={(r) => nav(`/factures/${r.id}`)} empty="Aucune facture" columns={[
          { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
          { key: 'number', label: 'N°' },
          { key: 'patient_name', label: 'Patient', render: (r) => <>{r.patient_name}<div className="muted small">{r.patient_number}</div></> },
          { key: 'total', label: 'Total', align: 'right', render: (r) => gnf(r.total) },
          { key: 'paid', label: 'Payé', align: 'right', render: (r) => gnf(r.paid) },
          { key: 'remaining', label: 'Solde', align: 'right', render: (r) => <Money value={r.remaining} /> },
          { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="invoice_status" /> },
        ]} />
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
      {modal && <InvoiceNew onClose={() => setModal(false)} onSaved={(inv) => { setModal(false); toast(`Facture ${inv.number} créée`); nav(`/factures/${inv.id}`); }} />}
    </>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: inv, setData, error } = useFetch(`/invoices/${id}`);
  const [pay, setPay] = useState({ amount: '', method: 'especes', reference: '', register_id: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancel, setCancel] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!inv) return <Empty>Chargement…</Empty>;
  const submitPay = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api.post(`/invoices/${id}/pay`, {
        amount: pay.amount ? Number(pay.amount) : undefined, method: pay.method, reference: pay.reference || null,
        register_id: pay.register_id ? Number(pay.register_id) : null,
      });
      setData(r.invoice); setPay({ ...pay, amount: '', reference: '' });
      toast(`Règlement enregistré : ${r.payments.map((p) => p.receipt_number).join(', ')}`);
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={`Facture ${inv.number}`} subtitle={<><Link to={`/patients/${inv.patient_id}`}>{inv.patient_name}</Link> · {inv.patient_number} · émise le {dateTime(inv.created_at)} par {inv.created_by_name}</>}>
        <Badge value={inv.status} map="invoice_status" />
        <a className="btn ghost" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">🖨 Facture PDF</a>
        {inv.status !== 'annulee' && can('payments.cancel') && <button className="btn ghost" onClick={() => setCancel(true)}>Annuler la facture</button>}
      </PageHeader>
      {inv.status === 'annulee' && <div className="alert-box warn">Facture annulée le {dateTime(inv.cancelled_at)} par {inv.cancelled_by_name} — motif : {inv.cancel_reason}. Les paiements et reçus restent valables.</div>}
      <div className="grid-2">
        <Card title="Lignes">
          <Table rows={inv.lines} columns={[
            { key: 'description', label: 'Désignation' },
            { key: 'amount', label: 'Montant', align: 'right', render: (l) => gnf(l.amount) },
            { key: 'discount', label: 'Remise', align: 'right', render: (l) => (l.discount ? gnf(l.discount) : '—') },
            { key: 'paid', label: 'Payé', align: 'right', render: (l) => gnf(l.paid) },
            { key: 'remaining', label: 'Reste', align: 'right', render: (l) => <Money value={l.remaining} /> },
          ]} />
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Total</dt><dd><b>{gnf(inv.total)}</b></dd>
            <dt>Remises</dt><dd>{gnf(inv.discount)}</dd>
            <dt>Montant payé</dt><dd>{gnf(inv.paid)}</dd>
            <dt>Solde restant</dt><dd><b><Money value={inv.remaining} /></b></dd>
          </dl>
          {inv.notes && <p className="muted small">{inv.notes}</p>}
        </Card>
        <div className="stack">
          {inv.status !== 'annulee' && inv.remaining > 0 && can('payments.create') && (
            <Card title="Enregistrer un règlement">
              <form className="form" onSubmit={submitPay}>
                <div className="form-grid">
                  <Field label="Montant (GNF)" hint={`Vide = solde complet (${gnf(inv.remaining)})`}><input type="number" min="1" max={inv.remaining} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
                  <Field label="Mode"><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                  {pay.method !== 'especes' && <Field label="Référence" required={pay.method !== 'autre'}><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} required={pay.method !== 'autre'} /></Field>}
                  <RegisterSelect value={pay.register_id} onChange={(v) => setPay((x) => ({ ...x, register_id: v }))} required={pay.method === 'especes'} />
                </div>
                <p className="hint">Le règlement est réparti sur les lignes non soldées ; chaque part produit un paiement et son reçu.</p>
                <ErrorBox error={err} />
                <div className="form-actions"><button className="btn primary" disabled={busy}>Encaisser</button></div>
              </form>
            </Card>
          )}
          <Card title="Historique des paiements">
            {!inv.payments.length ? <Empty>Aucun paiement</Empty> : inv.payments.map((p) => (
              <div key={p.id} className="row">
                <Link to={`/paiements/${p.id}`}>{p.receipt_number}</Link>
                <span className="grow small muted">{dateTime(p.created_at)} · {p.method_label} · {p.received_by_name}{p.discount ? ` · remise ${gnf(p.discount)}` : ''}</span>
                <Badge value={p.status} map="pay_status" /><Money value={p.amount} />
              </div>
            ))}
          </Card>
        </div>
      </div>
      {cancel && <ReasonModal title={`Annuler la facture ${inv.number}`} danger onClose={() => setCancel(false)} onConfirm={async (reason) => setData(await api.post(`/invoices/${id}/cancel`, { reason }))}><p className="muted">Les éléments redeviennent facturables. Les paiements et reçus existants ne sont pas modifiés (utilisez l'annulation ou le remboursement des paiements si nécessaire).</p></ReasonModal>}
    </>
  );
}

/** Vérification d'authenticité d'un document émis (numéro + code imprimé en pied de page). */
export function DocumentVerify() {
  const [f, setF] = useState({ type: 'ordonnance', number: '', code: '' });
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null); setRes(null);
    try { setRes(await api.get('/documents/verify', { type: f.type, number: f.number.trim(), code: f.code.trim() })); } catch (err) { setError(err); }
  };
  return (
    <>
      <PageHeader title="Vérifier un document" subtitle="Ordonnance, certificat, compte rendu d'examens ou facture présenté au cabinet" />
      <Card>
        <form className="form" onSubmit={submit} style={{ maxWidth: 480 }}>
          <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="ordonnance">Ordonnance</option><option value="certificat">Certificat médical</option>
            <option value="compte_rendu">Compte rendu d'examens</option><option value="facture">Facture</option>
          </select></Field>
          <Field label="Numéro du document" required><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} placeholder="ORD-2026-000012" required /></Field>
          <Field label="Code de vérification (pied de page)" required><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="XXXX-XXXX-XXXX" required /></Field>
          <ErrorBox error={error} />
          <div className="form-actions"><button className="btn primary">Vérifier</button></div>
        </form>
        {res && (res.valid
          ? <div className={`alert-box ${res.cancelled ? 'warn' : 'ok'}`}>✔ Document authentique : {res.type_label} {res.number}, émis le {dateTime(res.issued_at)} (dossier {res.patient_number}){res.cancelled ? ' — ATTENTION : document annulé.' : '.'}</div>
          : <div className="alert-box danger">✖ Document non reconnu : numéro ou code incorrect.</div>)}
      </Card>
    </>
  );
}
