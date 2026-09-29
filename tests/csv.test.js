import test from 'node:test';
import assert from 'node:assert/strict';

import { neutralize, toCSV } from '../src/export/csv.js';

// Analyseur minimal (séparateur ';', guillemets doublés) pour relire la sortie de toCSV.
function parseCSV(text) {
  assert.ok(text.startsWith('\uFEFF'), 'BOM attendu');
  const src = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') { row.push(cell); cell = ''; } else if (ch === '\r' && src[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += ch;
  }
  assert.equal(cell, '', 'la sortie se termine par CRLF');
  assert.equal(row.length, 0);
  return rows;
}

test('neutralize : chaque préfixe dangereux reçoit une apostrophe', () => {
  for (const s of ['=1+1', '+33 6 00', '-2+3+cmd|\' /C calc\'!A0', '@SUM(A1:A2)', '\tcode', '\rcode', '=HYPERLINK("http://x")']) {
    assert.equal(neutralize(s), `'${s}`, JSON.stringify(s));
  }
});

test('neutralize : espaces initiaux suivis d’un caractère dangereux ⇒ préfixe aussi', () => {
  for (const s of ['  =1+1', ' +1', '\u00a0-1', '\u2003@A1', '\n=1+1', ' \t=1', '\u3000=1']) {
    assert.equal(neutralize(s), `'${s}`, JSON.stringify(s));
  }
});

test('neutralize : textes ordinaires inchangés', () => {
  for (const s of ['', 'ChatGPT', 'a=b', 'Rédaction ; résumé', ' texte', "l'apostrophe", '1 + 1', 'R-AIA-HI-EMP', '02/12/2027 — Haut risque', '< 5 déclarations']) {
    assert.equal(neutralize(s), s, JSON.stringify(s));
  }
});

test('neutralize : nombres et booléens intacts, null ⇒ vide, tableaux joints', () => {
  assert.equal(neutralize(42), 42);
  assert.equal(neutralize(-3), -3);
  assert.equal(neutralize(0), 0);
  assert.equal(neutralize(3.14), 3.14);
  assert.equal(neutralize(true), true);
  assert.equal(neutralize(null), '');
  assert.equal(neutralize(undefined), '');
  assert.equal(neutralize('-3'), "'-3", 'un texte numérique négatif reste un texte neutralisé');
  assert.equal(neutralize(['=a', 'b']), "'=a, b");
  assert.equal(neutralize(['a', null, 'b']), 'a, , b');
});

const COLUMNS = [{ key: 'id', label: 'ID' }, { key: 'text', label: 'Texte' }, { key: 'n', label: 'Nombre' }];

test('toCSV : BOM UTF-8, séparateur point-virgule, CRLF', () => {
  const csv = toCSV([{ id: 'U-1', text: 'Rédaction', n: 3 }], COLUMNS);
  assert.equal(csv, '\uFEFFID;Texte;Nombre\r\nU-1;Rédaction;3\r\n');
  const bytes = new TextEncoder().encode(csv);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM encodé en UTF-8');
});

test('toCSV : guillemets doublés, points-virgules et retours ligne protégés', () => {
  const rows = [
    { id: 'a', text: 'Il a dit "bonjour"', n: 1 },
    { id: 'b', text: 'Rédaction ; résumé', n: 2 },
    { id: 'c', text: 'ligne 1\nligne 2', n: 3 },
    { id: 'd', text: 'CR\r\nLF', n: 4 },
    { id: 'e', text: ' espace initial', n: -5 },
  ];
  const csv = toCSV(rows, COLUMNS);
  assert.ok(csv.includes('"Il a dit ""bonjour"""'));
  assert.ok(csv.includes('"Rédaction ; résumé"'));
  assert.ok(csv.includes('"ligne 1\nligne 2"'));
  assert.ok(csv.includes(';-5\r\n'), 'nombre négatif ni préfixé ni entouré de guillemets');
  const parsed = parseCSV(csv);
  assert.deepEqual(parsed[0], ['ID', 'Texte', 'Nombre']);
  assert.deepEqual(parsed.slice(1).map((r) => r[1]), rows.map((r) => r.text));
  assert.deepEqual(parsed.slice(1).map((r) => Number(r[2])), [1, 2, 3, 4, -5]);
});

test('toCSV : toutes les cellules neutralisées, en-tête compris', () => {
  const cols = [{ key: 'a', label: '=en-tête' }, { key: 'b', label: 'B' }];
  const csv = toCSV([{ a: '=1+1', b: '@A1;x' }, { a: '  -2', b: '\tcmd' }, { a: null, b: undefined }], cols);
  const parsed = parseCSV(csv);
  assert.deepEqual(parsed, [
    ["'=en-tête", 'B'],
    ["'=1+1", "'@A1;x"],
    ["'  -2", "'\tcmd"],
    ['', ''],
  ]);
  for (const row of parsed) {
    for (const c of row) assert.ok(!/^\s*[=+\-@]/.test(c) && !/^[\t\r]/.test(c), `cellule non neutralisée : ${JSON.stringify(c)}`);
  }
});

test('toCSV : aucune ligne ⇒ en-tête seul ; colonnes absentes ⇒ vide', () => {
  assert.equal(toCSV([], COLUMNS), '\uFEFFID;Texte;Nombre\r\n');
  assert.equal(toCSV([{}], COLUMNS), '\uFEFFID;Texte;Nombre\r\n;;\r\n');
});
