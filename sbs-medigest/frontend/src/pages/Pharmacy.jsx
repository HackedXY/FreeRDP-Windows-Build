import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  PageHeader, Card, Table, Pagination, useFetch, Modal, Field, ErrorBox, Badge, Empty, useToast, PeriodFilter, periodParams, Money,
  PatientPicker, Tabs, ReasonModal, useForm, RegisterSelect,
} from '../components/ui.jsx';
import { date, dateTime, gnf, num, LABELS, todayISO } from '../format.js';

const STOCK_TONE = { ok: 'ok', faible: 'warn', epuise: 'danger' };
const STOCK_LABEL = { ok: 'OK', faible: 'Stock faible', epuise: 'Épuisé' };

function ProductForm({ product, onClose, onSaved }) {
  const { data: suppliers } = useFetch('/suppliers');
  const { values, bind } = useForm(product ? { ...product, supplier_id: product.supplier_id || '' } : { category: 'medicament', min_threshold: 10, purchase_price: 0, sale_price: 0, supplier_id: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = {
      reference: values.reference, name: values.name, category: values.category, form: values.form || null, supplier_id: values.supplier_id ? Number(values.supplier_id) : null,
      purchase_price: Number(values.purchase_price), sale_price: Number(values.sale_price), min_threshold: Number(values.min_threshold),
    };
    if (product) body.active = values.active !== false && values.active !== 'false';
    else Object.assign(body, { initial_quantity: Number(values.initial_quantity) || 0, lot_number: values.lot_number || null, expiry_date: values.expiry_date || null });
    try { onSaved(product ? await api.put(`/pharmacy/products/${product.id}`, body) : await api.post('/pharmacy/products', body)); } catch (err) { setError(err); }
  };
  return (
    <Modal title={product ? `Modifier ${product.name}` : 'Nouveau produit'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nom" required className="span-2"><input {...bind('name')} required /></Field>
          <Field label="Référence" required><input {...bind('reference')} required /></Field>
          <Field label="Catégorie"><select {...bind('category')}>{Object.entries(LABELS.category).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Forme"><input {...bind('form')} placeholder="comprimé, sirop, injectable…" /></Field>
          <Field label="Fournisseur"><select {...bind('supplier_id')}><option value="">—</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Prix d'achat (GNF)"><input type="number" min="0" {...bind('purchase_price')} /></Field>
          <Field label="Prix de vente (GNF)"><input type="number" min="0" {...bind('sale_price')} /></Field>
          <Field label="Seuil minimal"><input type="number" min="0" {...bind('min_threshold')} /></Field>
          {product && <Field label="Statut"><select {...bind('active')}><option value="true">Actif</option><option value="false">Inactif</option></select></Field>}
          {!product && <>
            <Field label="Quantité initiale"><input type="number" min="0" {...bind('initial_quantity')} /></Field>
            <Field label="N° de lot"><input {...bind('lot_number')} /></Field>
            <Field label="Date d'expiration"><input type="date" {...bind('expiry_date')} /></Field>
          </>}
        </div>
        {product && <p className="hint">Tout changement de prix est tracé et signalé à l'administrateur.</p>}
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

function StockModal({ product, direction, onClose, onSaved }) {
  const { data: suppliers } = useFetch(direction === 'in' ? '/suppliers' : null);
  const { values, bind } = useForm({ quantity: '', reason: direction === 'in' ? 'achat' : 'utilisation', supplier_id: product.supplier_id || '', unit_cost: product.purchase_price, lot_id: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = direction === 'in'
      ? { product_id: product.id, quantity: Number(values.quantity), reason: values.reason, lot_number: values.lot_number || null, expiry_date: values.expiry_date || null, unit_cost: Number(values.unit_cost) || null, supplier_id: values.supplier_id ? Number(values.supplier_id) : null, document_ref: values.document_ref || null, note: values.note || null }
      : { product_id: product.id, quantity: Number(values.quantity), reason: values.reason, lot_id: values.lot_id ? Number(values.lot_id) : null, note: values.note || null };
    try { onSaved(await api.post(`/pharmacy/stock/${direction}`, body)); } catch (err) { setError(err); }
  };
  return (
    <Modal title={`${direction === 'in' ? 'Entrée' : 'Sortie'} de stock — ${product.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted" style={{ margin: 0 }}>Stock actuel : <b>{num(product.quantity)}</b></p>
        <div className="form-grid">
          <Field label="Quantité" required><input type="number" min="1" {...bind('quantity')} required autoFocus /></Field>
          <Field label="Motif"><select {...bind('reason')}>
            {(direction === 'in' ? ['achat', 'livraison', 'retour'] : ['utilisation', 'perte', 'expiration', 'retour']).map((r) => <option key={r} value={r}>{LABELS.stock_reason[r]}</option>)}
          </select></Field>
          {direction === 'in' ? <>
            <Field label="N° de lot"><input {...bind('lot_number')} /></Field>
            <Field label="Date d'expiration"><input type="date" {...bind('expiry_date')} /></Field>
            <Field label="Coût unitaire"><input type="number" min="0" {...bind('unit_cost')} /></Field>
            <Field label="Fournisseur"><select {...bind('supplier_id')}><option value="">—</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="N° facture / BL"><input {...bind('document_ref')} /></Field>
          </> : product.lots?.length > 0 && (
            <Field label="Lot (sinon : premier expiré, premier sorti)"><select {...bind('lot_id')}><option value="">Automatique (FEFO)</option>{product.lots.filter((l) => l.quantity > 0).map((l) => <option key={l.id} value={l.id}>{l.lot_number} — {l.quantity} u. — exp. {date(l.expiry_date)}</option>)}</select></Field>
          )}
        </div>
        <Field label={direction === 'out' ? 'Justification (obligatoire pour perte / expiration)' : 'Note'}><textarea rows={2} {...bind('note')} /></Field>
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Valider</button></div>
      </form>
    </Modal>
  );
}

function SalePanel({ onDone }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data: products } = useFetch('/pharmacy/products');
  const { data: cash } = useFetch(can('payments.create') ? '/cash/current' : null);
  const [patient, setPatient] = useState(null);
  const [customer, setCustomer] = useState('');
  const [cart, setCart] = useState([]);
  const [q, setQ] = useState('');
  const [pay, setPay] = useState({ now: can('payments.create'), method: 'especes', reference: '', register_id: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const add = (p) => setCart((c) => { const ex = c.find((x) => x.product.id === p.id); return ex ? c.map((x) => x === ex ? { ...x, quantity: x.quantity + 1 } : x) : [...c, { product: p, quantity: 1 }]; });
  const total = cart.reduce((s, x) => s + x.product.sale_price * x.quantity, 0);
  const matches = q.length >= 2 ? (products || []).filter((p) => (p.name + p.reference).toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body = { patient_id: patient?.id || null, customer_name: customer || null, items: cart.map((x) => ({ product_id: x.product.id, quantity: x.quantity })) };
      if (pay.now) body.payment = { method: pay.method, reference: pay.reference || null, register_id: pay.register_id ? Number(pay.register_id) : null };
      const s = await api.post('/pharmacy/sales', body);
      toast(`Vente ${s.number} enregistrée — ${gnf(s.amount)}`);
      setCart([]); setPatient(null); setCustomer('');
      onDone(s);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="grid-2">
      <Card title="Produits">
        <input type="search" placeholder="Rechercher un médicament…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} autoFocus />
        <div className="stack" style={{ gap: 4, marginTop: 8 }}>
          {matches.map((p) => (
            <button key={p.id} className="picked" style={{ cursor: 'pointer', textAlign: 'left' }} onClick={() => add(p)} disabled={p.quantity === 0}>
              <span><b>{p.name}</b> <span className="muted small">{p.reference} · stock {p.quantity}</span></span><Money value={p.sale_price} />
            </button>
          ))}
          {q.length >= 2 && !matches.length && <Empty>Aucun produit</Empty>}
        </div>
      </Card>
      <Card title="Panier">
        {!cart.length ? <Empty>Panier vide</Empty> : cart.map((x) => (
          <div key={x.product.id} className="row" style={{ padding: '4px 0' }}>
            <span className="grow">{x.product.name}</span>
            <input type="number" min="1" max={x.product.quantity} value={x.quantity} style={{ width: 70 }} aria-label="Quantité"
              onChange={(e) => setCart(cart.map((y) => y === x ? { ...y, quantity: Math.max(1, Number(e.target.value)) } : y))} />
            <Money value={x.product.sale_price * x.quantity} />
            <button className="icon-btn" onClick={() => setCart(cart.filter((y) => y !== x))} aria-label="Retirer">✕</button>
          </div>
        ))}
        <div className="form" style={{ marginTop: 12 }}>
          <Field as="div" label="Patient (facultatif)"><PatientPicker value={patient} onChange={setPatient} /></Field>
          {!patient && <Field label="Nom du client"><input value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>}
          {can('payments.create') && <label className="check"><input type="checkbox" checked={pay.now} onChange={(e) => setPay({ ...pay, now: e.target.checked })} /> Encaisser maintenant</label>}
          {pay.now && <div className="form-grid">
            <Field label="Mode"><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(LABELS.method).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            {pay.method !== 'especes' && <Field label="Référence"><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>}
            <RegisterSelect value={pay.register_id} onChange={(v) => setPay((x) => ({ ...x, register_id: v }))} required={pay.method === 'especes'} />
          </div>}
          {pay.now && pay.method === 'especes' && cash && !cash.length && <div className="alert-box warn">Aucune caisse ouverte.</div>}
          {!pay.now && <p className="hint">La vente sera réglée à la caisse.</p>}
          <div className="row"><span className="grow"><b style={{ fontSize: '1.2rem' }}>Total : {gnf(total)}</b></span><button className="btn primary" disabled={!cart.length || busy} onClick={submit}>Valider la vente</button></div>
          <ErrorBox error={error} />
        </div>
      </Card>
    </div>
  );
}

/** Délivrance d'une prescription : quantités prescrites / délivrées / restantes par ligne. */
function DispenseModal({ id, onClose, onDone }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data: pr, error: loadError } = useFetch(`/consultations/prescriptions/${id}`);
  const { data: products } = useFetch('/pharmacy/products');
  const [lines, setLines] = useState({});
  const [pay, setPay] = useState({ now: can('payments.create'), method: 'especes', reference: '', register_id: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pr) return;
    setLines(Object.fromEntries(pr.items.map((l) => [l.line, {
      selected: l.remaining_quantity === null ? l.dispensed_quantity === 0 : l.remaining_quantity > 0,
      product_id: l.product_id || '', quantity: l.remaining_quantity ?? 1,
    }])));
  }, [pr]);
  if (loadError) return <Modal title="Prescription" onClose={onClose}><ErrorBox error={loadError} /></Modal>;
  if (!pr) return <Modal title="Prescription" onClose={onClose}><Empty>Chargement…</Empty></Modal>;
  const set = (line, k, v) => setLines({ ...lines, [line]: { ...lines[line], [k]: v } });
  const chosen = pr.items.filter((l) => lines[l.line]?.selected);
  const priceOf = (pid) => products?.find((p) => p.id === Number(pid))?.sale_price || 0;
  const total = chosen.reduce((s, l) => s + priceOf(lines[l.line].product_id) * (Number(lines[l.line].quantity) || 0), 0);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const items = chosen.map((l) => ({ product_id: Number(lines[l.line].product_id), quantity: Number(lines[l.line].quantity), prescription_line: l.line }));
      if (items.some((i) => !i.product_id || !i.quantity)) throw new Error('Choisissez le produit et la quantité de chaque ligne à délivrer.');
      const body = { prescription_id: pr.id, items };
      if (pay.now) body.payment = { method: pay.method, reference: pay.reference || null, register_id: pay.register_id ? Number(pay.register_id) : null };
      const s = await api.post('/pharmacy/sales', body);
      toast(`Délivrance enregistrée — vente ${s.number} (${LABELS.prescription_status[s.prescription.status]})`);
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Prescription ${pr.number}`} onClose={onClose} wide footer={null}>
      <p className="muted small">{pr.patient_name} ({pr.patient_number}) · Dr {pr.prescriber || '—'} · {dateTime(pr.created_at)} · <Badge value={pr.status} map="prescription_status" />
        {' '}<a href={`/api/consultations/prescriptions/${pr.id}/pdf`} target="_blank" rel="noreferrer">🖨 Ordonnance PDF</a></p>
      <Table rows={pr.items} columns={[
        { key: 'sel', label: '', render: (l) => <input type="checkbox" aria-label={`Délivrer la ligne ${l.line}`} checked={!!lines[l.line]?.selected} disabled={l.remaining_quantity === 0} onChange={(e) => set(l.line, 'selected', e.target.checked)} /> },
        { key: 'drug_name', label: 'Prescrit', render: (l) => <><b>{l.drug_name}</b><div className="muted small">{[l.dosage, l.frequency, l.duration].filter(Boolean).join(' · ')}{l.instructions ? ` · ${l.instructions}` : ''}</div></> },
        { key: 'q', label: 'Prescrit / délivré / reste', render: (l) => `${l.prescribed_quantity ?? '—'} / ${l.dispensed_quantity} / ${l.remaining_quantity ?? '—'}` },
        { key: 'product', label: 'Produit délivré', render: (l) => (
          <select value={lines[l.line]?.product_id || ''} disabled={!lines[l.line]?.selected} onChange={(e) => set(l.line, 'product_id', e.target.value)} aria-label="Produit">
            <option value="">— Produit —</option>
            {products?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id} disabled={p.quantity === 0}>{p.name} (stock {p.quantity})</option>)}
          </select>
        ) },
        { key: 'qty', label: 'Qté', render: (l) => <input type="number" min="1" max={l.remaining_quantity ?? undefined} style={{ width: 70 }} value={lines[l.line]?.quantity ?? ''} disabled={!lines[l.line]?.selected} onChange={(e) => set(l.line, 'quantity', e.target.value)} aria-label="Quantité" /> },
      ]} />
      {pr.items.some((l) => l.dispensations.length) && (
        <>
          <h3 className="small muted" style={{ margin: '12px 0 6px' }}>Délivrances</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {pr.items.flatMap((l) => l.dispensations.map((d) => (
              <li key={d.id} className={d.cancelled_at ? 'muted' : ''}>Ligne {l.line} : {d.quantity} × {d.product_name} — {d.dispensed_by_name}, {dateTime(d.dispensed_at)} ({d.sale_number}){d.cancelled_at ? ' — annulée' : ''}</li>
            )))}
          </ul>
        </>
      )}
      <div className="form" style={{ marginTop: 12 }}>
        {can('payments.create') && <label className="check"><input type="checkbox" checked={pay.now} onChange={(e) => setPay({ ...pay, now: e.target.checked })} /> Encaisser maintenant</label>}
        {pay.now && <div className="form-grid">
          <Field label="Mode"><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(LABELS.method).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {pay.method !== 'especes' && <Field label="Référence"><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>}
          <RegisterSelect value={pay.register_id} onChange={(v) => setPay((x) => ({ ...x, register_id: v }))} required={pay.method === 'especes'} />
        </div>}
        <ErrorBox error={error} />
        <div className="row"><span className="grow"><b>Total : {gnf(total)}</b></span>
          <button className="btn ghost" onClick={onClose}>Fermer</button>
          <button className="btn primary" disabled={!chosen.length || busy} onClick={submit}>Délivrer</button></div>
      </div>
    </Modal>
  );
}

function PrescriptionsPanel() {
  const [status, setStatus] = useState('a_delivrer');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const { data, reload } = useFetch('/pharmacy/prescriptions', { status, q, page });
  return (
    <Card>
      <div className="toolbar">
        <input type="search" placeholder="N° d'ordonnance, patient…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Statut">
          <option value="a_delivrer">À délivrer</option><option value="delivree">Délivrées</option><option value="toutes">Toutes</option>
        </select>
      </div>
      <Table rows={data?.items} onRowClick={(r) => setOpen(r.id)} empty="Aucune ordonnance" columns={[
        { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
        { key: 'number', label: 'N°' },
        { key: 'patient_name', label: 'Patient', render: (r) => <>{r.patient_name}<div className="muted small">{r.patient_number}</div></> },
        { key: 'prescriber', label: 'Prescripteur' },
        { key: 'status', label: 'Statut', render: (r) => <Badge value={r.status} map="prescription_status" /> },
        { key: 'last_dispensed_at', label: 'Dernière délivrance', render: (r) => dateTime(r.last_dispensed_at) },
      ]} />
      <Pagination page={page} total={data?.total} onChange={setPage} />
      {open && <DispenseModal id={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); reload(); }} />}
    </Card>
  );
}

export function Pharmacy() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState(can('pharmacy.view') ? 'products' : 'sale');
  const [q, setQ] = useState('');
  const [low, setLow] = useState(sp.get('low') === '1');
  const [category, setCategory] = useState('');
  const [modal, setModal] = useState(null);
  const { data: products, reload } = useFetch(tab === 'products' ? '/pharmacy/products' : null, { q, low: low ? '1' : '', category, all: can('pharmacy.manage') ? '1' : '' });
  const [period, setPeriod] = useState({ period: 'today' });
  const [page, setPage] = useState(1);
  const { data: sales, reload: reloadSales } = useFetch(tab === 'sales' ? '/pharmacy/sales' : null, { ...periodParams(period), page });
  const { data: movements } = useFetch(tab === 'movements' ? '/pharmacy/movements' : null, { ...periodParams(period), page });
  const { data: inventories } = useFetch(tab === 'inventories' ? '/pharmacy/inventories' : null);
  const stockValue = (products || []).reduce((s, p) => s + p.quantity * p.purchase_price, 0);
  return (
    <>
      <PageHeader title="Pharmacie & stock">
        {can('pharmacy.manage') && <button className="btn" onClick={() => setModal('product')}>+ Produit</button>}
        {can('pharmacy.sell') && <button className="btn primary" onClick={() => setTab('sale')}>💊 Nouvelle vente</button>}
      </PageHeader>
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[
        can('pharmacy.view') && { key: 'products', label: 'Produits' },
        can('pharmacy.sell') && { key: 'sale', label: 'Vente' },
        can('pharmacy.sell') && { key: 'prescriptions', label: 'Ordonnances' },
        can('pharmacy.sell', 'payments.view') && { key: 'sales', label: 'Ventes' },
        can('pharmacy.view') && { key: 'movements', label: 'Mouvements' },
        can('stock.inventory') && { key: 'inventories', label: 'Inventaires' },
      ]} />
      {tab === 'products' && (
        <Card>
          <div className="toolbar">
            <input type="search" placeholder="Nom, référence…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Catégorie"><option value="">Toutes catégories</option>{Object.entries(LABELS.category).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <label className="check"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Sous le seuil</label>
            <span className="grow" />{products?.[0]?.purchase_price !== undefined && <span className="muted small">Valeur du stock (achat) : <b>{gnf(stockValue)}</b></span>}
          </div>
          <Table rows={products} onRowClick={(r) => nav(`/pharmacie/produits/${r.id}`)} columns={[
            { key: 'name', label: 'Produit', render: (r) => <><b>{r.name}</b>{!r.active && <Badge tone="muted">inactif</Badge>}<div className="muted small">{r.reference} · {LABELS.category[r.category]}</div></> },
            { key: 'quantity', label: 'Stock', align: 'right', render: (r) => <b>{num(r.quantity)}</b> },
            { key: 'min_threshold', label: 'Seuil', align: 'right' },
            { key: 'stock_status', label: 'État', render: (r) => <Badge tone={STOCK_TONE[r.stock_status]}>{STOCK_LABEL[r.stock_status]}</Badge> },
            { key: 'next_expiry', label: 'Prochaine expiration', render: (r) => date(r.next_expiry) },
            { key: 'sale_price', label: 'Prix vente', align: 'right', render: (r) => gnf(r.sale_price) },
          ]} />
        </Card>
      )}
      {tab === 'sale' && <SalePanel onDone={() => {}} />}
      {tab === 'prescriptions' && <PrescriptionsPanel />}
      {tab === 'sales' && (
        <Card>
          <div className="toolbar"><PeriodFilter value={period} onChange={setPeriod} /></div>
          <Table rows={sales?.items} columns={[
            { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
            { key: 'number', label: 'N°' },
            { key: 'customer', label: 'Client', render: (r) => r.customer || '—' },
            { key: 'items_summary', label: 'Produits' },
            { key: 'sold_by_name', label: 'Vendeur' },
            { key: 'status', label: 'Statut', render: (r) => r.status === 'annulee' ? <Badge tone="muted">Annulée</Badge> : <Badge value={r.payment_status} map="payment_status" /> },
            { key: 'amount', label: 'Montant', align: 'right', render: (r) => <Money value={r.amount} /> },
            { key: 'x', label: '', render: (r) => r.status === 'valide' && r.payment_status === 'non_payee' && <>
              {can('payments.create') && <Link className="btn sm" to={`/paiements/nouveau?source=pharmacy_sale&id=${r.id}`}>Encaisser</Link>}
              {can('pharmacy.cancel_sale') && <button className="btn sm ghost" onClick={() => setModal({ cancelSale: r })}>Annuler</button>}
            </> },
          ]} />
          <Pagination page={page} total={sales?.total} onChange={setPage} />
        </Card>
      )}
      {tab === 'movements' && (
        <Card>
          <div className="toolbar"><PeriodFilter value={period} onChange={setPeriod} /></div>
          <MovementTable rows={movements?.items} showProduct />
          <Pagination page={page} total={movements?.total} limit={100} onChange={setPage} />
        </Card>
      )}
      {tab === 'inventories' && (
        <Card title="Inventaires" actions={<button className="btn primary" onClick={async () => { try { const i = await api.post('/pharmacy/inventories', {}); nav(`/pharmacie/inventaires/${i.id}`); } catch (e) { toast(e.message, 'danger'); } }}>+ Démarrer un inventaire</button>}>
          <Table rows={inventories} onRowClick={(r) => nav(`/pharmacie/inventaires/${r.id}`)} columns={[
            { key: 'number', label: 'N°' }, { key: 'started_at', label: 'Début', render: (r) => dateTime(r.started_at) },
            { key: 'started_by_name', label: 'Par' }, { key: 'line_count', label: 'Produits' }, { key: 'diff_count', label: 'Écarts' },
            { key: 'status', label: 'Statut', render: (r) => <Badge tone={r.status === 'valide' ? 'ok' : 'warn'}>{r.status === 'valide' ? 'Validé' : 'En cours'}</Badge> },
            { key: 'validated_at', label: 'Validé le', render: (r) => dateTime(r.validated_at) },
          ]} />
        </Card>
      )}
      {modal === 'product' && <ProductForm onClose={() => setModal(null)} onSaved={(p) => { setModal(null); toast('Produit créé'); reload(); nav(`/pharmacie/produits/${p.id}`); }} />}
      {modal?.cancelSale && <ReasonModal title={`Annuler la vente ${modal.cancelSale.number}`} danger onClose={() => setModal(null)} onConfirm={async (reason) => { await api.post(`/pharmacy/sales/${modal.cancelSale.id}/cancel`, { reason }); reloadSales(); }}><p className="muted">Les produits seront remis en stock.</p></ReasonModal>}
    </>
  );
}

function MovementTable({ rows, showProduct }) {
  return (
    <Table rows={rows} columns={[
      { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
      ...(showProduct ? [{ key: 'product_name', label: 'Produit', render: (r) => <Link to={`/pharmacie/produits/${r.product_id}`}>{r.product_name}</Link> }] : []),
      { key: 'reason', label: 'Motif', render: (r) => LABELS.stock_reason[r.reason] },
      { key: 'quantity', label: 'Quantité', align: 'right', render: (r) => <b className={r.quantity < 0 ? 'money neg' : 'money pos'}>{r.quantity > 0 ? '+' : ''}{r.quantity}</b> },
      { key: 'qty', label: 'Avant → après', render: (r) => `${r.qty_before} → ${r.qty_after}` },
      { key: 'lot_number', label: 'Lot', render: (r) => r.lot_number || '—' },
      { key: 'note', label: 'Note', render: (r) => r.note || r.document_ref || '' },
      { key: 'user_name', label: 'Par' },
    ]} />
  );
}

export function ProductDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: p, reload, error } = useFetch(`/pharmacy/products/${id}`);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Empty>Chargement…</Empty>;
  const status = p.quantity === 0 ? 'epuise' : p.quantity <= p.min_threshold ? 'faible' : 'ok';
  return (
    <>
      <PageHeader title={p.name} subtitle={`${p.reference} · ${LABELS.category[p.category]}${p.form ? ` · ${p.form}` : ''}${p.supplier_name ? ` · ${p.supplier_name}` : ''}`}>
        <Badge tone={STOCK_TONE[status]}>{STOCK_LABEL[status]}</Badge>
        {can('stock.move') && <button className="btn primary" onClick={() => setModal('in')}>+ Entrée</button>}
        {can('stock.move') && <button className="btn" onClick={() => setModal('out')}>− Sortie</button>}
        {can('pharmacy.manage') && <button className="btn ghost" onClick={() => setModal('edit')}>✏️ Modifier</button>}
      </PageHeader>
      <div className="stats">
        <div className="stat"><div className="stat-body"><div className="stat-label">Stock</div><div className="stat-value">{num(p.quantity)}</div><div className="stat-sub">seuil {p.min_threshold}</div></div></div>
        {p.purchase_price !== undefined && <div className="stat"><div className="stat-body"><div className="stat-label">Prix d'achat</div><div className="stat-value">{gnf(p.purchase_price)}</div></div></div>}
        <div className="stat"><div className="stat-body"><div className="stat-label">Prix de vente</div><div className="stat-value">{gnf(p.sale_price)}</div>{p.purchase_price !== undefined && <div className="stat-sub">marge {gnf(p.sale_price - p.purchase_price)}</div>}</div></div>
        {p.purchase_price !== undefined && <div className="stat"><div className="stat-body"><div className="stat-label">Valeur du stock</div><div className="stat-value">{gnf(p.quantity * p.purchase_price)}</div></div></div>}
      </div>
      <Card title="Lots">
        <Table rows={p.lots.filter((l) => l.quantity > 0)} empty="Aucun lot en stock" columns={[
          { key: 'lot_number', label: 'Lot' },
          { key: 'expiry_date', label: 'Expiration', render: (r) => { const days = r.expiry_date ? Math.round((new Date(r.expiry_date) - new Date(todayISO())) / 86400000) : null; return <>{date(r.expiry_date)} {days !== null && days < 0 && <Badge tone="danger">expiré</Badge>}{days !== null && days >= 0 && days <= 60 && <Badge tone="warn">{days} j</Badge>}</>; } },
          { key: 'quantity', label: 'Quantité', align: 'right' },
        ]} />
      </Card>
      <Card title="Historique des mouvements"><MovementTable rows={p.movements} /></Card>
      {modal === 'edit' && <ProductForm product={p} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Produit modifié'); reload(); }} />}
      {(modal === 'in' || modal === 'out') && <StockModal product={p} direction={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Mouvement enregistré'); reload(); }} />}
    </>
  );
}

export function InventoryDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data: inv, reload, error } = useFetch(`/pharmacy/inventories/${id}`);
  const [lines, setLines] = useState([]);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { if (inv) setLines(inv.lines.map((l) => ({ ...l, counted_qty: l.counted_qty ?? '' }))); }, [inv]);
  if (error) return <ErrorBox error={error} />;
  if (!inv) return <Empty>Chargement…</Empty>;
  const editable = inv.status === 'en_cours';
  const upd = (pid, k, v) => setLines(lines.map((l) => l.product_id === pid ? { ...l, [k]: v } : l));
  const save = async () => {
    setErr(null);
    try { await api.put(`/pharmacy/inventories/${id}/lines`, { lines: lines.map((l) => ({ product_id: l.product_id, counted_qty: l.counted_qty === '' ? null : Number(l.counted_qty), justification: l.justification || null })) }); toast('Comptage enregistré'); return true; } catch (e) { setErr(e); return false; }
  };
  const validate = async () => {
    if (!(await save())) return;
    try { const r = await api.post(`/pharmacy/inventories/${id}/validate`); toast(`Inventaire validé : ${r.corrections} correction(s)`); reload(); } catch (e) { setErr(e); }
  };
  const shown = lines.filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
  const diffs = lines.filter((l) => l.counted_qty !== '' && Number(l.counted_qty) !== l.theoretical_qty);
  return (
    <>
      <PageHeader title={`Inventaire ${inv.number}`} subtitle={`Démarré le ${dateTime(inv.started_at)}${inv.validated_at ? ` · validé le ${dateTime(inv.validated_at)}` : ''}`}>
        <Badge tone={editable ? 'warn' : 'ok'}>{editable ? 'En cours' : 'Validé'}</Badge>
        {editable && <button className="btn" onClick={save}>Enregistrer le comptage</button>}
        {editable && <button className="btn primary" onClick={validate}>Valider et corriger le stock</button>}
      </PageHeader>
      <ErrorBox error={err} />
      <Card title={`Comptage — ${diffs.length} écart(s)`}>
        <div className="toolbar"><input type="search" placeholder="Filtrer…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Produit</th><th className="right">Théorique</th><th className="right">Compté</th><th className="right">Écart</th><th>Justification</th></tr></thead>
          <tbody>{shown.map((l) => {
            const d = l.counted_qty === '' ? null : Number(l.counted_qty) - l.theoretical_qty;
            return (
              <tr key={l.product_id}>
                <td data-label="Produit"><b>{l.name}</b><div className="muted small">{l.reference}</div></td>
                <td data-label="Théorique" className="right">{l.theoretical_qty}</td>
                <td data-label="Compté" className="right">{editable ? <input type="number" min="0" value={l.counted_qty} style={{ width: 90 }} onChange={(e) => upd(l.product_id, 'counted_qty', e.target.value)} /> : l.counted_qty}</td>
                <td data-label="Écart" className="right">{d === null ? '—' : <b className={d < 0 ? 'money neg' : d > 0 ? 'money pos' : ''}>{d > 0 ? '+' : ''}{d}</b>}</td>
                <td data-label="Justification">{editable ? (d ? <input value={l.justification || ''} onChange={(e) => upd(l.product_id, 'justification', e.target.value)} placeholder="obligatoire" /> : '') : l.justification}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Card>
    </>
  );
}
