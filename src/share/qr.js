// QR codes (vendor/qrcode.mjs, qrcode-generator 2.0.4).
// qrMatrix et qrSvgString sont purs (Node et navigateur) ; qrSvgElement et
// qrPngBlob n'accèdent au DOM qu'à l'appel.
//
// Niveau de correction « auto » : le plus élevé parmi Q, M, L qui garde le symbole
// en version ≤ QR_AUTO_MAX_VERSION (117 modules), sinon L. Un lien de collecte de
// 1 500 caractères donne ainsi une version 28 en L (129 modules) au lieu de 32 en M :
// des modules plus gros, donc plus faciles à lire sur une fiche A4 ou un écran.

import qrcode from '../../vendor/qrcode.mjs';
import { sanitizeText } from './channels.js';

export const QR_MARGIN = 4;
export const QR_LEVELS = Object.freeze(['L', 'M', 'Q', 'H']);
export const QR_AUTO_LEVELS = Object.freeze(['Q', 'M']);
export const QR_AUTO_MAX_VERSION = 25;

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CACHE_MAX = 8;
const TITLE_MAX = 300;
const cache = new Map();

export class QrError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code} : ${detail}` : code);
    this.name = 'QrError';
    this.code = code;
  }
}

// La bibliothèque encode en mode octet un caractère par octet : on lui passe
// l'UTF-8 sous forme de chaîne « binaire ».
function utf8Binary(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  return out;
}

function build(text, ecc) {
  const key = `${ecc}\u0000${text}`;
  if (cache.has(key)) return cache.get(key);
  const qr = qrcode(0, ecc);
  qr.addData(utf8Binary(text), 'Byte');
  try {
    qr.make();
  } catch {
    throw new QrError('too_long', `${text.length} caractères`);
  }
  const size = qr.getModuleCount();
  const matrix = Object.freeze({
    size,
    version: (size - 17) / 4,
    ecc,
    isDark: (row, col) => row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col) === true,
  });
  cache.set(key, matrix);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return matrix;
}

/** Niveau de correction retenu pour un texte en mode « auto ». */
export function chooseEcc(text) {
  return qrMatrix(text, 'auto').ecc;
}

/**
 * Matrice QR : { size, version, ecc, isDark(row, col) } (hors marge ; isDark
 * renvoie false en dehors). ecc : 'L' | 'M' | 'Q' | 'H' | 'auto'.
 */
export function qrMatrix(text, ecc = 'M') {
  if (typeof text !== 'string' || text.length === 0) throw new QrError('empty');
  if (ecc === 'auto') {
    const low = build(text, 'L');
    if (low.version > QR_AUTO_MAX_VERSION) return low;
    for (const level of QR_AUTO_LEVELS) {
      const m = build(text, level);
      if (m.version <= QR_AUTO_MAX_VERSION) return m;
    }
    return low;
  }
  if (!QR_LEVELS.includes(ecc)) throw new QrError('invalid_ecc', String(ecc));
  return build(text, ecc);
}

/** Tracé SVG des modules sombres (une sous-trajectoire par série horizontale). */
export function qrPath(matrix, margin = QR_MARGIN) {
  const parts = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) { col += 1; continue; }
      const start = col;
      while (col < matrix.size && matrix.isDark(row, col)) col += 1;
      parts.push(`M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`);
    }
  }
  return parts.join('');
}

function options(opts = {}) {
  const margin = Number.isInteger(opts.margin) && opts.margin > QR_MARGIN ? Math.min(opts.margin, 32) : QR_MARGIN;
  return {
    ecc: opts.ecc ?? 'auto',
    margin,
    dark: COLOR_RE.test(opts.dark ?? '') ? opts.dark : '#000000',
    light: COLOR_RE.test(opts.light ?? '') ? opts.light : '#ffffff',
    // Titre nettoyé : un caractère de contrôle rendrait le fichier SVG mal formé (XML 1.0).
    title: typeof opts.title === 'string' ? sanitizeText(opts.title, TITLE_MAX) : '',
  };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * SVG autonome (fichier téléchargeable) : viewBox, marge de 4 modules, fond blanc,
 * un seul <path>, couleurs en attributs fill (aucun style).
 * opts : { ecc = 'auto', margin, size (px), title, dark, light }
 */
export function qrSvgString(text, opts = {}) {
  const o = options(opts);
  const m = qrMatrix(text, o.ecc);
  const n = m.size + 2 * o.margin;
  const px = Number.isInteger(opts.size) && opts.size > 0 ? opts.size : n * 8;
  const label = o.title ? ` role="img" aria-label="${escapeXml(o.title)}"` : '';
  const title = o.title ? `<title>${escapeXml(o.title)}</title>` : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<svg xmlns="${SVG_NS}" version="1.1" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges"${label}>`
    + `${title}<rect width="${n}" height="${n}" fill="${o.light}"/>`
    + `<path d="${qrPath(m, o.margin)}" fill="${o.dark}"/></svg>\n`;
}

/**
 * Élément SVG (navigateur), construit par document.createElementNS.
 * opts : { ecc, margin, size (px, sinon dimensionné par CSS), title, className, dark, light }
 */
export function qrSvgElement(text, opts = {}) {
  const o = options(opts);
  const m = qrMatrix(text, o.ecc);
  const n = m.size + 2 * o.margin;
  const doc = globalThis.document;
  const el = (tag, attrs) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  const root = el('svg', { viewBox: `0 0 ${n} ${n}`, 'shape-rendering': 'crispEdges', class: opts.className || 'qr' });
  if (Number.isInteger(opts.size) && opts.size > 0) {
    root.setAttribute('width', String(opts.size));
    root.setAttribute('height', String(opts.size));
  }
  if (o.title) {
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', o.title);
    const title = el('title', {});
    title.textContent = o.title;
    root.append(title);
  } else {
    root.setAttribute('aria-hidden', 'true');
  }
  root.append(el('rect', { width: n, height: n, fill: o.light }), el('path', { d: qrPath(m, o.margin), fill: o.dark }));
  return root;
}

/**
 * PNG (navigateur) : modules de taille entière (rendu net), centrés dans une image
 * de `size` pixels de côté (au moins un pixel par module).
 * opts : { size = 1024, ecc, margin, dark, light }
 */
export async function qrPngBlob(text, opts = {}) {
  const o = options(opts);
  const m = qrMatrix(text, o.ecc);
  const n = m.size + 2 * o.margin;
  const wanted = Number.isInteger(opts.size) ? Math.min(Math.max(opts.size, 64), 8192) : 1024;
  const scale = Math.max(1, Math.floor(wanted / n));
  const dim = Math.max(wanted, n * scale);
  const offset = Math.floor((dim - n * scale) / 2) + o.margin * scale;
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(dim, dim)
    : Object.assign(globalThis.document.createElement('canvas'), { width: dim, height: dim });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new QrError('canvas');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = o.light;
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = o.dark;
  for (let row = 0; row < m.size; row += 1) {
    let col = 0;
    while (col < m.size) {
      if (!m.isDark(row, col)) { col += 1; continue; }
      const start = col;
      while (col < m.size && m.isDark(row, col)) col += 1;
      ctx.fillRect(offset + start * scale, offset + row * scale, (col - start) * scale, scale);
    }
  }
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new QrError('png'))), 'image/png');
  });
}
