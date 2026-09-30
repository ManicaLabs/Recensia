// Graphiques en SVG natif (CDC §8.1) : barres horizontales, barre empilée 100 %, anneau.
// Aucune bibliothèque, aucun style inline : les couleurs viennent des classes de
// src/styles/charts.css (bar-aia-<niveau>, bar-data-<0..3>, bar-status-<statut>…), chargée ici.
// Chaque graphique renvoie une <figure class="chart"> : SVG (role="img" + aria-label) et
// <table class="visually-hidden"> reprenant les mêmes données. Les étiquettes et les valeurs
// sont toujours écrites en texte : la couleur n'est qu'un renfort.
// Les fonctions de géométrie (barLayout, stackLayout, donutLayout…) sont pures et testées sous Node.

import { h, svg, loadCss } from './dom.js';
import { LOCALE } from '../i18n.js';

const CSS_HREF = 'src/styles/charts.css';

/** En-têtes par défaut de la table de données (remplaçables par opts.headers). */
export const DEFAULT_HEADERS = Object.freeze({ label: 'Catégorie', value: 'Valeur', share: 'Part' });

/** Part de la largeur (en %) réservée aux barres ; le reste accueille la valeur écrite après la barre. */
export const BAR_AREA = 86;

/** Géométrie verticale d'une ligne de barres (px) : étiquette au-dessus, barre dessous. */
export const BAR_ROW = Object.freeze({ label: 18, gap: 5, bar: 14, after: 13 });
export const BAR_ROW_HEIGHT = BAR_ROW.label + BAR_ROW.gap + BAR_ROW.bar + BAR_ROW.after;
export const LABEL_MAX = 48;
export const STACK_HEIGHT = 28;
export const DONUT = Object.freeze({ size: 120, radius: 46, stroke: 18, gap: 0.6 });

const numberFormat = new Intl.NumberFormat(LOCALE);
const percentFormat = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 });
const smallPercent = `< ${percentFormat.format(0.01)}`;

let idCounter = 0;
let cssPromise = null;

function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * Charge la feuille de style des graphiques (une seule fois). Renvoie une promesse
 * (résolue immédiatement hors navigateur) : une vue peut l'attendre pour éviter un flash.
 */
export function chartStyles() {
  if (cssPromise) return cssPromise;
  if (!globalThis.document?.head || typeof globalThis.document.querySelectorAll !== 'function') return Promise.resolve(null);
  cssPromise = loadCss(CSS_HREF).catch((err) => {
    console.warn('[Recensia] Feuille de style des graphiques non chargée.', err);
    return null;
  });
  return cssPromise;
}

