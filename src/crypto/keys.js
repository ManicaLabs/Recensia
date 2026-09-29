// Clés de campagne : ECDH P-256 via WebCrypto.
//
// - Clé publique : point brut non compressé (65 octets, 0x04 ‖ X ‖ Y) encodé en base64url.
// - Clé privée : JWK normalisé { kty, crv, x, y, d } (extractible, pour le fichier de récupération).
// - Empreinte : 8 hexadécimaux MAJUSCULES = 4 premiers octets de SHA-256(clé publique brute).
//
// Aucune fonction de ce module ne journalise ni ne renvoie dans un message d'erreur
// le paramètre privé « d ».

import { b64urlDecode, b64urlEncode } from './b64url.js';

export const EC_ALGORITHM = Object.freeze({ name: 'ECDH', namedCurve: 'P-256' });
export const PUBLIC_KEY_BYTES = 65;

const subtle = () => globalThis.crypto.subtle;
const COORD_RE = /^[A-Za-z0-9_-]{43}$/; // 32 octets en base64url
const FINGERPRINT_RE = /^[0-9A-F]{8}$/;

/**
 * Génère la paire de clés d'une campagne.
 * @returns {Promise<{ publicKeyB64: string, privateKeyJwk: object, fingerprint: string }>}
 */
export async function generateCampaignKeys() {
  const pair = await subtle().generateKey(EC_ALGORITHM, true, ['deriveBits']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const jwk = normalizePrivateJwk(await subtle().exportKey('jwk', pair.privateKey));
  const publicKeyB64 = b64urlEncode(raw);
  return { publicKeyB64, privateKeyJwk: jwk, fingerprint: await fingerprint(publicKeyB64) };
}

/**
 * Décode une clé publique base64url et vérifie sa forme (65 octets, préfixe 0x04).
 * Ne vérifie pas l'appartenance à la courbe (voir importPublicKey).
 * @param {string} b64
 * @returns {Uint8Array}
 * @throws {TypeError}
 */
export function decodePublicKey(b64) {
  let raw;
  try {
    raw = b64urlDecode(b64);
  } catch {
    throw new TypeError('Clé publique : encodage base64url invalide.');
  }
  if (raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new TypeError('Clé publique : 65 octets non compressés (0x04…) attendus.');
  }
  return raw;
}

/**
 * Importe une clé publique de campagne (base64url, point brut). Le point doit être sur la courbe P-256.
 * @param {string} b64
 * @returns {Promise<CryptoKey>}
 * @throws {TypeError}
 */
export async function importPublicKey(b64) {
  return importRawPublicKey(decodePublicKey(b64));
}

/** Importe un point brut de 65 octets (usage interne et module codes.js). */
export async function importRawPublicKey(raw) {
  try {
    return await subtle().importKey('raw', raw, EC_ALGORITHM, true, []);
  } catch {
    throw new TypeError('Clé publique : point P-256 invalide.');
  }
}

/**
 * Vérifie la forme d'un JWK privé P-256 et le renvoie normalisé { kty, crv, x, y, d }.
 * @param {object} jwk
 * @returns {{ kty: 'EC', crv: 'P-256', x: string, y: string, d: string }}
 * @throws {TypeError}
 */
export function normalizePrivateJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw new TypeError('Clé privée : objet JWK attendu.');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new TypeError('Clé privée : JWK EC P-256 attendu.');
  for (const k of ['x', 'y', 'd']) {
    if (typeof jwk[k] !== 'string' || !COORD_RE.test(jwk[k])) throw new TypeError('Clé privée : JWK incomplet ou mal formé.');
    try {
      b64urlDecode(jwk[k]);
    } catch {
      throw new TypeError('Clé privée : JWK incomplet ou mal formé.');
    }
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

/**
 * Importe une clé privée de campagne (JWK) pour le déchiffrement (usage deriveBits, non extractible).
 * @param {object} jwk
 * @returns {Promise<CryptoKey>}
 * @throws {TypeError}
 */
export async function importPrivateKey(jwk) {
  const clean = normalizePrivateJwk(jwk);
  try {
    return await subtle().importKey('jwk', clean, EC_ALGORITHM, false, ['deriveBits']);
  } catch {
    throw new TypeError('Clé privée : JWK refusé par WebCrypto.');
  }
}

/**
 * Clé publique (base64url, point brut) correspondant à un JWK privé.
 * Les coordonnées x, y sont validées comme point de la courbe ; la cohérence avec « d »
 * est vérifiée par verifyKeyPair.
 * @param {object} jwk
 * @returns {Promise<string>}
 */
export async function publicKeyFromPrivateJwk(jwk) {
  const clean = normalizePrivateJwk(jwk);
  await importPrivateKey(clean);
  const raw = rawFromCoordinates(clean.x, clean.y);
  await importRawPublicKey(raw);
  return b64urlEncode(raw);
}

/**
 * Vérifie qu'un JWK privé correspond bien à une clé publique, par un échange ECDH témoin :
 * pour une clé éphémère E, ECDH(d, E) doit être égal à ECDH(e, P). Ne dépend pas des
 * coordonnées x, y déclarées dans le JWK.
 * @param {object} jwk
 * @param {string} publicKeyB64
 * @returns {Promise<boolean>}
 */
export async function verifyKeyPair(jwk, publicKeyB64) {
  let privateKey;
  let publicKey;
  try {
    privateKey = await importPrivateKey(jwk);
    publicKey = await importPublicKey(publicKeyB64);
  } catch {
    return false;
  }
  if (publicKeyFromJwkCoordinates(jwk) !== publicKeyB64) return false;
  const probe = await subtle().generateKey(EC_ALGORITHM, false, ['deriveBits']);
  const a = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: probe.publicKey }, privateKey, 256));
  const b = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publicKey }, probe.privateKey, 256));
  return bytesEqual(a, b);
}

/**
 * Empreinte d'une clé publique : 8 hexadécimaux MAJUSCULES (4 premiers octets de SHA-256).
 * @param {string} publicKeyB64
 * @returns {Promise<string>}
 */
export async function fingerprint(publicKeyB64) {
  const raw = decodePublicKey(publicKeyB64);
  const hash = new Uint8Array(await subtle().digest('SHA-256', raw));
  return toHex(hash.subarray(0, 4)).toUpperCase();
}

/**
 * Mise en forme lisible d'une empreinte : 'A1B2C3D4' → 'A1B2-C3D4'.
 * Une valeur qui n'a pas la forme attendue est renvoyée telle quelle (chaîne vide si absente).
 * @param {string} fp
 * @returns {string}
 */
export function formatFingerprint(fp) {
  if (fp == null) return '';
  const s = String(fp).toUpperCase();
  return FINGERPRINT_RE.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : String(fp);
}

/** Vrai si `fp` est une empreinte au format 'A1B2C3D4'. */
export function isFingerprint(fp) {
  return typeof fp === 'string' && FINGERPRINT_RE.test(fp);
}

// ---------------------------------------------------------------------------

function publicKeyFromJwkCoordinates(jwk) {
  try {
    const clean = normalizePrivateJwk(jwk);
    return b64urlEncode(rawFromCoordinates(clean.x, clean.y));
  } catch {
    return null;
  }
}

function rawFromCoordinates(x, y) {
  const bx = b64urlDecode(x);
  const by = b64urlDecode(y);
  const raw = new Uint8Array(PUBLIC_KEY_BYTES);
  raw[0] = 0x04;
  raw.set(bx, 1);
  raw.set(by, 33);
  return raw;
}

/** Hexadécimal minuscule. */
export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
