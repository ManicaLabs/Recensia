// Chiffrement par mot de passe : fichier de récupération de la clé et sauvegarde complète (CDC §7.6, D8).
//
// Enveloppe chiffrée (tous les octets en base64url) :
//   { format: 'recensia-encrypted', v: 1,
//     kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },   // sel de 16 octets, ≥ 600 000 itérations
//     cipher: { name: 'AES-GCM', iv },                               // AES-256-GCM, IV de 12 octets, tag 128 bits
//     ciphertext }                                                   // JSON UTF-8 chiffré
//
// Fichier de récupération :
//   { format: 'recensia-key', v: 1, created_at,
//     campaign: { id, title, org_name, mode, departments, settings, public_key, fingerprint, created_at },
//     protected: bool, key: enveloppe (protected = true) | JWK en clair (protected = false) }
// Fichier protégé : l'enveloppe chiffre { private_key_jwk, campaign }. La copie en clair de `campaign`
// ne sert qu'à l'affichage avant la saisie du mot de passe ; à la lecture, seule la copie chiffrée
// (donc authentifiée) est utilisée, et une copie en clair qui annonce une autre campagne est refusée.
// Sans cela, quiconque intercepte le fichier pourrait en modifier le mode, les canaux de retour ou
// le seuil de masquage sans connaître le mot de passe.
//
// Le mot de passe est normalisé en NFC (même saisie sur macOS, Windows ou mobile).
// Aucune fonction ne journalise la clé ; aucun message d'erreur ne contient le paramètre « d ».

import { b64urlDecode, b64urlEncode } from './b64url.js';
import { utf8Decode, utf8Encode } from './compress.js';
import { isCampaignId } from './codes.js';
import { fingerprint, isFingerprint, normalizePrivateJwk, publicKeyFromPrivateJwk, decodePublicKey, verifyKeyPair } from './keys.js';
import { randomBytes } from './random.js';

export const ENCRYPTED_FORMAT = 'recensia-encrypted';
export const RECOVERY_FORMAT = 'recensia-key';
export const BACKUP_VERSION = 1;
export const PBKDF2_MIN_ITERATIONS = 600000;
/** Borne haute acceptée à la lecture (évite de bloquer le navigateur avec un fichier piégé). */
export const PBKDF2_MAX_ITERATIONS = 10000000;
export const PBKDF2_DEFAULT_ITERATIONS = PBKDF2_MIN_ITERATIONS;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

const subtle = () => globalThis.crypto.subtle;

/**
 * Erreur de sauvegarde. reason : 'format' (fichier illisible ou paramètres refusés) · 'version' ·
 * 'password' (mot de passe absent, incorrect, ou fichier altéré) · 'mismatch' (clé privée ne correspondant pas
 * à la clé publique ou à l'empreinte de la campagne).
 */
export class BackupError extends Error {
  constructor(reason, message) {
    super(message || BACKUP_MESSAGES[reason] || 'Fichier invalide.');
    this.name = 'BackupError';
    this.reason = reason;
  }
}

const BACKUP_MESSAGES = {
  format: 'Fichier illisible ou non reconnu.',
  version: 'Version de fichier non prise en charge : mettez l’application à jour.',
  password: 'Mot de passe incorrect (ou fichier altéré).',
  mismatch: 'La clé privée ne correspond pas à la clé publique de la campagne.',
};

// --- Enveloppe chiffrée ----------------------------------------------------

/**
 * Chiffre un objet JSON par mot de passe.
 * @param {unknown} obj
 * @param {string} password non vide
 * @param {{ iterations?: number }} [opts] itérations PBKDF2 (≥ 600 000)
 * @returns {Promise<object>} enveloppe 'recensia-encrypted'
 */
export async function encryptWithPassword(obj, password, { iterations = PBKDF2_DEFAULT_ITERATIONS } = {}) {
  assertPassword(password);
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(`PBKDF2 : entre ${PBKDF2_MIN_ITERATIONS} et ${PBKDF2_MAX_ITERATIONS} itérations requises.`);
  }
  const json = JSON.stringify(obj);
  if (json === undefined) throw new TypeError('encryptWithPassword : valeur JSON attendue.');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await derivePasswordKey(password, salt, iterations, 'encrypt');
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8Encode(json)));
  return {
    format: ENCRYPTED_FORMAT,
    v: BACKUP_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64urlEncode(salt) },
    cipher: { name: 'AES-GCM', iv: b64urlEncode(iv) },
    ciphertext: b64urlEncode(ciphertext),
  };
}

/**
 * Déchiffre une enveloppe (objet ou texte JSON).
 * @param {object|string} envelope
 * @param {string} password
 * @returns {Promise<unknown>}
 * @throws {BackupError} 'format' · 'version' · 'password'
 */
