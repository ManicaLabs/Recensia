// Codes de réponse chiffrés (CDC §7.2, ARCHITECTURE §4.2).
//
// Code  = 'RCN1.' + base64url(0x01 ‖ clé publique éphémère brute (65) ‖ IV (12) ‖ chiffré + tag (16))
// Clé   = ECDH(éphémère, pk) sur 256 bits → HKDF-SHA-256 (sel = clé publique éphémère brute,
//         info = UTF-8 'recensia-v1|' + campaign_id) → AES-256-GCM, tag de 128 bits
// AAD   = UTF-8(campaign_id)
// Clair = DEFLATE brut du JSON UTF-8 :
//         { v: 1, sv: 1, campaign_id, entry_id, rev, submitted_day, submitted_at?, respondent?, usage }
//
// Une clé éphémère et un IV neufs sont tirés pour CHAQUE code : deux codes au contenu
// identique sont différents et ne peuvent pas être reliés entre eux.

import { B64URL_RE, b64urlDecode, b64urlEncode } from './b64url.js';
import { InflateError, deflateRaw, inflateRaw, utf8Decode, utf8Encode } from './compress.js';
import { EC_ALGORITHM, PUBLIC_KEY_BYTES, importPrivateKey, importPublicKey, importRawPublicKey, normalizePrivateJwk, toHex } from './keys.js';
import { randomBytes } from './random.js';

export const CODE_PREFIX = 'RCN1.';
/** Octet de version en tête du binaire. */
export const CODE_VERSION = 1;
/** Valeur du champ `v` du clair. */
export const PLAIN_VERSION = 1;
/** Versions du schéma du questionnaire (`sv`) lisibles par cette version de l'application. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);
/** Longueur maximale d'un code, préfixe compris (vérifiée avant tout décodage). */
export const CODE_MAX_LENGTH = 12000;
/** Plafond du clair JSON décompressé (octets). */
export const PLAIN_MAX_BYTES = 16384;

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const HEADER_BYTES = 1 + PUBLIC_KEY_BYTES + IV_BYTES;
/** Taille binaire minimale : en-tête + au moins un octet chiffré + tag. */
export const CODE_MIN_BYTES = HEADER_BYTES + 1 + TAG_BYTES;

const HKDF_INFO_PREFIX = 'recensia-v1|';
const PLAIN_KEYS = new Set(['v', 'sv', 'campaign_id', 'entry_id', 'rev', 'submitted_day', 'submitted_at', 'respondent', 'usage']);
const ENTRY_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
// Tout préfixe « RCNn. » est extrait : un code d'une version future doit arriver jusqu'à decryptEntry,
// qui répond 'version' (« mettez l'application à jour ») au lieu de le laisser disparaître sans message.
const CODE_IN_TEXT_RE = /RCN[1-9][0-9]{0,2}\.[A-Za-z0-9_-]+/g;

const subtle = () => globalThis.crypto.subtle;

/**
 * Erreur de code. reason :
 * 'format' (préfixe, alphabet, taille minimale, contenu illisible) · 'version' (version non prise en charge) ·
 * 'size' (code ou clair trop long) · 'decrypt' (déchiffrement impossible : mauvaise clé, code altéré,
 * autre campagne) · 'campaign' (clair d'une autre campagne) · 'schema' (structure du clair invalide).
 */
export class CodeError extends Error {
  constructor(reason, message) {
    super(message || MESSAGES[reason] || 'Code invalide.');
    this.name = 'CodeError';
    this.reason = reason;
  }
}

const MESSAGES = {
  format: 'Code mal formé.',
  version: 'Version de code non prise en charge : mettez l’application à jour.',
  size: 'Code trop volumineux.',
  decrypt: 'Déchiffrement impossible (clé différente, code altéré ou autre campagne).',
  campaign: 'Ce code appartient à une autre campagne.',
  schema: 'Contenu du code invalide.',
};

// --- Chiffrement -----------------------------------------------------------

