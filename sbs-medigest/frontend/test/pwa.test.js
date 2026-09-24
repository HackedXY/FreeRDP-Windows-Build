// PWA : manifeste, icônes, et stratégie de cache du service worker — aucune donnée
// (API, temps réel, PDF, justificatifs) n'est jamais mise en cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const pub = new URL('../public/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, pub));
const sw = (() => {
  const module = { exports: {} };
  vm.runInNewContext(read('sw.js').toString(), { module, URL });
  return module.exports;
})();
const origin = 'https://sbs.exemple.gn';
const req = (path, { method = 'GET', mode = 'cors' } = {}) => [new URL(path, origin), { method, mode }, origin];

test('manifeste : installation Android (nom, couleurs, icônes 192/512 et maskable)', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.ok(m.name && m.short_name && m.background_color && m.theme_color);
  const png = m.icons.filter((i) => i.type === 'image/png');
  assert.ok(png.some((i) => i.sizes === '192x192'));
  assert.ok(png.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(png.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) {
    const buf = read(i.src.slice(1));
    if (i.type === 'image/png') {
      assert.equal(buf.subarray(1, 4).toString(), 'PNG', i.src);
      const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      assert.equal(`${w}x${h}`, i.sizes, i.src);
    }
  }
});

test('service worker : API, temps réel, requêtes non GET et autres origines jamais interceptées', () => {
  for (const p of ['/api/patients', '/api/auth/me', '/api/consultations/prescriptions/1/pdf', '/api/payments/1/receipt.pdf', '/socket.io/?EIO=4']) {
    assert.equal(sw.strategyFor(...req(p)), 'bypass', p);
  }
  assert.equal(sw.strategyFor(...req('/assets/index.js', { method: 'POST' })), 'bypass');
  assert.equal(sw.strategyFor(new URL('https://cdn.exemple.com/x.js'), { method: 'GET', mode: 'cors' }, origin), 'bypass');
});

test('service worker : seule l\'interface est mise en cache ; navigation réseau d\'abord avec page hors ligne statique', () => {
  assert.equal(sw.strategyFor(...req('/assets/index-abc123.js')), 'asset');
  assert.equal(sw.strategyFor(...req('/offline.html')), 'asset');
  assert.equal(sw.strategyFor(...req('/patients/12', { mode: 'navigate' })), 'navigate');
  assert.equal(sw.strategyFor(...req('/uploads/justificatif.pdf')), 'network');
  const res = (status, cc, type = 'basic') => ({ status, type, headers: { get: () => cc } });
  assert.equal(sw.cacheable(res(200, 'public, max-age=31536000, immutable')), true);
  assert.equal(sw.cacheable(res(200, 'no-store')), false, 'réponse no-store (API) jamais conservée');
  assert.equal(sw.cacheable(res(200, 'private')), false);
  assert.equal(sw.cacheable(res(206, '')), false);
  assert.equal(sw.cacheable(res(200, '', 'opaque')), false);
  const offline = read('offline.html').toString();
  assert.doesNotMatch(offline, /<script|onclick=/, 'page hors ligne sans script (CSP)');
  assert.ok(sw.PRECACHE.every((p) => !p.startsWith('/api')));
});
