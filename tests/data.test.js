// Cohérence des données métier : questionnaire (= ARCHITECTURE §3.1), règles, actions, calendrier.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AI_ACT_ORDER, DATA_LEVELS } from '../src/engine/levels.js';
import { conditionLeaves, evaluateCondition } from '../src/engine/evaluate.js';
import { SCHEMA_VERSION } from '../src/engine/validate.js';
import { loadAll } from './helpers/load-data.js';

const { questionnaire, rules, actions, calendar } = loadAll();

// ARCHITECTURE.md §3.1 : clés et valeurs d'énumération exactes.
const SPEC = {
  usage_name: { type: 'text', max: 80 },
  department: { type: 'department' },
  tool: { values: ['chatgpt', 'claude', 'gemini', 'microsoft_copilot', 'github_copilot', 'mistral_le_chat', 'perplexity', 'deepl',
    'midjourney', 'notion_ai', 'embedded_software_ai', 'internal_system', 'other'] },
  tool_other: { type: 'text', max: 80 },
  model: { type: 'text', max: 80 },
  account_type: { values: ['enterprise_provided', 'personal_paid', 'personal_free', 'api_integration', 'internal_system', 'unknown'] },
  task_types: { multi: true, values: ['redaction', 'resume', 'traduction', 'code', 'analyse_donnees', 'recherche_information',
    'generation_media', 'transcription', 'chatbot_externe', 'evaluation_tri_personnes', 'aide_decision', 'agent_automatisation', 'autre'] },
  business_domain: { values: ['rh', 'finance_credit', 'service_client', 'marketing_com', 'juridique', 'it_dev', 'production', 'formation',
    'sante', 'direction', 'commercial_devis', 'autre'] },
  data_types: { multi: true, values: ['aucune', 'docs_internes', 'donnees_clients', 'donnees_collaborateurs', 'donnees_candidats',
    'donnees_sensibles', 'secrets_affaires', 'code_source', 'donnees_financieres', 'identifiants'] },
  frequency: { values: ['daily', 'weekly', 'monthly', 'occasional'] },
  users_count: { values: ['1', '2-5', '6-15', '>15'] },
  output_audience: { values: ['internal_only', 'external_clients', 'public', 'not_applicable'] },
  output_review: { values: ['systematic', 'partial', 'none'] },
  affects_people: { values: ['yes_decision', 'yes_input', 'no', 'unknown'] },
  direct_interaction: { values: ['yes', 'no'] },
  biometric_emotion: { values: ['yes', 'no', 'unknown'] },
  built_or_customized: { values: ['use_as_is', 'configured_prompt', 'built_own'] },
  status: { values: ['in_use', 'pilot', 'planned'] },
  comment: { type: 'textarea', max: 500 },
};
const REQUIRED = ['usage_name', 'tool', 'account_type', 'task_types', 'business_domain', 'data_types', 'frequency', 'output_audience',
  'output_review', 'affects_people', 'direct_interaction', 'biometric_emotion', 'built_or_customized', 'status'];
const OPTIONAL = ['tool_other', 'model', 'users_count', 'comment'];

const ACTION_IDS = ['ACT-POL-01', 'ACT-LIT-01', 'ACT-SHADOW-01', 'ACT-DPA-01', 'ACT-DPIA-01', 'ACT-SEC-01', 'ACT-REV-01', 'ACT-TRANS-01',
  'ACT-TRANS-02', 'ACT-HR-01', 'ACT-HR-02', 'ACT-HR-03', 'ACT-LOG-01', 'ACT-PRO-01', 'ACT-QUAL-01', 'ACT-INV-01'];
const DEADLINE_IDS = ['prohibitions_art5', 'literacy_art4', 'gpai_providers', 'transparency_art50', 'marking_grace_art50_2',
  'omnibus_new_prohibitions', 'high_risk_annex_iii', 'high_risk_annex_i'];
const CDC_RULE_IDS = ['R-AIA-PRO-01', 'R-AIA-PRO-02', 'R-AIA-HI-EMP', 'R-AIA-HI-CRE', 'R-AIA-HI-EDU', 'R-AIA-HI-OTH', 'R-AIA-LIM-01',
  'R-AIA-LIM-02', 'R-AIA-PRV-01', 'R-AIA-MIN', 'R-AIA-LIT', 'R-AIA-HI-BIO', 'R-AIA-Q-BIO', 'R-AIA-Q-AFF'];
