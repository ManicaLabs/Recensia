// Questionnaire d'usage (CDC §5.1), rendu entièrement piloté par data/questionnaire.json :
// sections (titre, introduction), types text (suggestions), textarea (compteur, avertissement),
// select, radio, multi (valeurs exclusives), department (services de la campagne).
// show_if / required_if évalués par engine/evaluate.js ; validation par engine/validate.js.
// Les champs toujours facultatifs sont regroupés dans un dernier bloc « Précisions facultatives »
// (displaySections) : les questions obligatoires se suivent.
//
// Contrat (ARCHITECTURE §5.4) :
//   renderQuestionnaire(root, { questionnaire, campaign: { mode, departments, department_required },
//                               initial, t, onChange, idPrefix, headingLevel })
//   → { getValue(), validate() → { ok, errors, value }, focusFirstError(), reset(value), destroy() }
//
// Les fonctions exportées avant renderQuestionnaire sont pures (testées sous Node).

import { h, mount, announce } from './dom.js';
import { icon, setFieldError } from './components.js';
import { t as translate, has as hasKey } from '../i18n.js';
import { evaluateCondition } from '../engine/evaluate.js';
import { validateUsage } from '../engine/validate.js';

const MODES = ['anonymous', 'open'];
const CHOICE_TYPES = new Set(['select', 'radio']);
const COUNTER_WARN_AT = 50;

// --- Logique pure --------------------------------------------------------------------------

/**
 * Typographie française à l'affichage : espace insécable avant « : ; ? ! » et à l'intérieur
 * des guillemets (les libellés de data/*.json utilisent des espaces ordinaires).
 */
export function frenchSpacing(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/ ([:;?!\u00BB])/g, '\u00A0$1').replace(/\u00AB /g, '\u00AB\u00A0');
}

const DISPLAY_KEYS = new Set(['label', 'help', 'intro', 'title', 'warning', 'placeholder']);

