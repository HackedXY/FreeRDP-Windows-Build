import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useRealtime } from '../realtime.js';
import {
  PageHeader, Card, Table, Pagination, useFetch, Modal, Field, ErrorBox, Badge, Empty, PatientPicker, ReasonModal, useToast, RegisterSelect,
  PeriodFilter, periodParams, Money,
} from '../components/ui.jsx';
import { dateTime, date, time, gnf, LABELS, toCSV, download } from '../format.js';

const METHODS = Object.entries(LABELS.method);

export function PaymentList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [period, setPeriod] = useState({ period: 'today' });
  const [f, setF] = useState({ method: '', status: '', q: '' });
  const [page, setPage] = useState(1);
  const params = { ...periodParams(period), ...f, page };
  const { data, reload } = useFetch('/payments', params);
  useRealtime((e, p) => { if (e === 'stats' && p?.kind === 'payment') reload(); });
  const exportCsv = async () => {
    const all = await api.get('/payments', { ...params, page: 1, limit: 200 });
    download(`paiements-${Date.now()}.csv`, toCSV(all.items, [
      { label: 'Date', value: (r) => dateTime(r.created_at) }, { label: 'Transaction', value: 'number' }, { label: 'Reçu', value: 'receipt_number' },
      { label: 'Patient', value: 'patient_name' }, { label: 'Prestation', value: 'description' }, { label: 'Mode', value: (r) => LABELS.method[r.method] },
      { label: 'Référence', value: 'reference' }, { label: 'Remise', value: 'discount' }, { label: 'Montant', value: 'amount' },
      { label: 'Statut', value: (r) => LABELS.pay_status[r.status] }, { label: 'Caissier', value: 'received_by_name' },
    ]));
  };
  return (
    <>
      <PageHeader title="Paiements" subtitle="Toutes les transactions sont numérotées et tracées">
        <button className="btn ghost" onClick={exportCsv}>⬇ Export CSV</button>
        {can('payments.create') && <Link className="btn primary" to="/paiements/nouveau">+ Encaisser</Link>}
      </PageHeader>
      <Card>
        <div className="toolbar">
          <input type="search" placeholder="N° transaction, reçu, patient, référence…" value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1); }} />
          <PeriodFilter value={period} onChange={(p) => { setPeriod(p); setPage(1); }} />
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} aria-label="Mode"><option value="">Tous modes</option>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Statut"><option value="">Tous statuts</option><option value="valide">Valide</option><option value="annule">Annulé</option><option value="rembourse">Remboursé</option></select>
        </div>
        {data && <p className="muted small" style={{ marginTop: 0 }}>Total encaissé (valides) : <b className="money">{gnf(data.total_valid)}</b></p>}
        <Table rows={data?.items} onRowClick={(r) => nav(`/paiements/${r.id}`)} columns={[
          { key: 'created_at', label: 'Date', render: (r) => <span className="nowrap">{date(r.created_at)} {time(r.created_at)}</span> },
          { key: 'receipt_number', label: 'Reçu', render: (r) => <b>{r.receipt_number}</b> },
          { key: 'patient_name', label: 'Patient', render: (r) => r.patient_name || '—' },
          { key: 'description', label: 'Prestation' },
          { key: 'method', label: 'Mode', render: (r) => LABELS.method[r.method] },
          { key: 'received_by_name', label: 'Caissier' },
          { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="pay_status" /> },
          { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.amount} /> },
        ]} />
        <Pagination page={page} total={data?.total} onChange={setPage} />
      </Card>
    </>
  );
}

