// Aléa cryptographique (WebCrypto getRandomValues), identique navigateur et Node ≥ 20.

import { b64urlEncode } from './b64url.js';

/**
 * Octets aléatoires.
 * @param {number} n nombre d'octets (1..65536)
 * @returns {Uint8Array}
 */
export function randomBytes(n) {
  if (!Number.isInteger(n) || n < 1 || n > 65536) throw new RangeError('randomBytes : taille invalide.');
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Identifiant aléatoire en base64url : 12 octets ⇒ 16 caractères, 9 octets ⇒ 12 caractères.
 * @param {number} [bytes=12]
 * @returns {string}
 */
export function randomId(bytes = 12) {
  return b64urlEncode(randomBytes(bytes));
}