const EUR_LEX = 'https://eur-lex.europa.eu/';

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const values = (field) => (questionnaire.fields[field].options ?? []).map((o) => o.value);
const isMulti = (field) => questionnaire.fields[field].type === 'multi';

/** Vérifie qu'une condition ne référence que des champs et des valeurs existants, avec un opérateur adapté. */
function checkCondition(condition, where) {
  assert.doesNotThrow(() => evaluateCondition(condition, {}), `${where} : condition mal formée`);
  for (const leaf of conditionLeaves(condition)) {
    const at = `${where} (${leaf.field} ${leaf.op})`;
    assert.ok(Object.hasOwn(questionnaire.fields, leaf.field), `${at} : champ inconnu`);
    const known = values(leaf.field);
    const operands = Array.isArray(leaf.operand) ? leaf.operand : [leaf.operand];
    assert.ok(operands.length > 0, `${at} : liste vide`);
    for (const v of operands) assert.ok(known.includes(v), `${at} : valeur inconnue ${JSON.stringify(v)}`);
    if (leaf.op === 'includes_any' || leaf.op === 'includes_all') assert.ok(isMulti(leaf.field), `${at} : champ non multiple`);
    else assert.ok(!isMulti(leaf.field), `${at} : champ multiple, utiliser includes_any / includes_all`);
  }
}

function assertUnique(ids, what) {
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], `${what} en double : ${dup.join(', ')}`);
}

describe('questionnaire.json', () => {
  test('en-tête', () => {
    assert.equal(questionnaire.schema_version, SCHEMA_VERSION);
    assert.equal(questionnaire.estimated_minutes, 3);
  });

  test('clés exactement celles du §3.1', () => {
    assert.deepEqual(Object.keys(questionnaire.fields).sort(), Object.keys(SPEC).sort());
  });

  test('énumérations exactement celles du §3.1 (ordre compris)', () => {
    for (const [key, spec] of Object.entries(SPEC)) {
      const def = questionnaire.fields[key];
      if (spec.values) {
        assert.deepEqual(values(key), spec.values, key);
        assert.equal(def.type, spec.multi ? 'multi' : def.type, key);
        assert.ok(spec.multi ? def.type === 'multi' : ['select', 'radio'].includes(def.type), `${key} : type ${def.type}`);
      } else {
        assert.equal(def.type, spec.type, key);
        assert.equal(def.max, spec.max, `${key} : longueur maximale`);
        assert.equal(def.options, undefined, key);
      }
    }
  });

  test('caractère requis', () => {
    for (const key of REQUIRED) assert.equal(questionnaire.fields[key].required, true, key);
    for (const key of OPTIONAL) assert.equal(questionnaire.fields[key].required, false, key);
    assert.equal(questionnaire.fields.department.required, 'campaign');
    assert.equal(questionnaire.fields.task_types.min, 1);
    assert.equal(questionnaire.fields.data_types.min, 1);
    assert.deepEqual(questionnaire.fields.data_types.exclusive, ['aucune']);
  });

  test('tool_other : affiché et requis si « autre »', () => {
    const def = questionnaire.fields.tool_other;
    assert.deepEqual(def.show_if, { field: 'tool', eq: 'other' });
    assert.deepEqual(def.required_if, { field: 'tool', eq: 'other' });
  });

  test('cinq sections, chaque champ une seule fois, dans l\'ordre attendu', () => {
    assert.deepEqual(questionnaire.sections.map((s) => s.fields), [
      ['usage_name', 'department', 'tool', 'tool_other', 'model', 'account_type', 'status'],
      ['task_types', 'business_domain', 'frequency', 'users_count'],
      ['data_types'],
      ['output_audience', 'output_review', 'affects_people', 'direct_interaction', 'biometric_emotion', 'built_or_customized'],
      ['comment'],
    ]);
    assertUnique(questionnaire.sections.map((s) => s.id), 'section');
    for (const s of questionnaire.sections) assert.ok(s.title && s.id, s.id);
  });

  test('« Je ne sais pas » là où l\'énumération le prévoit', () => {
    for (const [key, def] of Object.entries(questionnaire.fields)) {
      const unknown = (def.options ?? []).find((o) => o.value === 'unknown');
      if (unknown) assert.equal(unknown.label, 'Je ne sais pas', key);
    }
  });

  test('libellés et aides en français, non vides', () => {
    for (const [key, def] of Object.entries(questionnaire.fields)) {
      assert.ok(typeof def.label === 'string' && def.label.trim().length > 3, key);
      for (const prop of ['help', 'placeholder', 'warning']) {
        if (prop in def) assert.ok(typeof def[prop] === 'string' && def[prop].trim() !== '', `${key}.${prop}`);
      }
      for (const o of def.options ?? []) {
        assert.ok(typeof o.label === 'string' && o.label.trim() !== '', `${key}.${o.value}`);
        assert.ok(/^[a-z0-9_>\-]+$/.test(o.value), `${key}.${o.value} : identifiant ASCII`);
      }
      assertUnique((def.options ?? []).map((o) => o.value), `${key} : valeur`);
    }
  });

  test('textes imposés : personnes physiques, commentaire sans donnée personnelle', () => {
    assert.ok(questionnaire.fields.affects_people.help.includes('personnes physiques (salariés, candidats, clients particuliers), pas des entreprises'));
    assert.ok(questionnaire.fields.comment.warning.startsWith('N\'y mettez aucune donnée personnelle'));
  });

  test('suggestions de modèles : listes de chaînes, outils existants', () => {
    const def = questionnaire.fields.model;
    assert.ok(def.suggestions.every((s) => typeof s === 'string' && s.length <= def.max));
    assert.equal(def.suggestions_by.field, 'tool');
    for (const [tool, list] of Object.entries(def.suggestions_by.values)) {
      assert.ok(values('tool').includes(tool), tool);
      assert.ok(Array.isArray(list) && list.every((s) => typeof s === 'string' && s.length <= def.max), tool);
    }
    assert.ok(questionnaire.fields.usage_name.suggestions.every((s) => s.length <= 80));
  });

  test('conditions du questionnaire valides', () => {
    for (const [key, def] of Object.entries(questionnaire.fields)) {
      if (def.show_if) checkCondition(def.show_if, `${key}.show_if`);
      if (def.required_if) checkCondition(def.required_if, `${key}.required_if`);
    }
  });
});

