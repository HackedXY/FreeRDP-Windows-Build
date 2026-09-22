process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://sbs:sbs@localhost:5432/sbs_test';
process.env.ADMIN_PASSWORD = 'AdminTest2026';

const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');
const { createApp } = await import('../src/app.js');
const { invalidateSettings } = await import('../src/lib/settings.js');
const supertest = (await import('supertest')).default;

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateSettings();
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
}

export const app = createApp();

/** Agent authentifié (cookie de session) avec en-tête anti-CSRF. */
export async function login(username, password) {
  const agent = supertest.agent(app);
  const wrap = (m) => (url) => agent[m](url).set('X-SBS-Client', 'test');
  const a = { get: (url) => agent.get(url), post: wrap('post'), put: wrap('put'), delete: wrap('delete'), raw: agent };
  const res = await a.post('/api/auth/login').send({ username, password });
  a.loginRes = res;
  return a;
}

export async function adminAgent() {
  let a = await login('admin', 'AdminTest2026');
  if (a.loginRes.status === 200) {
    const me = await a.get('/api/auth/me');
    if (me.body.user.mustChangePassword) {
      await a.post('/api/auth/change-password').send({ currentPassword: 'AdminTest2026', newPassword: 'Proprietaire2026' });
    }
  }
  a = await login('admin', 'Proprietaire2026');
  return a;
}

/** Crée un employé et renvoie un agent connecté (mot de passe déjà changé). */
export async function employee(admin, roleCode, username) {
  const roles = (await admin.get('/api/roles')).body;
  const role = roles.find((r) => r.code === roleCode);
  const res = await admin.post('/api/users').send({
    first_name: username, last_name: 'Test', role_id: role.id, username, job_title: role.name,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const tmp = res.body.temporaryPassword;
  const a = await login(username, tmp);
  await a.post('/api/auth/change-password').send({ currentPassword: tmp, newPassword: 'Employe2026x' });
  const b = await login(username, 'Employe2026x');
  b.user = res.body.user;
  return b;
}

export { pool };
