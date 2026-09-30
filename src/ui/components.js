// Composants d'interface partagés (boutons, champs, badges, encarts, dialogues, notifications).

import { h, svg, announce } from './dom.js';
import { t as translate } from '../i18n.js';
import { copyText, copyRich } from './clipboard.js';

// Pictogrammes au trait (grille 24 × 24, couleur du texte courant).
const ICONS = {
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  copy: [['rect', { x: '9', y: '9', width: '12', height: '12', rx: '2' }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  download: [['path', { d: 'M12 3v12' }], ['path', { d: 'm7 10 5 5 5-5' }], ['path', { d: 'M5 21h14' }]],
  upload: [['path', { d: 'M12 21V9' }], ['path', { d: 'm7 14 5-5 5 5' }], ['path', { d: 'M5 3h14' }]],
  share: [['path', { d: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7' }], ['path', { d: 'm16 6-4-4-4 4' }], ['path', { d: 'M12 2v13' }]],
  mail: [['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }], ['path', { d: 'm22 7-10 6L2 7' }]],
  print: [['path', { d: 'M6 9V2h12v7' }], ['path', { d: 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2' }], ['rect', { x: '6', y: '14', width: '12', height: '8', rx: '1' }]],
  plus: [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]],
  trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4h8v2' }], ['path', { d: 'm19 6-1 14H6L5 6' }]],
  edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' }]],
  info: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 16v-5' }], ['path', { d: 'M12 8h.01' }]],
  alert: [['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
  danger: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  success: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm8 12 3 3 5-6' }]],
  lock: [['rect', { x: '4', y: '11', width: '16', height: '10', rx: '2' }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
  key: [['circle', { cx: '7.5', cy: '15.5', r: '4.5' }], ['path', { d: 'm10.7 12.3 9.8-9.8' }], ['path', { d: 'm16 7 3 3' }], ['path', { d: 'm18.5 4.5 2 2' }]],
  shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  list: [['path', { d: 'M9 6h12' }], ['path', { d: 'M9 12h12' }], ['path', { d: 'M9 18h12' }], ['path', { d: 'M4 6h.01' }], ['path', { d: 'M4 12h.01' }], ['path', { d: 'M4 18h.01' }]],
  users: [['circle', { cx: '9', cy: '8', r: '4' }], ['path', { d: 'M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1' }], ['path', { d: 'M16 4a4 4 0 0 1 0 8' }], ['path', { d: 'M22 21v-1a6 6 0 0 0-4-5.6' }]],
  file: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z' }], ['path', { d: 'M14 2v6h6' }]],
  qr: [['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }], ['path', { d: 'M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3' }]],
  external: [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
  'arrow-right': [['path', { d: 'M5 12h14' }], ['path', { d: 'm12 5 7 7-7 7' }]],
  'arrow-left': [['path', { d: 'M19 12H5' }], ['path', { d: 'm12 19-7-7 7-7' }]],
  close: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  refresh: [['path', { d: 'M21 12a9 9 0 1 1-2.6-6.4' }], ['path', { d: 'M21 3v6h-6' }]],
  offline: [['path', { d: 'm2 2 20 20' }], ['path', { d: 'M8.5 16.4a5 5 0 0 1 7 0' }], ['path', { d: 'M5 12.9a10 10 0 0 1 5.2-2.8' }], ['path', { d: 'M19 12.9a10 10 0 0 0-2.1-1.6' }], ['path', { d: 'M12 20h.01' }]],
  server: [['rect', { x: '3', y: '3', width: '18', height: '7', rx: '2' }], ['rect', { x: '3', y: '14', width: '18', height: '7', rx: '2' }], ['path', { d: 'M7 6.5h.01M7 17.5h.01' }]],
};

const KIND_ICONS = { info: 'info', warn: 'alert', danger: 'danger', success: 'success' };
const AI_ACT_LEVELS = ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal'];
const DATA_LEVELS = [0, 1, 2, 3];

let idCounter = 0;
function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function kindOf(kind) {
  if (kind === 'error') return 'danger';
  if (kind === 'warning') return 'warn';
  return Object.hasOwn(KIND_ICONS, kind) ? kind : 'info';
}

/** Pictogramme SVG décoratif (ou étiqueté si label est fourni). Nom inconnu : null. */
export function icon(name, { label, className } = {}) {
  const shapes = Object.hasOwn(ICONS, name) ? ICONS[name] : null;
  if (!shapes) return null;
  return svg('svg', {
    class: ['icon', className],
    viewBox: '0 0 24 24',
    width: '20',
    height: '20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
    'aria-hidden': label ? null : 'true',
    role: label ? 'img' : null,
    'aria-label': label ?? null,
  }, shapes.map(([tag, attrs]) => svg(tag, attrs)));
}

/**
 * Bouton. variant : primary | secondary | ghost | danger ; size : 'sm' ;
 * icon : nom de pictogramme ou nœud ; attrs : attributs supplémentaires (class fusionnée).
 */
export function button(label, onClick, { variant = 'secondary', type = 'button', icon: iconSpec, size, attrs = {} } = {}) {
  const { class: extraClass, ...rest } = attrs;
  const iconNode = typeof iconSpec === 'string' ? icon(iconSpec) : (iconSpec ?? null);
  return h('button', {
    ...rest,
    type,
    class: ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : null, extraClass],
    onClick: typeof onClick === 'function' ? onClick : undefined,
  }, iconNode, h('span', { class: 'btn-label' }, label));
}

/**
 * Champ de formulaire étiqueté. L'aide et l'erreur sont reliées au contrôle par aria-describedby.
 * group : true pour un groupe de cases ou de boutons radio (fieldset + legend).
 */
export function field({ id, label, help, error, required = false, control, group = false }) {
  if (!id) throw new TypeError('field() : « id » est requis.');
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, errorId].filter(Boolean).join(' ');
  const marker = required ? h('span', { class: 'field-required', 'aria-hidden': 'true' }, ' *') : null;
  const helpNode = help ? h('p', { class: 'field-help', id: helpId }, help) : null;
  const errorNode = h('p', { class: 'field-error', id: errorId, hidden: !error }, error ? [icon('alert'), h('span', null, error)] : null);

  if (group) {
    return h('fieldset', { class: ['field', 'field-group', error ? 'has-error' : null], id, 'aria-describedby': describedBy },
      h('legend', { class: 'field-label' }, label, marker), helpNode, control, errorNode);
  }

  if (control && typeof control.setAttribute === 'function') {
    if (!control.id) control.id = id;
    const existing = control.getAttribute('aria-describedby');
    control.setAttribute('aria-describedby', [existing, describedBy].filter(Boolean).join(' '));
    if (error) control.setAttribute('aria-invalid', 'true');
    if (required && 'required' in control) control.required = true;
  }
  return h('div', { class: ['field', error ? 'has-error' : null] },
    h('label', { class: 'field-label', for: control?.id || id }, label, marker), helpNode, control, errorNode);
}

/** Met à jour (ou efface avec null) le message d'erreur d'un champ créé par field(). */
export function setFieldError(fieldNode, message) {
  const errorNode = fieldNode.querySelector('.field-error');
  const controls = fieldNode.querySelectorAll('input, select, textarea');
  if (message) {
    errorNode?.replaceChildren(icon('alert'), h('span', null, message));
    if (errorNode) errorNode.hidden = false;
    fieldNode.classList.add('has-error');
    controls.forEach((control) => control.setAttribute('aria-invalid', 'true'));
  } else {
    errorNode?.replaceChildren();
    if (errorNode) errorNode.hidden = true;
    fieldNode.classList.remove('has-error');
    controls.forEach((control) => control.removeAttribute('aria-invalid'));
  }
}

const AXIS_LABEL_MODES = new Set(['hidden', 'visible', 'none']);

// Préfixe « AI Act : » / « Exposition des données : » : l'axe ne repose jamais sur la seule forme
// ou la seule couleur du badge (WCAG 1.3.1 et 1.4.1 ; CDC D5, deux axes séparés).
function axisPrefix(axis, mode, tr) {
  if (mode === 'none' || (axis !== 'ai_act' && axis !== 'data')) return null;
  const text = tr('common.levels.axis_prefix', { axis: tr(`common.levels.axis.${axis}`) });
  return h('span', { class: mode === 'visible' ? 'badge-axis' : 'visually-hidden' }, text);
}

/**
 * Badge de niveau. axis : 'ai_act' (classes badge-aia-<niveau>) ou 'data' (badge-data-<0..3>).
 * Le texte porte toujours l'information (la couleur n'est qu'un renfort).
 * axisLabel : 'hidden' (défaut : axe lu par les lecteurs d'écran seulement), 'visible' (axe affiché),
 * 'none' (l'axe est déjà donné par le contexte, par exemple un en-tête de colonne).
 * short : libellé court à l'écran ; le libellé complet reste dans title et pour les lecteurs d'écran.
 */
export function levelBadge(axis, level, t = translate, { short = false, axisLabel = 'hidden' } = {}) {
  const tr = typeof t === 'function' ? t : translate;
  const mode = AXIS_LABEL_MODES.has(axisLabel) ? axisLabel : 'hidden';
  if (axis === 'ai_act' && AI_ACT_LEVELS.includes(level)) {
    const label = tr(`common.levels.ai_act.${level}`);
    return h('span', {
      class: ['badge', `badge-aia-${level}`],
      'data-level': level,
      title: short ? label : null,
    },
    axisPrefix(axis, mode, tr),
    short
      ? [h('span', { 'aria-hidden': 'true' }, tr(`common.levels.ai_act_short.${level}`)), h('span', { class: 'visually-hidden' }, label)]
      : label);
  }
  const n = typeof level === 'string' && level.trim() !== '' ? Number(level) : level;
  if (axis === 'data' && DATA_LEVELS.includes(n)) {
    return h('span', { class: ['badge', `badge-data-${n}`], 'data-level': String(n) }, axisPrefix(axis, mode, tr), tr(`common.levels.data.${n}`));
  }
  return h('span', { class: ['badge', 'badge-neutral'] },
    axisPrefix(axis, mode, tr),
    level === null || level === undefined ? '—' : String(level));
}

/** Encart : info | warn | danger | success. */
export function callout(kind, ...children) {
  const k = kindOf(kind);
  return h('div', { class: ['callout', `callout-${k}`], role: 'note' },
    icon(KIND_ICONS[k], { className: 'callout-icon' }),
    h('div', { class: 'callout-body' }, children));
}

/**
 * Boîte de dialogue modale (<dialog> natif). Échap ou fermeture ⇒ null ; le focus revient
 * à l'élément actif à l'ouverture.
 * actions : [{ label, value, variant, autofocus }] ; value peut être une fonction (éventuellement
 * asynchrone) appelée au clic : si elle renvoie undefined, la boîte reste ouverte (validation).
 * describe : true relie le contenu au dialogue (aria-describedby), pour qu'il soit lu à l'ouverture
 * même quand le focus va directement sur un bouton ; à réserver aux messages courts. Pour un dialogue
 * qui contient un formulaire, passer plutôt le nœud du message d'avertissement (élément du contenu).
 * alert : true ⇒ role="alertdialog" (confirmation d'une action risquée).
 * @returns {Promise<any>}
 */
export function modal({ title, content, actions = [], dismissible = true, size, describe = false, alert = false } = {}) {
  const d = globalThis.document;
  const previous = d.activeElement;
  const titleId = uniqueId('modal-title');
  const describedNode = describe && typeof describe === 'object' && describe.nodeType === 1 ? describe : null;
  if (describedNode && !describedNode.getAttribute('id')) describedNode.setAttribute('id', uniqueId('modal-desc'));
  const contentId = describedNode ? null : (describe === true ? uniqueId('modal-content') : null);
  const describedBy = describedNode ? describedNode.getAttribute('id') : contentId;

  return new Promise((resolve) => {
    let settled = false;
    const dialog = h('dialog', {
      class: ['modal', size ? `modal-${size}` : null],
      role: alert ? 'alertdialog' : null,
      'aria-labelledby': titleId,
      'aria-describedby': describedBy,
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
      resolve(value);
    };

    const actionButtons = actions.map((action) => button(action.label, async () => {
      let value = action.value;
      if (typeof value === 'function') {
        try {
          value = await value();
        } catch (err) {
          console.error(err);
          return;
        }
        if (value === undefined) return;
      }
      finish(value);
    }, { variant: action.variant ?? 'secondary', attrs: { autofocus: action.autofocus ? true : null } }));

    const header = h('div', { class: 'modal-header' },
      h('h2', { class: 'modal-title', id: titleId }, title),
      dismissible
        ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon modal-close', 'aria-label': translate('common.actions.close'), onClick: () => finish(null) }, icon('close'))
        : null);

    dialog.appendChild(h('div', { class: 'modal-inner' },
      header,
      h('div', { class: 'modal-content', id: contentId }, content),
      actionButtons.length ? h('div', { class: 'modal-actions' }, actionButtons) : null));

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (dismissible) finish(null);
    });
    dialog.addEventListener('close', () => finish(null));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog && dismissible) finish(null);
    });

    d.body.appendChild(dialog);
    dialog.showModal();
    if (!dialog.querySelector('[autofocus]')) {
      const first = dialog.querySelector('.modal-content :is(input:not([type="hidden"]), select, textarea):not([disabled])');
      if (first) first.focus();
    }
  });
}

/**
 * Demande de confirmation. danger : bouton rouge, focus initial sur « Annuler » et role="alertdialog".
 * Le message est relié au dialogue (aria-describedby) : il est lu à l'ouverture.
 */
export function confirmDialog({ title, message, confirmLabel, danger = false } = {}) {
  return modal({
    title,
    content: typeof message === 'string' ? h('p', null, message) : message,
    describe: true,
    alert: danger,
    actions: [
      { label: translate('common.actions.cancel'), value: false, autofocus: danger },
      { label: confirmLabel ?? translate('common.actions.confirm'), value: true, variant: danger ? 'danger' : 'primary', autofocus: !danger },
    ],
  }).then((value) => value === true);
}

// Notifications : 4 au plus, 2 sur écran étroit (la pile y occupe toute la largeur). Les erreurs et
// avertissements restent affichés jusqu'à leur fermeture ; les autres disparaissent seuls.
export const TOAST_LIMIT = 4;
export const TOAST_LIMIT_NARROW = 2;
const NARROW_QUERY = '(max-width: 40rem)';
const TOAST_DELAY_MS = 5000;
const PERSISTENT_KINDS = new Set(['danger', 'warn']);
const toastDismissers = new WeakMap();

/** Nombre maximal de notifications visibles pour la largeur d'écran courante. */
export function toastLimit(win = globalThis) {
  try {
    return win.matchMedia?.(NARROW_QUERY)?.matches ? TOAST_LIMIT_NARROW : TOAST_LIMIT;
  } catch {
    return TOAST_LIMIT;
  }
}

/** Délai d'effacement automatique en ms, ou null si la notification reste jusqu'à sa fermeture. */
export function toastTimeout(kind, timeout) {
  if (timeout !== undefined) return Number.isFinite(timeout) && timeout > 0 ? timeout : null;
  return PERSISTENT_KINDS.has(kindOf(kind)) ? null : TOAST_DELAY_MS;
}

/**
 * Notifications à retirer pour ne pas dépasser limit : les plus anciennes, en commençant par celles
 * qui s'effacent seules ; la dernière arrivée n'est jamais retirée.
 * @param {{ persistent: boolean }[]} items du plus ancien au plus récent
 * @returns {number[]} indices à retirer
 */
export function toastsToEvict(items, limit) {
  const excess = items.length - Math.max(1, limit);
  if (excess <= 0) return [];
  const candidates = items.slice(0, -1).map((item, index) => ({ index, persistent: Boolean(item.persistent) }));
  const ordered = [...candidates.filter((c) => !c.persistent), ...candidates.filter((c) => c.persistent)];
  return ordered.slice(0, excess).map((c) => c.index).sort((a, b) => a - b);
}

function toastContainer(d) {
  let container = d.getElementById('toasts');
  if (!container) {
    container = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    d.body.appendChild(container);
  }
  watchOverlays(d, container);
  return container;
}

/**
 * Suit dès le démarrage les éléments fixés en bas d'écran (pile de notifications, bannière de mise à
 * jour) : sans cela, le suivi ne commence qu'à la première notification.
 */
export function watchBottomOverlays() {
  const d = globalThis.document;
  if (d?.body) toastContainer(d);
}

// Éléments fixés en bas d'écran (notifications, bannière de mise à jour) : leur hauteur est exposée en
// --bottom-overlay (scroll-padding-bottom et marge basse de la page, app.css) et l'élément qui a le focus
// clavier est ramené au-dessus d'eux s'ils le recouvrent (WCAG 2.4.11).
let overlayWatch = null;

function watchOverlays(d, container) {
  if (overlayWatch?.container === container) return;
  const win = d.defaultView ?? globalThis;
  const root = d.documentElement;
  if (!root?.style || typeof container.getBoundingClientRect !== 'function') return;
  const watch = { container, lastOutside: null };
  overlayWatch = watch;

  const banner = () => {
    const node = d.getElementById('update-banner');
    return node && !node.hidden && node.isConnected ? node : null;
  };
  // Le conteneur de la pile, et non chaque notification : sa boîte ne suit pas l'animation d'entrée.
  const obstacles = () => [container.children.length ? container : null, banner()].filter(Boolean);

  const layout = () => {
    const vh = win.innerHeight || root.clientHeight || 0;
    const bar = banner();
    const barRect = bar ? bar.getBoundingClientRect() : null;
    // La pile de notifications se place au-dessus de la bannière de mise à jour.
    if (barRect && barRect.height) root.style.setProperty('--update-banner-space', `${Math.ceil(barRect.height) + 8}px`);
    else root.style.removeProperty('--update-banner-space');
    const tops = obstacles().map((node) => node.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top);
    const extent = tops.length ? Math.ceil(vh - Math.min(...tops)) + 8 : 0;
    if (extent > 0) root.style.setProperty('--bottom-overlay', `${extent}px`);
    else root.style.removeProperty('--bottom-overlay');
  };

  const reveal = () => {
    const el = d.activeElement;
    if (!el || el === d.body || el === root || typeof el.getBoundingClientRect !== 'function') return;
    const blockers = obstacles();
    if (!blockers.length || blockers.some((node) => node.contains(el)) || el.closest?.('dialog[open]')) return;
    try {
      if (!el.matches(':focus-visible')) return;
    } catch {
      // :focus-visible non reconnu : on considère le focus comme visible.
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const covered = blockers.map((node) => node.getBoundingClientRect())
      .some((o) => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top);
    // scroll-padding-bottom (= --bottom-overlay) place l'élément au-dessus de la pile.
    if (covered) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const update = () => {
    if (overlayWatch !== watch) return;
    layout();
    reveal();
  };
  watch.update = update;

  const RO = win.ResizeObserver;
  if (typeof RO === 'function') {
    const observer = new RO(update);
    observer.observe(container);
    const bar = d.getElementById('update-banner');
    if (bar) observer.observe(bar);
  }
  win.addEventListener?.('resize', update, { passive: true });
  d.addEventListener('focusin', (event) => {
    if (overlayWatch !== watch) return;
    const target = event.target;
    if (target && !container.contains(target)) watch.lastOutside = target;
    if (obstacles().length) reveal();
  });
}

// Fermeture d'une notification qui contenait le focus : retour au dernier élément focalisé hors de la
// pile (sinon au contenu principal), pour ne pas perdre le focus sur <body>.
function restoreFocusFrom(node, d) {
  if (typeof node.contains !== 'function' || !node.contains(d.activeElement)) return;
  const previous = overlayWatch?.lastOutside;
  const target = previous && previous.isConnected && typeof previous.focus === 'function'
    ? previous
    : d.getElementById('app');
  target?.focus?.();
}

/**
 * Notification (info | success | warn | danger). Les erreurs (danger) et avertissements (warn) restent
 * jusqu'à leur fermeture ; info et success s'effacent après 5 s (pause au survol et au focus).
 * timeout : délai en ms imposé (0 ou null : jusqu'à la fermeture). Une notification identique déjà
 * affichée est remplacée. Échap ferme la notification qui a le focus. Renvoie la fonction de fermeture.
 */
export function toast(message, kind = 'info', { timeout } = {}) {
  const d = globalThis.document;
  const container = toastContainer(d);
  const k = kindOf(kind);
  const delay = toastTimeout(k, timeout);
  let timer = null;
  let closed = false;
  const messageNode = h('p', { class: 'toast-message' }, message);
  const node = h('div', { class: ['toast', `toast-${k}`], 'data-persistent': delay === null ? 'true' : 'false' },
    icon(KIND_ICONS[k], { className: 'toast-icon' }),
    messageNode,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': translate('common.actions.close_notification'), onClick: () => dismiss() }, icon('close')));
  const dismiss = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    restoreFocusFrom(node, d);
    node.remove();
  };
  const arm = () => {
    clearTimeout(timer);
    if (delay !== null && !closed) timer = setTimeout(dismiss, delay);
  };
  toastDismissers.set(node, dismiss);
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', arm);
  node.addEventListener('focusin', () => clearTimeout(timer));
  node.addEventListener('focusout', arm);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismiss();
  });

  // Même message déjà affiché : l'ancien est remplacé (pas de pile de doublons).
  const text = messageNode.textContent;
  for (const other of Array.from(container.children)) {
    if (other.classList?.contains(`toast-${k}`) && other.querySelector?.('.toast-message')?.textContent === text) {
      (toastDismissers.get(other) ?? (() => other.remove()))();
    }
  }
  container.appendChild(node);
  const current = Array.from(container.children);
  const evict = toastsToEvict(current.map((n) => ({ persistent: n.getAttribute('data-persistent') === 'true' })), toastLimit());
  for (const index of evict) {
    const victim = current[index];
    (toastDismissers.get(victim) ?? (() => victim.remove()))();
  }
  arm();
  overlayWatch?.update?.();
  return dismiss;
}

/**
 * Bouton « Copier » avec retour « Copié ».
 * getText() → texte (ou promesse) ; avec rich: true → { html, text } copié en texte riche.
 */
export function copyButton(getText, { label, rich = false, variant = 'secondary', size, attrs } = {}) {
  const baseLabel = label ?? translate('common.actions.copy');
  let timer = null;
  const btn = button(baseLabel, async () => {
    let ok = false;
    try {
      const value = typeof getText === 'function' ? await getText() : getText;
      ok = rich && value && typeof value === 'object'
        ? await copyRich(value.html, value.text)
        : await copyText(String(value ?? ''));
    } catch (err) {
      console.error(err);
      ok = false;
    }
    if (!ok) {
      toast(translate('common.copy.failed'), 'warn');
      return;
    }
    setState(true);
    announce(translate('common.copy.announce'));
    clearTimeout(timer);
    timer = setTimeout(() => setState(false), 2000);
  }, { variant, size, icon: 'copy', attrs });

  const labelNode = btn.querySelector('.btn-label');
  const setState = (copied) => {
    btn.classList.toggle('is-copied', copied);
    labelNode.textContent = copied ? translate('common.copy.done') : baseLabel;
    const current = btn.querySelector('svg.icon');
    const next = icon(copied ? 'check' : 'copy');
    if (current && next) current.replaceWith(next);
  };
  return btn;
}

/** Mention « indicatif, à confirmer — pas un avis juridique ». */
export function disclaimer(t = translate) {
  const tr = typeof t === 'function' ? t : translate;
  return h('p', { class: 'disclaimer' }, icon('info', { className: 'disclaimer-icon' }), h('span', null, tr('common.disclaimer')));
}
