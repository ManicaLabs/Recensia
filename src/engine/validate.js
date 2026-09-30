// Validation stricte d'un usage (§3.1) et d'un répondant, d'après data/questionnaire.json.
// Utilisée pour la saisie comme pour les codes déchiffrés : aucune donnée n'est acceptée
// sans passer par ici. Module pur : le questionnaire est passé en paramètre.
//
// Codes d'erreur : not_object, unknown_field, required, invalid_type, invalid_value, too_long,
// too_few, duplicate, exclusive, not_allowed, invalid_email, invalid_mode.

import { evaluateCondition } from './evaluate.js';

export const SCHEMA_VERSION = 1;

export const NAME_MAX = 60;
export const EMAIL_MAX = 254;
const DEPARTMENT_MAX = 80;

// Caractères de contrôle C0/C1 (hors saut de ligne, traité à part).
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
// Caractères de mise en forme invisibles (catégorie Unicode Cf) : bidi, espaces sans chasse, trait d'union
// conditionnel, opérateurs invisibles, étiquettes Unicode (texte caché)… et remplisseurs hangûl (lettres sans
// glyphe : U+115F, U+1160, U+3164, U+FFA0). Seuls les liants U+200C et U+200D, nécessaires à certaines
// écritures et aux émojis composés, sont conservés. Même définition dans src/crypto/link.js (textes du lien)
// et src/share/channels.js (sanitizeText) : tests/validate.test.js vérifie que les trois chemins concordent.
const FORMAT = /(?![\u200C\u200D])[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;
const MODES = ['anonymous', 'open'];
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(\.[^\s@<>()[\]\\,;:".]+)+$/;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function length(s) {
  return [...s].length;
}

/**
 * Retire les demi-codets isolés (chaîne mal formée) : ils feraient échouer plus loin
 * encodeURIComponent (URIError) et seraient remplacés par U+FFFD à l'encodage.
 */
function dropLoneSurrogates(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0xd800 || cp > 0xdfff) out += ch;
  }
  return out;
}

/**
 * Texte d'une ligne : contrôles, bidi et invisibles retirés, espaces normalisés, rogné.
 * La normalisation NFC suit les retraits (« e », U+200B, U+0301 donne « é ») : le résultat est stable,
 * cleanLine(cleanLine(x)) === cleanLine(x).
 */
