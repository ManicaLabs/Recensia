// Libellés des valeurs d'énumération, lus dans data/questionnaire.json.
// Module pur : le questionnaire est passé en paramètre.

/**
 * Libellé français d'une valeur d'énumération ; la valeur brute si elle est inconnue,
 * une chaîne vide si elle est absente.
 */
export function optionLabel(questionnaire, field, value) {
  if (value === null || value === undefined) return '';
  const options = questionnaire?.fields?.[field]?.options;
  if (Array.isArray(options)) {
    const option = options.find((o) => o.value === value);
    if (option && typeof option.label === 'string') return option.label;
  }
  return String(value);
}

/** Comme optionLabel, mais accepte aussi un tableau (libellés joints par ', '). */
export function formatUsageValue(questionnaire, field, value) {
  if (Array.isArray(value)) {
    return value.map((v) => optionLabel(questionnaire, field, v)).filter((s) => s !== '').join(', ');
  }
  return optionLabel(questionnaire, field, value);
}