/**
 * Chiffre un usage déclaré pour la clé publique d'une campagne.
 * `plain.v` et `plain.campaign_id` sont facultatifs (complétés) mais doivent correspondre s'ils sont fournis ;
 * `sv` vaut 1 par défaut. `submitted_at` et `respondent` nuls sont omis.
 * @param {object} plain
 * @param {string} publicKeyB64 clé publique de campagne (base64url, 65 octets)
 * @param {string} campaignId
 * @returns {Promise<string>} 'RCN1.…'
 * @throws {CodeError}
 */
export async function encryptEntry(plain, publicKeyB64, campaignId) {
  const ephemeral = await subtle().generateKey(EC_ALGORITHM, false, ['deriveBits']);
  const ephemeralRaw = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  return encryptWithEphemeral(plain, publicKeyB64, campaignId, ephemeral.privateKey, ephemeralRaw, randomBytes(IV_BYTES));
}

/**
 * INTERNE — réservé aux vecteurs de test déterministes (tests/vectors/codes-v1.json).
 * Même chiffrement que encryptEntry, avec une clé éphémère (JWK) et un IV imposés.
 * Ne jamais l'utiliser dans l'application : réutiliser une clé éphémère ou un IV casse la confidentialité.
 * @param {object} plain
 * @param {string} publicKeyB64
 * @param {string} campaignId
 * @param {{ ephemeralPrivateJwk: object, iv: Uint8Array }} injected
 */
export async function _encryptEntryWith(plain, publicKeyB64, campaignId, { ephemeralPrivateJwk, iv }) {
  const jwk = normalizePrivateJwk(ephemeralPrivateJwk);
  if (!(iv instanceof Uint8Array) || iv.length !== IV_BYTES) throw new TypeError('IV de 12 octets attendu.');
  const privateKey = await importPrivateKey(jwk);
  const raw = new Uint8Array(PUBLIC_KEY_BYTES);
  raw[0] = 0x04;
  raw.set(b64urlDecode(jwk.x), 1);
  raw.set(b64urlDecode(jwk.y), 33);
  return encryptWithEphemeral(plain, publicKeyB64, campaignId, privateKey, raw, iv);
}

async function encryptWithEphemeral(plain, publicKeyB64, campaignId, ephemeralPrivate, ephemeralRaw, iv) {
  assertCampaignId(campaignId);
  const canonical = canonicalPlain(plain, campaignId);
  const json = utf8Encode(JSON.stringify(canonical));
  if (json.length > PLAIN_MAX_BYTES) throw new CodeError('size', `Contenu trop volumineux (plus de ${PLAIN_MAX_BYTES} octets).`);

  let recipient;
  try {
    recipient = await importPublicKey(publicKeyB64);
  } catch {
    throw new CodeError('format', 'Clé publique de campagne invalide.');
  }
  const shared = await subtle().deriveBits({ name: 'ECDH', public: recipient }, ephemeralPrivate, 256);
  const aesKey = await deriveAesKey(shared, ephemeralRaw, campaignId, 'encrypt');
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8Encode(campaignId), tagLength: 128 }, aesKey, deflateRaw(json)),
  );

  const bytes = new Uint8Array(HEADER_BYTES + sealed.length);
  bytes[0] = CODE_VERSION;
  bytes.set(ephemeralRaw, 1);
  bytes.set(iv, 1 + PUBLIC_KEY_BYTES);
  bytes.set(sealed, HEADER_BYTES);
  const code = CODE_PREFIX + b64urlEncode(bytes);
  if (code.length > CODE_MAX_LENGTH) throw new CodeError('size');
  return code;
}

