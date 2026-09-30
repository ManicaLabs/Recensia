// Brouillon du répondant (formulaire #/c/<payload>) : usages décrits, identité (mode ouvert),
// saisie en cours et codes déjà produits. Conservé sur l'appareil du répondant uniquement
// (safe-storage local, une clé par campagne) ; rien n'est envoyé.
//
// Révisions (CDC §4) : chaque usage garde son entry_id ; le code produit mémorise le contenu
// chiffré (usage + identité). Si ce contenu change après la génération d'un code, le code
// suivant porte rev + 1 et remplace l'ancien à l'import (le rev le plus élevé gagne).
//
// Module pur : aucun accès au DOM ni au stockage.

import { validateUsage } from '../../engine/validate.js';

export const DRAFT_VERSION = 1;
/** Nombre maximal d'usages relus depuis un brouillon (garde-fou contre un stockage corrompu). */
export const DRAFT_MAX_ITEMS = 100;
export const REV_MAX = 1000;

const ENTRY_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const CODE_RE = /^RCN1\.[A-Za-z0-9_-]{16,12000}$/;
const TEXT_MAX = 2000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Clé de stockage du brouillon d'une campagne (préfixée « recensia: » par safe-storage). */
export function draftKey(campaignId) {
  return `form-draft:${campaignId}`;
}

/** Brouillon vide. */
export function emptyDraft(campaignId) {
  return { v: DRAFT_VERSION, campaign_id: campaignId, respondent: null, items: [], current: null };
}

/** Le brouillon contient-il quelque chose à effacer ? */
export function hasContent(draft) {
  return Boolean(draft && (draft.items.length > 0 || draft.current || draft.respondent));
}

function cleanString(v, max = TEXT_MAX) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

/** Ne garde que les clés du questionnaire, avec des valeurs de forme plausible (chaîne ou liste de chaînes). */
export function sanitizeUsageShape(usage, questionnaire) {
  const fields = questionnaire?.fields ?? {};
  const out = {};
  if (!isPlainObject(usage)) return out;
  for (const key of Object.keys(fields)) {
    const v = usage[key];
    if (typeof v === 'string') out[key] = v.slice(0, TEXT_MAX);
    else if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string').slice(0, 50);
    else out[key] = null;
  }
  return out;
}

function sanitizeRespondent(r) {
  if (!isPlainObject(r)) return null;
  const out = {
    first_name: cleanString(r.first_name, 200) ?? '',
    last_name: cleanString(r.last_name, 200) ?? '',
    email: cleanString(r.email, 300) ?? '',
  };
  return out.first_name || out.last_name || out.email ? out : null;
}

function sanitizeCoded(c) {
  if (!isPlainObject(c)) return null;
  if (!Number.isInteger(c.rev) || c.rev < 1 || c.rev > REV_MAX) return null;
  if (typeof c.content !== 'string' || c.content.length > 64 * 1024) return null;
  if (typeof c.code !== 'string' || !CODE_RE.test(c.code)) return null;
  return { rev: c.rev, content: c.content, code: c.code };
}

/**
 * Relit un brouillon stocké (valeur quelconque) pour une campagne. Tout ce qui n'a pas la forme
 * attendue est écarté ; un brouillon d'une autre campagne ou d'une autre version est ignoré.
 * @returns {object} brouillon (vide si illisible)
 */
export function restoreDraft(raw, campaignId, questionnaire) {
  const draft = emptyDraft(campaignId);
  if (!isPlainObject(raw) || raw.v !== DRAFT_VERSION || raw.campaign_id !== campaignId) return draft;
  draft.respondent = sanitizeRespondent(raw.respondent);
  const seen = new Set();
  for (const item of Array.isArray(raw.items) ? raw.items.slice(0, DRAFT_MAX_ITEMS) : []) {
    if (!isPlainObject(item) || typeof item.entry_id !== 'string' || !ENTRY_ID_RE.test(item.entry_id)) continue;
    if (seen.has(item.entry_id)) continue;
    seen.add(item.entry_id);
    const rev = Number.isInteger(item.rev) && item.rev >= 1 && item.rev <= REV_MAX ? item.rev : 1;
    const coded = sanitizeCoded(item.coded);
    draft.items.push({
      entry_id: item.entry_id,
      rev: coded && coded.rev > rev ? coded.rev : rev,
      usage: sanitizeUsageShape(item.usage, questionnaire),
      coded,
    });
  }
  if (isPlainObject(raw.current)) {
    const entryId = typeof raw.current.entry_id === 'string' && seen.has(raw.current.entry_id) ? raw.current.entry_id : null;
    draft.current = { entry_id: entryId, value: sanitizeUsageShape(raw.current.value, questionnaire) };
  }
  return draft;
}

