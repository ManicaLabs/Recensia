// Graphiques SVG (src/ui/charts.js) : géométrie pure, formats, structure DOM (figure, SVG
// role="img", table masquée), aucune couleur ni style inline.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  barLayout, stackLayout, donutLayout, formatShare, formatValue, truncateLabel, chartSummary, toValue,
  barChart, stackedBar, donut, BAR_AREA, BAR_ROW_HEIGHT, LABEL_MAX, DEFAULT_HEADERS,
} from '../src/ui/charts.js';
import { installFakeDocument } from './helpers/fake-dom.js';
import { readSource } from './helpers/source-scan.js';

// Les espaces produites par Intl (insécables, fines ou non) dépendent de la version d'ICU.
const pct = (n) => new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 }).format(n);
const num = (n) => new Intl.NumberFormat('fr-FR').format(n);

function walk(node, out = []) {
  if (!node || node.nodeType !== 1) return out;
  out.push(node);
  for (const child of node.childNodes) walk(child, out);
  return out;
}

const tagOf = (node) => String(node.localName ?? node.tagName).toLowerCase();
const byTag = (root, tag) => walk(root).filter((n) => tagOf(n) === tag);
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const hasClass = (node, cls) => classes(node).includes(cls);

describe('valeurs et formats', () => {
  test('toValue : nombres positifs seulement', () => {
    assert.equal(toValue(3), 3);
    assert.equal(toValue('4'), 4);
    assert.equal(toValue(-2), 0);
    assert.equal(toValue(NaN), 0);
    assert.equal(toValue(null), 0);
    assert.equal(toValue('abc'), 0);
    assert.equal(toValue(Infinity), 0);
  });

  test('formatValue et formatShare (espaces insécables du français)', () => {
    assert.equal(formatValue(1500), num(1500));
    assert.match(formatValue(1500), /^1\s500$/u);
    assert.equal(formatShare(0.3), pct(0.3));
    assert.equal(formatShare(0), pct(0));
    assert.equal(formatShare(1), pct(1));
    assert.equal(formatShare(0.004), `< ${pct(0.01)}`);
    assert.equal(formatShare(2), pct(1));
    assert.equal(formatShare(NaN), pct(0));
  });

  test('truncateLabel : coupe proprement au-delà de la limite', () => {
    assert.equal(truncateLabel('  Court  '), 'Court');
    const long = 'a'.repeat(LABEL_MAX + 10);
    const cut = truncateLabel(long);
    assert.equal(Array.from(cut).length, LABEL_MAX);
    assert.ok(cut.endsWith('…'));
    assert.equal(truncateLabel('Réponse très longue', 8), 'Réponse…');
  });

  test('chartSummary : titre et valeurs affichées (masquage compris)', () => {
    const text = chartSummary('Outils', [{ label: 'ChatGPT', display: '7' }, { label: 'Claude', display: '< 5' }]);
    assert.equal(text, 'Outils\u00a0: ChatGPT, 7\u00a0; Claude, < 5');
    assert.equal(chartSummary('Vide', []), 'Vide');
    assert.equal(chartSummary('', [{ label: 'A', display: '1', shareText: '50 %' }], { withShare: true }), 'A, 1 (50 %)');
  });
});

