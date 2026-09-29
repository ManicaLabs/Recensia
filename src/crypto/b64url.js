// Base64url strict (RFC 4648 §5) : alphabet A-Za-z0-9-_, sans remplissage « = ».
// Le décodage refuse tout autre caractère, les longueurs impossibles et les
// bits de fin non nuls (une seule écriture possible pour une suite d'octets).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** Expression régulière d'une chaîne base64url non vide. */
export const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Vrai si `str` est une chaîne base64url non vide (alphabet seul, sans « = »). */
export function isB64url(str) {
  return typeof str === 'string' && B64URL_RE.test(str);
}

/**
 * Encode des octets en base64url sans remplissage.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {string}
 */
export function b64urlEncode(bytes) {
  const u8 = toBytes(bytes);
  let out = '';
  let i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = u8.length - i;
  if (rest === 1) {
    const n = u8[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/**
 * Décode une chaîne base64url stricte.
 * @param {string} str
 * @returns {Uint8Array}
 * @throws {TypeError} si la chaîne n'est pas du base64url canonique.
 */
export function b64urlDecode(str) {
  if (typeof str !== 'string') throw new TypeError('base64url : une chaîne est attendue.');
  const len = str.length;
  if (len % 4 === 1) throw new TypeError('base64url : longueur invalide.');
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const n = (sextet(str, i) << 18) | (sextet(str, i + 1) << 12) | (sextet(str, i + 2) << 6) | sextet(str, i + 3);
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = len - i;
  if (rest === 2) {
    const a = sextet(str, i);
    const b = sextet(str, i + 1);
    if (b & 15) throw new TypeError('base64url : bits de fin non nuls.');
    out[o++] = (a << 2) | (b >> 4);
  } else if (rest === 3) {
    const a = sextet(str, i);
    const b = sextet(str, i + 1);
    const c = sextet(str, i + 2);
    if (c & 3) throw new TypeError('base64url : bits de fin non nuls.');
    out[o++] = (a << 2) | (b >> 4);
    out[o++] = ((b & 15) << 4) | (c >> 2);
  }
  return out;
}

function sextet(str, i) {
  const c = str.charCodeAt(i);
  const v = c < 128 ? DECODE[c] : -1;
  if (v < 0) throw new TypeError('base64url : caractère non autorisé.');
  return v;
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('base64url : des octets sont attendus.');
}
