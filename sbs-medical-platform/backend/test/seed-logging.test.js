import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, closePools } from './helpers.js';
const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');

after(async () => { await closePools(); });

test('initialisation : le mot de passe administrateur fourni par l\'environnement n\'est jamais journalisé', async () => {
  await ownerPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  const lines = [];
  await seed({ log: (l) => lines.push(String(l)) });
  const out = lines.join('\n');
  assert.ok(out.includes('Compte administrateur créé'));
  assert.ok(out.includes('non affiché'));
  assert.ok(!out.includes(process.env.ADMIN_PASSWORD), 'le mot de passe ne doit pas apparaître');
});