function canonicalPlain(plain, campaignId) {
  if (!isPlainObject(plain)) throw new CodeError('schema', 'Contenu du code : objet attendu.');
  for (const key of Object.keys(plain)) {
    if (!PLAIN_KEYS.has(key)) throw new CodeError('schema', `Contenu du code : champ inconnu « ${key.slice(0, 40)} ».`);
  }
  if (plain.v !== undefined && plain.v !== PLAIN_VERSION) throw new CodeError('version');
  if (plain.campaign_id !== undefined && plain.campaign_id !== campaignId) throw new CodeError('campaign');
  const out = {
    v: PLAIN_VERSION,
    sv: plain.sv === undefined ? SUPPORTED_SCHEMA_VERSIONS[SUPPORTED_SCHEMA_VERSIONS.length - 1] : plain.sv,
    campaign_id: campaignId,
    entry_id: plain.entry_id,
    rev: plain.rev,
    submitted_day: plain.submitted_day,
  };
  if (plain.submitted_at != null) out.submitted_at = plain.submitted_at;
  if (plain.respondent != null) out.respondent = plain.respondent;
  out.usage = plain.usage;
  const check = validatePlain(out, campaignId);
  if (!check.ok) throw new CodeError(check.reason, check.message);
  return out;
}

// --- Déchiffrement ---------------------------------------------------------

/**
 * Déchiffre et valide un code.
 * Contrôles, dans l'ordre : ceux de checkCodeFormat (type et longueur totale ≤ CODE_MAX_LENGTH avant
 * tout décodage, préfixe, alphabet base64url strict, taille minimale, octet de version), puis
 * déchiffrement authentifié, décompression en flux plafonnée à PLAIN_MAX_BYTES, JSON, structure du clair.
 * La validation fine de `usage` et `respondent` relève de src/engine/validate.js.
 * @param {string} code
 * @param {CryptoKey|object} privateKey clé privée ECDH (CryptoKey avec usage deriveBits) ou JWK
 * @param {string} campaignId campagne attendue
 * @returns {Promise<{ v: 1, sv: number, campaign_id: string, entry_id: string, rev: number,
 *   submitted_day: string, submitted_at: string|null, respondent: object|null, usage: object }>}
 * @throws {CodeError} (TypeError si la clé privée ou campaignId fournis sont inutilisables)
 */
export async function decryptEntry(code, privateKey, campaignId) {
  assertCampaignId(campaignId);
  const header = parseCode(code);
  if (!header.ok) throw new CodeError(header.reason, header.message);
  const { bytes } = header;

  const key = await resolvePrivateKey(privateKey);
  const ephemeralRaw = bytes.slice(1, 1 + PUBLIC_KEY_BYTES);
  const iv = bytes.slice(1 + PUBLIC_KEY_BYTES, HEADER_BYTES);
  const sealed = bytes.subarray(HEADER_BYTES);

  let compressed;
  try {
    const ephemeral = await importRawPublicKey(ephemeralRaw);
    const shared = await subtle().deriveBits({ name: 'ECDH', public: ephemeral }, key, 256);
    const aesKey = await deriveAesKey(shared, ephemeralRaw, campaignId, 'decrypt');
    compressed = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8Encode(campaignId), tagLength: 128 }, aesKey, sealed),
    );
  } catch {
    throw new CodeError('decrypt');
  }

  let parsed;
  try {
    parsed = JSON.parse(utf8Decode(inflateRaw(compressed, PLAIN_MAX_BYTES)));
  } catch (err) {
    if (err instanceof InflateError && err.reason === 'size') throw new CodeError('size', `Contenu décompressé supérieur à ${PLAIN_MAX_BYTES} octets.`);
    throw new CodeError('format', 'Contenu du code illisible.');
  }

  const check = validatePlain(parsed, campaignId);
  if (!check.ok) throw new CodeError(check.reason, check.message);
  return check.value;
}

/**
 * Contrôles préalables au déchiffrement, sans clé ni campagne (ceux de decryptEntry, dans le même
 * ordre) : type et longueur totale (≤ CODE_MAX_LENGTH, avant tout décodage), préfixe, alphabet
 * base64url strict, taille minimale, octet de version. Synchrone, sans cryptographie.
 * Un code accepté ici peut encore être refusé au déchiffrement ('decrypt', 'campaign', 'schema'…).
 * @param {unknown} code
 * @returns {null | 'format' | 'size' | 'version'} null si le code peut être soumis au déchiffrement ;
 *   sinon la raison que donnerait decryptEntry (CodeError.reason)
 */