export function cleanLine(s) {
  return dropLoneSurrogates(String(s))
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(CONTROL, '')
    .replace(FORMAT, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texte multiligne : idem, en conservant les sauts de ligne (au plus une ligne vide). */
export function cleanMultiline(s) {
  return dropLoneSurrogates(String(s))
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(FORMAT, '')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function normalizeText(def, raw, errors, key) {
  if (typeof raw !== 'string') {
    errors.push({ field: key, code: 'invalid_type' });
    return null;
  }
  const text = def.type === 'textarea' ? cleanMultiline(raw) : cleanLine(raw);
  if (text === '') return null;
  if (Number.isInteger(def.max) && length(text) > def.max) {
    errors.push({ field: key, code: 'too_long' });
    return null;
  }
  return text;
}

function normalizeChoice(def, raw, errors, key) {
  if (typeof raw !== 'string') {
    errors.push({ field: key, code: 'invalid_type' });
    return null;
  }
  if (!(def.options ?? []).some((o) => o.value === raw)) {
    errors.push({ field: key, code: 'invalid_value' });
    return null;
  }
  return raw;
}

function normalizeMulti(def, raw, errors, key) {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    errors.push({ field: key, code: 'invalid_type' });
    return null;
  }
  const values = (def.options ?? []).map((o) => o.value);
  if (raw.some((x) => !values.includes(x))) {
    errors.push({ field: key, code: 'invalid_value' });
    return null;
  }
  if (new Set(raw).size !== raw.length) {
    errors.push({ field: key, code: 'duplicate' });
    return null;
  }
  const exclusive = def.exclusive ?? [];
  if (raw.length > 1 && raw.some((x) => exclusive.includes(x))) {
    errors.push({ field: key, code: 'exclusive' });
    return null;
  }
  if (raw.length === 0) return null;
  if (Number.isInteger(def.min) && raw.length < def.min) {
    errors.push({ field: key, code: 'too_few' });
    return null;
  }
  // Ordre canonique : celui des options du questionnaire.
  return values.filter((v) => raw.includes(v));
}

function normalizeDepartment(raw, departments, errors, key) {
  if (typeof raw !== 'string') {
    errors.push({ field: key, code: 'invalid_type' });
    return null;
  }
  const text = cleanLine(raw);
  if (text === '') return null;
  if (Array.isArray(departments)) {
    if (!departments.includes(text)) {
      errors.push({ field: key, code: 'invalid_value' });
      return null;
    }
  } else if (length(text) > DEPARTMENT_MAX) {
    errors.push({ field: key, code: 'too_long' });
    return null;
  }
  return text;
}

function normalizeField(def, raw, errors, key, options) {
  switch (def.type) {
    case 'text':
    case 'textarea':
      return normalizeText(def, raw, errors, key);
    case 'select':
    case 'radio':
      return normalizeChoice(def, raw, errors, key);
    case 'multi':
      return normalizeMulti(def, raw, errors, key);
    case 'department':
      return normalizeDepartment(raw, options.departments, errors, key);
    default:
      errors.push({ field: key, code: 'invalid_type' });
      return null;
  }
}

function isRequired(def, campaignOptions) {
  if (def.required === true) return true;
  if (def.required === 'campaign') {
    // Une campagne sans aucun service proposé ne peut pas l'exiger : rien ne serait valide.
    if (Array.isArray(campaignOptions.departments) && campaignOptions.departments.length === 0) return false;
    return campaignOptions.mode === 'open' || campaignOptions.department_required === true;
  }
  return false;
}

/**
 * Valide et normalise un usage.
 * @param {object} usage objet §3.1 (issu d'un formulaire ou d'un code déchiffré)
 * @param {object} questionnaire contenu de data/questionnaire.json
 * @param {{ departments?: string[], department_required?: boolean, mode?: 'anonymous'|'open' }} options
 * @returns {{ ok: boolean, errors: {field: string|null, code: string}[], value: object|null }}
 *   value : usage normalisé (toutes les clés présentes, champs facultatifs absents ⇒ null), null si erreur.
 */
export function validateUsage(usage, questionnaire, options = {}) {
  const campaignOptions = options ?? {};
  const fields = questionnaire?.fields ?? {};
  const errors = [];
  if (!isPlainObject(usage)) return { ok: false, errors: [{ field: null, code: 'not_object' }], value: null };
  if (campaignOptions.mode != null && !MODES.includes(campaignOptions.mode)) {
    return { ok: false, errors: [{ field: 'mode', code: 'invalid_mode' }], value: null };
  }

  for (const key of Object.keys(usage)) {
    if (!Object.hasOwn(fields, key)) errors.push({ field: key, code: 'unknown_field' });
  }

  // Première passe : normalisation de chaque champ fourni.
  const value = {};
  for (const [key, def] of Object.entries(fields)) {
    const raw = usage[key];
    value[key] = isEmpty(raw) ? null : normalizeField(def, raw, errors, key, campaignOptions);
  }

  // Seconde passe : présence (required, required_if, show_if) sur les valeurs normalisées.
  for (const [key, def] of Object.entries(fields)) {
    if (errors.some((e) => e.field === key)) continue;
    const visible = def.show_if ? evaluateCondition(def.show_if, value) : true;
    if (!visible) {
      if (value[key] !== null) errors.push({ field: key, code: 'not_allowed' });
      value[key] = null;
      continue;
    }
    const required = isRequired(def, campaignOptions) || (def.required_if ? evaluateCondition(def.required_if, value) : false);
    if (required && value[key] === null) errors.push({ field: key, code: 'required' });
  }

  return errors.length === 0 ? { ok: true, errors, value } : { ok: false, errors, value: null };
}

/**
 * Valide le répondant selon le mode de la campagne.
 * Ouvert : prénom et nom requis (1..60), e-mail facultatif mais valide.
 * Anonyme : aucun répondant (null ou absent).
 */
export function validateRespondent(respondent, mode) {
  if (mode === 'anonymous') {
    if (respondent === null || respondent === undefined) return { ok: true, errors: [], value: null };
    return { ok: false, errors: [{ field: 'respondent', code: 'not_allowed' }], value: null };
  }
  if (mode !== 'open') return { ok: false, errors: [{ field: 'mode', code: 'invalid_mode' }], value: null };
  if (respondent === null || respondent === undefined) {
    return { ok: false, errors: [{ field: 'respondent', code: 'required' }], value: null };
  }
  if (!isPlainObject(respondent)) return { ok: false, errors: [{ field: 'respondent', code: 'not_object' }], value: null };

  const errors = [];
  const allowed = ['first_name', 'last_name', 'email'];
  for (const key of Object.keys(respondent)) {
    if (!allowed.includes(key)) errors.push({ field: key, code: 'unknown_field' });
  }
  const value = { first_name: null, last_name: null, email: null };
  for (const key of ['first_name', 'last_name']) {
    const raw = respondent[key];
    if (isEmpty(raw)) {
      errors.push({ field: key, code: 'required' });
    } else if (typeof raw !== 'string') {
      errors.push({ field: key, code: 'invalid_type' });
    } else {
      const text = cleanLine(raw);
      if (text === '') errors.push({ field: key, code: 'required' });
      else if (length(text) > NAME_MAX) errors.push({ field: key, code: 'too_long' });
      else value[key] = text;
    }
  }
  const rawEmail = respondent.email;
  if (!isEmpty(rawEmail)) {
    if (typeof rawEmail !== 'string') {
      errors.push({ field: 'email', code: 'invalid_type' });
    } else {
      const email = cleanLine(rawEmail);
      if (email === '') value.email = null;
      else if (email.length > EMAIL_MAX) errors.push({ field: 'email', code: 'too_long' });
      else if (!EMAIL.test(email)) errors.push({ field: 'email', code: 'invalid_email' });
      else value.email = email;
    }
  }
  return errors.length === 0 ? { ok: true, errors, value } : { ok: false, errors, value: null };
}
