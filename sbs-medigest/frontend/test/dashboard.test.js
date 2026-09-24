import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { FinanceDashboard, MedicalDashboard } from '../src/pages/Dashboard.jsx';
import { ErrorBoundary } from '../src/components/ErrorBoundary.jsx';

const base = {
  patients_today: 3, new_patients: 1, consultations: 2, lab_requests: 0, appointments: 1,
  consultations_by_status: { terminee: 1 }, pending: { lab_pending: 0, low_stock: 2 },
  series: [{ day: '2031-03-10', consultations: 2, revenue: 1000, expenses: 0 }], generated_at: new Date().toISOString(),
};
const finance = {
  ...base, finance: true, revenue: 150000, payment_count: 2, refunds: 0, expenses: 50000, pharmacy_sales: 0, lab_revenue: 0,
  revenue_by_method: [{ method: 'especes', total: 150000, count: 2 }],
  cash: { open_sessions: [], theoretical: 0, last_closed: null }, activity: [],
  pending: { ...base.pending, expenses_to_validate: 1, unpaid_consultations: 0 },
  employees: { active: 5, total: 6, logged_today: 3, online: 2 },
};
const render = (el) => renderToStaticMarkup(h(MemoryRouter, null, el));

test('tableau de bord financier AVEC alerts.view : cartes d\'alertes affichées', () => {
  const html = render(h(FinanceDashboard, { d: { ...finance, alerts: { open: 4, stock: 1, to_check: 3, high: 2 } }, clinic: { name: 'SBS' } }));
  assert.match(html, /Alertes stock/);
  assert.match(html, /Alertes à vérifier/);
  assert.match(html, /2 priorité haute/);
});

test('tableau de bord financier SANS alerts.view (bloc absent) : rendu sans erreur, cartes masquées', () => {
  const d = { ...finance };
  delete d.alerts;
  let html;
  assert.doesNotThrow(() => { html = render(h(FinanceDashboard, { d, clinic: { name: 'SBS' } })); });
  assert.match(html, /Recettes/);
  assert.doesNotMatch(html, /Alertes stock/);
  assert.doesNotMatch(html, /Alertes à vérifier/);
});

test('tableau de bord financier : blocs optionnels (personnel, caisse, fil) absents → pas d\'écran blanc', () => {
  const d = { ...finance };
  delete d.employees; delete d.cash; delete d.activity; delete d.alerts; delete d.revenue_by_method;
  const html = render(h(FinanceDashboard, { d, clinic: { name: 'SBS' } }));
  assert.match(html, /Caisse fermée/);
  assert.doesNotMatch(html, /Personnel actif/);
});

test('utilisateur sans accès financier : volet médical sans aucune donnée financière', () => {
  const html = render(h(MedicalDashboard, { d: { ...base, finance: false } }));
  assert.match(html, /Activité médicale du jour/);
  assert.doesNotMatch(html, /Recettes|Dépenses|Caisse/);
});

test('ErrorBoundary : une erreur d\'affichage produit un message de secours (pas d\'écran blanc)', () => {
  const state = ErrorBoundary.getDerivedStateFromError(new TypeError("Cannot read properties of undefined (reading 'stock')"));
  const eb = new ErrorBoundary({ children: 'contenu' });
  eb.state = { ...eb.state, ...state };
  const html = renderToStaticMarkup(eb.render());
  assert.match(html, /problème d&#x27;affichage|problème d'affichage/);
  assert.match(html, /Réessayer/);
  // sans erreur : les enfants sont rendus normalement
  assert.equal(renderToStaticMarkup(h(ErrorBoundary, null, h('p', null, 'ok'))), '<p>ok</p>');
  // changement de page (resetKey) : la garde se réinitialise
  assert.deepEqual(ErrorBoundary.getDerivedStateFromProps({ resetKey: '/b' }, { error: new Error('x'), resetKey: '/a' }), { error: null, resetKey: '/b' });
});
