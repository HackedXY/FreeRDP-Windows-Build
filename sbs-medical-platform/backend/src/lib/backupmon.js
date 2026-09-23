// Surveillance des sauvegardes par l'application : alerte haute si la dernière
// sauvegarde a échoué ou si aucune sauvegarde réussie n'est plus récente que le seuil.
import { raiseAlert, notify } from './notify.js';

export async function checkBackups(db, ctx, { maxAgeHours = 26 } = {}) {
  const { rows: [last] } = await db.query('SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 1');
  const { rows: [ok] } = await db.query(`SELECT * FROM backup_runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1`);
  const raised = [];
  const stale = !ok || Date.now() - new Date(ok.finished_at).getTime() > maxAgeHours * 3600000;
  if (last?.status === 'failed') {
    const a = await raiseAlert(db, ctx, {
      category: 'systeme', type: 'sauvegarde_echec', severity: 'haute',
      title: `Échec de la sauvegarde du ${new Date(last.started_at).toLocaleString('fr-FR')}`,
      details: { message: last.error || 'Erreur inconnue' }, refType: 'backup_run', refId: last.id,
      dedupeKey: `backup_failed:${last.id}`, link: '/parametres',
    });
    if (a) raised.push(a);
  }
  if (stale) {
    const a = await raiseAlert(db, ctx, {
      category: 'systeme', type: 'sauvegarde_absente', severity: 'haute',
      title: ok ? `Aucune sauvegarde réussie depuis le ${new Date(ok.finished_at).toLocaleString('fr-FR')}` : 'Aucune sauvegarde réussie enregistrée',
      details: { message: `Seuil : ${maxAgeHours} h. Vérifier le service de sauvegarde et le stockage distant.` },
      dedupeKey: 'backup_stale', link: '/parametres',
    });
    if (a) {
      raised.push(a);
      await notify(db, ctx, { permission: 'settings.manage', type: 'backup', icon: '💾', title: 'Sauvegarde en retard', body: a.title, link: '/parametres', includeActor: true });
    }
  } else {
    // Sauvegarde récente réussie : les alertes de retard/échec antérieures sont résolues
    await db.query(
      `UPDATE alerts SET status = 'resolue', resolved_at = now(), resolution_note = 'Résolue automatiquement : sauvegarde réussie le ' || $1
       WHERE status IN ('nouvelle','en_verification') AND (dedupe_key = 'backup_stale'
         OR (type = 'sauvegarde_echec' AND ref_id IN (SELECT id FROM backup_runs WHERE started_at < $2)))`,
      [new Date(ok.finished_at).toLocaleString('fr-FR'), ok.started_at]);
  }
  return { last, lastSuccess: ok || null, stale, raised };
}
