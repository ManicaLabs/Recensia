// Composant questionnaire (src/ui/questionnaire.js) : logique pure — visibilité, obligation,
// exclusivité de « aucune », suggestions, valeur transmise à la validation, messages d'erreur.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  campaignOptions, fieldOrder, isFieldVisible, isFieldRequired, toggleChoice, orderValues, suggestionsFor,
  emptyUsage, normalizeInitial, visibleValue, errorText, firstErrors, textLength, frenchSpacing, displayQuestionnaire,
  nextFieldKey,
} from '../src/ui/questionnaire.js';
import { validateUsage } from '../src/engine/validate.js';
import { loadQuestionnaire, makeUsage } from './helpers/load-data.js';

const q = loadQuestionnaire();
const ANON = { mode: 'anonymous', departments: ['Direction', 'Production'], department_required: false };
const ANON_REQ = { ...ANON, department_required: true };
const ANON_NONE = { mode: 'anonymous', departments: [] };
const OPEN = { mode: 'open', departments: ['Direction', 'Production'] };
const catalog = JSON.parse(readFileSync(new URL('../src/i18n/fr/questionnaire.json', import.meta.url), 'utf8'));

// t() de test : résout dans le catalogue questionnaire.json, interpolation simple.
function lookup(key) {
  const [ns, ...path] = key.split('.');
  if (ns !== 'questionnaire') return undefined;
  let cur = catalog;
  for (const p of path) cur = cur && typeof cur === 'object' ? cur[p] : undefined;
  return cur;
}
function t(key, vars = {}) {
  let v = lookup(key);
  if (v && typeof v === 'object') v = Number(vars.count) === 1 ? v.one : v.other;
  if (typeof v !== 'string') return key;
  return v.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}
const has = (key) => typeof lookup(key) === 'string';

describe('options de campagne et ordre des champs', () => {
  test('campaignOptions normalise mode, services et obligation', () => {
    assert.deepEqual(campaignOptions(null), { mode: 'anonymous', departments: [], department_required: false });
    assert.deepEqual(campaignOptions({ mode: 'open', departments: ['A', 'A', '', 3, 'B'] }), { mode: 'open', departments: ['A', 'B'], department_required: false });
    assert.equal(campaignOptions({ settings: { department_required: true } }).department_required, true);
    assert.equal(campaignOptions({ mode: 'x' }).mode, 'anonymous');
  });

  test('fieldOrder suit les sections et couvre tous les champs une fois', () => {
    const order = fieldOrder(q);
    assert.equal(order[0], 'usage_name');
    assert.equal(order.at(-1), 'comment');
    assert.deepEqual([...order].sort(), Object.keys(q.fields).sort());
  });
});

describe('visibilité (show_if, service)', () => {
  test('tool_other visible seulement pour « Autre »', () => {
    assert.equal(isFieldVisible('tool_other', q, { tool: 'chatgpt' }, ANON), false);
    assert.equal(isFieldVisible('tool_other', q, { tool: 'other' }, ANON), true);
    assert.equal(isFieldVisible('tool_other', q, {}, ANON), false);
  });

  test('service masqué sans service proposé, affiché sinon', () => {
    assert.equal(isFieldVisible('department', q, {}, ANON_NONE), false);
    assert.equal(isFieldVisible('department', q, {}, ANON), true);
    assert.equal(isFieldVisible('department', q, {}, { mode: 'open', departments: [] }), false);
  });

  test('nextFieldKey : Entrée passe à la question suivante affichée', () => {
    assert.equal(nextFieldKey(q, {}, ANON, 'usage_name'), 'department');
    assert.equal(nextFieldKey(q, {}, ANON_NONE, 'usage_name'), 'tool', 'service masqué sauté');
    assert.equal(nextFieldKey(q, { tool: 'chatgpt' }, ANON, 'tool'), 'model', 'précision masquée sautée');
    assert.equal(nextFieldKey(q, { tool: 'other' }, ANON, 'tool_other'), 'model');
    assert.equal(nextFieldKey(q, {}, ANON, 'comment'), null);
    assert.equal(nextFieldKey(q, {}, ANON, 'inconnu'), null);
  });

  test('champ inconnu : non visible, non requis', () => {
    assert.equal(isFieldVisible('nope', q, {}, ANON), false);
    assert.equal(isFieldRequired('nope', q, {}, ANON), false);
  });
});

