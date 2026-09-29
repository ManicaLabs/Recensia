// Export CSV pour Excel (FR) : BOM UTF-8, séparateur ';', fins de ligne CRLF (CDC §8.3).
// Module pur.

const BOM = '\uFEFF';
const SEPARATOR = ';';
const EOL = '\r\n';

// Caractères qu'un tableur interprète comme début de formule. Les espaces initiaux ne
// protègent pas : certains tableurs les ignorent avant d'analyser la cellule, d'où le
// préfixe aussi dans ce cas (« ␠␠=1+1 » devient « '␠␠=1+1 »).
const FORMULA_START = /^[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+\-@]/;
const CONTROL_START = /^[\t\r]/;

/**
 * Neutralise l'injection de formules : préfixe d'une apostrophe toute cellule texte
 * commençant (éventuellement après des espaces) par =, +, - ou @, ou commençant par une
 * tabulation ou un retour chariot. Les nombres et booléens sont renvoyés intacts ; null et
 * undefined deviennent '' ; un tableau est joint par ', '.
 */
export function neutralize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  const text = Array.isArray(value) ? value.map((v) => (v ?? '')).join(', ') : String(value);
  return FORMULA_START.test(text) || CONTROL_START.test(text) ? `'${text}` : text;
}

function cell(value) {
  const v = neutralize(value);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v !== 'string') return String(v);
  return /[";\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Sérialise des lignes en CSV. `columns` = [{ key, label }] : l'en-tête reprend les libellés,
 * chaque ligne les valeurs `row[key]`. Toutes les cellules (en-tête compris) sont neutralisées.
 */
export function toCSV(rows, columns) {
  const cols = columns ?? [];
  const lines = [cols.map((c) => cell(c.label ?? c.key)).join(SEPARATOR)];
  for (const row of rows ?? []) {
    lines.push(cols.map((c) => cell(row?.[c.key])).join(SEPARATOR));
  }
  return BOM + lines.join(EOL) + EOL;
}