export function checkCodeFormat(code) {
  const parsed = parseCode(code);
  return parsed.ok ? null : parsed.reason;
}

// → { ok: true, bytes } ou { ok: false, reason, message } (message précis ou celui de la raison).
function parseCode(code) {
  const fail = (reason, message) => ({ ok: false, reason, message: message || MESSAGES[reason] });
  if (typeof code !== 'string') return fail('format', 'Le code doit être une chaîne.');
  if (code.length > CODE_MAX_LENGTH) return fail('size');
  if (!code.startsWith(CODE_PREFIX)) {
    return /^RCN\d+\./.test(code) ? fail('version') : fail('format', 'Préfixe RCN1. absent.');
  }
  const body = code.slice(CODE_PREFIX.length);
  if (!B64URL_RE.test(body)) return fail('format', 'Caractère non autorisé dans le code.');
  let bytes;
  try {
    bytes = b64urlDecode(body);
  } catch {
    return fail('format', 'Encodage du code invalide.');
  }
  if (bytes.length < CODE_MIN_BYTES) return fail('format', 'Code tronqué.');
  if (bytes[0] !== CODE_VERSION) return fail('version');
  return { ok: true, bytes };
}

/**
 * Vérifie la structure d'un clair déchiffré (sans la validation fine de `usage`).
 * @param {unknown} obj
 * @param {string} campaignId campagne attendue
 * @returns {{ ok: true, value: object } | { ok: false, reason: string, field: string|null, message: string }}
 */
export function validatePlain(obj, campaignId) {
  const fail = (reason, field, message) => ({ ok: false, reason, field, message: message || MESSAGES[reason] });
  if (!isPlainObject(obj)) return fail('schema', null, 'Contenu du code : objet attendu.');
  if (!Number.isInteger(obj.v)) return fail('schema', 'v');
  if (obj.v !== PLAIN_VERSION) return fail('version', 'v');
  if (!Number.isInteger(obj.sv)) return fail('schema', 'sv');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(obj.sv)) return fail('version', 'sv', 'Version du questionnaire non prise en charge : mettez l’application à jour.');
  for (const key of Object.keys(obj)) {
    if (!PLAIN_KEYS.has(key)) return fail('schema', key.slice(0, 40), `Contenu du code : champ inconnu « ${key.slice(0, 40)} ».`);
  }
  if (typeof obj.campaign_id !== 'string') return fail('schema', 'campaign_id');
  if (obj.campaign_id !== campaignId) return fail('campaign', 'campaign_id');
  if (typeof obj.entry_id !== 'string' || !ENTRY_ID_RE.test(obj.entry_id)) return fail('schema', 'entry_id');
  if (!Number.isInteger(obj.rev) || obj.rev < 1 || obj.rev > 1000) return fail('schema', 'rev');
  if (!isValidDay(obj.submitted_day)) return fail('schema', 'submitted_day');
  if (obj.submitted_at != null && !isIsoTimestamp(obj.submitted_at)) return fail('schema', 'submitted_at');
  if (obj.respondent != null && !isPlainObject(obj.respondent)) return fail('schema', 'respondent');
  if (!isPlainObject(obj.usage)) return fail('schema', 'usage');
  return {
    ok: true,
    value: {
      v: obj.v,
      sv: obj.sv,
      campaign_id: obj.campaign_id,
      entry_id: obj.entry_id,
      rev: obj.rev,
      submitted_day: obj.submitted_day,
      submitted_at: obj.submitted_at ?? null,
      respondent: obj.respondent ?? null,
      usage: obj.usage,
    },
  };
}

// --- Extraction et empreinte -----------------------------------------------

// Codes recoupés par une messagerie. Un client de messagerie en texte brut recoupe les lignes (72 à 80 colonnes), éventuellement après
// une marque de citation (« > », « >> »). Un code qui se termine en fin de ligne peut donc se
// poursuivre sur les lignes suivantes. Sans déchiffrer, on ne peut pas savoir où il s'arrête : on
// produit une chaîne de candidats recollés, dont un « préféré » d'après la géométrie des lignes
// (seul le recollage exact se déchiffre : le tag AES-GCM écarte les autres).