describe('rules.json', () => {
  test('en-tête', () => {
    assert.equal(rules.version, '2026-09-29.1');
    assert.equal(rules.reviewed, false);
    assert.equal(rules.note, 'Point de départ à relire par un juriste');
    assert.deepEqual(rules.ai_act_order, [...AI_ACT_ORDER]);
  });

  test('identifiants uniques ; règles du CDC et des décisions présentes', () => {
    const ids = rules.rules.map((r) => r.id);
    assertUnique(ids, 'règle');
    for (const id of CDC_RULE_IDS) assert.ok(ids.includes(id), id);
    for (const id of ids) assert.match(id, /^R-[A-Z]+(-[A-Z0-9]+)+$/, id);
  });

  test('barème data_base : chaque catégorie de données, score 0..3', () => {
    assert.deepEqual(Object.keys(rules.data_base).sort(), [...SPEC.data_types.values].sort());
    for (const [k, v] of Object.entries(rules.data_base)) assert.ok(DATA_LEVELS.includes(v), k);
    assert.equal(rules.data_base.aucune, 0);
    assert.equal(rules.data_base.identifiants, 3);
    assert.equal(rules.data_base.donnees_sensibles, 3);
    assert.equal(rules.data_base.docs_internes, 1);
  });

  test('forme de chaque règle', () => {
    for (const r of rules.rules) {
      assert.ok(['ai_act', 'data'].includes(r.axis), `${r.id} : axis`);
      assert.ok(['level', 'modifier', 'signal', 'transverse', 'question'].includes(r.kind), `${r.id} : kind`);
      for (const prop of ['label', 'legal_ref', 'explanation']) assert.ok(typeof r[prop] === 'string' && r[prop].trim() !== '', `${r.id}.${prop}`);
      assert.ok(Array.isArray(r.action_ids) && Array.isArray(r.deadline_ids), `${r.id} : listes`);
      assert.ok('condition' in r, `${r.id} : condition`);
      if (r.axis === 'ai_act') assert.ok(r.level === null || AI_ACT_ORDER.includes(r.level), `${r.id} : niveau AI Act`);
      else assert.ok(r.level === null || DATA_LEVELS.includes(r.level), `${r.id} : niveau de données`);
      if (r.kind === 'level') assert.ok(r.level !== null && r.level !== undefined, `${r.id} : règle de niveau sans niveau`);
      if (r.kind === 'transverse' || r.kind === 'signal' || r.kind === 'modifier') assert.equal(r.level, null, `${r.id} : pas de niveau`);
      if (r.kind === 'modifier') {
        assert.equal(r.axis, 'data', r.id);
        assert.ok(Number.isInteger(r.delta) && r.delta !== 0, `${r.id} : delta`);
        assert.ok(r.cap === undefined || DATA_LEVELS.includes(r.cap), `${r.id} : cap`);
        assert.ok(r.min_base === undefined || DATA_LEVELS.includes(r.min_base), `${r.id} : min_base`);
      }
      if (r.kind === 'signal') assert.ok(typeof r.signal === 'string' && r.signal in rules.signals, `${r.id} : signal`);
      if (r.signal !== undefined) assert.ok(r.signal in rules.signals, `${r.id} : libellé du signal`);
      if (r.kind === 'question') assert.ok(typeof r.question === 'string' && r.question.endsWith('?'), `${r.id} : question`);
      if (r.role !== undefined) assert.equal(r.role, 'potential_provider', `${r.id} : rôle`);
      if (r.fallback !== undefined) assert.equal(r.fallback, true, r.id);
    }
  });

  test('conditions valides (champs et valeurs du questionnaire)', () => {
    for (const r of rules.rules) checkCondition(r.condition, r.id);
  });

  test('toute règle « à qualifier » pose une question et appelle ACT-QUAL-01', () => {
    for (const r of rules.rules) {
      if (r.level === 'to_qualify' || r.kind === 'question') {
        assert.ok(typeof r.question === 'string' && r.question.endsWith('?'), `${r.id} : question`);
        assert.ok(r.action_ids.includes('ACT-QUAL-01'), `${r.id} : ACT-QUAL-01`);
      }
    }
  });

  test('règles de niveau des données cohérentes avec data_base', () => {
    const levelRules = rules.rules.filter((r) => r.axis === 'data' && r.kind === 'level');
    const covered = [];
    for (const r of levelRules) {
      assert.equal(r.condition.field, 'data_types', r.id);
      for (const t of r.condition.includes_any) {
        assert.equal(rules.data_base[t], r.level, `${r.id} : ${t}`);
        covered.push(t);
      }
    }
    assertUnique(covered, 'catégorie de données');
    assert.deepEqual(covered.sort(), Object.keys(rules.data_base).sort());
  });

  test('un seul repli par axe, sans condition restrictive', () => {
    const fallbacks = rules.rules.filter((r) => r.fallback);
    assert.deepEqual(fallbacks.map((r) => r.id), ['R-AIA-MIN']);
    assert.deepEqual(fallbacks[0].condition, { all: [] });
    assert.equal(fallbacks[0].level, 'minimal');
  });

  test('R-AIA-LIT transverse, sur tous les usages, action ACT-LIT-01', () => {
    const lit = rules.rules.find((r) => r.id === 'R-AIA-LIT');
    assert.equal(lit.kind, 'transverse');
    assert.equal(lit.level, null);
    assert.deepEqual(lit.condition, { all: [] });
    assert.ok(lit.action_ids.includes('ACT-LIT-01'));
  });

  test('action_ids et deadline_ids existants', () => {
    const actionIds = actions.templates.map((t) => t.id);
    const deadlineIds = calendar.deadlines.map((d) => d.id);
    for (const r of rules.rules) {
      for (const a of r.action_ids) assert.ok(actionIds.includes(a), `${r.id} → ${a}`);
      for (const d of r.deadline_ids) assert.ok(deadlineIds.includes(d), `${r.id} → ${d}`);
      assertUnique(r.action_ids, `${r.id} : action`);
      assertUnique(r.deadline_ids, `${r.id} : échéance`);
    }
  });

  test('aucune date réglementaire dans les règles (elles viennent du calendrier)', () => {
    assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(JSON.stringify(rules.rules)));
  });
});