export async function decryptWithPassword(envelope, password) {
  const env = parseEnvelope(envelope);
  if (typeof password !== 'string' || password.length === 0) throw new BackupError('password', 'Mot de passe requis.');
  const key = await derivePasswordKey(password, env.salt, env.iterations, 'decrypt');
  let plain;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: env.iv, tagLength: 128 }, key, env.ciphertext));
  } catch {
    throw new BackupError('password');
  }
  try {
    return JSON.parse(utf8Decode(plain));
  } catch {
    throw new BackupError('format', 'Contenu déchiffré illisible.');
  }
}

/** Vrai si `obj` a la forme d'une enveloppe chiffrée (sans la déchiffrer). */
export function isEncryptedEnvelope(obj) {
  try {
    parseEnvelope(obj);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sauvegarde complète chiffrée (alias documenté de encryptWithPassword) : `data` est l'objet
 * 'recensia-backup' produit par store.exportCampaignData (clé privée incluse seulement si chiffré).
 */
export async function exportEncrypted(data, password, opts) {
  return encryptWithPassword(data, password, opts);
}

/** Lecture d'une sauvegarde complète chiffrée (alias documenté de decryptWithPassword ; objet ou texte JSON). */
export async function importEncrypted(file, password) {
  return decryptWithPassword(file, password);
}

// --- Fichier de récupération -----------------------------------------------

/**
 * Construit le fichier de récupération d'une campagne. La paire de clés est vérifiée avant écriture.
 * @param {object} campaign campagne (ARCHITECTURE §3.2) avec private_key_jwk
 * @param {string|null} passphrase mot de passe, ou null (explicite) pour un fichier NON protégé (JWK en clair) ;
 *   un argument omis est refusé, pour qu'un oubli ne produise jamais une clé en clair
 * @param {{ iterations?: number }} [opts]
 * @returns {Promise<object>} objet JSON 'recensia-key'
 */
export async function wrapPrivateKey(campaign, passphrase, opts = {}) {
  if (!isPlainObject(campaign)) throw new TypeError('wrapPrivateKey : campagne attendue.');
  if (passphrase === undefined) {
    throw new TypeError('wrapPrivateKey : mot de passe requis (null, explicitement, pour un fichier non protégé).');
  }
  if (passphrase !== null) assertPassword(passphrase);
  if (!isCampaignId(campaign.id)) throw new TypeError('wrapPrivateKey : identifiant de campagne invalide.');
  try {
    decodePublicKey(campaign.public_key);
  } catch {
    throw new TypeError('wrapPrivateKey : clé publique de campagne invalide.');
  }
  let jwk;
  try {
    jwk = normalizePrivateJwk(campaign.private_key_jwk);
  } catch {
    throw new TypeError('wrapPrivateKey : clé privée absente ou invalide.');
  }
  if (!(await verifyKeyPair(jwk, campaign.public_key))) throw new BackupError('mismatch');
  const fp = await fingerprint(campaign.public_key);
  if (campaign.fingerprint != null && campaign.fingerprint !== fp) {
    throw new BackupError('mismatch', 'L’empreinte enregistrée ne correspond pas à la clé publique de la campagne.');
  }
  const meta = {
    id: campaign.id,
    title: campaign.title ?? '',
    org_name: campaign.org_name ?? '',
    mode: campaign.mode,
    departments: Array.isArray(campaign.departments) ? [...campaign.departments] : [],
    settings: isPlainObject(campaign.settings) ? JSON.parse(JSON.stringify(campaign.settings)) : {},
    public_key: campaign.public_key,
    fingerprint: fp,
    created_at: typeof campaign.created_at === 'string' ? campaign.created_at : null,
  };
  // Mêmes règles qu'à la lecture : on n'écrit jamais un fichier que unwrapPrivateKey refuserait.
  if (!isValidCampaignMeta(meta)) throw new TypeError('wrapPrivateKey : campagne incomplète ou mal formée.');
  const isProtected = passphrase !== null;
  return {
    format: RECOVERY_FORMAT,
    v: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    campaign: meta,
    protected: isProtected,
    key: isProtected
      ? await encryptWithPassword({ private_key_jwk: jwk, campaign: meta }, passphrase, opts)
      : jwk,
  };
}

/**
 * Lit un fichier de récupération (objet ou texte JSON) et vérifie que la clé privée correspond
 * à la clé publique et à l'empreinte de la campagne. Pour un fichier protégé, la campagne renvoyée
 * est la copie chiffrée (authentifiée), jamais la copie en clair.
 * @param {object|string} file
 * @param {string|null} passphrase ignoré si le fichier n'est pas protégé
 * @returns {Promise<{ campaign: object, private_key_jwk: object }>}
 * @throws {BackupError}
 */
export async function unwrapPrivateKey(file, passphrase) {
  const obj = parseJsonInput(file);
  if (!isPlainObject(obj) || obj.format !== RECOVERY_FORMAT) throw new BackupError('format', 'Ce fichier n’est pas un fichier de récupération Recensia.');
  if (obj.v !== BACKUP_VERSION) throw new BackupError(Number.isInteger(obj.v) ? 'version' : 'format');
  if (!isValidCampaignMeta(obj.campaign)) throw new BackupError('format', 'Informations de campagne illisibles.');
  if (typeof obj.protected !== 'boolean') throw new BackupError('format');

  let c = obj.campaign;
  let rawJwk;
  if (obj.protected) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new BackupError('password', 'Ce fichier est protégé : mot de passe requis.');
    const inner = await decryptWithPassword(obj.key, passphrase);
    if (!isPlainObject(inner) || !isValidCampaignMeta(inner.campaign)) {
      throw new BackupError('format', 'Contenu chiffré du fichier de récupération illisible.');
    }
    const clear = obj.campaign;
    if (inner.campaign.id !== clear.id || inner.campaign.public_key !== clear.public_key || inner.campaign.fingerprint !== clear.fingerprint) {
      throw new BackupError('mismatch', 'Les informations en clair du fichier de récupération ont été modifiées.');
    }
    c = inner.campaign;
    rawJwk = inner.private_key_jwk;
  } else {
    rawJwk = obj.key;
  }
  let jwk;
  try {
    jwk = normalizePrivateJwk(rawJwk);
  } catch {
    throw new BackupError('format', 'Clé privée illisible.');
  }

  let derived;
  try {
    derived = await publicKeyFromPrivateJwk(jwk);
  } catch {
    throw new BackupError('mismatch');
  }
  if (derived !== c.public_key || !(await verifyKeyPair(jwk, c.public_key))) throw new BackupError('mismatch');
  if ((await fingerprint(c.public_key)) !== c.fingerprint) {
    throw new BackupError('mismatch', 'L’empreinte du fichier ne correspond pas à sa clé publique.');
  }

  return {
    campaign: {
      id: c.id,
      title: c.title,
      org_name: c.org_name,
      mode: c.mode,
      departments: [...c.departments],
      settings: JSON.parse(JSON.stringify(c.settings)),
      public_key: c.public_key,
      fingerprint: c.fingerprint,
      created_at: c.created_at ?? null,
    },
    private_key_jwk: jwk,
  };
}

/** Vrai si `obj` ressemble à un fichier de récupération (format et version), sans le vérifier. */
export function isRecoveryFile(obj) {
  return isPlainObject(obj) && obj.format === RECOVERY_FORMAT && obj.v === BACKUP_VERSION;
}

// ---------------------------------------------------------------------------

/**
 * Métadonnées de campagne d'un fichier de récupération : types attendus, identifiant, mode,
 * clé publique (forme) et empreinte (format). La cohérence avec la clé privée est vérifiée à part.
 */
function isValidCampaignMeta(c) {
  if (!isPlainObject(c)) return false;
  if (!isCampaignId(c.id) || !['anonymous', 'open'].includes(c.mode) || !isFingerprint(c.fingerprint)) return false;
  if (typeof c.title !== 'string' || typeof c.org_name !== 'string') return false;
  if (!Array.isArray(c.departments) || !c.departments.every((d) => typeof d === 'string')) return false;
  if (!isPlainObject(c.settings)) return false;
  if (c.created_at != null && typeof c.created_at !== 'string') return false;
  try {
    decodePublicKey(c.public_key);
  } catch {
    return false;
  }
  return true;
}

function parseEnvelope(envelope) {
  const env = parseJsonInput(envelope);
  if (!isPlainObject(env) || env.format !== ENCRYPTED_FORMAT) throw new BackupError('format', 'Ce fichier n’est pas un fichier chiffré Recensia.');
  if (env.v !== BACKUP_VERSION) throw new BackupError(Number.isInteger(env.v) ? 'version' : 'format');
  const { kdf, cipher } = env;
  if (!isPlainObject(kdf) || !isPlainObject(cipher)) throw new BackupError('format');
  if (!onlyKeys(kdf, ['name', 'hash', 'iterations', 'salt']) || !onlyKeys(cipher, ['name', 'iv'])) throw new BackupError('format');
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || cipher.name !== 'AES-GCM') {
    throw new BackupError('format', 'Algorithme de chiffrement non pris en charge.');
  }
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < PBKDF2_MIN_ITERATIONS || kdf.iterations > PBKDF2_MAX_ITERATIONS) {
    throw new BackupError('format', 'Nombre d’itérations PBKDF2 refusé.');
  }
  const salt = decodeField(kdf.salt);
  const iv = decodeField(cipher.iv);
  const ciphertext = decodeField(env.ciphertext);
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length < 16) throw new BackupError('format');
  return { iterations: kdf.iterations, salt, iv, ciphertext };
}

function decodeField(v) {
  try {
    return b64urlDecode(v);
  } catch {
    throw new BackupError('format');
  }
}

async function derivePasswordKey(password, salt, iterations, usage) {
  const base = await subtle().importKey('raw', utf8Encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('Mot de passe non vide requis.');
}

function parseJsonInput(input) {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    throw new BackupError('format');
  }
}

function onlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
