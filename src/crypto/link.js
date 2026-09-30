// Lien de collecte auto-porteur (CDC §7.2, §7.7 ; ARCHITECTURE §4.2).
//
// URL = `${baseUrl}#/c/${payload}`, payload = base64url(DEFLATE brut(JSON)) de
//   { v: 1, id, title, org, mode, depts: [], dreq?, pk, closes?, channels? }
// Le lien ne contient que des données publiques : la clé publique sait chiffrer, pas déchiffrer.
// campaignToLinkConfig ne recopie jamais la clé privée.
//
// Le décodage est strict : longueur plafonnée avant tout décodage, alphabet base64url seul,
// décompression en flux plafonnée, aucun octet après la fin du flux DEFLATE, JSON objet,
// clés connues seulement, valeurs bornées, caractères de contrôle et de contrôle bidirectionnel refusés.
//
// decodeCampaignLink est synchrone et ne vérifie que la forme de la clé publique (65 octets, 0x04).
// L'appartenance du point à la courbe P-256 exige WebCrypto (asynchrone) : le formulaire répondant
// (src/views/form.js) doit appeler verifyCampaignKey(config.pk) — ou utiliser directement
// decodeAndVerifyCampaignLink — avant d'afficher le questionnaire. encryptEntry échouerait de
// toute façon sur une clé invalide, mais trop tard pour le répondant.

import { B64URL_RE, b64urlDecode, b64urlEncode } from './b64url.js';
import { InflateError, deflateJson, inflateJson, inflateRaw } from './compress.js';
import { isCampaignId, isValidDay } from './codes.js';
import { decodePublicKey, importPublicKey } from './keys.js';

export const LINK_VERSION = 1;

// Ponctuation finale tolérée (et retirée) après un payload : jamais dans l'alphabet base64url.
const TRAILING_JUNK = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '»', "'", '"', '’', '…']);

