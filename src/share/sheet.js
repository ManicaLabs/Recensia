// Fiche d'invitation imprimable (A4, une page), utilisable aussi comme diapositive.
// Module navigateur : construit le DOM avec h()/svg() (src/ui/dom.js), sans injection de HTML.
// Les textes viennent de data/messages.fr.json (section « sheet ») via sheetContent(),
// pour que le bloc d'anonymat soit exactement celui des messages générés.
// Styles : src/styles/sheet.css (à charger avec loadCss).

import { h, svg } from '../ui/dom.js';
import { qrMatrix, qrPath, QR_MARGIN } from './qr.js';
import { sheetContent } from './messages.js';

export const SHEET_CSS = 'src/styles/sheet.css';
const PRINT_ROOT_CLASS = 'rc-print-root';
const PRINT_HTML_CLASS = 'rc-print-sheet';

function qrElement(link, label) {
  const m = qrMatrix(link, 'auto');
  const n = String(m.size + 2 * QR_MARGIN);
  return svg('svg', {
    class: 'rc-sheet__qr-svg',
    viewBox: `0 0 ${n} ${n}`,
    'shape-rendering': 'crispEdges',
    role: 'img',
    'aria-label': label,
    'data-qr-version': String(m.version),
    'data-qr-ecc': m.ecc,
  },
  svg('rect', { width: n, height: n, fill: '#ffffff' }),
  svg('path', { d: qrPath(m, QR_MARGIN), fill: '#000000' }));
}

/**
 * Construit la fiche.
 * @param {object} p
 * @param {object} p.campaign     campagne (§3.2) : seuls title, org_name, mode, settings.channels,
 *                                settings.closes_on et fingerprint sont lus
 * @param {string} p.link         lien de collecte complet
 * @param {string} [p.fingerprint] empreinte (8 hex) ; à défaut campaign.fingerprint
 * @param {Function} [p.t]        accepté pour compatibilité avec le contrat (textes : templates.sheet)
 * @param {object} p.templates    data/messages.fr.json
 * @param {object} p.channelsData data/channels.json
 * @param {'page'|'slide'} [p.layout] 'page' (A4 portrait, défaut) ou 'slide' (16:9)
 * @returns {HTMLElement}
 */
export function buildPrintableSheet({ campaign, link, fingerprint, templates, channelsData, layout = 'page' } = {}) {
  if (!templates || !channelsData) {
    throw new TypeError('buildPrintableSheet : templates (messages.fr.json) et channelsData (channels.json) sont requis');
  }
  const c = sheetContent({ campaign, link, fingerprint, templates, channelsData });
  const variant = layout === 'slide' ? 'slide' : 'page';

  const header = h('header', { class: 'rc-sheet__header' },
    ...(c.org ? [h('p', { class: 'rc-sheet__org', text: c.org })] : []),
    h('h2', { class: 'rc-sheet__title', text: c.title }),
    h('p', { class: 'rc-sheet__lead', text: c.lead }));

  const steps = h('section', { class: 'rc-sheet__steps', 'aria-label': c.steps_title },
    h('h3', { class: 'rc-sheet__heading', text: c.steps_title }),
    h('ol', { class: 'rc-sheet__list' }, ...(variant === 'slide' ? c.steps_slide : c.steps).map((step) => h('li', { text: step }))));

  const channel = h('section', { class: 'rc-sheet__channel', 'aria-label': c.channel_title },
    h('h3', { class: 'rc-sheet__heading', text: c.channel_title }),
    h('ul', { class: 'rc-sheet__channels' }, ...c.channels.map((item) => h('li', { text: item }))),
    ...(c.closes ? [h('p', { class: 'rc-sheet__closes', text: c.closes })] : []));

  const footer = h('footer', { class: 'rc-sheet__footer' },
    ...(c.fingerprint ? [
      h('p', { class: 'rc-sheet__fingerprint' },
        h('span', { text: `${c.fingerprint_label} ` }),
        h('strong', { class: 'rc-sheet__fp', text: c.fingerprint })),
      h('p', { class: 'rc-sheet__fp-help', text: c.fingerprint_help }),
    ] : []),
    h('p', { class: 'rc-sheet__link' },
      h('span', { class: 'rc-sheet__link-title', text: `${c.link_title} ` }),
      h('span', { class: 'rc-sheet__url', text: c.link })));

  const page = h('article', { class: 'rc-sheet__page', lang: c.locale },
    header,
    h('div', { class: 'rc-sheet__qr' }, qrElement(c.link, c.qr_label)),
    h('div', { class: 'rc-sheet__body' },
      steps,
      channel,
      h('p', { class: 'rc-sheet__anonymity', 'data-locked': 'anonymity', text: c.anonymity_block })),
    footer);

  // Densité : texte resserré quand les consignes ou le titre sont longs (voir sheet.css).
  const density = c.density === 'normal' ? [] : ['rc-sheet--dense', ...(c.density === 'compact' ? ['rc-sheet--compact'] : [])];
  return h('div', { class: ['rc-sheet', `rc-sheet--${variant}`, ...density], 'data-layout': variant, 'data-density': c.density }, page);
}

/**
 * Imprime une fiche seule : copie placée dans un conteneur dédié, le reste de la
 * page étant masqué par sheet.css pendant l'impression. Retourne une fonction de nettoyage.
 */
export function printSheet(sheet) {
  const doc = globalThis.document;
  const win = globalThis.window;
  doc.querySelectorAll(`.${PRINT_ROOT_CLASS}`).forEach((node) => node.remove());
  const root = h('div', { class: PRINT_ROOT_CLASS }, sheet.cloneNode(true));
  doc.body.append(root);
  doc.documentElement.classList.add(PRINT_HTML_CLASS);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    doc.documentElement.classList.remove(PRINT_HTML_CLASS);
    root.remove();
    win.removeEventListener('afterprint', cleanup);
  };
  win.addEventListener('afterprint', cleanup);
  win.print();
  return cleanup;
}
