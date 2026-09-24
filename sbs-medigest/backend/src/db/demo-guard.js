// Garde-fous du jeu de démonstration : il ne doit JAMAIS s'exécuter sur une base réelle.
// Trois barrières indépendantes :
//   1. environnement : refus si NODE_ENV=production (vérifié avant tout chargement de configuration) ;
//   2. base marquée « production » par le service de migration (settings.deployment) ;
//   3. base non vierge (patients ou employés déjà présents).
// L'image Docker de production ne contient en outre pas le script (voir Dockerfile).
export class DemoRefused extends Error {}

export function assertDemoEnvironment(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new DemoRefused('Données de démonstration interdites en production (NODE_ENV=production).');
  }
}

export async function assertDemoDatabase(db) {
  const { rows: [m] } = await db.query(`SELECT value FROM settings WHERE key = 'deployment'`);
  if (m?.value?.mode === 'production') {
    throw new DemoRefused('Base marquée « production » : données de démonstration interdites.');
  }
  const { rows: [c] } = await db.query(
    `SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM users) AS users`);
  if (c.patients > 0 || c.users > 1) {
    throw new DemoRefused(`Base non vierge (${c.patients} patient(s), ${c.users} compte(s)) : la démonstration ne s'exécute que sur une base neuve.`);
  }
}