/** Copie du questionnaire dont les textes affichés suivent la typographie française (valeurs inchangées). */
export function displayQuestionnaire(questionnaire) {
  const walk = (value, key) => {
    if (typeof value === 'string') return DISPLAY_KEYS.has(key) ? frenchSpacing(value) : value;
    if (Array.isArray(value)) return value.map((item) => walk(item, null));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return walk(questionnaire, null);
}

/** Options de campagne normalisées : { mode, departments[], department_required }. */
export function campaignOptions(campaign) {
  const c = campaign && typeof campaign === 'object' ? campaign : {};
  const departments = Array.isArray(c.departments)
    ? [...new Set(c.departments.filter((d) => typeof d === 'string' && d.trim() !== ''))]
    : [];
  return {
    mode: MODES.includes(c.mode) ? c.mode : 'anonymous',
    departments,
    department_required: c.department_required === true || c.settings?.department_required === true,
  };
}

/**
 * Champ toujours facultatif : ni obligatoire, ni obligatoire sous condition (required_if),
 * ni réglé par la campagne (service).
 */
export function isAlwaysOptional(def) {
  if (!def || typeof def !== 'object' || def.type === 'department') return false;
  return (def.required === false || def.required === undefined) && !def.required_if;
}

/**
 * Sections telles qu'affichées : les champs toujours facultatifs (modèle, nombre de personnes,
 * commentaire…) sont regroupés dans un dernier bloc « Précisions facultatives », pour que les
 * questions obligatoires se suivent (premier usage en moins de 3 minutes, CDC §4 et §14).
 * Une section qui ne contient que des champs facultatifs est fondue dans ce bloc.
 * → [{ id, title, intro, fields: [], optional: false } …, { id: 'optional', title: null, intro: null, fields, optional: true }]
 */
export function displaySections(questionnaire) {
  const fields = questionnaire?.fields ?? {};
  const seen = new Set();
  const out = [];
  const optional = [];
  for (const section of questionnaire?.sections ?? []) {
    const keys = [];
    for (const key of section.fields ?? []) {
      if (!Object.hasOwn(fields, key) || seen.has(key)) continue;
      seen.add(key);
      (isAlwaysOptional(fields[key]) ? optional : keys).push(key);
    }
    if (keys.length) out.push({ id: section.id ?? null, title: section.title ?? '', intro: section.intro ?? null, fields: keys, optional: false });
  }
  if (optional.length) out.push({ id: 'optional', title: null, intro: null, fields: optional, optional: true });
  return out;
}

/** Clés des champs dans l'ordre d'affichage (displaySections), puis les champs hors section ; chaque clé une fois. */
export function fieldOrder(questionnaire) {
  const fields = questionnaire?.fields ?? {};
  const out = displaySections(questionnaire).flatMap((section) => section.fields);
  for (const key of Object.keys(fields)) if (!out.includes(key)) out.push(key);
  return out;
}

function safeCondition(condition, value) {
  try {
    return evaluateCondition(condition, value);
  } catch (err) {
    console.error('[Recensia] Condition du questionnaire invalide.', err);
    return false;
  }
}

/** Le champ est-il affiché ? (service : seulement si la campagne en propose ; show_if sinon.) */
export function isFieldVisible(key, questionnaire, value, campaign) {
  const def = questionnaire?.fields?.[key];
  if (!def) return false;
  const opts = campaignOptions(campaign);
  if (def.type === 'department' && opts.departments.length === 0) return false;
  return def.show_if ? safeCondition(def.show_if, value ?? {}) : true;
}

/** Le champ est-il obligatoire ? (mêmes règles que validateUsage : required, 'campaign', required_if.) */
export function isFieldRequired(key, questionnaire, value, campaign) {
  const def = questionnaire?.fields?.[key];
  if (!def || !isFieldVisible(key, questionnaire, value, campaign)) return false;
  if (def.required === true) return true;
  if (def.required === 'campaign') {
    const opts = campaignOptions(campaign);
    if (opts.departments.length === 0) return false;
    return opts.mode === 'open' || opts.department_required;
  }
  return def.required_if ? safeCondition(def.required_if, value ?? {}) : false;
}

function optionValues(def) {
  return (def?.options ?? []).map((o) => o.value);
}

/** Valeurs d'une liste remises dans l'ordre des options, inconnues et doublons retirés. */
export function orderValues(def, values) {
  const list = Array.isArray(values) ? values : [];
  return optionValues(def).filter((v) => list.includes(v));
}

/**
 * Coche ou décoche une option d'un champ multiple, en respectant les valeurs exclusives :
 * cocher une valeur exclusive (« aucune ») décoche tout le reste ; cocher une autre valeur
 * décoche les exclusives. → nouvelle liste, dans l'ordre des options.
 */
export function toggleChoice(def, current, option, checked) {
  const list = (Array.isArray(current) ? current : []).filter((v) => v !== option);
  if (!checked) return orderValues(def, list);
  const exclusive = Array.isArray(def?.exclusive) ? def.exclusive : [];
  if (exclusive.includes(option)) return orderValues(def, [option]);
  return orderValues(def, [...list.filter((v) => !exclusive.includes(v)), option]);
}

/** Suggestions d'un champ texte : celles liées à la valeur d'un autre champ (suggestions_by) d'abord. */
export function suggestionsFor(def, value) {
  const base = Array.isArray(def?.suggestions) ? def.suggestions : [];
  let specific = [];
  const by = def?.suggestions_by;
  if (by && typeof by.field === 'string' && by.values && typeof by.values === 'object') {
    const key = value?.[by.field];
    if (typeof key === 'string' && Object.hasOwn(by.values, key) && Array.isArray(by.values[key])) specific = by.values[key];
  }
  return [...new Set([...specific, ...base].filter((s) => typeof s === 'string' && s !== ''))];
}

/** Usage vide : toutes les clés du questionnaire à null. */
export function emptyUsage(questionnaire) {
  return Object.fromEntries(fieldOrder(questionnaire).map((key) => [key, null]));
}

/**
 * Valeur initiale : chaque clé du questionnaire, valeurs de forme valide conservées
 * (options connues, services de la campagne), le reste à null.
 */
export function normalizeInitial(questionnaire, initial, campaign) {
  const out = emptyUsage(questionnaire);
  if (!initial || typeof initial !== 'object') return out;
  const opts = campaignOptions(campaign);
  for (const key of Object.keys(out)) {
    const def = questionnaire.fields[key];
    const v = initial[key];
    if (def.type === 'multi') {
      const list = orderValues(def, v);
      out[key] = list.length ? list : null;
    } else if (CHOICE_TYPES.has(def.type)) {
      out[key] = typeof v === 'string' && optionValues(def).includes(v) ? v : null;
    } else if (def.type === 'department') {
      out[key] = typeof v === 'string' && opts.departments.includes(v) ? v : null;
    } else {
      out[key] = typeof v === 'string' && v !== '' ? v : null;
    }
  }
  return out;
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Valeur transmise à la validation : champs masqués et vides à null (un champ masqué n'est jamais envoyé). */
export function visibleValue(questionnaire, value, campaign) {
  const keys = fieldOrder(questionnaire);
  let current = { ...emptyUsage(questionnaire), ...(value ?? {}) };
  // Quelques passes : un champ masqué peut conditionner l'affichage d'un autre.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = {};
    for (const key of keys) {
      const v = current[key];
      next[key] = isFieldVisible(key, questionnaire, current, campaign) && !isEmpty(v) ? (Array.isArray(v) ? [...v] : v) : null;
    }
    const stable = keys.every((key) => JSON.stringify(next[key]) === JSON.stringify(current[key]));
    current = next;
    if (stable) break;
  }
  return current;
}

/**
 * Champ suivant affiché après `key` (ordre du questionnaire), ou null s'il n'y en a pas.
 * Sert à la touche Entrée d'un champ texte : passer à la question suivante plutôt que
 * d'envoyer tout le formulaire (sur mobile, « OK » du clavier ferait apparaître toutes les erreurs).
 */
export function nextFieldKey(questionnaire, value, campaign, key) {
  const order = fieldOrder(questionnaire);
  const start = order.indexOf(key);
  if (start < 0) return null;
  return order.slice(start + 1).find((k) => isFieldVisible(k, questionnaire, value, campaign)) ?? null;
}

/** Longueur en caractères (points de code), comme la validation. */
export function textLength(s) {
  return typeof s === 'string' ? [...s].length : 0;
}

/**
 * Message lisible d'une erreur de validation { field, code }.
 * Un message propre au champ (questionnaire.field_errors.<champ>.<code>) prime sur le message générique.
 */
export function errorText(error, questionnaire, t = translate, has = hasKey) {
  const field = error?.field ?? null;
  const code = error?.code ?? 'invalid';
  const def = field ? questionnaire?.fields?.[field] : null;
  const specific = `questionnaire.field_errors.${field}.${code}`;
  if (def && has(specific)) return t(specific);
  switch (code) {
    case 'required':
      if (def?.type === 'multi') return t('questionnaire.errors.required_multi');
      if (def?.type === 'radio') return t('questionnaire.errors.required_radio');
      if (def?.type === 'select' || def?.type === 'department') return t('questionnaire.errors.required_select');
      return t('questionnaire.errors.required_text');
    case 'too_long':
      return t('questionnaire.errors.too_long', { max: def?.max ?? '' });
    case 'too_few':
      return t('questionnaire.errors.too_few', { count: def?.min ?? 1 });
    case 'exclusive': {
      const labels = (def?.exclusive ?? []).map((v) => def.options?.find((o) => o.value === v)?.label ?? v);
      return t('questionnaire.errors.exclusive', { option: labels.join(', ') });
    }
    case 'invalid_value':
      return def?.type === 'department' ? t('questionnaire.errors.invalid_department') : t('questionnaire.errors.invalid_value');
    default:
      return t('questionnaire.errors.invalid');
  }
}

/** Première erreur de chaque champ, dans l'ordre du questionnaire. → [{ field, code }] */
export function firstErrors(errors, questionnaire) {
  const order = fieldOrder(questionnaire);
  const seen = new Map();
  for (const e of errors ?? []) {
    const key = e && order.includes(e.field) ? e.field : null;
    const slot = key ?? '__global';
    if (!seen.has(slot)) seen.set(slot, { field: key, code: e?.code ?? 'invalid' });
  }
  return [...seen.values()].sort((a, b) => {
    const ia = a.field === null ? -1 : order.indexOf(a.field);
    const ib = b.field === null ? -1 : order.indexOf(b.field);
    return ia - ib;
  });
}

// --- Composant -----------------------------------------------------------------------------

function describedBy(...ids) {
  const list = ids.filter(Boolean);
  return list.length ? list.join(' ') : null;
}

/**
 * Affiche le questionnaire dans root.
 * @param {HTMLElement} root
 * @param {{ questionnaire: object, campaign?: object, initial?: object, t?: Function,
 *   onChange?: (value: object, field: string) => void, idPrefix?: string, headingLevel?: number }} options
 */
export function renderQuestionnaire(root, options = {}) {
  const { initial = null, onChange, idPrefix = 'q' } = options;
  if (!options.questionnaire || typeof options.questionnaire.fields !== 'object' || !Array.isArray(options.questionnaire.sections)) {
    throw new TypeError('renderQuestionnaire : questionnaire invalide.');
  }
  const questionnaire = displayQuestionnaire(options.questionnaire);
  const t = typeof options.t === 'function' ? options.t : translate;
  const campaign = campaignOptions(options.campaign);
  const level = Number.isInteger(options.headingLevel) ? Math.min(Math.max(options.headingLevel, 2), 6) : 3;
  const headingTag = `h${level}`;
  const fields = questionnaire.fields;
  const order = fieldOrder(questionnaire);

  let value = normalizeInitial(questionnaire, initial, campaign);
  let showErrors = false;
  let destroyed = false;
  const entries = new Map();
  const sectionNodes = [];

  const summaryList = h('ul', { class: 'q-error-list' });
  const summaryTitle = h('p', { class: 'q-error-title', id: `${idPrefix}-errors-title` });
  const summary = h('div', {
    class: 'callout callout-danger q-error-summary',
    id: `${idPrefix}-errors`,
    tabindex: '-1',
    // Un <div> générique ne peut pas être nommé (ARIA) : rôle « group » pour que le titre s'applique.
    role: 'group',
    'aria-labelledby': `${idPrefix}-errors-title`,
    hidden: true,
  }, icon('danger', { className: 'callout-icon' }), h('div', { class: 'callout-body' }, summaryTitle, summaryList));

  const api = {
    getValue: () => visibleValue(questionnaire, value, campaign),
    validate,
    focusFirstError,
    reset,
    destroy,
  };

  // Enveloppe d'un champ (même structure que field() de components.js : setFieldError s'y applique).
  function shell(key, def, id, { group = false, control, before = [], after = [], describe = [] }) {
    const helpId = def.help ? `${id}-help` : null;
    const errorId = `${id}-error`;
    const marker = h('span', { class: 'q-required', hidden: true },
      h('span', { class: 'field-required', 'aria-hidden': 'true' }, ' *'),
      group ? h('span', { class: 'visually-hidden' }, ` (${t('common.field.required')})`) : null);
    const helpNode = def.help ? h('p', { class: 'field-help', id: helpId }, def.help) : null;
    const errorNode = h('p', { class: 'field-error', id: errorId, hidden: true });
    const ids = describedBy(helpId, ...describe, errorId);
    const node = group
      ? h('fieldset', { class: 'field field-group q-field', id: `${id}-field`, 'data-field': key, 'aria-describedby': ids },
        h('legend', { class: 'field-label' }, def.label, marker), helpNode, before, control, after, errorNode)
      : h('div', { class: 'field q-field', id: `${id}-field`, 'data-field': key },
        h('label', { class: 'field-label', for: id }, def.label, marker), helpNode, before, control, after, errorNode);
    return { node, marker, ids };
  }

  function fieldId(key) {
    return `${idPrefix}-${key}`;
  }

  function buildText(key, def) {
    const id = fieldId(key);
    const listId = `${id}-suggestions`;
    const hasSuggestions = Array.isArray(def.suggestions) || Boolean(def.suggestions_by);
    const datalist = hasSuggestions ? h('datalist', { id: listId }) : null;
    const input = h('input', {
      type: 'text',
      id,
      name: key,
      maxlength: Number.isInteger(def.max) ? String(def.max) : null,
      placeholder: def.placeholder ?? null,
      autocomplete: 'off',
      enterkeyhint: 'next',
      list: hasSuggestions ? listId : null,
      onInput: () => {
        value[key] = input.value === '' ? null : input.value;
        changed(key);
      },
      onKeydown: (event) => {
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        // Entrée : question suivante, sans envoyer le formulaire (envoi implicite).
        event.preventDefault();
        const next = nextFieldKey(questionnaire, value, campaign, key);
        if (next) focusEntry(entries.get(next));
      },
    });
    const { node, marker, ids } = shell(key, def, id, { control: input, after: [datalist] });
    input.setAttribute('aria-describedby', ids);
    let lastSuggestions = '';
    return {
      key, def, node, marker, controls: [input],
      write() { input.value = value[key] ?? ''; },
      setRequired(required) { input.required = required; },
      sync() {
        if (!datalist) return;
        const list = suggestionsFor(def, value);
        const signature = JSON.stringify(list);
        if (signature === lastSuggestions) return;
        lastSuggestions = signature;
        datalist.replaceChildren(...list.map((s) => h('option', { value: s })));
      },
      focusTarget: () => input,
    };
  }

  function buildTextarea(key, def) {
    const id = fieldId(key);
    const warningId = def.warning ? `${id}-warning` : null;
    const counterId = Number.isInteger(def.max) ? `${id}-counter` : null;
    const warning = def.warning
      ? h('p', { class: 'q-warning', id: warningId }, icon('alert'), h('span', null, def.warning))
      : null;
    const counter = counterId ? h('p', { class: 'q-counter', id: counterId }) : null;
    let warnedAt = null;
    const area = h('textarea', {
      id,
      name: key,
      rows: '4',
      maxlength: Number.isInteger(def.max) ? String(def.max) : null,
      placeholder: def.placeholder ?? null,
      onInput: () => {
        value[key] = area.value === '' ? null : area.value;
        updateCounter(true);
        changed(key);
      },
    });
    const updateCounter = (speak) => {
      if (!counter) return;
      const n = textLength(area.value);
      const left = def.max - n;
      counter.textContent = t('questionnaire.counter', { count: n, max: def.max });
      counter.classList.toggle('is-near', left <= COUNTER_WARN_AT);
      if (!speak) return;
      // Annonce ponctuelle à l'approche de la limite (pas à chaque frappe).
      const step = left <= 0 ? 0 : left <= COUNTER_WARN_AT ? COUNTER_WARN_AT : null;
      if (step !== null && step !== warnedAt) announce(t('questionnaire.counter_left', { count: Math.max(left, 0) }));
      warnedAt = step;
    };
    const { node, marker, ids } = shell(key, def, id, { control: area, before: [warning], after: [counter], describe: [warningId, counterId] });
    area.setAttribute('aria-describedby', ids);
    return {
      key, def, node, marker, controls: [area],
      write() { area.value = value[key] ?? ''; updateCounter(false); },
      setRequired(required) { area.required = required; },
      sync() {},
      focusTarget: () => area,
    };
  }

  function buildSelect(key, def, { department = false } = {}) {
    const id = fieldId(key);
    const optionHelpId = `${id}-option-help`;
    const optionHelp = department ? null : h('p', { class: 'field-help q-option-help', id: optionHelpId, hidden: true, 'aria-live': 'polite' });
    const placeholder = h('option', { value: '' });
    const options = department
      ? campaign.departments.map((d) => h('option', { value: d }, d))
      : (def.options ?? []).map((o) => h('option', { value: o.value }, o.label));
    const select = h('select', {
      id,
      name: key,
      onChange: () => {
        value[key] = select.value === '' ? null : select.value;
        changed(key);
      },
    }, placeholder, options);
    const { node, marker, ids } = shell(key, def, id, { control: select, after: [optionHelp], describe: [optionHelp ? optionHelpId : null] });
    select.setAttribute('aria-describedby', ids);
    const setPlaceholder = (required) => {
      placeholder.textContent = department && !required
        ? t('questionnaire.department_unspecified')
        : (def.placeholder ?? t('questionnaire.select_placeholder'));
    };
    setPlaceholder(false);
    return {
      key, def, node, marker, controls: [select],
      write() { select.value = value[key] ?? ''; },
      setRequired(required) { select.required = required; setPlaceholder(required); },
      sync() {
        if (!optionHelp) return;
        const help = (def.options ?? []).find((o) => o.value === value[key])?.help ?? '';
        optionHelp.textContent = help;
        optionHelp.hidden = help === '';
      },
      focusTarget: () => select,
    };
  }

  function choiceNode(key, def, option, index, type) {
    const id = `${fieldId(key)}-${index}`;
    const labelId = `${id}-label`;
    const helpId = option.help ? `${id}-help` : null;
    const exclusive = type === 'checkbox' && (def.exclusive ?? []).includes(option.value);
    const input = h('input', {
      type,
      id,
      name: fieldId(key),
      value: option.value,
      'aria-labelledby': helpId ? labelId : null,
      'aria-describedby': helpId,
    });
    const label = h('label', { class: ['choice', exclusive ? 'q-choice-exclusive' : null], for: id },
      input,
      h('span', { class: 'choice-text' },
        h('span', { class: 'choice-label', id: labelId }, option.label),
        option.help ? h('span', { class: 'choice-help', id: helpId }, option.help) : null));
    return { input, label };
  }

  function buildRadio(key, def) {
    const id = fieldId(key);
    const items = (def.options ?? []).map((o, i) => choiceNode(key, def, o, i, 'radio'));
    for (const { input } of items) {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        value[key] = input.value;
        changed(key);
      });
    }
    const clear = h('button', {
      type: 'button',
      class: 'btn btn-ghost q-clear',
      hidden: true,
      onClick: () => {
        value[key] = null;
        for (const { input } of items) input.checked = false;
        changed(key);
        items[0]?.input.focus();
        announce(t('questionnaire.cleared', { label: def.label }));
      },
    }, icon('close'), h('span', null, t('questionnaire.clear')));
    const grid = h('div', { class: 'choice-grid q-choices' }, items.map((x) => x.label));
    const { node, marker } = shell(key, def, id, { group: true, control: grid, after: [clear] });
    let required = false;
    return {
      key, def, node, marker, controls: items.map((x) => x.input),
      write() { for (const { input } of items) input.checked = value[key] === input.value; },
      setRequired(r) {
        required = r;
        for (const { input } of items) input.required = r;
      },
      sync() { clear.hidden = required || value[key] === null; },
      focusTarget: () => (items.find((x) => x.input.checked) ?? items[0])?.input ?? null,
    };
  }

  function buildMulti(key, def) {
    const id = fieldId(key);
    const items = (def.options ?? []).map((o, i) => choiceNode(key, def, o, i, 'checkbox'));
    const exclusive = def.exclusive ?? [];
    const write = () => {
      const list = value[key] ?? [];
      for (const { input } of items) input.checked = list.includes(input.value);
    };
    for (const { input } of items) {
      input.addEventListener('change', () => {
        const before = value[key] ?? [];
        const next = toggleChoice(def, before, input.value, input.checked);
        value[key] = next.length ? next : null;
        write();
        const dropped = before.filter((v) => !next.includes(v) && v !== input.value);
        if (input.checked && dropped.length) {
          const label = (def.options ?? []).find((o) => o.value === input.value)?.label ?? input.value;
          announce(exclusive.includes(input.value)
            ? t('questionnaire.exclusive_checked', { option: label })
            : t('questionnaire.exclusive_unchecked', { option: dropped.map((v) => def.options.find((o) => o.value === v)?.label ?? v).join(', ') }));
        }
        changed(key);
      });
    }
    const grid = h('div', { class: 'choice-grid q-choices' }, items.map((x) => x.label));
    const { node, marker } = shell(key, def, id, { group: true, control: grid });
    return {
      key, def, node, marker, controls: items.map((x) => x.input),
      write,
      setRequired() {},
      sync() {},
      focusTarget: () => (items.find((x) => x.input.checked) ?? items[0])?.input ?? null,
    };
  }

  function buildField(key) {
    const def = fields[key];
    switch (def.type) {
      case 'text': return buildText(key, def);
      case 'textarea': return buildTextarea(key, def);
      case 'select': return buildSelect(key, def);
      case 'department': return buildSelect(key, def, { department: true });
      case 'radio': return buildRadio(key, def);
      case 'multi': return buildMulti(key, def);
      default:
        console.error(`[Recensia] Type de champ inconnu : ${def.type} (${key})`);
        return null;
    }
  }

  const layout = displaySections(questionnaire);
  const sectionCount = layout.length;
  const sections = layout.map((section, index) => {
    const titleId = `${idPrefix}-section-${section.id ?? index}`;
    const nodes = [];
    const keys = [];
    for (const key of section.fields) {
      if (entries.has(key)) continue;
      const entry = buildField(key);
      if (!entry) continue;
      entries.set(key, entry);
      keys.push(key);
      nodes.push(entry.node);
    }
    const title = section.optional ? t('questionnaire.optional.title') : section.title;
    const intro = section.optional ? t('questionnaire.optional.intro') : section.intro;
    const node = h('section', { class: ['q-section', section.optional ? 'q-section-optional' : null], 'aria-labelledby': titleId },
      h('p', { class: 'q-section-count' }, t('questionnaire.section_count', { n: index + 1, total: sectionCount })),
      h(headingTag, { class: 'q-section-title', id: titleId }, title),
      intro ? h('p', { class: 'q-section-intro' }, intro) : null,
      nodes);
    sectionNodes.push({ node, keys });
    return node;
  });

  mount(root, h('div', { class: 'questionnaire' },
    h('p', { class: 'q-legend muted' }, t('common.field.required_legend')),
    summary,
    sections));

  for (const entry of entries.values()) entry.write();
  refreshDynamic();

  function refreshDynamic() {
    for (const [key, entry] of entries) {
      const visible = isFieldVisible(key, questionnaire, value, campaign);
      entry.node.hidden = !visible;
      const required = visible && isFieldRequired(key, questionnaire, value, campaign);
      entry.marker.hidden = !required;
      entry.setRequired(required);
      entry.sync();
    }
    for (const section of sectionNodes) {
      section.node.hidden = section.keys.every((key) => entries.get(key).node.hidden);
    }
  }

  function applyErrors(errors) {
    const list = firstErrors(errors, questionnaire);
    const byField = new Map(list.filter((e) => e.field).map((e) => [e.field, e]));
    for (const [key, entry] of entries) {
      setFieldError(entry.node, byField.has(key) ? errorText(byField.get(key), questionnaire, t) : null);
    }
    if (!list.length) {
      summary.hidden = true;
      summaryList.replaceChildren();
      return list;
    }
    summaryTitle.textContent = t('questionnaire.summary.title', { count: list.length });
    summaryList.replaceChildren(...list.map((e) => {
      const message = errorText(e, questionnaire, t);
      if (!e.field) return h('li', null, message);
      const entry = entries.get(e.field);
      return h('li', null, h('a', {
        href: `#${fieldId(e.field)}-field`,
        onClick: (event) => {
          // Le hash est réservé au routeur : on déplace le focus sans modifier l'adresse.
          event.preventDefault();
          focusEntry(entry);
        },
      }, t('questionnaire.summary.item', { label: entry.def.label, message })));
    }));
    summary.hidden = false;
    return list;
  }

  function changed(key) {
    if (destroyed) return;
    refreshDynamic();
    if (showErrors) {
      const result = validateUsage(api.getValue(), questionnaire, campaign);
      applyErrors(result.errors);
      if (result.ok) showErrors = false;
    }
    if (typeof onChange === 'function') {
      try {
        onChange(api.getValue(), key);
      } catch (err) {
        console.error('[Recensia] Erreur dans onChange du questionnaire.', err);
      }
    }
  }

  function validate() {
    const result = validateUsage(api.getValue(), questionnaire, campaign);
    showErrors = !result.ok;
    applyErrors(result.errors);
    return result;
  }

  function focusEntry(entry) {
    const target = entry?.focusTarget();
    if (!target) return false;
    target.focus({ preventScroll: true });
    entry.node.scrollIntoView?.({ block: 'center' });
    return true;
  }

  function focusFirstError() {
    const key = order.find((k) => entries.get(k)?.node.classList.contains('has-error'));
    const count = summaryList.children.length;
    if (count) announce(t('questionnaire.summary.announce', { count }), { assertive: true });
    if (key) return focusEntry(entries.get(key));
    if (!summary.hidden) {
      summary.focus();
      return true;
    }
    return false;
  }

  function reset(next = null) {
    value = normalizeInitial(questionnaire, next, campaign);
    showErrors = false;
    for (const entry of entries.values()) entry.write();
    applyErrors([]);
    refreshDynamic();
  }

  function destroy() {
    destroyed = true;
    entries.clear();
    root.replaceChildren();
  }

  return api;
}