describe('obligation (mêmes règles que validateUsage)', () => {
  test('service : obligatoire en mode ouvert ou si la campagne l\'exige', () => {
    assert.equal(isFieldRequired('department', q, {}, ANON), false);
    assert.equal(isFieldRequired('department', q, {}, ANON_REQ), true);
    assert.equal(isFieldRequired('department', q, {}, OPEN), true);
    assert.equal(isFieldRequired('department', q, {}, ANON_NONE), false);
  });

  test('required_if : précision obligatoire pour « Autre »', () => {
    assert.equal(isFieldRequired('tool_other', q, { tool: 'other' }, ANON), true);
    assert.equal(isFieldRequired('tool_other', q, { tool: 'claude' }, ANON), false);
  });

  test('facultatifs et obligatoires du questionnaire', () => {
    assert.equal(isFieldRequired('usage_name', q, {}, ANON), true);
    assert.equal(isFieldRequired('model', q, {}, ANON), false);
    assert.equal(isFieldRequired('users_count', q, {}, ANON), false);
    assert.equal(isFieldRequired('comment', q, {}, ANON), false);
  });

  test('cohérence avec validateUsage : chaque champ requis vide produit « required »', () => {
    for (const campaign of [ANON, ANON_REQ, OPEN, ANON_NONE]) {
      const value = visibleValue(q, { tool: 'other' }, campaign);
      const result = validateUsage(value, q, campaign);
      const required = fieldOrder(q).filter((key) => value[key] === null && isFieldRequired(key, q, value, campaign));
      const flagged = result.errors.filter((e) => e.code === 'required').map((e) => e.field);
      assert.deepEqual(flagged.sort(), required.sort(), JSON.stringify(campaign));
    }
  });
});

describe('cases à cocher : « aucune » exclusive', () => {
  const def = q.fields.data_types;

  test('cocher « aucune » décoche tout le reste', () => {
    assert.deepEqual(toggleChoice(def, ['docs_internes', 'donnees_clients'], 'aucune', true), ['aucune']);
  });

  test('cocher une autre valeur décoche « aucune »', () => {
    assert.deepEqual(toggleChoice(def, ['aucune'], 'donnees_clients', true), ['donnees_clients']);
  });

  test('ordre canonique des options, décocher retire la valeur', () => {
    assert.deepEqual(toggleChoice(def, ['identifiants'], 'docs_internes', true), ['docs_internes', 'identifiants']);
    assert.deepEqual(toggleChoice(def, ['docs_internes', 'identifiants'], 'identifiants', false), ['docs_internes']);
    assert.deepEqual(toggleChoice(def, null, 'aucune', false), []);
  });

  test('sans exclusivité (task_types) : cumul libre', () => {
    const tasks = q.fields.task_types;
    assert.deepEqual(toggleChoice(tasks, ['resume'], 'redaction', true), ['redaction', 'resume']);
  });

  test('orderValues écarte les inconnues et les doublons', () => {
    assert.deepEqual(orderValues(def, ['code_source', 'x', 'code_source', 'aucune']), ['aucune', 'code_source']);
  });

  test('le résultat de toggleChoice est toujours accepté par validateUsage', () => {
    let value = [];
    for (const [option, checked] of [['docs_internes', true], ['aucune', true], ['identifiants', true], ['aucune', true], ['aucune', false], ['secrets_affaires', true]]) {
      value = toggleChoice(def, value, option, checked);
      if (!value.length) continue;
      const result = validateUsage(makeUsage({ data_types: value }), q, ANON);
      assert.ok(result.ok, `${JSON.stringify(value)} : ${JSON.stringify(result.errors)}`);
    }
  });
});

