// Niveaux de risque : ordre de gravité AI Act et échelle d'exposition des données.
// Module pur, sans effet de bord.

/**
 * Niveaux AI Act, du plus grave au moins grave.
 * « to_qualify » est placé au-dessus de « limited » : une réponse « je ne sais pas »
 * ne doit jamais faire baisser le niveau affiché.
 */
export const AI_ACT_ORDER = Object.freeze(['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']);

/** Échelle d'exposition des données : 0 faible, 1 modéré, 2 élevé, 3 critique. */
export const DATA_LEVELS = Object.freeze([0, 1, 2, 3]);

export function isAiActLevel(level) {
  return AI_ACT_ORDER.includes(level);
}

export function isDataLevel(level) {
  return DATA_LEVELS.includes(level);
}

function rank(level) {
  const i = AI_ACT_ORDER.indexOf(level);
  return i === -1 ? AI_ACT_ORDER.length : i;
}

/**
 * Compare deux niveaux AI Act : < 0 si `a` est plus grave que `b`, > 0 s'il l'est moins,
 * 0 s'ils sont égaux. Une valeur inconnue est considérée comme la moins grave.
 */
export function compareAiAct(a, b) {
  return rank(a) - rank(b);
}

/** Niveau le plus grave d'une liste ; 'minimal' si la liste est vide. */
export function maxAiAct(levels) {
  let best = null;
  for (const level of levels ?? []) {
    if (!isAiActLevel(level)) continue;
    if (best === null || compareAiAct(level, best) < 0) best = level;
  }
  return best ?? 'minimal';
}

/** Niveau d'exposition le plus élevé d'une liste ; 0 si la liste est vide. */
export function maxDataLevel(levels) {
  let best = 0;
  for (const level of levels ?? []) {
    if (isDataLevel(level) && level > best) best = level;
  }
  return best;
}