/** Valeur numérique positive ou nulle (0 pour toute valeur invalide). */
export function toValue(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 1500 ⇒ « 1 500 ». */
export function formatValue(value) {
  return numberFormat.format(toValue(value));
}

/** Part (0..1) ⇒ « 35 % » ; une part non nulle inférieure à 1 % s'écrit « < 1 % ». */
export function formatShare(share) {
  const s = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  if (s > 0 && s < 0.005) return smallPercent;
  return percentFormat.format(s);
}

/** Étiquette abrégée (points de suspension) au-delà de `max` caractères. */
export function truncateLabel(label, max = LABEL_MAX) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

// Pourcentage écrit pour un attribut SVG (au plus deux décimales, sans zéro inutile).
function pct(n) {
  const rounded = Math.round(n * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && typeof item === 'object').map((item) => {
    const value = toValue(item.value);
    const label = String(item.label ?? '');
    return {
      label,
      value,
      display: item.display !== undefined && item.display !== null && String(item.display) !== '' ? String(item.display) : formatValue(value),
      className: typeof item.className === 'string' && item.className.trim() !== '' ? item.className.trim() : null,
      masked: item.masked === true,
    };
  });
}

/**
 * Géométrie des barres horizontales. max : valeur correspondant à la barre la plus longue
 * (défaut : la plus grande valeur). Largeurs en % de la zone utile (BAR_AREA).
 * → { max, height, rows: [{ label, shortLabel, value, display, className, masked, ratio, width, end, labelY, barY, valueY }] }
 */
export function barLayout(items, { max, labelMax = LABEL_MAX } = {}) {
  const rows = normalizeItems(items);
  const top = Math.max(0, ...rows.map((r) => r.value));
  const scale = toValue(max) > 0 ? toValue(max) : top;
  return {
    max: scale,
    height: Math.max(rows.length * BAR_ROW_HEIGHT, BAR_ROW_HEIGHT),
    rows: rows.map((row, i) => {
      const ratio = scale > 0 ? Math.min(1, row.value / scale) : 0;
      const y = i * BAR_ROW_HEIGHT;
      return {
        ...row,
        shortLabel: truncateLabel(row.label, labelMax),
        ratio,
        width: pct(ratio * BAR_AREA),
        end: pct(ratio * BAR_AREA),
        labelY: y + BAR_ROW.label - 4,
        barY: y + BAR_ROW.label + BAR_ROW.gap,
        valueY: y + BAR_ROW.label + BAR_ROW.gap + BAR_ROW.bar - 2,
      };
    }),
  };
}

/**
 * Segments d'une barre empilée 100 %. Les valeurs nulles restent dans `items` (légende, table)
 * mais ne produisent pas de segment. start / width en % de la largeur totale.
 * → { total, items: [{ …, share, shareText }], segments: [{ …, start, width }] }
 */
export function stackLayout(items) {
  const list = normalizeItems(items);
  const total = list.reduce((sum, item) => sum + item.value, 0);
  const withShare = list.map((item) => {
    const share = total > 0 ? item.value / total : 0;
    return { ...item, share, shareText: formatShare(share) };
  });
  let cursor = 0;
  const segments = [];
  for (const item of withShare) {
    if (item.value <= 0) continue;
    const width = item.share * 100;
    segments.push({ ...item, start: pct(cursor), width: pct(width), startValue: cursor, widthValue: width });
    cursor += width;
  }
  return { total, items: withShare, segments };
}

/**
 * Segments d'un anneau (cercle de longueur normalisée pathLength = 100, départ à midi,
 * sens horaire). dash = longueur du trait, offset = stroke-dashoffset (négatif = début du segment).
 * Un léger espace sépare les segments quand il y en a plusieurs.
 * → { total, items: [{ …, share, shareText }], segments: [{ …, dash, gap, offset, start }] }
 */
export function donutLayout(items, { gap = DONUT.gap } = {}) {
  const { total, items: withShare } = stackLayout(items);
  const visible = withShare.filter((item) => item.value > 0);
  const spacing = visible.length > 1 ? gap : 0;
  let cursor = 0;
  const segments = visible.map((item) => {
    const length = item.share * 100;
    const dash = Math.max(0, length - spacing);
    const seg = {
      ...item,
      start: round(cursor),
      dash: round(dash),
      gap: round(100 - dash),
      offset: round(cursor === 0 ? 0 : -cursor),
    };
    cursor += length;
    return seg;
  });
  return { total, items: withShare, segments };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Texte de l'aria-label : « Titre : A, 3 ; B, < 5 ». */
export function chartSummary(title, rows, { withShare = false } = {}) {
  const parts = rows.map((r) => `${r.label}, ${r.display}${withShare && r.shareText ? ` (${r.shareText})` : ''}`);
  const head = String(title ?? '').trim();
  if (!parts.length) return head;
  return head ? `${head} : ${parts.join(' ; ')}` : parts.join(' ; ');
}

function headersOf(opts) {
  return { ...DEFAULT_HEADERS, ...(opts?.headers && typeof opts.headers === 'object' ? opts.headers : {}) };
}

// Table des données, masquée visuellement. Le conteneur lui aussi masqué évite qu'une table (dont
// la largeur ne descend pas sous celle de son contenu) élargisse la page sur mobile.
function dataTable(title, rows, headers, { share = false } = {}) {
  return h('div', { class: ['visually-hidden', 'chart-data'] }, h('table', { class: ['visually-hidden', 'chart-table'] },
    title ? h('caption', null, title) : null,
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, headers.label),
      h('th', { scope: 'col' }, headers.value),
      share ? h('th', { scope: 'col' }, headers.share) : null)),
    h('tbody', null, rows.map((row) => h('tr', null,
      h('th', { scope: 'row' }, row.label),
      h('td', null, row.display),
      share ? h('td', null, row.shareText) : null)))));
}