describe('suggestions', () => {
  test('suggestions du modèle selon l\'outil, puis suggestions générales', () => {
    const def = q.fields.model;
    assert.deepEqual(suggestionsFor(def, { tool: 'claude' }).slice(0, 3), ['Claude Sonnet', 'Claude Opus', 'Claude Haiku']);
    assert.ok(suggestionsFor(def, { tool: 'claude' }).includes('Modèle par défaut de l\'outil'));
    assert.deepEqual(suggestionsFor(def, { tool: 'other' }), ['Modèle par défaut de l\'outil']);
    assert.deepEqual(suggestionsFor(def, {}), ['Modèle par défaut de l\'outil']);
  });

  test('suggestions simples du nom de l\'usage ; aucune pour un champ sans liste', () => {
    assert.ok(suggestionsFor(q.fields.usage_name, {}).includes('Résumer des documents'));
    assert.deepEqual(suggestionsFor(q.fields.tool_other, {}), []);
    assert.deepEqual(suggestionsFor({ suggestions_by: { field: 'tool', values: { a: 'pas une liste' } } }, { tool: 'a' }), []);
  });
});

describe('valeurs initiales et valeur transmise', () => {
  test('emptyUsage : toutes les clés à null', () => {
    const empty = emptyUsage(q);
    assert.deepEqual(Object.keys(empty).sort(), Object.keys(q.fields).sort());
    assert.ok(Object.values(empty).every((v) => v === null));
  });

  test('normalizeInitial garde les valeurs valides, écarte le reste', () => {
    const init = normalizeInitial(q, {
      usage_name: 'Test', tool: 'inconnu', department: 'Direction', task_types: ['resume', 'zzz'], data_types: [], extra: 'x', comment: 42,
    }, ANON);
    assert.equal(init.usage_name, 'Test');
    assert.equal(init.tool, null);
    assert.equal(init.department, 'Direction');
    assert.deepEqual(init.task_types, ['resume']);
    assert.equal(init.data_types, null);
    assert.equal(init.comment, null);
    assert.equal(Object.hasOwn(init, 'extra'), false);
    assert.equal(normalizeInitial(q, { department: 'Direction' }, ANON_NONE).department, null, 'service hors campagne');
  });

  test('visibleValue : un champ masqué n\'est jamais transmis', () => {
    const value = visibleValue(q, makeUsage({ tool: 'chatgpt', tool_other: 'reste de saisie', department: 'Direction' }), ANON_NONE);
    assert.equal(value.tool_other, null);
    assert.equal(value.department, null);
    assert.ok(validateUsage(value, q, ANON_NONE).ok);
  });

  test('visibleValue : vides à null, listes copiées', () => {
    const tasks = ['resume'];
    const value = visibleValue(q, { usage_name: '', task_types: tasks, data_types: [] }, ANON);
    assert.equal(value.usage_name, null);
    assert.equal(value.data_types, null);
    assert.deepEqual(value.task_types, ['resume']);
    assert.notEqual(value.task_types, tasks);
  });

  test('usage complet du formulaire : valide en anonyme comme en ouvert', () => {
    const usage = makeUsage({ department: 'Production', tool: 'other', tool_other: 'Outil maison' });
    assert.ok(validateUsage(visibleValue(q, usage, OPEN), q, OPEN).ok);
    assert.ok(validateUsage(visibleValue(q, usage, ANON), q, ANON).ok);
  });

  test('textLength compte les caractères, pas les unités UTF-16', () => {
    assert.equal(textLength('é🙂'), 2);
    assert.equal(textLength(null), 0);
  });
});