/** Retire la ponctuation collée à la fin d'un lien (parcours linéaire depuis la fin, sans regex). */
export function stripTrailingJunk(s) {
  let end = s.length;
  while (end > 0 && TRAILING_JUNK.has(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}
/** Longueur maximale du payload (caractères), vérifiée avant tout décodage. */
export const LINK_MAX_PAYLOAD = 6000;
/** Plafond du JSON décompressé (octets). */
export const LINK_MAX_INFLATED = 16384;

export const LINK_LIMITS = Object.freeze({
  title: 80,
  org: 80,
  depts: 30,
  dept: 60,
  channels: 3,
  instruction: 200,
  email: 254,
});

export const MODES = Object.freeze(['anonymous', 'open']);
export const CHANNEL_TYPES = Object.freeze(['mailto', 'copy', 'file', 'share', 'teams', 'whatsapp']);

const CONFIG_KEYS = ['v', 'id', 'title', 'org', 'mode', 'depts', 'dreq', 'pk', 'closes', 'channels'];
const CHANNEL_KEYS = new Set(['type', 'target']);
const WHATSAPP_RE = /^[1-9][0-9]{6,14}$/;
const EMAIL_LOCAL_RE = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/;
const EMAIL_DOMAIN_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;
// Contrôles C0, DEL, C1, séparateurs de ligne/paragraphe Unicode, marques et contrôles bidirectionnels.
const FORBIDDEN_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

/**
 * Erreur de lien. code : 'format' (encodage, compression ou JSON illisible) · 'version' (v non pris en charge) ·
 * 'size' (trop long) · 'schema' (contenu non conforme ; détail dans `errors`).
 */
export class LinkError extends Error {
  constructor(code, message, errors = []) {
    super(message || LINK_MESSAGES[code] || 'Lien invalide.');
    this.name = 'LinkError';
    this.code = code;
    this.errors = errors;
  }
}

const LINK_MESSAGES = {
  format: 'Lien de collecte illisible : il a peut-être été tronqué ou modifié.',
  version: 'Version de lien non prise en charge : mettez l’application à jour.',
  size: 'Lien de collecte trop long.',
  schema: 'Lien de collecte invalide.',
};

// --- Encodage / décodage ---------------------------------------------------

/**
 * Encode une configuration de lien (validée au préalable).
 * @param {object} config
 * @returns {string} payload base64url
 * @throws {LinkError}
 */
export function encodeCampaignLink(config) {
  const check = validateCampaignConfig(config);
  if (!check.ok) {
    const versionOnly = check.errors.every((e) => e.code === 'version');
    throw new LinkError(versionOnly ? 'version' : 'schema', undefined, check.errors);
  }
  const payload = b64urlEncode(deflateJson(check.value));
  if (payload.length > LINK_MAX_PAYLOAD) throw new LinkError('size');
  return payload;
}

/**
 * Décode et valide strictement un payload de lien (sans la vérification asynchrone du point P-256).
 * @param {string} payload
 * @returns {object} configuration normalisée
 * @throws {LinkError}
 */
export function decodeCampaignLink(payload) {
  if (typeof payload !== 'string' || payload.length === 0) throw new LinkError('format');
  if (payload.length > LINK_MAX_PAYLOAD) throw new LinkError('size');
  // Une messagerie colle parfois une ponctuation au lien (« …ABC). », « …ABC> ») : ces caractères
  // n'appartiennent jamais à l'alphabet base64url, on les retire avant la validation stricte.
  payload = stripTrailingJunk(payload);
  if (payload.length === 0) throw new LinkError('format');
  if (!B64URL_RE.test(payload)) throw new LinkError('format');
  let obj;
  let bytes;
  try {
    bytes = b64urlDecode(payload);
    obj = inflateJson(bytes, LINK_MAX_INFLATED);
  } catch (err) {
    if (err instanceof InflateError && err.reason === 'size') throw new LinkError('size');
    throw new LinkError('format');
  }
  if (hasTrailingBytes(bytes)) throw new LinkError('format');
  if (!isPlainObject(obj)) throw new LinkError('format');
  if (!Number.isInteger(obj.v)) throw new LinkError('schema', undefined, [{ field: 'v', code: 'required' }]);
  if (obj.v !== LINK_VERSION) throw new LinkError('version');
  const check = validateCampaignConfig(obj);
  if (!check.ok) throw new LinkError('schema', undefined, check.errors);
  return check.value;
}

/**
 * Vérifie que la clé publique d'un lien est un point P-256 importable par WebCrypto.
 * À appeler par le formulaire répondant après decodeCampaignLink.
 * @param {string} pk
 * @returns {Promise<true>}
 * @throws {LinkError} 'schema'
 */
export async function verifyCampaignKey(pk) {
  try {
    await importPublicKey(pk);
    return true;
  } catch {
    throw new LinkError('schema', 'Clé publique de campagne invalide.', [{ field: 'pk', code: 'invalid_key' }]);
  }
}

/**
 * decodeCampaignLink puis verifyCampaignKey.
 * @param {string} payload
 * @returns {Promise<object>}
 * @throws {LinkError}
 */
export async function decodeAndVerifyCampaignLink(payload) {
  const config = decodeCampaignLink(payload);
  await verifyCampaignKey(config.pk);
  return config;
}

// --- Validation ------------------------------------------------------------

/**
 * Valide une configuration de lien.
 * errors : [{ field, code }] avec code ∈ required · type · unknown · version · pattern · enum · chars ·
 * too_short · too_long · too_many · duplicate · invalid_date · invalid_key · invalid_email · forbidden.
 * value : configuration normalisée (textes NFC sans espaces de bord, clés dans l'ordre canonique,
 * champs facultatifs nuls ou vides omis).
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: { field: string, code: string }[], value: object|null }}
 */
export function validateCampaignConfig(obj) {
  const errors = [];
  const err = (field, code) => errors.push({ field, code });
  if (!isPlainObject(obj)) return { ok: false, errors: [{ field: '', code: 'type' }], value: null };

  for (const key of Object.keys(obj)) if (!CONFIG_KEYS.includes(key)) err(key.slice(0, 40), 'unknown');

  const value = { v: LINK_VERSION };
  if (obj.v === undefined) err('v', 'required');
  else if (obj.v !== LINK_VERSION) err('v', Number.isInteger(obj.v) ? 'version' : 'type');

  if (!isCampaignId(obj.id)) err('id', obj.id === undefined ? 'required' : 'pattern');
  else value.id = obj.id;

  const title = checkText(obj.title, 1, LINK_LIMITS.title);
  if (title.error) err('title', title.error);
  else value.title = title.value;

  const org = checkText(obj.org, 0, LINK_LIMITS.org);
  if (org.error) err('org', org.error);
  else value.org = org.value;

  if (obj.mode === undefined) err('mode', 'required');
  else if (!MODES.includes(obj.mode)) err('mode', 'enum');
  else value.mode = obj.mode;

  if (obj.depts === undefined) err('depts', 'required');
  else if (!Array.isArray(obj.depts)) err('depts', 'type');
  else if (obj.depts.length > LINK_LIMITS.depts) err('depts', 'too_many');
  else {
    const seen = new Set();
    const depts = [];
    obj.depts.forEach((d, i) => {
      const t = checkText(d, 1, LINK_LIMITS.dept);
      if (t.error) return err(`depts[${i}]`, t.error);
      if (seen.has(t.value)) return err(`depts[${i}]`, 'duplicate');
      seen.add(t.value);
      depts.push(t.value);
    });
    value.depts = depts;
  }

  if (obj.dreq != null) {
    if (typeof obj.dreq !== 'boolean') err('dreq', 'type');
    else value.dreq = obj.dreq;
  }

  if (obj.pk === undefined) err('pk', 'required');
  else if (typeof obj.pk !== 'string') err('pk', 'type');
  else {
    try {
      decodePublicKey(obj.pk);
      value.pk = obj.pk;
    } catch {
      err('pk', 'invalid_key');
    }
  }

  if (obj.closes != null) {
    if (!isValidDay(obj.closes)) err('closes', 'invalid_date');
    else value.closes = obj.closes;
  }

  if (obj.channels != null) {
    if (!Array.isArray(obj.channels)) err('channels', 'type');
    else if (obj.channels.length > LINK_LIMITS.channels) err('channels', 'too_many');
    else {
      const types = new Set();
      const channels = [];
      obj.channels.forEach((c, i) => {
        const ch = checkChannel(c, `channels[${i}]`, err);
        if (!ch) return;
        if (types.has(ch.type)) return err(`channels[${i}].type`, 'duplicate');
        types.add(ch.type);
        channels.push(ch);
      });
      if (channels.length) value.channels = channels;
    }
  }

  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors: [], value };
}

function checkChannel(c, field, err) {
  if (!isPlainObject(c)) {
    err(field, 'type');
    return null;
  }
  let ok = true;
  for (const key of Object.keys(c)) {
    if (!CHANNEL_KEYS.has(key)) {
      err(`${field}.${key.slice(0, 40)}`, 'unknown');
      ok = false;
    }
  }
  if (!CHANNEL_TYPES.includes(c.type)) {
    err(`${field}.type`, c.type === undefined ? 'required' : 'enum');
    return null;
  }
  const out = { type: c.type };
  const target = c.target;
  const hasTarget = target != null;
  if (hasTarget && typeof target !== 'string') {
    err(`${field}.target`, 'type');
    return null;
  }
  switch (c.type) {
    case 'mailto':
      if (!hasTarget || target === '') {
        err(`${field}.target`, 'required');
        ok = false;
      } else if (!isStrictEmail(target)) {
        err(`${field}.target`, 'invalid_email');
        ok = false;
      } else out.target = target;
      break;
    case 'copy':
    case 'file':
      if (hasTarget) {
        const t = checkText(target, 0, LINK_LIMITS.instruction);
        if (t.error) {
          err(`${field}.target`, t.error);
          ok = false;
        } else if (t.value) out.target = t.value;
      }
      break;
    case 'whatsapp':
      if (hasTarget && target !== '') {
        if (!WHATSAPP_RE.test(target)) {
          err(`${field}.target`, 'pattern');
          ok = false;
        } else out.target = target;
      }
      break;
    default: // share, teams : aucune cible
      if (hasTarget) {
        err(`${field}.target`, 'forbidden');
        ok = false;
      }
  }
  return ok ? out : null;
}

/**
 * Adresse e-mail stricte pour un lien `mailto` : ASCII, partie locale sans point initial, final ou double,
 * domaine à au moins deux labels, 254 caractères au plus. Aucun caractère de structure d'URL (? & # % , ;).
 * @param {string} s
 * @returns {boolean}
 */
export function isStrictEmail(s) {
  if (typeof s !== 'string' || s.length > LINK_LIMITS.email) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return local.length <= 64 && domain.length <= 253 && EMAIL_LOCAL_RE.test(local) && EMAIL_DOMAIN_RE.test(domain);
}

/**
 * Vrai si le texte contient un caractère interdit dans un champ issu du lien : contrôles (C0, DEL, C1),
 * séparateurs U+2028/U+2029, marques et contrôles bidirectionnels (U+061C, U+200E, U+200F,
 * U+202A–U+202E, U+2066–U+2069) ou surrogate isolé.
 * @param {string} s
 * @returns {boolean}
 */
export function hasForbiddenChars(s) {
  if (FORBIDDEN_CHARS_RE.test(s)) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function checkText(v, min, max) {
  if (v === undefined) return { error: 'required' };
  if (typeof v !== 'string') return { error: 'type' };
  if (hasForbiddenChars(v)) return { error: 'chars' };
  const value = v.normalize('NFC').trim();
  const n = codePointLength(value);
  if (n < min) return { error: min === 1 && n === 0 ? 'required' : 'too_short' };
  if (n > max) return { error: 'too_long' };
  return { value };
}

function codePointLength(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// --- Campagne → lien -------------------------------------------------------

/**
 * Configuration de lien d'une campagne (ARCHITECTURE §3.2). Ne recopie QUE les champs publics :
 * id, title, org_name, mode, departments, settings.department_required, public_key,
 * settings.closes_on, settings.channels ({ type, target } seulement). Jamais private_key_jwk.
 * @param {object} campaign
 * @returns {object} config (à valider par encodeCampaignLink)
 */
export function campaignToLinkConfig(campaign) {
  if (!isPlainObject(campaign)) throw new TypeError('campaignToLinkConfig : campagne attendue.');
  const settings = isPlainObject(campaign.settings) ? campaign.settings : {};
  const config = {
    v: LINK_VERSION,
    id: campaign.id,
    title: campaign.title,
    org: campaign.org_name ?? '',
    mode: campaign.mode,
    depts: Array.isArray(campaign.departments) ? [...campaign.departments] : [],
  };
  if (settings.department_required === true) config.dreq = true;
  config.pk = campaign.public_key;
  if (settings.closes_on) config.closes = settings.closes_on;
  if (Array.isArray(settings.channels) && settings.channels.length) {
    config.channels = settings.channels.map((c) => {
      const ch = { type: c?.type };
      if (c?.target != null && c.target !== '') ch.target = c.target;
      return ch;
    });
  }
  return config;
}

/**
 * Lien de collecte complet : `${baseUrl}#/c/${payload}` (un éventuel fragment de baseUrl est retiré).
 * @param {string} baseUrl ex. 'https://manicalabs.github.io/Recensia/'
 * @param {object} campaign
 * @returns {string}
 * @throws {LinkError}
 */
export function buildCollectUrl(baseUrl, campaign) {
  if (typeof baseUrl !== 'string') throw new TypeError('buildCollectUrl : URL de base attendue.');
  const base = baseUrl.split('#')[0];
  return `${base}#/c/${encodeCampaignLink(campaignToLinkConfig(campaign))}`;
}

/**
 * Vrai si des octets suivent le bloc final du flux DEFLATE (fflate les ignore sans erreur).
 * Un flux sans excédent se termine dans son dernier octet : privé de celui-ci, il devient
 * incomplet. S'il reste décodable, le dernier octet était superflu.
 */
function hasTrailingBytes(bytes) {
  try {
    inflateRaw(bytes.subarray(0, bytes.length - 1), LINK_MAX_INFLATED);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