function figure(kind, { title, caption, className, empty }, ...children) {
  return h('figure', { class: ['chart', `chart-${kind}`, empty ? 'is-empty' : null, className] },
    caption !== false && title ? h('figcaption', { class: 'chart-title' }, title) : null,
    children);
}

function emptyNote(opts) {
  return typeof opts?.emptyText === 'string' && opts.emptyText !== '' ? h('p', { class: 'chart-empty' }, opts.emptyText) : null;
}

function swatch(className) {
  return svg('svg', { class: ['chart-swatch-svg', className], width: '12', height: '12', viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { class: 'chart-swatch', x: '0', y: '0', width: '12', height: '12', rx: '2' }));
}

function legend(rows) {
  // Légende visuelle : la table masquée porte déjà les mêmes données pour les lecteurs d'écran.
  return h('ul', { class: 'chart-legend', role: 'list', 'aria-hidden': 'true' }, rows.map((row) => h('li', { class: ['chart-legend-item', row.value <= 0 ? 'is-zero' : null] },
    swatch(row.className),
    h('span', { class: 'chart-legend-label' }, row.label),
    h('span', { class: 'chart-legend-value' }, row.display, row.shareText ? h('span', { class: 'chart-legend-share' }, ` · ${row.shareText}`) : null))));
}

/**
 * Barres horizontales.
 * items : [{ label, value, display?, className?, masked? }] ; display remplace la valeur écrite
 * (ex. « < 5 » en mode anonyme) ; masked : barre en pointillés (effectif masqué, longueur = borne).
 * opts : { title, max, className, caption = true, headers, emptyText, labelMax }
 */
export function barChart(items, opts = {}) {
  chartStyles();
  const { title = '', max, className, caption = true } = opts;
  const layout = barLayout(items, { max, labelMax: opts.labelMax });
  const headers = headersOf(opts);
  const empty = layout.rows.length === 0;
  const svgEl = svg('svg', {
    class: 'chart-svg chart-bars-svg',
    width: '100%',
    height: String(layout.height),
    role: 'img',
    'aria-label': chartSummary(title, layout.rows),
    focusable: 'false',
  }, layout.rows.map((row) => svg('g', { class: ['chart-row', row.className, row.masked ? 'is-masked' : null] },
    // Étiquette dans un SVG imbriqué qui la coupe à la largeur du graphique : sur un écran étroit,
    // un libellé long ne déborde pas de la carte (libellé complet dans <title> et dans la table).
    svg('svg', {
      class: 'chart-label-box',
      x: '0',
      y: String(row.labelY - (BAR_ROW.label - 4)),
      width: '100%',
      height: String(BAR_ROW.label + 1),
      overflow: 'hidden',
    }, svg('text', { class: 'chart-label', x: '0', y: String(BAR_ROW.label - 4) },
      row.shortLabel,
      row.shortLabel !== row.label ? svg('title', null, row.label) : null)),
    svg('rect', { class: 'chart-track', x: '0', y: String(row.barY), width: pct(BAR_AREA), height: String(BAR_ROW.bar), rx: '3' }),
    row.ratio > 0
      ? svg('rect', { class: ['chart-bar', row.masked ? 'chart-bar-masked' : null], x: '0', y: String(row.barY), width: row.width, height: String(BAR_ROW.bar), rx: '3' })
      : null,
    svg('text', { class: 'chart-value', x: row.end, dx: row.ratio > 0 ? '6' : '2', y: String(row.valueY) }, row.display))));
  return figure('bars', { title, caption, className, empty },
    empty ? emptyNote(opts) : svgEl,
    dataTable(title, layout.rows, headers));
}

