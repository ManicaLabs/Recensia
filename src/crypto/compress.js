// Compression JSON par DEFLATE brut (fflate vendorisé, sans en-tête zlib ni gzip).
//
// La décompression se fait EN FLUX avec un plafond : l'entrée est poussée par
// tranches de INFLATE_CHUNK octets et l'opération s'interrompt dès que la sortie
// cumulée dépasse le plafond. La sortie est copiée dans un tampon de taille
// exactement égale au plafond ; une tranche ne peut produire au plus que
// ~INFLATE_CHUNK × 1032 octets (taux maximal de DEFLATE), si bien qu'une « bombe »
// de décompression n'est jamais développée au-delà.

import { Inflate, deflateSync } from '../../vendor/fflate.mjs';

/** Plafond par défaut d'un clair décompressé (octets). */
export const MAX_INFLATED_BYTES = 16384;

/** Taille des tranches d'entrée poussées dans le décompresseur (octets). */
export const INFLATE_CHUNK = 64;

/** Erreur de (dé)compression. reason : 'size' (plafond dépassé) | 'format' (flux ou JSON invalide). */
export class InflateError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'InflateError';
    this.reason = reason;
  }
}

const encoder = new TextEncoder();

/** Encode une chaîne en UTF-8. */
export function utf8Encode(str) {
  return encoder.encode(str);
}

/**
 * Décode de l'UTF-8 strict (séquence invalide ⇒ InflateError 'format').
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function utf8Decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InflateError('format', 'Texte UTF-8 invalide.');
  }
}

/**
 * Sérialise en JSON UTF-8 puis compresse (DEFLATE brut, niveau 9).
 * @param {unknown} obj
 * @returns {Uint8Array}
 */
export function deflateJson(obj) {
  return deflateRaw(utf8Encode(JSON.stringify(obj)));
}

/** Compresse des octets (DEFLATE brut, niveau 9). */
export function deflateRaw(bytes) {
  return deflateSync(bytes, { level: 9 });
}

/**
 * Décompresse un flux DEFLATE brut en flux, avec plafond.
 * @param {Uint8Array} bytes
 * @param {number} [maxBytes=MAX_INFLATED_BYTES]
 * @returns {Uint8Array}
 * @throws {InflateError} 'size' si la sortie dépasse maxBytes, 'format' si le flux est invalide ou tronqué.
 */
export function inflateRaw(bytes, maxBytes = MAX_INFLATED_BYTES) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('inflateRaw : Uint8Array attendu.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('inflateRaw : plafond invalide.');
  if (bytes.length === 0) throw new InflateError('format', 'Flux compressé vide.');

  const out = new Uint8Array(maxBytes);
  let total = 0;
  let overflow = false;
  let finished = false;

  const inflater = new Inflate((chunk, final) => {
    if (overflow) return;
    if (chunk.length > maxBytes - total) {
      overflow = true;
      return;
    }
    out.set(chunk, total);
    total += chunk.length;
    if (final) finished = true;
  });

  for (let offset = 0; offset < bytes.length; offset += INFLATE_CHUNK) {
    const end = Math.min(offset + INFLATE_CHUNK, bytes.length);
    try {
      inflater.push(bytes.subarray(offset, end), end === bytes.length);
    } catch {
      throw new InflateError('format', 'Flux compressé invalide.');
    }
    if (overflow) throw new InflateError('size', `Contenu décompressé supérieur à ${maxBytes} octets.`);
  }
  if (!finished) throw new InflateError('format', 'Flux compressé incomplet.');
  return out.slice(0, total);
}

/**
 * Décompresse (plafond maxBytes) puis analyse le JSON UTF-8.
 * @param {Uint8Array} bytes
 * @param {number} [maxBytes=MAX_INFLATED_BYTES]
 * @returns {unknown}
 * @throws {InflateError}
 */
export function inflateJson(bytes, maxBytes = MAX_INFLATED_BYTES) {
  const text = utf8Decode(inflateRaw(bytes, maxBytes));
  try {
    return JSON.parse(text);
  } catch {
    throw new InflateError('format', 'JSON invalide.');
  }
}
