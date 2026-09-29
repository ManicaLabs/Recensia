// Contrôles structurels d'une matrice QR (ISO/IEC 18004) : motifs de repérage,
// motifs de synchronisation, informations de format et de version (codes BCH).

const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;
const G18 = 0b1111100100101;

function bchDigit(n) {
  let d = 0;
  while (n !== 0) { d += 1; n >>>= 1; }
  return d;
}

function bchRemainder(data, g, shift) {
  let d = data << shift;
  while (bchDigit(d) - bchDigit(g) >= 0) d ^= g << (bchDigit(d) - bchDigit(g));
  return d;
}

export const ECC_BITS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });

/** Motif de repérage 7×7 dont le coin supérieur gauche est (row, col). */
export function hasFinder(m, row, col) {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const expected = ring !== 2;
      if (m.isDark(row + r, col + c) !== expected) return false;
    }
  }
  return true;
}

/** Motifs de synchronisation (ligne 6 et colonne 6). */
export function hasTiming(m) {
  for (let i = 8; i < m.size - 8; i += 1) {
    if (m.isDark(6, i) !== (i % 2 === 0) || m.isDark(i, 6) !== (i % 2 === 0)) return false;
  }
  return true;
}

/** Informations de format (deux copies) → { ecc, mask } ; lève une erreur si incohérentes. */
export function readFormat(m) {
  const n = m.size;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 15; i += 1) {
    const va = i < 6 ? m.isDark(i, 8) : i < 8 ? m.isDark(i + 1, 8) : m.isDark(n - 15 + i, 8);
    const vb = i < 8 ? m.isDark(8, n - i - 1) : i < 9 ? m.isDark(8, 15 - i) : m.isDark(8, 15 - i - 1);
    if (va) a |= 1 << i;
    if (vb) b |= 1 << i;
  }
  if (a !== b) throw new Error('les deux copies des informations de format diffèrent');
  const data = (a ^ G15_MASK) >>> 10;
  if ((((data << 10) | bchRemainder(data, G15, 10)) ^ G15_MASK) !== a) throw new Error('BCH de format invalide');
  const eccBits = data >>> 3;
  const ecc = Object.keys(ECC_BITS).find((k) => ECC_BITS[k] === eccBits);
  return { ecc, mask: data & 7 };
}

/** Informations de version (versions ≥ 7) → numéro de version ; lève une erreur si incohérentes. */
export function readVersion(m) {
  const n = m.size;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 18; i += 1) {
    if (m.isDark(Math.floor(i / 3), (i % 3) + n - 11)) a |= 1 << i;
    if (m.isDark((i % 3) + n - 11, Math.floor(i / 3))) b |= 1 << i;
  }
  if (a !== b) throw new Error('les deux copies des informations de version diffèrent');
  const version = a >>> 12;
  if (((version << 12) | bchRemainder(version, G18, 12)) !== a) throw new Error('BCH de version invalide');
  return version;
}

/** Nombre de modules sombres. */
export function darkCount(m) {
  let count = 0;
  for (let r = 0; r < m.size; r += 1) for (let c = 0; c < m.size; c += 1) if (m.isDark(r, c)) count += 1;
  return count;
}
