// Évaluateur des conditions déclaratives (règles et questionnaire).
// Langage : { all: [...] } | { any: [...] } | { not: condition }
//           | { field, eq } | { field, in: [...] } | { field, includes_any: [...] } | { field, includes_all: [...] }
// Module pur, sans effet de bord.

export const COMBINATORS = Object.freeze(['all', 'any', 'not']);
export const LEAF_OPERATORS = Object.freeze(['eq', 'in', 'includes_any', 'includes_all']);

function invalid(condition, reason) {
  let text;
  try {
    text = JSON.stringify(condition);
  } catch {
    text = String(condition);
  }
  return new TypeError(`Condition invalide (${reason}) : ${text}`);
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Évalue une condition sur un usage. Lève une TypeError si la condition est mal formée
 * (clé inconnue, plusieurs opérateurs, liste attendue absente…).
 */
export function evaluateCondition(condition, usage) {
  if (!isPlainObject(condition)) throw invalid(condition, 'objet attendu');
  const keys = Object.keys(condition);

  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const list = condition[keys[0]];
    if (!Array.isArray(list)) throw invalid(condition, `liste attendue pour « ${keys[0]} »`);
    return keys[0] === 'all'
      ? list.every((c) => evaluateCondition(c, usage))
      : list.some((c) => evaluateCondition(c, usage));
  }
  if (keys.length === 1 && keys[0] === 'not') {
    return !evaluateCondition(condition.not, usage);
  }

  if (keys.length !== 2 || typeof condition.field !== 'string' || condition.field === '') {
    throw invalid(condition, 'feuille { field, opérateur } attendue');
  }
  const op = keys.find((k) => k !== 'field');
  if (!LEAF_OPERATORS.includes(op)) throw invalid(condition, `opérateur inconnu « ${op} »`);

  const value = usage == null ? undefined : usage[condition.field];
  const operand = condition[op];
  if (op === 'eq') return value === operand;

  if (!Array.isArray(operand)) throw invalid(condition, `liste attendue pour « ${op} »`);
  if (op === 'in') return operand.includes(value);
  if (!Array.isArray(value)) return false;
  if (op === 'includes_any') return operand.some((x) => value.includes(x));
  return operand.every((x) => value.includes(x));
}

/** Liste les feuilles { field, op, operand } d'une condition (vérifications, outillage). */
export function conditionLeaves(condition) {
  if (!isPlainObject(condition)) throw invalid(condition, 'objet attendu');
  if ('all' in condition || 'any' in condition) {
    const list = condition.all ?? condition.any;
    if (!Array.isArray(list)) throw invalid(condition, 'liste attendue');
    return list.flatMap((c) => conditionLeaves(c));
  }
  if ('not' in condition) return conditionLeaves(condition.not);
  const op = Object.keys(condition).find((k) => k !== 'field');
  return [{ field: condition.field, op, operand: condition[op] }];
}
