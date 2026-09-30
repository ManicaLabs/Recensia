// Création de campagne : logique pure (sans DOM), testée par tests/new.test.js.
//
// - validateCampaignForm : contrôle des champs saisis dans #/new (erreurs par champ), puis validation
//   du lien de collecte (src/crypto/link.js) avec un identifiant et une clé publique provisoires.
// - buildCampaign : campagne complète (ARCHITECTURE §3.2) à partir des valeurs validées et des clés.
//   Titre, entreprise, services et canaux STOCKÉS sont exactement ceux du lien normalisé
//   (validateCampaignConfig(campaignToLinkConfig(c)).value) : le formulaire répondant et l'import
//   comparent ensuite les services au caractère près.
// - draftCampaign / collectUrlLength : aperçu en direct de la longueur du lien de collecte.
// - passwordStrength : étape « Protégez votre clé » (le fichier lui-même : buildRecoveryFile,
//   src/services/recovery.js, commun avec l'onglet Paramètres).

import { cleanLine } from '../../engine/validate.js';
import { validateChannels, CHANNELS_MAX } from '../../share/channels.js';
import { validateCampaignConfig, campaignToLinkConfig, LINK_LIMITS, MODES } from '../../crypto/link.js';
import { isValidDay } from '../../crypto/codes.js';
import { b64urlEncode } from '../../crypto/b64url.js';
import { deflateJson } from '../../crypto/compress.js';

export const TITLE_MAX = LINK_LIMITS.title;
export const ORG_MAX = LINK_LIMITS.org;
export const DEPARTMENTS_MAX = LINK_LIMITS.depts;
export const DEPARTMENT_MAX = LINK_LIMITS.dept;
export { CHANNELS_MAX };

/** Longueur cible du lien de collecte (CDC §7.2) : au-delà, avertissement. */
export const LINK_TARGET_LENGTH = 1500;

/** Seuil de masquage des petits groupes (mode anonyme). */
export const MIN_GROUP_SIZE = Object.freeze({ min: 3, max: 20, default: 5 });

/** Mot de passe du fichier de récupération : longueur minimale (caractères). */
export const PASSWORD_MIN_LENGTH = 10;

/** Suggestions de services proposées en un clic (clés des libellés dans src/i18n/fr/new.json). */
export const DEPARTMENT_SUGGESTION_KEYS = Object.freeze([
  'direction', 'commercial', 'production', 'rh', 'comptabilite', 'service_client', 'marketing', 'informatique',
]);