/** Au-delà de cette longueur, une ligne n'a pas été recoupée par une messagerie. */
const WRAP_LINE_MAX = 200;
/** Tolérance (caractères) pour juger qu'une ligne recoupée est « pleine ». */
const WRAP_TOLERANCE = 2;
/** Au moins autant de caractères de code d'affilée sur une ligne : c'est une suite de code, pas du texte. */
const WRAP_DENSE_MIN = 40;
/** Nombre maximal de lignes recollées à un même code. */
const WRAP_MAX_LINES = 400;
/** Plus court que ce texte, un code est forcément incomplet (en-tête + 1 octet + tag). */
const CODE_MIN_TEXT = CODE_PREFIX.length + Math.ceil((CODE_MIN_BYTES * 4) / 3);
// Retrait de la marque de citation et de l'indentation (une seule classe de caractères, ancrée).
const QUOTE_PREFIX_RE = /^[>\s]+/;
const B64URL_RUN_RE = /^[A-Za-z0-9_-]+/;
// Une ligne qui commence par un autre code ou une adresse n'est pas la suite du code précédent.
const NOT_CONTINUATION_RE = /^(?:RCN[1-9][0-9]{0,2}\.|[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)/;
// Préfixe « RCNn. » coupé en fin de ligne (lien d'import à plusieurs codes : « …~RC⏎N1.… »).
// Testé sur les 8 derniers caractères seulement ; le point n'appartenant pas à l'alphabet des
// codes, un « RCNn. » à cheval sur deux lignes est toujours un début de code.
const PREFIX_TAIL_RE = /(?:RCN[1-9][0-9]{0,2}\.?|RCN|RC|R)$/;
const CODE_START_RE = /^RCN[1-9][0-9]{0,2}\.[A-Za-z0-9_-]+/;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

function continuationOf(line) {
  return line.trimEnd().replace(QUOTE_PREFIX_RE, '');
}

/**
 * Candidats d'un code dont le texte `code` finit en fin de la ligne `lines[next - 1]` (longueur
 * `firstLen`) : le code seul, puis recollé ligne après ligne (chaîne arrêtée au premier obstacle :
 * ligne vide, autre code, adresse, mot). Le recollage préféré suit la géométrie des lignes
 * (preferredJoin) ; les autres restent candidats.
 * → candidats sans doublon, le préféré en tête, puis une ligne de plus, une de moins, le code non
 *   recollé et le recollage complet.
 */
function wrapCandidates(lines, next, code, firstLen) {
  const parts = [code];
  const items = [];
  let length = code.length;
  for (let j = next; j < lines.length && parts.length <= WRAP_MAX_LINES && length < CODE_MAX_LENGTH; j += 1) {
    const raw = lines[j].trimEnd();
    const rest = raw.replace(QUOTE_PREFIX_RE, '');
    if (NOT_CONTINUATION_RE.test(rest)) break;
    const run = B64URL_RUN_RE.exec(rest)?.[0];
    if (!run) break;
    // Suivie d'une lettre ou d'un chiffre hors alphabet (« Réponses »…), la suite est un mot, pas une fin de code.
    if (run.length < rest.length && LETTER_OR_DIGIT_RE.test(rest[run.length])) break;
    const consumed = run.length === rest.length;
    parts.push(run);
    items.push({ len: raw.length, run: run.length, consumed });
    length += run.length;
    if (!consumed) break; // la suite s'arrête sur cette ligne (espace, ponctuation…)
  }
  const preferred = firstLen <= WRAP_LINE_MAX || code.length < CODE_MIN_TEXT ? preferredJoin(items, firstLen) : 0;
  const last = parts.length - 1;
  const joined = (n) => parts.slice(0, n + 1).join('');
  return [...new Set([preferred, preferred + 1, preferred - 1, 0, last])]
    .filter((n) => n >= 0 && n <= last)
    .map(joined);
}

/**
 * Nombre de suites à recoller (géométrie des lignes recoupées). Une ligne est retenue :
 * - après une ligne « pleine » (même largeur que les précédentes, à WRAP_TOLERANCE près) : la
 *   ligne suivante, plus courte, est la fin du code ;
 * - recoupage « en peigne » d'une citation recoupée à nouveau (72 colonnes, puis 4, puis 72…) :
 *   reconnu quand une ligne faite uniquement de caractères de code sur au moins WRAP_DENSE_MIN
 *   caractères (un texte a des espaces) suit une ou deux lignes courtes (les « dents »). Les dents
 *   suivantes doivent avoir la même longueur que les premières ; une dent plus courte, ou une ligne
 *   longue incomplète, termine le code.
 */
function preferredJoin(items, firstLen) {
  let width = firstLen;
  let prevFull = true; // la ligne du code est pleine par hypothèse
  let teeth = []; // longueurs des lignes courtes depuis la dernière ligne pleine
  let comb = null; // longueurs des dents du peigne reconnu
  let preferred = 0;
  const denseWithin = (k, max) => {
    for (let m = k; m < items.length && m <= k + max; m += 1) {
      if (items[m].run >= WRAP_DENSE_MIN) return true;
      if (!items[m].consumed) return false;
    }
    return false;
  };
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k];
    width = Math.max(width, item.len);
    const full = item.len >= width - WRAP_TOLERANCE;
    const tooth = comb !== null && teeth.length < comb.length && (prevFull || teeth.length > 0);
    let end = !item.consumed; // la suite s'arrête sur cette ligne
    if (tooth) {
      // Dent du peigne : jamais plus longue que la dent de référence ; plus courte, c'est la fin du code.
      if (item.len > comb[teeth.length]) break;
      if (item.len < comb[teeth.length]) end = true;
    } else if (comb !== null) {
      if (!full) end = true; // ligne longue incomplète : fin du code
    } else if (!prevFull) {
      // Après une ou deux lignes courtes : peigne si une ligne dense arrive aussitôt.
      if (teeth.length > 2 || !denseWithin(k, 2 - teeth.length)) break;
      if (item.run >= WRAP_DENSE_MIN) comb = teeth.slice();
    }
    preferred = k + 1;
    if (end) break;
    if (full) teeth = [];
    else teeth.push(item.len);
    prevFull = full;
  }
  return preferred;
}