describe('messages d\'erreur', () => {
  test('message propre au champ quand il existe', () => {
    assert.match(errorText({ field: 'usage_name', code: 'required' }, q, t, has), /nom court/);
    assert.match(errorText({ field: 'tool_other', code: 'required' }, q, t, has), /Précisez/);
  });

  test('messages génériques selon le type de champ', () => {
    assert.equal(errorText({ field: 'users_count', code: 'required' }, q, t, () => false), catalog.errors.required_radio);
    assert.equal(errorText({ field: 'task_types', code: 'required' }, q, t, () => false), catalog.errors.required_multi);
    assert.equal(errorText({ field: 'tool', code: 'required' }, q, t, () => false), catalog.errors.required_select);
    assert.equal(errorText({ field: 'model', code: 'required' }, q, t, () => false), catalog.errors.required_text);
    assert.match(errorText({ field: 'comment', code: 'too_long' }, q, t, has), /^500 /);
    assert.match(errorText({ field: 'data_types', code: 'exclusive' }, q, t, has), /Aucune donnée de l'entreprise/);
    assert.equal(errorText({ field: 'department', code: 'invalid_value' }, q, t, has), catalog.errors.invalid_department);
    assert.equal(errorText({ field: 'x', code: 'unknown_field' }, q, t, has), catalog.errors.invalid);
  });

  test('chaque code d\'erreur de validateUsage a un texte (aucune clé brute affichée)', () => {
    const codes = ['required', 'too_long', 'too_few', 'exclusive', 'invalid_value', 'invalid_type', 'duplicate', 'not_allowed', 'unknown_field'];
    for (const field of fieldOrder(q)) {
      for (const code of codes) {
        const text = errorText({ field, code }, q, t, has);
        assert.ok(!text.startsWith('questionnaire.'), `${field}/${code} : ${text}`);
      }
    }
  });

  test('firstErrors : une erreur par champ, dans l\'ordre du questionnaire, erreurs globales en tête', () => {
    const list = firstErrors([
      { field: 'comment', code: 'too_long' },
      { field: 'usage_name', code: 'required' },
      { field: 'usage_name', code: 'too_long' },
      { field: 'inconnu', code: 'unknown_field' },
    ], q);
    assert.deepEqual(list, [
      { field: null, code: 'unknown_field' },
      { field: 'usage_name', code: 'required' },
      { field: 'comment', code: 'too_long' },
    ]);
  });
});

describe('typographie des textes affichés', () => {
  test('frenchSpacing : insécable avant la ponctuation haute et dans les guillemets', () => {
    assert.equal(frenchSpacing('Ex. : a ? « b » ; c !'), 'Ex.\u00A0: a\u00A0? «\u00A0b\u00A0»\u00A0; c\u00A0!');
    assert.equal(frenchSpacing('déjà\u00A0: rien'), 'déjà\u00A0: rien');
    assert.equal(frenchSpacing(null), null);
  });

  test('displayQuestionnaire : textes corrigés, valeurs et suggestions intactes', () => {
    const d = displayQuestionnaire(q);
    assert.equal(d.fields.model.placeholder, "Ex.\u00A0: modèle par défaut de l'outil");
    assert.equal(d.fields.data_types.label, "Quelles données envoyez-vous à l'outil\u00A0?");
    assert.deepEqual(d.fields.tool.options.map((o) => o.value), q.fields.tool.options.map((o) => o.value));
    assert.deepEqual(d.fields.model.suggestions_by, q.fields.model.suggestions_by);
    assert.deepEqual(d.fields.tool_other.show_if, q.fields.tool_other.show_if);
    assert.equal(q.fields.model.placeholder.includes('\u00A0'), false, 'original non modifié');
    assert.ok(validateUsage(makeUsage(), d, ANON).ok);
  });
});

describe('catalogue questionnaire.json', () => {
  test('typographie : espaces insécables avant « : ; ? ! » et dans les guillemets', () => {
    const problems = [];
    const walk = (v, path) => {
      if (typeof v === 'string') {
        if (/ [:;?!]| »|« /.test(v)) problems.push(path);
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    for (const ns of ['questionnaire', 'form', 'add']) {
      walk(JSON.parse(readFileSync(new URL(`../src/i18n/fr/${ns}.json`, import.meta.url), 'utf8')), ns);
    }
    assert.deepEqual(problems, []);
  });

  test('messages propres aux champs : seulement des champs et codes existants', () => {
    for (const [field, codes] of Object.entries(catalog.field_errors)) {
      assert.ok(Object.hasOwn(q.fields, field), field);
      for (const code of Object.keys(codes)) assert.ok(['required', 'too_long', 'invalid_value', 'exclusive', 'too_few'].includes(code), `${field}.${code}`);
    }
  });
});
