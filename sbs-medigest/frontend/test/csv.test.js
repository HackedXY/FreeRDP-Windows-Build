import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvSafe, toCSV } from '../src/format.js';

test('CSV : les cellules commençant par = + - @ sont neutralisées', () => {
  for (const v of ['=1+1', '+33 6', '-2+3', '@SUM(A1)', '=HYPERLINK("http://x","clic")', '\t=1', '\r=1', '  =1+1', ' @cmd']) {
    assert.equal(csvSafe(v), `'${v}`, JSON.stringify(v));
  }
});

test('CSV : les valeurs ordinaires et les nombres restent inchangés', () => {
  assert.equal(csvSafe('Paracétamol 500 mg'), 'Paracétamol 500 mg');
  assert.equal(csvSafe('P-000012'), 'P-000012');
  assert.equal(csvSafe(-5000), '-5000', 'un nombre (type number) reste un nombre');
  assert.equal(csvSafe(0), '0');
  assert.equal(csvSafe(null), '');
  assert.equal(csvSafe(undefined), '');
});

test('CSV : toCSV applique la neutralisation à l\'en-tête et aux cellules, guillemets échappés', () => {
  const csv = toCSV(
    [{ name: '=cmd|\' /C calc\'!A0', note: 'dit "bonjour"', amount: -1500 }, { name: '@evil', note: '+1', amount: 10 }],
    [{ label: 'Nom', value: 'name' }, { label: 'Note', value: 'note' }, { label: '=Montant', value: (r) => r.amount }],
  );
  const lines = csv.replace(/^﻿/, '').split('\n');
  assert.equal(lines[0], '"Nom";"Note";"\'=Montant"');
  assert.equal(lines[1], '"\'=cmd|\' /C calc\'!A0";"dit ""bonjour""";"-1500"');
  assert.equal(lines[2], '"\'@evil";"\'+1";"10"');
});