/** Code dont le préfixe « RCNn. » est coupé entre `lines[i]` et `lines[i + 1]` ; null sinon. */
function splitPrefixCandidates(lines, i) {
  if (i + 1 >= lines.length) return null;
  const line = lines[i].trimEnd();
  const tail = PREFIX_TAIL_RE.exec(line.slice(-8))?.[0];
  if (!tail) return null;
  const rest = continuationOf(lines[i + 1]);
  const m = CODE_START_RE.exec(tail + rest.slice(0, CODE_MAX_LENGTH));
  if (!m) return null; // le point de « RCNn. » est à cheval : m[0] déborde toujours sur la ligne suivante
  const code = m[0];
  if (code.length - tail.length !== rest.length) return [code];
  return wrapCandidates(lines, i + 2, code, Math.max(line.length, lines[i + 1].trimEnd().length));
}

/**
 * Codes d'un texte avec leurs variantes recollées (ligne coupée par une messagerie).
 * → [{ code, candidates }] : `code` est le candidat préféré, `candidates` commence par lui, puis
 *   les autres recollages plausibles (une ligne de plus ou de moins, code non recollé, recollage
 *   complet), sans doublon. Une seule entrée par code du texte : au pipeline d'import de retenir le
 *   premier candidat qui se déchiffre et de ne compter qu'une réponse.
 * Parcours linéaire, ligne par ligne, sans expression à retour arrière.
 * @param {string} text
 * @returns {{ code: string, candidates: string[] }[]}
 */