export function PaymentNew() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [patient, setPatient] = useState(null);
  const [mode, setMode] = useState('pending');
  const [item, setItem] = useState(null);
  const [f, setF] = useState({ method: 'especes', reference: '', discount: 0, amount: '', act_id: '', quantity: 1, description: '', payer_name: '', register_id: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`), []);
  const { data: acts } = useFetch('/acts');
  const { data: cash } = useFetch('/cash/current');
  const { data: pending, reload } = useFetch('/payments/pending', patient ? { patient_id: patient.id } : {});

  useEffect(() => {
    const pid = sp.get('patient');
    if (pid) api.get(`/patients/${pid}`).then(setPatient).catch(() => {});
  }, [sp]);
  useEffect(() => {
    const src = sp.get('source'); const id = Number(sp.get('id'));
    if (src && pending) {
      const it = pending.find((p) => p.source_type === src && p.source_id === id);
      if (it) { setItem(it); setF((x) => ({ ...x, amount: it.remaining })); if (!patient && it.patient_id) api.get(`/patients/${it.patient_id}`).then(setPatient).catch(() => {}); }
    }
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = acts?.find((a) => a.id === Number(f.act_id));
  const gross = mode === 'pending' ? Number(f.amount) || 0 : mode === 'act' ? (act?.price || 0) * (Number(f.quantity) || 1) : Number(f.amount) || 0;
  const net = gross - (Number(f.discount) || 0);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    const body = { method: f.method, reference: f.reference || null, discount: Number(f.discount) || 0, patient_id: patient?.id || null, payer_name: f.payer_name || null, register_id: f.register_id ? Number(f.register_id) : null };
    if (mode === 'pending') Object.assign(body, { source_type: item.source_type, source_id: item.source_id, amount: Number(f.amount) });
    else if (mode === 'act') Object.assign(body, { source_type: 'act', act_id: Number(f.act_id), quantity: Number(f.quantity) });
    else Object.assign(body, { source_type: 'other', amount: Number(f.amount), description: f.description });
    try {
      const p = await api.post('/payments', body, { headers: { 'Idempotency-Key': idemKey } });
      toast(`Paiement enregistré : ${gnf(p.amount)}`);
      nav(`/paiements/${p.id}?print=1`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const noCash = f.method === 'especes' && cash && !cash.length;
  return (
    <>
      <PageHeader title="Encaisser un paiement" />
      {noCash && <div className="alert-box warn">Aucune caisse ouverte : les paiements en espèces nécessitent l'<Link to="/caisse">ouverture de la caisse</Link>.</div>}
      <form className="grid-2" onSubmit={submit}>
        <Card title="1. Patient et prestation">
          <div className="form">
            <Field as="div" label="Patient"><PatientPicker value={patient} onChange={(p) => { setPatient(p); setItem(null); }} autoFocus /></Field>
            <div className="tabs">
              {[['pending', 'Éléments à payer'], ['act', 'Acte direct'], ['other', 'Autre']].map(([k, l]) => <button type="button" key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{l}</button>)}
            </div>
            {mode === 'pending' && (
              !pending ? <Empty>Chargement…</Empty> : !pending.length ? <Empty>Aucun élément en attente de paiement{patient ? ' pour ce patient' : ''}.</Empty> : (
                <div className="stack" style={{ gap: 6 }}>
                  {pending.map((p) => (
                    <label key={`${p.source_type}${p.source_id}`} className="picked" style={{ cursor: 'pointer', borderColor: item === p ? 'var(--primary)' : undefined }}>
                      <span className="row"><input type="radio" name="item" checked={item === p} onChange={() => { setItem(p); setF({ ...f, amount: p.remaining }); }} />
                        <span><b>{p.description}</b><br /><span className="muted small">{p.patient_name} · {date(p.date)}</span></span></span>
                      <span className="right"><Money value={p.remaining} />{p.paid_amount > 0 && <div className="muted small">sur {gnf(p.amount)}</div>}</span>
                    </label>
                  ))}
                  <button type="button" className="btn ghost sm" onClick={reload}>↻ Actualiser</button>
                </div>
              )
            )}
            {mode === 'pending' && item && <Field label="Montant à régler (paiement partiel possible)"><input type="number" min="1" max={item.remaining} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>}
            {mode === 'act' && (
              <div className="form-grid">
                <Field label="Acte" required className="span-2"><select value={f.act_id} onChange={(e) => setF({ ...f, act_id: e.target.value })} required><option value="">—</option>{acts?.map((a) => <option key={a.id} value={a.id}>{a.name} — {gnf(a.price)}</option>)}</select></Field>
                <Field label="Quantité"><input type="number" min="1" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
              </div>
            )}
            {mode === 'other' && (
              <div className="form-grid">
                <Field label="Libellé" required className="span-2"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required placeholder="Certificat médical, carnet…" /></Field>
                <Field label="Montant" required><input type="number" min="1" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
              </div>
            )}
            {!patient && mode !== 'pending' && <Field label="Nom du payeur (si non enregistré)"><input value={f.payer_name} onChange={(e) => setF({ ...f, payer_name: e.target.value })} /></Field>}
          </div>
        </Card>
        <Card title="2. Règlement">
          <div className="form">
            <Field label="Mode de paiement"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <RegisterSelect value={f.register_id} onChange={(v) => setF((x) => ({ ...x, register_id: v }))} required={f.method === 'especes'} />
            {f.method !== 'especes' && <Field label="Référence de transaction" required={f.method !== 'autre'}><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="ID de transaction Orange Money / MTN, n° virement…" required={f.method !== 'autre'} /></Field>}
            {can('payments.discount') && <Field label="Remise (GNF)" hint="Toute remise est tracée ; une remise importante déclenche une alerte."><input type="number" min="0" value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} /></Field>}
            <dl className="kv"><dt>Montant</dt><dd>{gnf(gross)}</dd>{Number(f.discount) > 0 && <><dt>Remise</dt><dd>- {gnf(f.discount)}</dd></>}<dt>Net à encaisser</dt><dd><b style={{ fontSize: '1.3rem' }}>{gnf(net)}</b></dd></dl>
            <ErrorBox error={error} />
            <button className="btn primary" disabled={busy || net < 0 || (mode === 'pending' && !item) || noCash}>{busy ? 'Enregistrement…' : `Encaisser ${gnf(net)}`}</button>
          </div>
        </Card>
      </form>
    </>
  );
}

export function Receipt({ p, clinic }) {
  return (
    <div className="receipt">
      <h3>{clinic?.name || 'CABINET MÉDICAL SBS'}</h3>
      <div className="c small">{clinic?.address}{clinic?.phone && <><br />Tél. {clinic.phone}</>}</div>
      <hr />
      <div className="c"><b>REÇU DE PAIEMENT</b></div>
      {p.status !== 'valide' && <div className="stamp">{p.status === 'annule' ? 'ANNULÉ' : 'REMBOURSÉ'}</div>}
      <div className="l"><span>N° reçu</span><b>{p.receipt_number}</b></div>
      <div className="l"><span>Référence</span><span>{p.number}</span></div>
      <div className="l"><span>Date</span><span>{date(p.created_at)}</span></div>
      <div className="l"><span>Heure</span><span>{time(p.created_at)}</span></div>
      <div className="l"><span>Patient</span><span>{p.patient_name || '—'}</span></div>
      <hr />
      <div className="l"><span>Prestation</span><span style={{ textAlign: 'right' }}>{p.description}</span></div>
      {p.discount > 0 && <><div className="l"><span>Montant</span><span>{gnf(p.gross_amount)}</span></div><div className="l"><span>Remise</span><span>- {gnf(p.discount)}</span></div></>}
      <div className="total">TOTAL : {gnf(p.amount)}</div>
      <div className="l"><span>Mode</span><span>{LABELS.method[p.method]}</span></div>
      {p.reference && <div className="l"><span>Réf. transaction</span><span>{p.reference}</span></div>}
      <div className="l"><span>Caissier</span><span>{p.received_by_name}</span></div>
      <hr />
      <div className="c small">Merci de votre confiance.</div>
    </div>
  );
}

export function PaymentDetail() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const { can, clinic } = useAuth();
  const toast = useToast();
  const { data: p, reload, error } = useFetch(`/payments/${id}`);
  const [modal, setModal] = useState(null);
  const [edit, setEdit] = useState({ amount: '', method: '', reference: '', register_id: '' });
  const [refundRegister, setRefundRegister] = useState('');
  useEffect(() => { if (p && sp.get('print') === '1') toast('Reçu prêt : imprimez, téléchargez ou partagez.'); }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Empty>Chargement…</Empty>;
  const pdfUrl = `/api/payments/${p.id}/receipt.pdf`;
  const share = async () => {
    const text = `${clinic?.name} — Reçu ${p.receipt_number}\n${p.description}\nMontant : ${gnf(p.amount)} (${LABELS.method[p.method]})\nDate : ${dateTime(p.created_at)}`;
    try {
      const blob = await (await fetch(pdfUrl)).blob();
      const file = new File([blob], `recu-${p.receipt_number}.pdf`, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: `Reçu ${p.receipt_number}`, text });
      else if (navigator.share) await navigator.share({ title: `Reçu ${p.receipt_number}`, text });
      else { await navigator.clipboard.writeText(text); toast('Reçu copié dans le presse-papiers'); }
    } catch { /* partage annulé */ }
  };
  return (
    <>
      <PageHeader title={`Paiement ${p.number}`} subtitle={`${p.description} · ${dateTime(p.created_at)} · ${p.received_by_name}`}>
        <Badge value={p.status} map="pay_status" />
        <button className="btn primary" onClick={() => window.print()}>🖨️ Imprimer</button>
        <a className="btn" href={pdfUrl} target="_blank" rel="noreferrer">⬇ PDF</a>
        <button className="btn" onClick={share}>📤 Partager</button>
      </PageHeader>
      <div className="grid-2">
        <Card><Receipt p={p} clinic={clinic} /></Card>
        <div className="stack no-print">
          <Card title="Détails">
            <dl className="kv">
              <dt>Transaction</dt><dd>{p.number}</dd>
              <dt>Source</dt><dd>{LABELS.source[p.source_type]}{p.source_type === 'consultation' && <> — <Link to={`/consultations/${p.source_id}`}>voir</Link></>}{p.source_type === 'lab_request' && <> — <Link to={`/laboratoire/${p.source_id}`}>voir</Link></>}</dd>
              <dt>Montant brut</dt><dd>{gnf(p.gross_amount)}</dd>
              <dt>Remise</dt><dd>{gnf(p.discount)}</dd>
              <dt>Net encaissé</dt><dd><b>{gnf(p.amount)}</b></dd>
              <dt>Caisse</dt><dd>{p.cash_session_number ? <Link to={`/caisse/sessions/${p.cash_session_id}`}>{p.cash_session_number}</Link> : '—'} {p.cash_session_status === 'cloturee' && <span className="muted small">(clôturée)</span>}</dd>
              {p.cancel_reason && <><dt>Motif d'annulation</dt><dd>{p.cancel_reason}</dd></>}
            </dl>
            {p.status === 'valide' && (
              <div className="actions" style={{ marginTop: 12 }}>
                {can('payments.update') && <button className="btn" onClick={() => { setEdit({ amount: p.amount, method: p.method, reference: p.reference || '' }); setModal('edit'); }}>✏️ Modifier</button>}
                {can('payments.cancel') && <button className="btn warn" onClick={() => setModal('cancel')}>Annuler</button>}
                {can('payments.refund') && <button className="btn danger" onClick={() => setModal('refund')}>Rembourser</button>}
              </div>
            )}
          </Card>
          {p.history?.length > 0 && (
            <Card title="Historique (journal d'audit)">
              <ul className="feed">
                {p.history.map((h) => (
                  <li key={h.id}><span className="when">{time(h.created_at)}</span>
                    <span className="what">{h.summary}<div className="who">{h.username} · {dateTime(h.created_at)}{h.reason && ` · motif : ${h.reason}`}</div></span></li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      {modal === 'edit' && (
        <ReasonModal title="Modifier le paiement" confirmLabel="Enregistrer la modification" onClose={() => setModal(null)}
          onConfirm={async (reason) => { await api.put(`/payments/${p.id}`, { amount: Number(edit.amount), method: edit.method, reference: edit.reference || null, register_id: edit.register_id ? Number(edit.register_id) : null, reason }); toast('Paiement modifié (tracé)'); reload(); }}>
          <div className="alert-box warn">Toute modification est enregistrée dans le journal d'audit et signalée à l'administrateur.</div>
          <div className="form-grid">
            <Field label="Montant net"><input type="number" min="0" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
            <Field label="Mode"><select value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            {edit.method === 'especes' && p.method !== 'especes' && <RegisterSelect value={edit.register_id} onChange={(v) => setEdit((x) => ({ ...x, register_id: v }))} />}
            <Field label="Référence"><input value={edit.reference} onChange={(e) => setEdit({ ...edit, reference: e.target.value })} /></Field>
          </div>
        </ReasonModal>
      )}
      {modal === 'cancel' && <ReasonModal title="Annuler le paiement" danger confirmLabel="Annuler le paiement" onClose={() => setModal(null)} onConfirm={async (reason) => { await api.post(`/payments/${p.id}/cancel`, { reason }); reload(); }}><p className="muted">L'annulation n'est possible que tant que la caisse du paiement est ouverte. Le montant sera retiré de la caisse.</p></ReasonModal>}
      {modal === 'refund' && <ReasonModal title={`Rembourser ${gnf(p.amount)}`} danger confirmLabel="Rembourser" onClose={() => setModal(null)} onConfirm={async (reason) => { await api.post(`/payments/${p.id}/refund`, { reason, register_id: refundRegister ? Number(refundRegister) : null }); reload(); }}><p className="muted">Un remboursement en espèces sort de la caisse ouverte choisie.</p>{p.method === 'especes' && <RegisterSelect value={refundRegister} onChange={setRefundRegister} />}</ReasonModal>}
    </>
  );
}