/**
 * Barre empilée 100 % avec légende.
 * items : [{ label, value, display?, className }] ; opts : { title, className, caption = true, headers, emptyText }
 */
export function stackedBar(items, opts = {}) {
  chartStyles();
  const { title = '', className, caption = true } = opts;
  const layout = stackLayout(items);
  const headers = headersOf(opts);
  const clipId = nextId('chart-clip');
  const empty = layout.total <= 0;
  const svgEl = svg('svg', {
    class: 'chart-svg chart-stack-svg',
    width: '100%',
    height: String(STACK_HEIGHT),
    role: 'img',
    'aria-label': chartSummary(title, layout.items, { withShare: true }),
    focusable: 'false',
  },
  svg('defs', null, svg('clipPath', { id: clipId }, svg('rect', { x: '0', y: '0', width: '100%', height: String(STACK_HEIGHT), rx: '6' }))),
  svg('g', { 'clip-path': `url(#${clipId})` },
    svg('rect', { class: 'chart-track', x: '0', y: '0', width: '100%', height: String(STACK_HEIGHT) }),
    layout.segments.map((seg) => svg('rect', { class: ['chart-seg', seg.className], x: seg.start, y: '0', width: seg.width, height: String(STACK_HEIGHT) }))));
  const note = empty ? emptyNote(opts) : null;
  return figure('stack', { title, caption, className, empty },
    note ?? svgEl,
    legend(layout.items),
    dataTable(title, layout.items, headers, { share: true }));
}

/**
 * Anneau avec libellé central et légende.
 * items : [{ label, value, display?, className }] ;
 * opts : { title, centerLabel (texte, ou [principal, secondaire]), className, caption = true, headers, emptyText }
 */
export function donut(items, opts = {}) {
  chartStyles();
  const { title = '', className, caption = true } = opts;
  const layout = donutLayout(items);
  const headers = headersOf(opts);
  const c = DONUT.size / 2;
  const [main, sub] = Array.isArray(opts.centerLabel) ? opts.centerLabel : [opts.centerLabel, null];
  const svgEl = svg('svg', {
    class: 'chart-svg chart-donut-svg',
    viewBox: `0 0 ${DONUT.size} ${DONUT.size}`,
    width: String(DONUT.size),
    height: String(DONUT.size),
    role: 'img',
    'aria-label': chartSummary(title, layout.items, { withShare: true }),
    focusable: 'false',
  },
  svg('circle', { class: 'chart-donut-track', cx: String(c), cy: String(c), r: String(DONUT.radius), fill: 'none', 'stroke-width': String(DONUT.stroke) }),
  svg('g', { transform: `rotate(-90 ${c} ${c})` }, layout.segments.map((seg) => svg('circle', {
    class: ['chart-arc', seg.className],
    cx: String(c),
    cy: String(c),
    r: String(DONUT.radius),
    fill: 'none',
    'stroke-width': String(DONUT.stroke),
    pathLength: '100',
    'stroke-dasharray': `${seg.dash} ${seg.gap}`,
    'stroke-dashoffset': String(seg.offset),
  }))),
  main !== undefined && main !== null && String(main) !== ''
    ? svg('text', { class: 'chart-center', x: String(c), y: String(sub ? c - 4 : c), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(main))
    : null,
  sub ? svg('text', { class: 'chart-center-sub', x: String(c), y: String(c + 16), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(sub)) : null);
  return figure('donut', { title, caption, className, empty: layout.total <= 0 },
    h('div', { class: 'chart-donut-body' }, svgEl, legend(layout.items)),
    dataTable(title, layout.items, headers, { share: true }));
}