describe('actions.json', () => {
  test('en-tête et les 16 actions du CDC §9', () => {
    assert.equal(typeof actions.version, 'string');
    assert.equal(actions.reviewed, false);
    assert.deepEqual(actions.templates.map((t) => t.id), ACTION_IDS);
  });

  test('forme de chaque modèle', () => {
    for (const t of actions.templates) {
      for (const prop of ['title', 'description', 'horizon']) assert.ok(typeof t[prop] === 'string' && t[prop].trim() !== '', `${t.id}.${prop}`);
      assert.ok(['high', 'medium', 'low'].includes(t.default_priority), `${t.id} : priorité`);
      assert.ok(['S', 'M', 'L'].includes(t.effort), `${t.id} : effort`);
      assert.ok(['Direction', 'DSI', 'RH', 'DPO/juriste', 'Métier'].includes(t.suggested_role), `${t.id} : rôle`);
      assert.ok(['usage', 'campaign'].includes(t.scope), `${t.id} : portée`);
      assert.ok(Array.isArray(t.rule_ids) && t.rule_ids.length > 0, `${t.id} : règles`);
      assert.ok(!('owner' in t), `${t.id} : jamais de responsable prédéfini`);
    }
  });

  test('portées : charte, littératie et revue du registre au niveau de la campagne', () => {
    const campaign = actions.templates.filter((t) => t.scope === 'campaign').map((t) => t.id);
    assert.deepEqual(campaign, ['ACT-POL-01', 'ACT-LIT-01', 'ACT-INV-01']);
    assert.equal(actions.templates.find((t) => t.id === 'ACT-SEC-01').default_priority, 'high');
    assert.equal(actions.templates.find((t) => t.id === 'ACT-SEC-01').horizon, 'Immédiat');
  });

  test('rule_ids existants et cohérents dans les deux sens', () => {
    const ruleIds = rules.rules.map((r) => r.id);
    for (const t of actions.templates) {
      for (const id of t.rule_ids) {
        assert.ok(ruleIds.includes(id), `${t.id} → ${id}`);
        assert.ok(rules.rules.find((r) => r.id === id).action_ids.includes(t.id), `${id} n'appelle pas ${t.id}`);
      }
    }
    for (const r of rules.rules) {
      for (const a of r.action_ids) {
        assert.ok(actions.templates.find((t) => t.id === a).rule_ids.includes(r.id), `${a} ne cite pas ${r.id}`);
      }
    }
  });

  test('chaque action est appelée par au moins une règle', () => {
    const called = new Set(rules.rules.flatMap((r) => r.action_ids));
    for (const id of ACTION_IDS) assert.ok(called.has(id), id);
  });
});

