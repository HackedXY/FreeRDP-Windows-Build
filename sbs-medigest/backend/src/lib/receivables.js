// Ventes de pharmacie restées impayées : alerte (contrôle financier) et notification des
// personnes habilitées à encaisser. Aucune information médicale (ni produit, ni patient)
// dans l'alerte ou la notification : numéro de vente et montant uniquement.
import { raiseAlert, notify } from './notify.js';
import { getSettings } from './settings.js';
import { fmtGNF } from './helpers.js';

export async function checkUnpaidSales(db, ctx) {
  const { finance } = await getSettings();
  const hours = finance.unpaid_sale_alert_hours || 24;
  const { rows } = await db.query(
    `SELECT s.id, s.number, s.amount, s.paid_amount, s.created_at, u.first_name || ' ' || u.last_name AS sold_by_name
     FROM pharmacy_sales s LEFT JOIN users u ON u.id = s.sold_by
     WHERE s.status = 'valide' AND s.payment_status <> 'payee' AND s.amount > s.paid_amount
       AND s.created_at < now() - ($1 || ' hours')::interval
     ORDER BY s.id`, [String(hours)]);
  let created = 0;
  for (const s of rows) {
    const due = s.amount - s.paid_amount;
    const a = await raiseAlert(db, ctx, {
      category: 'financiere', type: 'vente_impayee', severity: 'moyenne',
      title: `Vente de pharmacie impayée : ${s.number} (reste ${fmtGNF(due)})`,
      details: { message: `Vente du ${new Date(s.created_at).toLocaleDateString('fr-FR')} par ${s.sold_by_name || '—'}, non soldée depuis plus de ${hours} h` },
      refType: 'pharmacy_sale', refId: s.id, dedupeKey: `unpaid_sale:${s.id}`, link: `/paiements/nouveau?source=pharmacy_sale&id=${s.id}`,
    });
    if (a) {
      created++;
      await notify(db, ctx, {
        permission: 'payments.create', type: 'to_pay', icon: '💊', title: 'Vente de pharmacie à encaisser',
        body: `${s.number} — reste ${fmtGNF(due)}`, link: `/paiements/nouveau?source=pharmacy_sale&id=${s.id}`,
      });
    }
  }
  return created;
}

/** Vente soldée ou annulée : l'alerte d'impayé ouverte est résolue automatiquement. */
export async function resolveUnpaidSaleAlert(db, saleId, note) {
  await db.query(
    `UPDATE alerts SET status = 'resolue', resolved_at = now(), resolution_note = $2
     WHERE dedupe_key = $1 AND status IN ('nouvelle','en_verification')`, [`unpaid_sale:${saleId}`, note]);
}