// Identifiant et clé publique provisoires de l'aperçu : même alphabet et même longueur que les vrais
// (12 caractères base64url ; 65 octets 0x04‖X‖Y), contenu pseudo-aléatoire déterministe pour que la
// compression donne la même longueur qu'avec une vraie clé.
function pseudoRandomBytes(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

const PLACEHOLDER_PK_BYTES = pseudoRandomBytes(65, 20260929);
PLACEHOLDER_PK_BYTES[0] = 0x04;
export const PLACEHOLDER_PUBLIC_KEY = b64urlEncode(PLACEHOLDER_PK_BYTES);
export const PLACEHOLDER_ID = b64urlEncode(pseudoRandomBytes(9, 7));

function codePointLength(s) {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

function text(value) {
  return cleanLine(value ?? '');
}

/** Clé de comparaison de deux services (« RH » et « rh » sont des doublons). */
export function departmentKey(name) {
  return text(name).toLocaleLowerCase('fr-FR');
}

/**
 * Service candidat à l'ajout : null s'il est acceptable, sinon un code
 * ('empty' | 'too_long' | 'duplicate' | 'too_many').
 */
export function departmentIssue(list, candidate) {
  const name = text(candidate);
  if (!name) return 'empty';
  if (codePointLength(name) > DEPARTMENT_MAX) return 'too_long';
  const key = departmentKey(name);
  const current = Array.isArray(list) ? list : [];
  if (current.some((d) => departmentKey(d) === key)) return 'duplicate';
  if (current.filter((d) => text(d) !== '').length >= DEPARTMENTS_MAX) return 'too_many';
  return null;
}

/** Formulaire initial de #/new. */
export function defaultForm() {
  return {
    title: '',
    org_name: '',
    mode: 'anonymous',
    departments: [],
    department_required: false,
    closes_on: '',
    min_group_size: MIN_GROUP_SIZE.default,
    comments_exportable: false,
    group_by_department: false,
    channels: [],
  };
}

function parseGroupSize(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : NaN;
  const s = String(raw ?? '').trim();
  return /^\d{1,3}$/.test(s) ? Number(s) : NaN;
}

function effectiveDepartmentRequired(mode, requested, count) {
  if (mode === 'open') return true;
  return requested === true && count > 0;
}

/**
 * Erreurs du lien de collecte (src/crypto/link.js) ramenées aux champs du formulaire.
 * @param {{ field: string, code: string }[]} errors
 * @param {{ type: string }[]} channels canaux dans l'ordre du lien
 */
export function mapLinkErrors(errors, channels = []) {
  return (errors ?? []).map(({ field, code }) => {
    let m;
    if (field === 'title') return { field: 'title', code };
    if (field === 'org') return { field: 'org_name', code };
    if (field === 'mode') return { field: 'mode', code };
    if (field === 'depts') return { field: 'departments', code };
    if ((m = /^depts\[(\d+)\]$/.exec(field))) return { field: `departments.${m[1]}`, code, index: Number(m[1]) };
    if (field === 'closes') return { field: 'closes_on', code };
    if (field === 'channels') return { field: 'channels', code };
    if ((m = /^channels\[(\d+)\]/.exec(field))) {
      const type = channels[Number(m[1])]?.type;
      return type ? { field: `channels.${type}`, code, type } : { field: 'channels', code };
    }
    return { field: 'form', code };
  });
}

/**
 * Valide le formulaire de création.
 * @param {object} form valeurs brutes (voir defaultForm) ; channels = canaux cochés [{ type, target }]
 * @param {{ channelsData: object, today?: string }} options today : 'AAAA-MM-JJ' (date de clôture passée refusée)
 * @returns {{ ok: boolean, errors: { field: string, code: string, index?: number, type?: string }[],
 *             value: { title, org_name, mode, departments, settings } }}
 */
export function validateCampaignForm(form, { channelsData, today } = {}) {
  const f = form && typeof form === 'object' ? form : {};
  const errors = [];
  const add = (field, code, extra = {}) => errors.push({ field, code, ...extra });

  const title = text(f.title);
  if (!title) add('title', 'required');
  else if (codePointLength(title) > TITLE_MAX) add('title', 'too_long');

  const org = text(f.org_name);
  if (codePointLength(org) > ORG_MAX) add('org_name', 'too_long');

  const mode = MODES.includes(f.mode) ? f.mode : null;
  if (!mode) add('mode', 'required');

  const rawDepartments = Array.isArray(f.departments) ? f.departments : [];
  const departments = [];
  const seen = new Set();
  rawDepartments.forEach((raw, index) => {
    const name = text(raw);
    const field = `departments.${index}`;
    if (!name) return add(field, 'empty', { index });
    if (codePointLength(name) > DEPARTMENT_MAX) return add(field, 'too_long', { index });
    const key = departmentKey(name);
    if (seen.has(key)) return add(field, 'duplicate', { index });
    seen.add(key);
    departments.push(name);
    return undefined;
  });
  if (rawDepartments.length > DEPARTMENTS_MAX) add('departments', 'too_many');
  if (mode === 'open' && departments.length === 0) add('departments', 'required_open');

  let closesOn = null;
  const closesRaw = String(f.closes_on ?? '').trim();
  if (closesRaw) {
    if (!isValidDay(closesRaw)) add('closes_on', 'invalid_date');
    else if (typeof today === 'string' && isValidDay(today) && closesRaw < today) add('closes_on', 'past');
    else closesOn = closesRaw;
  }

  let minGroupSize = parseGroupSize(f.min_group_size);
  const inRange = Number.isInteger(minGroupSize) && minGroupSize >= MIN_GROUP_SIZE.min && minGroupSize <= MIN_GROUP_SIZE.max;
  if (!inRange) {
    // Le seuil ne s'applique qu'au mode anonyme : en mode nominatif, une valeur invalide est remplacée.
    if (mode === 'anonymous') add('min_group_size', 'range');
    minGroupSize = MIN_GROUP_SIZE.default;
  }

  const rawChannels = Array.isArray(f.channels) ? f.channels.filter((c) => c && typeof c === 'object') : [];
  if (rawChannels.length > CHANNELS_MAX) add('channels', 'too_many');
  if (mode === 'anonymous' && rawChannels.length === 0) add('channels', 'required_anonymous');
  const checked = validateChannels(rawChannels.slice(0, CHANNELS_MAX), channelsData);
  for (const e of checked.errors) {
    if (e.index < 0) {
      if (e.code !== 'too_many') add('channels', e.code);
      continue;
    }
    const type = rawChannels[e.index]?.type;
    if (typeof type === 'string') add(`channels.${type}`, e.code, { type });
    else add('channels', e.code);
  }

  const value = {
    title,
    org_name: org,
    mode: mode ?? 'anonymous',
    departments,
    settings: {
      min_group_size: minGroupSize,
      department_required: effectiveDepartmentRequired(mode, f.department_required, departments.length),
      comments_exportable: f.comments_exportable === true,
      closes_on: closesOn,
      group_by_department: f.group_by_department === true,
      channels: checked.value,
    },
  };

  if (!errors.length) {
    // Dernier contrôle, celui du lien lui-même (caractères refusés, adresse stricte…).
    const draft = { ...value, id: PLACEHOLDER_ID, public_key: PLACEHOLDER_PUBLIC_KEY };
    const link = validateCampaignConfig(campaignToLinkConfig(draft));
    if (!link.ok) errors.push(...mapLinkErrors(link.errors, value.settings.channels));
    else applyLinkValue(value, link.value);
  }
  return { ok: errors.length === 0, errors, value };
}

function applyLinkValue(target, config) {
  target.title = config.title;
  target.org_name = config.org;
  target.departments = [...config.depts];
  target.settings.channels = (config.channels ?? []).map((c) => ({ ...c }));
}

/**
 * Campagne complète (ARCHITECTURE §3.2) à partir des valeurs validées et des clés générées.
 * Les champs repris dans le lien sont remplacés par leur version normalisée par le lien.
 * @param {object} value valeur renvoyée par validateCampaignForm
 * @param {{ id: string, publicKey: string, privateKeyJwk: object, fingerprint: string, createdAt: string }} keys
 * @returns {{ ok: boolean, errors: object[], campaign: object|null }}
 */
export function buildCampaign(value, { id, publicKey, privateKeyJwk, fingerprint, createdAt }) {
  const s = value.settings;
  const campaign = {
    id,
    title: value.title,
    org_name: value.org_name,
    mode: value.mode,
    departments: [...value.departments],
    settings: {
      min_group_size: s.min_group_size,
      department_required: effectiveDepartmentRequired(value.mode, s.department_required, value.departments.length),
      comments_exportable: s.comments_exportable === true,
      closes_on: s.closes_on ?? null,
      group_by_department: s.group_by_department === true,
      channels: (s.channels ?? []).map((c) => ({ ...c })),
    },
    public_key: publicKey,
    private_key_jwk: privateKeyJwk,
    fingerprint,
    created_at: createdAt,
    demo: false,
    last_backup_at: null,
    recovery_saved_at: null,
  };
  const link = validateCampaignConfig(campaignToLinkConfig(campaign));
  if (!link.ok) return { ok: false, errors: mapLinkErrors(link.errors, campaign.settings.channels), campaign: null };
  applyLinkValue(campaign, link.value);
  return { ok: true, errors: [], campaign };
}

/**
 * Campagne provisoire pour l'aperçu en direct : valeurs nettoyées, entrées invalides ignorées,
 * identifiant et clé publique provisoires. Ne lève jamais d'exception.
 */
export function draftCampaign(form, channelsData) {
  const f = form && typeof form === 'object' ? form : {};
  const mode = MODES.includes(f.mode) ? f.mode : 'anonymous';
  const seen = new Set();
  const departments = [];
  for (const raw of Array.isArray(f.departments) ? f.departments : []) {
    const name = text(raw);
    const key = departmentKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    departments.push(name);
  }
  let channels = [];
  try {
    channels = validateChannels((Array.isArray(f.channels) ? f.channels : []).slice(0, CHANNELS_MAX), channelsData).value;
  } catch {
    channels = [];
  }
  const closes = String(f.closes_on ?? '').trim();
  return {
    id: PLACEHOLDER_ID,
    title: text(f.title),
    org_name: text(f.org_name),
    mode,
    departments: departments.slice(0, DEPARTMENTS_MAX),
    settings: {
      department_required: effectiveDepartmentRequired(mode, f.department_required, departments.length),
      closes_on: isValidDay(closes) ? closes : null,
      channels,
    },
    public_key: PLACEHOLDER_PUBLIC_KEY,
  };
}

/**
 * Longueur exacte du lien `${baseUrl}#/c/<payload>` d'une campagne, sans validation
 * (identique à buildCollectUrl(baseUrl, campaign).length pour une campagne valide).
 */
export function collectUrlLength(baseUrl, campaign) {
  const base = String(baseUrl ?? '').split('#')[0];
  const payload = b64urlEncode(deflateJson(campaignToLinkConfig(campaign)));
  return base.length + '#/c/'.length + payload.length;
}

/** { length, target, over } : le lien dépasse-t-il la cible de 1 500 caractères ? */
export function linkLengthStatus(length, target = LINK_TARGET_LENGTH) {
  return { length, target, over: length > target };
}

/**
 * Force indicative d'un mot de passe (aucune promesse : seulement une aide).
 * → { level: 'empty' | 'too_short' | 'weak' | 'fair' | 'good' | 'strong', ok, length }
 * ok : longueur minimale atteinte et mot de passe non trivial.
 */
export function passwordStrength(password) {
  const pw = typeof password === 'string' ? password.normalize('NFC') : '';
  const length = codePointLength(pw);
  if (length === 0) return { level: 'empty', ok: false, length };
  if (length < PASSWORD_MIN_LENGTH) return { level: 'too_short', ok: false, length };
  const unique = new Set(pw.toLocaleLowerCase('fr-FR')).size;
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}]/u].filter((re) => re.test(pw)).length;
  const sequence = isSequence(pw);
  if (unique <= 3 || sequence) return { level: 'weak', ok: false, length };
  let level = 'fair';
  if (length >= 20 || (length >= 16 && classes >= 2) || (length >= 14 && classes >= 3)) level = 'strong';
  else if (length >= 14 || (length >= 12 && classes >= 3)) level = 'good';
  if (unique < 6 && level !== 'fair') level = 'fair';
  return { level, ok: true, length };
}

function isSequence(pw) {
  const s = pw.toLowerCase();
  const runs = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'azertyuiop', 'qwertyuiop'];
  return runs.some((run) => (run + run).includes(s) || (run + run).split('').reverse().join('').includes(s));
}