function cloneItem(item) {
  return { ...item, usage: { ...item.usage }, coded: item.coded ? { ...item.coded } : null };
}

function clone(draft) {
  return {
    ...draft,
    respondent: draft.respondent ? { ...draft.respondent } : null,
    items: draft.items.map(cloneItem),
    current: draft.current ? { entry_id: draft.current.entry_id, value: { ...draft.current.value } } : null,
  };
}

/** Retrouve un usage par entry_id (null si absent). */
export function findItem(draft, entryId) {
  return draft.items.find((item) => item.entry_id === entryId) ?? null;
}

/**
 * Enregistre un usage validé : remplace celui qui porte entryId, sinon en ajoute un nouveau
 * (entry_id = newId, rev 1). La saisie en cours est effacée. Renvoie un nouveau brouillon.
 */
export function upsertItem(draft, { entryId = null, usage, newId }) {
  const next = clone(draft);
  const existing = entryId ? next.items.find((item) => item.entry_id === entryId) : null;
  if (existing) {
    existing.usage = { ...usage };
  } else {
    if (typeof newId !== 'string' || !ENTRY_ID_RE.test(newId)) throw new TypeError('upsertItem : identifiant neuf invalide.');
    next.items.push({ entry_id: newId, rev: 1, usage: { ...usage }, coded: null });
  }
  next.current = null;
  return next;
}

/** Supprime un usage. Renvoie un nouveau brouillon. */
export function removeItem(draft, entryId) {
  const next = clone(draft);
  next.items = next.items.filter((item) => item.entry_id !== entryId);
  if (next.current?.entry_id === entryId) next.current = null;
  return next;
}

/** Mémorise la saisie en cours (usage non encore enregistré, ou modification d'un usage). */
export function setCurrent(draft, entryId, value) {
  const next = clone(draft);
  next.current = value ? { entry_id: entryId ?? null, value: { ...value } } : null;
  return next;
}

/** Mémorise l'identité saisie (mode ouvert). */
export function setRespondent(draft, respondent) {
  const next = clone(draft);
  next.respondent = sanitizeRespondent(respondent);
  return next;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

/** Représentation canonique du contenu chiffré d'un usage (usage + identité) pour détecter une modification. */
export function canonicalContent(usage, respondent = null) {
  return JSON.stringify(sortKeys({ usage: usage ?? null, respondent: respondent ?? null }));
}

/**
 * État du code d'un usage : 'none' (jamais produit), 'current' (le code correspond au contenu)
 * ou 'outdated' (usage ou identité modifiés depuis).
 */
export function codeState(item, respondent = null) {
  if (!item?.coded) return 'none';
  return item.coded.content === canonicalContent(item.usage, respondent) ? 'current' : 'outdated';
}

/**
 * Révision du prochain code d'un usage.
 * → { rev, reuse } : reuse = true si le code existant correspond déjà au contenu (aucun nouveau code).
 */
export function revisionFor(item, respondent = null) {
  const state = codeState(item, respondent);
  if (state === 'none') return { rev: item.rev, reuse: false };
  if (state === 'current') return { rev: item.coded.rev, reuse: true };
  return { rev: Math.min(item.coded.rev + 1, REV_MAX), reuse: false };
}

/**
 * Enregistre le code produit pour un usage (et sa révision). `usage` (facultatif) remplace
 * l'usage stocké par sa forme normalisée, celle qui a été chiffrée. Renvoie un nouveau brouillon.
 */
export function markCoded(draft, entryId, { rev, content, code, usage }) {
  const next = clone(draft);
  const item = next.items.find((x) => x.entry_id === entryId);
  if (!item) throw new Error(`markCoded : usage inconnu (${entryId}).`);
  if (usage) item.usage = { ...usage };
  item.rev = rev;
  item.coded = { rev, content, code };
  return next;
}

/** Vérifie chaque usage avec les règles de la campagne : → [{ entry_id, ok, value, errors }]. */
export function checkItems(draft, questionnaire, campaignOptions) {
  return draft.items.map((item) => {
    const result = validateUsage(item.usage, questionnaire, campaignOptions);
    return { entry_id: item.entry_id, ok: result.ok, value: result.value, errors: result.errors };
  });
}
