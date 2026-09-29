// Construction sûre du DOM : texte via textContent / nœuds texte, jamais de HTML interprété.
// Aucun accès au document à l'import : tout est résolu à l'appel.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const TAG_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const ATTR_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;
const FORBIDDEN_TAGS = new Set(['script', 'style']);
const FORBIDDEN_ATTRS = new Set(['style', 'srcdoc']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'data', 'srcset', 'ping', 'background']);
// Posées comme propriétés (après l'ajout des enfants, pour que <select value> fonctionne).
const PROPERTIES = new Set(['value', 'checked', 'selected', 'indeterminate', 'defaultValue', 'defaultChecked']);
const APP_ROOT = new URL('../../', import.meta.url);

function doc() {
  return globalThis.document;
}

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.nodeType === 'number';
}

function isAttrs(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isNode(value);
}

/** URL exécutable (javascript:, vbscript:) après retrait des espaces et caractères de contrôle. */
export function isDangerousUrl(value) {
  const normalized = String(value).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  return /(^|,)(javascript|vbscript):/.test(normalized);
}

function classList(value) {
  const list = Array.isArray(value) ? value.flat(Infinity) : [value];
  return list.filter((item) => typeof item === 'string' && item.trim() !== '').join(' ').trim();
}

function applyAttributes(el, attrs, { svgMode }) {
  const deferred = [];
  for (const [key, value] of Object.entries(attrs)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_ATTRS.has(lower)) {
      throw new Error(`Attribut « ${key} » refusé : utiliser une classe CSS (CSP).`);
    }
    if (/^on[a-z]/i.test(key)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value !== 'function') throw new TypeError(`Gestionnaire « ${key} » refusé : une fonction est attendue.`);
      el.addEventListener(lower.slice(2), value);
      continue;
    }
    if (lower.startsWith('aria-') || lower.startsWith('data-')) {
      if (value === null || value === undefined) continue;
      if (!ATTR_RE.test(key)) throw new TypeError(`Nom d'attribut invalide : ${key}`);
      el.setAttribute(key, String(value));
      continue;
    }
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      const cls = classList(value);
      if (cls) el.setAttribute('class', cls);
      continue;
    }
    if (key === 'text') {
      el.textContent = String(value);
      continue;
    }
    if (!svgMode && PROPERTIES.has(key)) {
      deferred.push([key, value]);
      continue;
    }
    const name = key === 'htmlFor' ? 'for' : key;
    if (!ATTR_RE.test(name)) throw new TypeError(`Nom d'attribut invalide : ${key}`);
    if (URL_ATTRS.has(name.toLowerCase()) && isDangerousUrl(value)) {
      throw new Error(`URL refusée dans « ${name} » : schéma javascript: interdit.`);
    }
    const text = value === true ? '' : String(value);
    if (name === 'xlink:href') el.setAttributeNS(XLINK_NS, name, text);
    else el.setAttribute(name, text);
  }
  return deferred;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (isNode(child)) {
      el.appendChild(child);
    } else if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint') {
      el.appendChild(doc().createTextNode(String(child)));
    } else {
      throw new TypeError(`Enfant non pris en charge : ${Object.prototype.toString.call(child)}`);
    }
  }
}

function build(el, attrs, children, svgMode) {
  let deferred = [];
  if (isAttrs(attrs)) deferred = applyAttributes(el, attrs, { svgMode });
  else if (attrs !== undefined) children.unshift(attrs);
  appendChildren(el, children);
  for (const [key, value] of deferred) el[key] = value;
  return el;
}

/**
 * Crée un élément HTML.
 * attrs : class (chaîne ou tableau), id, text, on<Événement> (fonctions), aria-*, data-*,
 * booléens (true ⇒ attribut vide, false/null ⇒ absent), value/checked (propriétés).
 * Refusés : style, srcdoc, on* non fonction, URL javascript:.
 */
export function h(tag, attrs, ...children) {
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new TypeError(`Balise invalide : ${tag}`);
  if (FORBIDDEN_TAGS.has(tag.toLowerCase())) throw new Error(`Balise « ${tag} » refusée.`);
  return build(doc().createElement(tag), attrs, children, false);
}

/** Crée un élément SVG (mêmes règles que h(), attributs uniquement). */
export function svg(tag, attrs, ...children) {
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new TypeError(`Balise invalide : ${tag}`);
  if (FORBIDDEN_TAGS.has(tag.toLowerCase())) throw new Error(`Balise « ${tag} » refusée.`);
  return build(doc().createElementNS(SVG_NS, tag), attrs, children, true);
}

function collect(nodes, out) {
  for (const node of nodes) {
    if (node === null || node === undefined || node === false || node === true) continue;
    if (Array.isArray(node)) collect(node, out);
    else if (isNode(node)) out.push(node);
    else out.push(doc().createTextNode(String(node)));
  }
  return out;
}

/** Remplace le contenu de root par les nœuds donnés. */
export function mount(root, ...nodes) {
  root.replaceChildren(...collect(nodes, []));
  return root;
}

const stylesheets = new Map();

/**
 * Ajoute une feuille de style (une seule fois). href relatif à la racine de l'application,
 * ex. loadCss('src/styles/console.css'). Renvoie une promesse résolue au chargement (ou à l'échec).
 */
export function loadCss(href) {
  const url = new URL(href, APP_ROOT);
  if (url.origin !== APP_ROOT.origin) return Promise.reject(new Error(`Feuille de style externe refusée : ${href}`));
  const key = url.href;
  if (stylesheets.has(key)) return stylesheets.get(key);
  const d = doc();
  const existing = Array.from(d.querySelectorAll('link[rel="stylesheet"]')).find((link) => link.href === key);
  const promise = existing
    ? Promise.resolve(existing)
    : new Promise((resolve) => {
      const link = h('link', { rel: 'stylesheet', href: key });
      link.addEventListener('load', () => resolve(link));
      link.addEventListener('error', () => {
        console.warn(`[Recensia] Feuille de style non chargée : ${href}`);
        resolve(link);
      });
      d.head.appendChild(link);
    });
  stylesheets.set(key, promise);
  return promise;
}

/** Annonce un message aux technologies d'assistance (région aria-live). */
export function announce(message, { assertive = false } = {}) {
  const d = doc();
  if (!d?.body) return;
  const id = assertive ? 'live-region-assertive' : 'live-region';
  let region = d.getElementById(id);
  if (!region) {
    region = h('div', { id, class: 'visually-hidden', 'aria-live': assertive ? 'assertive' : 'polite', 'aria-atomic': 'true' });
    d.body.appendChild(region);
  }
  region.textContent = '';
  // Léger délai : un message identique au précédent est ainsi annoncé de nouveau.
  setTimeout(() => {
    region.textContent = String(message ?? '');
  }, 60);
}