export function extractCodeCandidates(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // « ~ » et « % » (de %7E) ne font pas partie de l'alphabet : ils séparent naturellement les codes.
    for (const match of line.matchAll(CODE_IN_TEXT_RE)) {
      const end = match.index + match[0].length;
      found.push(line.slice(end).trim() === '' ? wrapCandidates(lines, i + 1, match[0], line.trimEnd().length) : [match[0]]);
    }
    const split = splitPrefixCandidates(lines, i);
    if (split) found.push(split);
  }
  // Un même code peut figurer deux fois (lien d'import et code brut en secours) : si le préféré
  // d'une occurrence n'est confirmé par aucune autre mais que l'un de ses autres candidats est le
  // préféré d'une autre occurrence, c'est ce code-là (une seule réponse, recollage confirmé).
  const count = new Map();
  for (const candidates of found) count.set(candidates[0], (count.get(candidates[0]) ?? 0) + 1);
  const seen = new Set();
  const out = [];
  for (const candidates of found) {
    let code = candidates[0];
    if (count.get(code) === 1) code = candidates.find((c, k) => k > 0 && count.has(c)) ?? code;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, candidates: code === candidates[0] ? candidates : [code, ...candidates.filter((c) => c !== code)] });
  }
  return out;
}

/**
 * Trouve les codes dans un texte arbitraire (e-mail collé, fichier .rcn, liens d'import
 * '#/i/<code>~<code>', y compris avec « ~ » encodé en %7E). Dédoublonnés, ordre d'apparition conservé.
 * Un code recoupé sur plusieurs lignes (texte brut à 76 colonnes, citation « > ») est recollé
 * (candidat préféré de extractCodeCandidates).
 * Les codes d'une autre version du format (« RCN2. »…) sont aussi renvoyés : decryptEntry les refuse
 * avec la raison 'version'. Aucun contrôle cryptographique : decryptEntry s'en charge.
 * @param {string} text
 * @returns {string[]}
 */
export function extractCodes(text) {
  return extractCodeCandidates(text).map((c) => c.code);
}

/**
 * Empreinte d'un code pour la déduplication : SHA-256 hexadécimal (minuscules) de la chaîne UTF-8.
 * @param {string} code
 * @returns {Promise<string>}
 */
export async function codeHash(code) {
  if (typeof code !== 'string') throw new TypeError('codeHash : chaîne attendue.');
  return toHex(new Uint8Array(await subtle().digest('SHA-256', utf8Encode(code))));
}

// --- Validateurs partagés --------------------------------------------------

/** Vrai si `s` est une date calendaire valide 'AAAA-MM-JJ'. */
export function isValidDay(s) {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Vrai si `s` est un horodatage ISO 8601 complet (date, heure, fuseau Z ou ±hh:mm). */
export function isIsoTimestamp(s) {
  if (typeof s !== 'string' || s.length > 40) return false;
  const m = ISO_RE.exec(s);
  if (!m || !isValidDay(m[1])) return false;
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || (m[4] !== undefined && Number(m[4]) > 59)) return false;
  if (m[5] !== undefined && (Number(m[5]) > 23 || Number(m[6]) > 59)) return false;
  return !Number.isNaN(Date.parse(s));
}

/** Vrai si `id` est un identifiant de campagne valide (base64url 8..32 ou 'demo'). */
export function isCampaignId(id) {
  return typeof id === 'string' && (id === 'demo' || CAMPAIGN_ID_RE.test(id));
}

// ---------------------------------------------------------------------------

async function deriveAesKey(sharedBits, ephemeralRaw, campaignId, usage) {
  const ikm = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ephemeralRaw, info: utf8Encode(HKDF_INFO_PREFIX + campaignId) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function resolvePrivateKey(privateKey) {
  if (privateKey && typeof privateKey === 'object' && privateKey.type === 'private' && privateKey.algorithm?.name === 'ECDH') {
    return privateKey;
  }
  return importPrivateKey(privateKey);
}

function assertCampaignId(campaignId) {
  if (!isCampaignId(campaignId)) throw new TypeError('Identifiant de campagne invalide.');
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
