// PWA côté serveur : en-têtes de cache sûrs (interface versionnée en cache long, service worker
// et pages toujours revalidés, API jamais mise en cache).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { closePools } from './helpers.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-static-'));
fs.mkdirSync(path.join(dir, 'assets'));
fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"></div>');
fs.writeFileSync(path.join(dir, 'sw.js'), '// sw');
fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
const previous = config.staticDir;
config.staticDir = dir;
const app = createApp();
config.staticDir = previous;
after(async () => { fs.rmSync(dir, { recursive: true, force: true }); await closePools(); });

test('service worker et manifeste : toujours revalidés, portée racine', async () => {
  const r = await supertest(app).get('/sw.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['service-worker-allowed'], '/');
  assert.equal((await supertest(app).get('/manifest.webmanifest')).headers['cache-control'], 'no-cache');
});

test('interface : fichiers versionnés en cache long ; pages de l\'application revalidées', async () => {
  assert.match((await supertest(app).get('/assets/index-abc123.js')).headers['cache-control'], /immutable/);
  for (const p of ['/', '/patients/12']) {
    const r = await supertest(app).get(p);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-cache', p);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  }
});

test('API : jamais mise en cache (no-store), même servie avec l\'interface', async () => {
  const r = await supertest(app).get('/api/health');
  assert.equal(r.headers['cache-control'], 'no-store');
});