describe('barLayout', () => {
  test('longueurs proportionnelles à la plus grande valeur, dans la zone utile', () => {
    const { rows, max, height } = barLayout([{ label: 'A', value: 10 }, { label: 'B', value: 5 }, { label: 'C', value: 0 }]);
    assert.equal(max, 10);
    assert.equal(height, 3 * BAR_ROW_HEIGHT);
    assert.deepEqual(rows.map((r) => r.ratio), [1, 0.5, 0]);
    assert.equal(rows[0].width, `${BAR_AREA}%`);
    assert.equal(rows[1].width, `${BAR_AREA / 2}%`);
    assert.equal(rows[2].width, '0%');
    assert.ok(rows[1].barY > rows[0].barY);
    assert.equal(rows[1].barY - rows[0].barY, BAR_ROW_HEIGHT);
    assert.ok(rows.every((r) => r.labelY < r.barY && r.valueY > r.barY));
  });

  test('max imposé, valeurs au-delà plafonnées', () => {
    const { rows } = barLayout([{ label: 'A', value: 3 }, { label: 'B', value: 12 }], { max: 6 });
    assert.equal(rows[0].ratio, 0.5);
    assert.equal(rows[1].ratio, 1);
  });

  test('display, className et masked conservés ; valeur affichée par défaut formatée', () => {
    const { rows } = barLayout([
      { label: 'Masqué', value: 5, display: '< 5', masked: true, className: 'bar-data-2' },
      { label: 'Grand', value: 1234 },
    ]);
    assert.equal(rows[0].display, '< 5');
    assert.equal(rows[0].masked, true);
    assert.equal(rows[0].className, 'bar-data-2');
    assert.equal(rows[1].display, num(1234));
    assert.equal(rows[1].masked, false);
  });

  test('liste vide ou valeurs nulles : aucune division par zéro', () => {
    assert.deepEqual(barLayout([]).rows, []);
    assert.equal(barLayout([]).height, BAR_ROW_HEIGHT);
    const { rows } = barLayout([{ label: 'A', value: 0 }, { label: 'B' }]);
    assert.deepEqual(rows.map((r) => r.ratio), [0, 0]);
    assert.deepEqual(barLayout(null).rows, []);
    assert.equal(barLayout([null, 'x', { label: 'ok', value: 1 }]).rows.length, 1);
  });

  test('largeurs écrites avec deux décimales au plus', () => {
    const { rows } = barLayout([{ label: 'A', value: 3 }, { label: 'B', value: 1 }]);
    assert.match(rows[1].width, /^\d+(\.\d{1,2})?%$/);
    assert.equal(rows[1].width, '28.67%');
  });
});

describe('stackLayout et donutLayout', () => {
  const items = [
    { label: 'À faire', value: 2, className: 'bar-status-todo' },
    { label: 'En cours', value: 0, className: 'bar-status-in_progress' },
    { label: 'Fait', value: 6, className: 'bar-status-done' },
  ];

  test('parts, cumul des segments, valeurs nulles hors segments', () => {
    const { total, items: all, segments } = stackLayout(items);
    assert.equal(total, 8);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((i) => i.share), [0.25, 0, 0.75]);
    assert.equal(all[0].shareText, pct(0.25));
    assert.equal(segments.length, 2);
    assert.equal(segments[0].start, '0%');
    assert.equal(segments[0].width, '25%');
    assert.equal(segments[1].start, '25%');
    assert.equal(segments[1].width, '75%');
    assert.equal(segments.reduce((s, x) => s + x.widthValue, 0), 100);
  });

  test('total nul : aucun segment', () => {
    const { total, segments, items: all } = stackLayout([{ label: 'A', value: 0 }]);
    assert.equal(total, 0);
    assert.deepEqual(segments, []);
    assert.equal(all[0].share, 0);
  });

  test('anneau : longueurs normalisées sur 100, espace entre segments, départ cumulatif', () => {
    const { segments } = donutLayout(items, { gap: 1 });
    assert.equal(segments.length, 2);
    assert.equal(segments[0].dash, 24);
    assert.equal(segments[0].gap, 76);
    assert.equal(segments[0].offset, 0);
    assert.equal(segments[1].dash, 74);
    assert.equal(segments[1].offset, -25);
    assert.ok(segments.every((s) => Math.abs(s.dash + s.gap - 100) < 1e-9));
  });

  test('anneau à un seul segment : cercle complet, sans espace', () => {
    const { segments } = donutLayout([{ label: 'Tout', value: 3 }, { label: 'Rien', value: 0 }]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].dash, 100);
    assert.equal(segments[0].gap, 0);
  });
});

