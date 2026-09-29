// Schéma de la base locale et utilitaires communs aux deux backends (IndexedDB et mémoire).
// Module pur : aucun accès au DOM ni à IndexedDB à l'import.

export const DB_NAME = 'recensia';
export const DB_VERSION = 1;
export const CAMPAIGN_INDEX = 'campaign_id';

// Définition des magasins : chemin de clé et index éventuel sur campaign_id.
export const STORES = Object.freeze({
  campaigns: Object.freeze({ keyPath: 'id', index: false }),
  entries: Object.freeze({ keyPath: Object.freeze(['campaign_id', 'entry_id']), index: true }),
  assessments: Object.freeze({ keyPath: Object.freeze(['campaign_id', 'usage_key']), index: true }),
  actions: Object.freeze({ keyPath: 'id', index: true }),
  meta: Object.freeze({ keyPath: 'key', index: false }),
});

export const STORE_NAMES = Object.freeze(Object.keys(STORES));

/** Erreur du module de stockage ; `code` est stable et exploitable par l'interface. */
export class StoreError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Vérifie que `value` est une chaîne non vide utilisable comme identifiant. */
export function assertId(value, name) {
  if (!isNonEmptyString(value)) {
    throw new StoreError('invalid_key', `Identifiant invalide (${name}) : chaîne non vide attendue.`);
  }
}

/** Extrait la clé primaire d'un enregistrement selon le chemin de clé du magasin. */
export function keyOf(storeName, record) {
  const def = STORES[storeName];
  if (!def) throw new StoreError('invalid_store', `Magasin inconnu : ${storeName}.`);
  if (Array.isArray(def.keyPath)) return def.keyPath.map((k) => record[k]);
  return record[def.keyPath];
}

/**
 * Contrôle un enregistrement avant écriture : objet, clé primaire complète et, pour les
 * magasins indexés, campaign_id renseigné (sinon l'enregistrement échapperait à la cascade).
 */
export function assertRecord(storeName, record) {
  if (!isPlainObject(record)) {
    throw new StoreError('invalid_record', `Enregistrement invalide pour « ${storeName} » : objet attendu.`);
  }
  const def = STORES[storeName];
  const fields = Array.isArray(def.keyPath) ? def.keyPath : [def.keyPath];
  for (const f of fields) assertId(record[f], `${storeName}.${f}`);
  if (def.index) assertId(record.campaign_id, `${storeName}.campaign_id`);
}

/** Ordre des clés d'IndexedDB, restreint aux chaînes et tableaux de chaînes utilisés ici. */
export function compareKeys(a, b) {
  const aa = Array.isArray(a);
  const ba = Array.isArray(b);
  if (aa !== ba) return aa ? 1 : -1; // les tableaux se classent après les chaînes
  if (!aa) return a < b ? -1 : a > b ? 1 : 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export function sameKey(a, b) {
  return compareKeys(a, b) === 0;
}

export function serializeKey(key) {
  return JSON.stringify(key);
}
