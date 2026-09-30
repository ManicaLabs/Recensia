// Évaluation d'une ligne du registre (ARCHITECTURE §3.4) : surcharges tracées, statut de
// validation, responsable. Module pur : la date est passée en paramètre, aucun accès au store.
// Toute modification d'une surcharge exige une justification d'au moins 10 caractères (CDC §6.1).

import { isAiActLevel, isDataLevel } from '../../../engine/levels.js';
import { VALIDATION_STATUSES } from './filters.js';

export const JUSTIFICATION_MIN = 10;
export const JUSTIFICATION_MAX = 1000;
export const OWNER_MAX = 120;
export const HISTORY_MAX = 200;
export const OVERRIDE_FIELDS = Object.freeze(['override_ai_act_level', 'override_data_level']);
export const TRACKED_FIELDS = Object.freeze([...OVERRIDE_FIELDS, 'validation_status', 'owner']);

/** Évaluation vide d'une ligne. */
export function emptyAssessment(campaignId, usageKey) {
  return {
    campaign_id: campaignId,
    usage_key: usageKey,
    override_ai_act_level: null,
    override_data_level: null,
    justification: '',
    owner: '',
    validation_status: 'to_review',
    history: [],
    updated_at: null,
  };
}

/** Texte saisi nettoyé : caractères de contrôle retirés (sauts de ligne gardés si multiline), bornes coupées. */
export function cleanText(value, max, { multiline = false } = {}) {
  let text = String(value ?? '').normalize('NFC');
  text = multiline
    ? text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\n{3,}/g, '\n\n')
    : text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n').trim();
  return Array.from(text).slice(0, max).join('').trim();
}

/** Valeur d'un <select> de surcharge AI Act : '' ⇒ null ; niveau valide ⇒ niveau ; sinon undefined. */
export function parseAiOverride(value) {
  if (value === null || value === undefined || value === '') return null;
  return isAiActLevel(value) ? value : undefined;
}

/** Valeur d'un <select> de surcharge des données : '' ⇒ null ; '0'..'3' ⇒ nombre ; sinon undefined. */
export function parseDataOverride(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : (/^[0-3]$/.test(String(value)) ? Number(value) : NaN);
  return isDataLevel(n) ? n : undefined;
}

/** Évaluation stockée normalisée (surcharges invalides ignorées, comme dans consolidate). */
export function normalizeAssessment(previous, campaignId, usageKey) {
  const base = emptyAssessment(campaignId, usageKey);
  if (!previous || typeof previous !== 'object') return base;
  return {
    ...previous,
    campaign_id: campaignId,
    usage_key: usageKey,
    override_ai_act_level: isAiActLevel(previous.override_ai_act_level) ? previous.override_ai_act_level : null,
    override_data_level: isDataLevel(previous.override_data_level) ? previous.override_data_level : null,
    justification: typeof previous.justification === 'string' ? previous.justification : '',
    owner: typeof previous.owner === 'string' ? previous.owner : '',
    validation_status: VALIDATION_STATUSES.includes(previous.validation_status) ? previous.validation_status : 'to_review',
    history: Array.isArray(previous.history) ? previous.history.filter((h) => h && typeof h === 'object') : [],
    updated_at: typeof previous.updated_at === 'string' ? previous.updated_at : null,
  };
}

/**
 * Applique une saisie à une évaluation.
 * input : { override_ai_act_level, override_data_level, justification, validation_status, owner }
 *   (valeurs de formulaire : '' = niveau calculé ; les clés absentes sont conservées)
 * → { ok, errors: [{ field, code }], changed, value, changes: [{ field, from, to }] }
 * codes : invalid (valeur inconnue), justification_required, justification_short.
 */
export function updateAssessment(previous, input, { campaignId, usageKey, now = new Date().toISOString() } = {}) {
  const current = normalizeAssessment(previous, campaignId, usageKey);
  const errors = [];
  const next = { ...current };
  const src = input && typeof input === 'object' ? input : {};

  if (Object.hasOwn(src, 'override_ai_act_level')) {
    const v = parseAiOverride(src.override_ai_act_level);
    if (v === undefined) errors.push({ field: 'override_ai_act_level', code: 'invalid' });
    else next.override_ai_act_level = v;
  }
  if (Object.hasOwn(src, 'override_data_level')) {
    const v = parseDataOverride(src.override_data_level);
    if (v === undefined) errors.push({ field: 'override_data_level', code: 'invalid' });
    else next.override_data_level = v;
  }
  if (Object.hasOwn(src, 'validation_status')) {
    if (VALIDATION_STATUSES.includes(src.validation_status)) next.validation_status = src.validation_status;
    else errors.push({ field: 'validation_status', code: 'invalid' });
  }
  if (Object.hasOwn(src, 'owner')) next.owner = cleanText(src.owner, OWNER_MAX);

  const changes = TRACKED_FIELDS.filter((field) => next[field] !== current[field]).map((field) => ({ field, from: current[field], to: next[field] }));
  const overrideChanged = changes.some((c) => OVERRIDE_FIELDS.includes(c.field));
  const justification = cleanText(src.justification, JUSTIFICATION_MAX, { multiline: true });
  if (overrideChanged) {
    if (justification === '') errors.push({ field: 'justification', code: 'justification_required' });
    else if (Array.from(justification).length < JUSTIFICATION_MIN) errors.push({ field: 'justification', code: 'justification_short' });
  }

  if (errors.length > 0) return { ok: false, errors, changed: false, value: current, changes };
  if (changes.length === 0) return { ok: true, errors: [], changed: false, value: current, changes };

  const entries = changes.map((c) => ({
    at: now,
    field: c.field,
    from: c.from,
    to: c.to,
    justification: OVERRIDE_FIELDS.includes(c.field) ? justification : '',
  }));
  next.history = [...current.history, ...entries].slice(-HISTORY_MAX);
  if (overrideChanged) next.justification = justification;
  next.updated_at = now;
  return { ok: true, errors: [], changed: true, value: next, changes };
}

/** Annule les surcharges (retour aux niveaux calculés), avec la justification fournie. */
export function revertOverrides(previous, { campaignId, usageKey, justification, now } = {}) {
  return updateAssessment(previous, { override_ai_act_level: '', override_data_level: '', justification }, { campaignId, usageKey, now });
}

/** Historique, du plus récent au plus ancien. */
export function historyNewestFirst(assessment) {
  const list = Array.isArray(assessment?.history) ? assessment.history.filter((h) => h && typeof h === 'object') : [];
  return list.map((entry, index) => ({ entry, index }))
    .sort((a, b) => String(b.entry.at ?? '').localeCompare(String(a.entry.at ?? '')) || b.index - a.index)
    .map(({ entry }) => entry);
}
