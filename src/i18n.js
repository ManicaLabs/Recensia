// Textes d'interface : t() synchrone, espaces de noms chargés à la demande
// depuis src/i18n/fr/<espace>.json (l'espace de noms est le premier segment de la clé).

export const LOCALE = 'fr-FR';

const NS_RE = /^[a-z][a-z0-9_]*$/;
const catalogs = new Map();
const pending = new Map();
const warned = new Set();
const pluralRules = new Intl.PluralRules(LOCALE);
const dayFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const numberFormat = new Intl.NumberFormat(LOCALE);

async function fetchCatalog(ns) {
  const url = new URL(`./i18n/fr/${ns}.json`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Textes introuvables : src/i18n/fr/${ns}.json (HTTP ${response.status})`);
  return response.json();
}

let loader = fetchCatalog;

/** Remplace le chargeur (tests sous Node : lecture via fs). Sans argument : chargeur par défaut. */
export function setLoader(fn) {
  loader = typeof fn === 'function' ? fn : fetchCatalog;
}

/** Enregistre directement un catalogue (tests, ou textes construits à l'exécution). */
export function register(ns, catalog) {
  if (!NS_RE.test(ns)) throw new TypeError(`Espace de noms invalide : ${ns}`);
  if (!catalog || typeof catalog !== 'object') throw new TypeError(`Catalogue invalide : ${ns}`);
  catalogs.set(ns, catalog);
}

export function isLoaded(ns) {
  return catalogs.has(ns);
}

/** Charge un espace de noms (une seule fois, résultat mis en cache). */
export function load(ns) {
  if (typeof ns !== 'string' || !NS_RE.test(ns)) {
    return Promise.reject(new TypeError(`Espace de noms invalide : ${ns}`));
  }
  if (catalogs.has(ns)) return Promise.resolve(catalogs.get(ns));
  if (!pending.has(ns)) {
    const promise = Promise.resolve()
      .then(() => loader(ns))
      .then((catalog) => {
        register(ns, catalog);
        return catalog;
      })
      .finally(() => pending.delete(ns));
    pending.set(ns, promise);
  }
  return pending.get(ns);
}

function lookup(catalog, path) {
  let current = catalog;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function pickPlural(forms, count) {
  if (count === 0 && typeof forms.zero === 'string') return forms.zero;
  const category = pluralRules.select(count);
  if (typeof forms[category] === 'string') return forms[category];
  return typeof forms.other === 'string' ? forms.other : forms.one;
}

function interpolate(text, vars) {
  if (!vars || typeof vars !== 'object') return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(vars, name) && vars[name] !== null && vars[name] !== undefined ? String(vars[name]) : match
  ));
}

function isLocalDev() {
  const host = globalThis.location?.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function warnMissing(key) {
  if (warned.has(key)) return;
  warned.add(key);
  if (isLocalDev()) console.warn(`[i18n] Clé absente : ${key}`);
}

function resolve(key, vars) {
  if (typeof key !== 'string') return undefined;
  const dot = key.indexOf('.');
  if (dot <= 0) return undefined;
  const catalog = catalogs.get(key.slice(0, dot));
  if (!catalog) return undefined;
  let value = lookup(catalog, key.slice(dot + 1));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const count = Number(vars?.count);
    value = vars && vars.count !== undefined && Number.isFinite(count) ? pickPlural(value, count) : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Texte traduit. Pluriels : { "one": "…", "other": "…" } choisis selon vars.count.
 * Interpolation : « {nom} » remplacé par vars.nom. Clé absente : renvoie la clé.
 */
export function t(key, vars) {
  const value = resolve(key, vars);
  if (value === undefined) {
    warnMissing(String(key));
    return String(key ?? '');
  }
  return interpolate(value, vars);
}

/** La clé existe-t-elle (espace de noms chargé) ? Une clé de pluriel compte comme présente. */
export function has(key) {
  return resolve(key) !== undefined || resolve(key, { count: 2 }) !== undefined;
}

function toUtcDay(day) {
  if (day instanceof Date) {
    return Number.isNaN(day.getTime()) ? null : new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
  }
  if (typeof day !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(Date.UTC(year, month - 1, date));
  return value.getUTCMonth() === month - 1 && value.getUTCDate() === date ? value : null;
}

// « 1 octobre » ⇒ « 1er octobre » (usage typographique français).
function joinParts(parts) {
  return parts.map((part) => (part.type === 'day' && part.value === '1' ? '1er' : part.value)).join('');
}

/** « 2026-10-31 » ⇒ « 31 octobre 2026 ». Valeur invalide : renvoyée telle quelle. */
export function formatDate(day) {
  const value = toUtcDay(day);
  if (!value) return typeof day === 'string' ? day : '';
  return joinParts(dayFormat.formatToParts(value));
}

/** Horodatage ISO ⇒ « 31 octobre 2026 à 14:05 » (fuseau local, ou options.timeZone). */
export function formatDateTime(iso, { timeZone } = {}) {
  const value = iso instanceof Date ? iso : new Date(iso);
  if (typeof iso !== 'string' && !(iso instanceof Date)) return '';
  if (Number.isNaN(value.getTime())) return typeof iso === 'string' ? iso : '';
  const format = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
  return joinParts(format.formatToParts(value));
}

/** 1500 ⇒ « 1 500 ». */
export function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? numberFormat.format(number) : String(value ?? '');
}

export const i18n = Object.freeze({
  locale: LOCALE, load, t, has, register, isLoaded, setLoader, formatDate, formatDateTime, formatNumber,
});
