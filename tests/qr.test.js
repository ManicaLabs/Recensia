import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qrMatrix, qrSvgString, qrPath, chooseEcc, QrError, QR_MARGIN, QR_AUTO_MAX_VERSION,
} from '../src/share/qr.js';
import { fakeCollectLink, fakeCode } from './helpers/share-fixtures.js';
import { parseXml } from './helpers/xml-check.js';
import { hasFinder, hasTiming, readFormat, readVersion, darkCount } from './helpers/qr-check.js';

function assertValidSymbol(m, expectedEcc) {
  assert.equal(m.size, 4 * m.version + 17, 'taille = 4 × version + 17');
  assert.ok(hasFinder(m, 0, 0), 'repère haut gauche');
  assert.ok(hasFinder(m, 0, m.size - 7), 'repère haut droit');
  assert.ok(hasFinder(m, m.size - 7, 0), 'repère bas gauche');
  assert.ok(hasTiming(m), 'motifs de synchronisation');
  assert.equal(m.isDark(m.size - 8, 8), true, 'module sombre fixe');
  assert.equal(readFormat(m).ecc, expectedEcc, 'niveau de correction encodé');
  if (m.version >= 7) assert.equal(readVersion(m), m.version, 'information de version');
}

test('un lien de collecte de 1 500 caractères tient et reste lisible (auto → L, version 28)', () => {
  const link = fakeCollectLink(1500);
  assert.equal(link.length, 1500);
  const m = qrMatrix(link, 'auto');
  assert.equal(m.ecc, 'L');
  assert.equal(m.version, 28);
  assert.ok(m.version <= 30, 'version assez basse pour une lecture sur A4 ou écran');
  assertValidSymbol(m, 'L');
});

test('le niveau M du contrat tient aussi (version 32), à titre de comparaison', () => {
  const m = qrMatrix(fakeCollectLink(1500));
  assert.equal(m.ecc, 'M');
  assert.equal(m.version, 32);
  assertValidSymbol(m, 'M');
});

test('niveau auto : le plus robuste possible sans dépasser la version plafond', () => {
  const code = fakeCode(650);
  const m = qrMatrix(code, 'auto');
  assert.equal(m.ecc, 'Q');
  assert.ok(m.version <= QR_AUTO_MAX_VERSION);
  assertValidSymbol(m, 'Q');
  assert.equal(chooseEcc('https://exemple.fr/'), 'Q');
  const mid = fakeCollectLink(1000);
  const autoMid = qrMatrix(mid, 'auto');
  assert.ok(autoMid.version <= QR_AUTO_MAX_VERSION || autoMid.ecc === 'L');
  assertValidSymbol(autoMid, autoMid.ecc);
});

test('les quatre niveaux explicites produisent un symbole valide', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) assertValidSymbol(qrMatrix('https://manicalabs.github.io/Recensia/#/c/abc', ecc), ecc);
});

test('texte UTF-8 encodé en octets (accents, symboles)', () => {
  const m = qrMatrix('Recensement « IA » — café ✓', 'M');
  assertValidSymbol(m, 'M');
});

test('erreurs : texte vide, niveau inconnu, texte trop long', () => {
  assert.throws(() => qrMatrix(''), (e) => e instanceof QrError && e.code === 'empty');
  assert.throws(() => qrMatrix('abc', 'X'), (e) => e instanceof QrError && e.code === 'invalid_ecc');
  assert.throws(() => qrMatrix('a'.repeat(3000), 'auto'), (e) => e instanceof QrError && e.code === 'too_long');
  assert.throws(() => qrMatrix('a'.repeat(2400), 'M'), (e) => e instanceof QrError && e.code === 'too_long');
});

test('isDark renvoie false hors de la matrice (marge claire)', () => {
  const m = qrMatrix('abc');
  assert.equal(m.isDark(-1, 0), false);
  assert.equal(m.isDark(0, m.size), false);
});

test('SVG autonome bien formé : viewBox, marge de 4 modules, fond blanc, un seul <path>, sans style', () => {
  const link = fakeCollectLink(1500);
  const svg = qrSvgString(link, { title: 'QR « Recensement » <test> & "guillemets"' });
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  const { root, elements } = parseXml(svg);
  assert.equal(root, 'svg');
  const m = qrMatrix(link, 'auto');
  const n = m.size + 2 * QR_MARGIN;
  const rootEl = elements[0];
  assert.equal(rootEl.attrs.xmlns, 'http://www.w3.org/2000/svg');
  assert.equal(rootEl.attrs.viewBox, `0 0 ${n} ${n}`);
  assert.equal(elements.filter((e) => e.name === 'path').length, 1);
  const rect = elements.find((e) => e.name === 'rect');
  assert.deepEqual(rect.attrs, { width: String(n), height: String(n), fill: '#ffffff' });
  const path = elements.find((e) => e.name === 'path');
  assert.equal(path.attrs.fill, '#000000');
  assert.ok(!/style/i.test(svg), 'aucun attribut ni élément style');
  assert.ok(!/<script/i.test(svg));
  assert.ok(svg.includes('&lt;test&gt; &amp; &quot;guillemets&quot;'));
  for (const el of elements) {
    for (const key of Object.keys(el.attrs)) assert.ok(!/^on/i.test(key), `attribut ${key}`);
  }
});

test('le tracé couvre exactement les modules sombres, décalés de la marge', () => {
  const m = qrMatrix('https://manicalabs.github.io/Recensia/#/c/xyz', 'Q');
  const d = qrPath(m, QR_MARGIN);
  let covered = 0;
  for (const [, x, y, len] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const col = Number(x) - QR_MARGIN;
    const row = Number(y) - QR_MARGIN;
    for (let k = 0; k < Number(len); k += 1) assert.equal(m.isDark(row, col + k), true);
    covered += Number(len);
  }
  assert.equal(covered, darkCount(m));
  assert.equal(d.replace(/M\d+ \d+h(\d+)v1h-\1z/g, ''), '', 'tracé composé uniquement de séries horizontales');
});

test('titre du SVG : caractères interdits en XML 1.0 retirés, fichier toujours bien formé', () => {
  const svg = qrSvgString('https://exemple.fr/', { title: 'Titre\u0007\u0000 \uD800 \u202Eok & <b>' });
  const { elements } = parseXml(svg);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\u202E]/.test(svg));
  assert.equal(elements[0].attrs['aria-label'], 'Titre ok &amp; &lt;b&gt;');
});

test('options SVG : couleurs non valides ignorées, marge minimale imposée', () => {
  const svg = qrSvgString('abc', { dark: 'red" onload="x', light: 'url(#a)', margin: 1, size: 256 });
  const { elements } = parseXml(svg);
  assert.equal(elements.find((e) => e.name === 'path').attrs.fill, '#000000');
  assert.equal(elements.find((e) => e.name === 'rect').attrs.fill, '#ffffff');
  const n = qrMatrix('abc', 'auto').size + 2 * QR_MARGIN;
  assert.equal(elements[0].attrs.viewBox, `0 0 ${n} ${n}`);
  assert.equal(elements[0].attrs.width, '256');
});