describe('regulatory-calendar.json', () => {
  test('en-tête', () => {
    // Valeurs susceptibles d'évoluer à la vérification sur EUR-Lex : seul le format est figé.
    assert.equal(typeof calendar.version, 'string');
    assert.ok(isDay(calendar.last_verified));
    assert.ok(['secondary', 'primary'].includes(calendar.verification_source));
    assert.ok(typeof calendar.note === 'string' && calendar.note.trim() !== '');
    assert.ok(calendar.reference_text.includes('2024/1689'));
  });

  test('échéances du CDC §13, identifiants uniques', () => {
    assert.deepEqual(calendar.deadlines.map((d) => d.id), DEADLINE_IDS);
  });

  test('forme de chaque échéance', () => {
    for (const d of calendar.deadlines) {
      assert.ok(isDay(d.date), `${d.id} : date`);
      assert.ok(isDay(d.last_verified), `${d.id} : last_verified`);
      assert.ok(['to_verify', 'verified'].includes(d.status), `${d.id} : statut`);
      assert.ok(typeof d.label === 'string' && d.label.trim() !== '', d.id);
      assert.ok(typeof d.note === 'string' && d.note.trim() !== '', d.id);
      assert.ok(d.source_url === null || d.source_url.startsWith(EUR_LEX), `${d.id} : source hors EUR-Lex`);
      if (d.source_url === null) assert.ok(/vérifi/.test(d.note), `${d.id} : une source absente doit être expliquée`);
    }
  });

  // Les dates elles-mêmes sont vérifiées séparément (EUR-Lex / JOUE) : seul l'enchaînement est figé ici.
  test('enchaînement cohérent des échéances', () => {
    const date = Object.fromEntries(calendar.deadlines.map((d) => [d.id, d.date]));
    assert.ok(date.prohibitions_art5 <= date.gpai_providers);
    assert.ok(date.gpai_providers <= date.transparency_art50);
    assert.ok(date.transparency_art50 <= date.marking_grace_art50_2);
    assert.ok(date.transparency_art50 <= date.high_risk_annex_iii);
    assert.ok(date.high_risk_annex_iii <= date.high_risk_annex_i);
  });
});