describe('construction DOM', () => {
  let env;
  before(() => { env = installFakeDocument(); });
  after(() => env.restore());

  function assertNoStyle(root) {
    for (const node of walk(root)) {
      assert.equal(node.getAttribute('style'), null, `style inline sur <${tagOf(node)}>`);
      assert.notEqual(tagOf(node), 'style');
    }
  }

  test('barChart : figure, SVG role="img" étiqueté, table masquée avec les mêmes données', () => {
    const fig = barChart([
      { label: 'Haut risque', value: 2, className: 'bar-aia-high' },
      { label: 'Service A', value: 5, display: '< 5', masked: true },
      { label: 'Aucun', value: 0 },
    ], { title: 'Usages par niveau', className: 'bar-primary' });
    assert.equal(tagOf(fig), 'figure');
    assert.ok(hasClass(fig, 'chart') && hasClass(fig, 'bar-primary'));
    const [figcaption] = byTag(fig, 'figcaption');
    assert.equal(figcaption.textContent, 'Usages par niveau');
    const [svgEl] = byTag(fig, 'svg');
    assert.equal(svgEl.getAttribute('role'), 'img');
    assert.match(svgEl.getAttribute('aria-label'), /^Usages par niveau\u00a0: Haut risque, 2\u00a0; Service A, < 5\u00a0; Aucun, 0$/);
    assert.equal(svgEl.getAttribute('width'), '100%');
    assert.equal(svgEl.getAttribute('height'), String(3 * BAR_ROW_HEIGHT));
    const bars = byTag(svgEl, 'rect').filter((r) => hasClass(r, 'chart-bar'));
    assert.equal(bars.length, 2, 'pas de barre pour une valeur nulle');
    assert.ok(hasClass(bars[1], 'chart-bar-masked'));
    const rows = byTag(svgEl, 'g');
    assert.ok(hasClass(rows[0], 'bar-aia-high'));
    assert.ok(hasClass(rows[1], 'is-masked'));
    const texts = byTag(svgEl, 'text').map((x) => x.textContent);
    assert.ok(texts.includes('Haut risque') && texts.includes('< 5'));
    const [table] = byTag(fig, 'table');
    assert.ok(hasClass(table, 'visually-hidden'));
    assert.ok(hasClass(table.parentNode, 'visually-hidden'), 'conteneur masqué (pas de débordement sur mobile)');
    assert.equal(byTag(table, 'caption')[0].textContent, 'Usages par niveau');
    assert.deepEqual(byTag(table, 'th').map((x) => x.textContent), [DEFAULT_HEADERS.label, DEFAULT_HEADERS.value, 'Haut risque', 'Service A', 'Aucun']);
    assert.deepEqual(byTag(table, 'td').map((x) => x.textContent), ['2', '< 5', '0']);
    assertNoStyle(fig);
  });

  test('barChart : caption false, en-têtes personnalisés, étiquette longue avec <title>', () => {
    const long = 'Un outil au nom particulièrement long pour tester la coupure des étiquettes';
    const fig = barChart([{ label: long, value: 1 }], { title: 'T', caption: false, headers: { label: 'Outil', value: 'Déclarations' } });
    assert.equal(byTag(fig, 'figcaption').length, 0);
    assert.deepEqual(byTag(fig, 'th').slice(0, 2).map((x) => x.textContent), ['Outil', 'Déclarations']);
    const label = byTag(fig, 'text').find((x) => hasClass(x, 'chart-label'));
    assert.equal(byTag(label, 'title')[0].textContent, long);
    // Étiquette coupée à la largeur du graphique (SVG imbriqué) : pas de débordement de la carte sur mobile.
    assert.equal(tagOf(label.parentNode), 'svg');
    assert.ok(hasClass(label.parentNode, 'chart-label-box'));
    assert.equal(label.parentNode.getAttribute('overflow'), 'hidden');
    assert.equal(label.parentNode.getAttribute('width'), '100%');
    assert.equal(byTag(fig, 'td')[0].textContent, '1');
    assert.equal(byTag(fig, 'th')[2].textContent, long, 'la table garde le libellé complet');
  });

  test('barChart vide : message, pas de SVG', () => {
    const fig = barChart([], { title: 'Rien', emptyText: 'Aucune donnée.' });
    assert.ok(hasClass(fig, 'is-empty'));
    assert.equal(byTag(fig, 'svg').length, 0);
    assert.equal(walk(fig).find((n) => hasClass(n, 'chart-empty')).textContent, 'Aucune donnée.');
  });

  test('stackedBar : segments, légende masquée aux lecteurs d’écran, table avec les parts', () => {
    const fig = stackedBar([
      { label: 'À faire', value: 1, className: 'bar-status-todo' },
      { label: 'Fait', value: 3, className: 'bar-status-done' },
      { label: 'Rejeté', value: 0, className: 'bar-status-rejected' },
    ], { title: 'Actions' });
    assert.ok(hasClass(fig, 'chart-stack'));
    const [svgEl] = byTag(fig, 'svg').filter((s) => s.getAttribute('role') === 'img');
    assert.ok(svgEl.getAttribute('aria-label').includes(`À faire, 1 (${pct(0.25)})`), svgEl.getAttribute('aria-label'));
    const segs = byTag(svgEl, 'rect').filter((r) => hasClass(r, 'chart-seg'));
    assert.deepEqual(segs.map((s) => [s.getAttribute('x'), s.getAttribute('width')]), [['0%', '25%'], ['25%', '75%']]);
    assert.ok(hasClass(segs[1], 'bar-status-done'));
    const clip = byTag(svgEl, 'clipPath')[0] ?? byTag(svgEl, 'clippath')[0];
    const group = byTag(svgEl, 'g')[0];
    assert.equal(group.getAttribute('clip-path'), `url(#${clip.getAttribute('id')})`);
    const legend = byTag(fig, 'ul')[0];
    assert.equal(legend.getAttribute('aria-hidden'), 'true');
    assert.equal(byTag(legend, 'li').length, 3);
    const tds = byTag(byTag(fig, 'table')[0], 'td').map((x) => x.textContent);
    assert.deepEqual(tds, ['1', pct(0.25), '3', pct(0.75), '0', pct(0)]);
    assertNoStyle(fig);
  });

  test('stackedBar : identifiants de découpe uniques', () => {
    const ids = [stackedBar([{ label: 'A', value: 1 }]), stackedBar([{ label: 'A', value: 1 }])]
      .map((fig) => (byTag(fig, 'clipPath')[0] ?? byTag(fig, 'clippath')[0]).getAttribute('id'));
    assert.notEqual(ids[0], ids[1]);
  });

  test('donut : arcs normalisés, libellé central, table', () => {
    const fig = donut([
      { label: 'Compte personnel', value: 3, className: 'bar-data-2' },
      { label: 'Autres', value: 7, className: 'bar-muted' },
    ], { title: 'Comptes', centerLabel: ['30 %', 'des usages'] });
    assert.ok(hasClass(fig, 'chart-donut'));
    const [svgEl] = byTag(fig, 'svg').filter((s) => s.getAttribute('role') === 'img');
    assert.equal(svgEl.getAttribute('viewBox'), '0 0 120 120');
    const arcs = byTag(svgEl, 'circle').filter((c) => hasClass(c, 'chart-arc'));
    assert.equal(arcs.length, 2);
    assert.ok(arcs.every((a) => a.getAttribute('pathLength') === '100'));
    assert.equal(arcs[1].getAttribute('stroke-dashoffset'), '-30');
    assert.ok(hasClass(arcs[0], 'bar-data-2'));
    const texts = byTag(svgEl, 'text').map((x) => x.textContent);
    assert.deepEqual(texts, ['30 %', 'des usages']);
    assert.equal(byTag(byTag(fig, 'table')[0], 'tr').length, 3);
    assertNoStyle(fig);
  });

  test('texte venant des données inséré comme texte (jamais interprété)', () => {
    const fig = barChart([{ label: '<img src=x onerror=alert(1)>', value: 1 }], { title: '<b>x</b>' });
    assert.equal(byTag(fig, 'img').length, 0);
    assert.equal(byTag(fig, 'b').length, 0);
    assert.equal(byTag(fig, 'figcaption')[0].textContent, '<b>x</b>');
  });
});

describe('feuille de style des graphiques', () => {
  const css = readSource('src/styles/charts.css');

  test('une couleur par niveau AI Act, par exposition et par statut d’action', () => {
    for (const level of ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']) {
      assert.match(css, new RegExp(`\\.bar-aia-${level}\\s*\\{`));
    }
    for (const n of [0, 1, 2, 3]) assert.match(css, new RegExp(`\\.bar-data-${n}\\s*\\{`));
    for (const s of ['todo', 'in_progress', 'done', 'rejected']) assert.match(css, new RegExp(`\\.bar-status-${s}\\s*\\{`));
  });

  test('thème sombre réservé à l’écran', () => {
    const darkBlocks = css.match(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/g) ?? [];
    assert.ok(darkBlocks.length > 0);
    assert.ok(darkBlocks.every((b) => /@media\s+screen\s+and/.test(b)), darkBlocks.join('\n'));
  });
});
