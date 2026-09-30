// Moteur de règles : niveaux, évaluateur, table de vérité, couverture des règles,
// propriété « je ne sais pas ne fait jamais baisser », libellés et pureté des modules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { AI_ACT_ORDER, DATA_LEVELS, compareAiAct, maxAiAct, maxDataLevel, isAiActLevel } from '../src/engine/levels.js';
import { evaluateCondition, conditionLeaves } from '../src/engine/evaluate.js';
import { classifyUsage, deadlineAppliesToRole, resolveDeadlines } from '../src/engine/classify.js';
import { optionLabel, formatUsageValue } from '../src/engine/labels.js';
import { validateUsage } from '../src/engine/validate.js';
import { loadAll, makeUsage, readText } from './helpers/load-data.js';

const { questionnaire, rules, calendar, fixtures, demo } = loadAll();
const classify = (usage) => classifyUsage(usage, rules, calendar);

describe('levels', () => {
  test('ordre de gravité : to_qualify au-dessus de limited', () => {
    assert.deepEqual([...AI_ACT_ORDER], ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']);
    assert.deepEqual([...DATA_LEVELS], [0, 1, 2, 3]);
    assert.ok(compareAiAct('to_qualify', 'limited') < 0);
    assert.ok(compareAiAct('high', 'to_qualify') < 0);
    assert.ok(compareAiAct('minimal', 'limited') > 0);
    assert.equal(compareAiAct('high', 'high'), 0);
    assert.ok(compareAiAct('minimal', 'inconnu') < 0, 'une valeur inconnue est la moins grave');
  });

  test('maxAiAct et maxDataLevel', () => {
    assert.equal(maxAiAct([]), 'minimal');
    assert.equal(maxAiAct(undefined), 'minimal');
    assert.equal(maxAiAct(['limited', 'to_qualify', 'minimal']), 'to_qualify');
    assert.equal(maxAiAct(['limited', 'high', 'prohibited_suspected']), 'prohibited_suspected');
    assert.equal(maxAiAct(['limited', 'bizarre']), 'limited');
    assert.equal(maxDataLevel([]), 0);
    assert.equal(maxDataLevel([1, 3, 2]), 3);
    assert.ok(isAiActLevel('high') && !isAiActLevel('medium'));
  });

  test('rules.json reprend le même ordre', () => {
    assert.deepEqual(rules.ai_act_order, [...AI_ACT_ORDER]);
  });
});

describe('evaluateCondition', () => {
  const u = makeUsage({ task_types: ['redaction', 'resume'], business_domain: 'rh' });

  test('feuilles eq, in, includes_any, includes_all', () => {
    assert.equal(evaluateCondition({ field: 'business_domain', eq: 'rh' }, u), true);
    assert.equal(evaluateCondition({ field: 'business_domain', eq: 'it_dev' }, u), false);
    assert.equal(evaluateCondition({ field: 'business_domain', in: ['it_dev', 'rh'] }, u), true);
    assert.equal(evaluateCondition({ field: 'business_domain', in: [] }, u), false);
    assert.equal(evaluateCondition({ field: 'task_types', includes_any: ['code', 'resume'] }, u), true);
    assert.equal(evaluateCondition({ field: 'task_types', includes_any: ['code'] }, u), false);
    assert.equal(evaluateCondition({ field: 'task_types', includes_all: ['redaction', 'resume'] }, u), true);
    assert.equal(evaluateCondition({ field: 'task_types', includes_all: ['redaction', 'code'] }, u), false);
    assert.equal(evaluateCondition({ field: 'business_domain', includes_any: ['rh'] }, u), false, 'includes_* exige un tableau');
    assert.equal(evaluateCondition({ field: 'task_types', eq: 'redaction' }, u), false, 'eq ne regarde pas dans un tableau');
    assert.equal(evaluateCondition({ field: 'absent', eq: 'x' }, u), false);
  });

  test('combinateurs all, any, not (y compris listes vides)', () => {
    const t = { field: 'business_domain', eq: 'rh' };
    const f = { field: 'business_domain', eq: 'it_dev' };
    assert.equal(evaluateCondition({ all: [t, t] }, u), true);
    assert.equal(evaluateCondition({ all: [t, f] }, u), false);
    assert.equal(evaluateCondition({ any: [f, t] }, u), true);
    assert.equal(evaluateCondition({ any: [f] }, u), false);
    assert.equal(evaluateCondition({ not: f }, u), true);
    assert.equal(evaluateCondition({ all: [] }, u), true);
    assert.equal(evaluateCondition({ any: [] }, u), false);
    assert.equal(evaluateCondition({ all: [{ not: { any: [f] } }, { any: [t] }] }, u), true);
  });

  test('conditions mal formées rejetées', () => {
    const bad = [
      null,
      [],
      'x',
      {},
      { field: 'tool' },
      { field: 'tool', gt: 1 },
      { field: 'tool', eq: 'a', in: ['a'] },
      { all: [], any: [] },
      { all: 'x' },
      { field: 'tool', in: 'chatgpt' },
      { field: 'tool', includes_any: 'chatgpt' },
      { field: '', eq: 'a' },
    ];
    for (const c of bad) assert.throws(() => evaluateCondition(c, u), TypeError, JSON.stringify(c));
  });

  test('usage absent : aucune feuille vraie', () => {
    assert.equal(evaluateCondition({ field: 'tool', eq: 'chatgpt' }, null), false);
    assert.equal(evaluateCondition({ not: { field: 'tool', eq: 'chatgpt' } }, undefined), true);
  });

  test('conditionLeaves parcourt toutes les feuilles', () => {
    const leaves = conditionLeaves({ all: [{ field: 'a', eq: 1 }, { not: { any: [{ field: 'b', in: [2] }] } }] });
    assert.deepEqual(leaves, [{ field: 'a', op: 'eq', operand: 1 }, { field: 'b', op: 'in', operand: [2] }]);
  });
});

describe('table de vérité (tests/fixtures/usages.json)', () => {
  const cases = fixtures.cases;

  test('au moins 50 cas, identifiants uniques, dont les 10 usages de l\'annexe A', () => {
    assert.ok(cases.length >= 50, `${cases.length} cas`);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    for (let i = 1; i <= 10; i += 1) {
      assert.ok(cases.some((c) => c.id === `annexA-${String(i).padStart(2, '0')}`), `annexA-${i}`);
    }
  });

  test('les fixtures suivent la version courante des règles', () => {
    assert.equal(fixtures.rules_version, rules.version, 'mettre à jour les fixtures (et rules_version) après toute modification des règles');
  });

  const departments = demo.campaign.departments;
  for (const c of cases) {
    test(`${c.id} : ${c.description}`, () => {
      const check = validateUsage(c.usage, questionnaire, { departments, department_required: false, mode: 'anonymous' });
      assert.deepEqual(check.errors, [], 'la fixture doit être un usage complet et valide');
      assert.deepEqual(check.value, c.usage, 'la fixture doit être déjà normalisée');

      const r = classify(c.usage);
      const e = c.expected;
      const ids = r.triggers.map((t) => t.rule_id);
      assert.equal(r.ai_act_level, e.ai_act_level, `niveau AI Act (déclencheurs : ${ids.join(', ')})`);
      assert.equal(r.data_level, e.data_level, 'exposition des données');
      if ('data_to_qualify' in e) assert.equal(r.data_to_qualify, e.data_to_qualify, 'data_to_qualify');
      assert.equal(r.role, e.role ?? 'deployer', 'rôle');
      // Listes exactes : un changement de règle qui touche ce cas doit être répercuté dans la fixture.
      assert.ok(Array.isArray(e.triggers) && Array.isArray(e.deadlines), 'la fixture doit fixer la liste exacte des déclencheurs et des échéances');
      assert.deepEqual(ids, e.triggers, 'déclencheurs (liste exacte, ordre du fichier de règles)');
      assert.deepEqual(r.deadlines.map((d) => d.id), e.deadlines, 'échéances (liste exacte, triées par date)');
      for (const id of e.triggers_include ?? []) assert.ok(ids.includes(id), `déclencheur attendu ${id}`);
      for (const id of e.triggers_exclude ?? []) assert.ok(!ids.includes(id), `déclencheur inattendu ${id}`);
      for (const id of e.actions_include ?? []) assert.ok(r.action_ids.includes(id), `action attendue ${id}`);
      for (const id of e.signals_include ?? []) assert.ok(r.signals.some((s) => s.id === id), `signal attendu ${id}`);
    });
  }

  test('chaque règle est déclenchée par au moins une fixture et vérifiée explicitement', () => {
    const fired = new Set();
    const asserted = new Set();
    for (const c of cases) {
      for (const t of classify(c.usage).triggers) fired.add(t.rule_id);
      for (const id of c.expected.triggers_include ?? []) asserted.add(id);
    }
    const missing = rules.rules.map((r) => r.id).filter((id) => !fired.has(id) || !asserted.has(id));
    assert.deepEqual(missing, [], `règles sans fixture : ${missing.join(', ')}`);
  });

  test('chaque niveau AI Act et chaque niveau de données est représenté', () => {
    const ai = new Set(cases.map((c) => c.expected.ai_act_level));
    const data = new Set(cases.map((c) => c.expected.data_level));
    for (const l of AI_ACT_ORDER) assert.ok(ai.has(l), l);
    for (const l of DATA_LEVELS) assert.ok(data.has(l), String(l));
  });
});

describe('« Je ne sais pas » ne fait jamais baisser le niveau', () => {
  // Champs dont l'énumération prévoit « unknown ».
  const unknownFields = Object.entries(questionnaire.fields)
    .filter(([, def]) => (def.options ?? []).some((o) => o.value === 'unknown'))
    .map(([key]) => key);

  test('champs concernés', () => {
    assert.deepEqual(unknownFields.sort(), ['account_type', 'affects_people', 'biometric_emotion']);
  });

  // Pour chaque fixture, chaque champ à « unknown » et chaque réponse connue possible :
  // le niveau obtenu avec « unknown » est au moins aussi grave que le niveau obtenu avec la réponse
  // connue, dans la limite de « to_qualify » (au-delà, c'est la question à confirmer qui porte
  // le risque : « je ne sais pas » ne peut pas valoir interdiction).
  test('propriété sur toutes les fixtures et toutes les réponses connues', () => {
    let checks = 0;
    for (const c of fixtures.cases) {
      for (const field of unknownFields) {
        const unknown = classify({ ...c.usage, [field]: 'unknown' });
        const known = questionnaire.fields[field].options.map((o) => o.value).filter((v) => v !== 'unknown');
        for (const value of known) {
          const base = classify({ ...c.usage, [field]: value });
          const floor = compareAiAct(base.ai_act_level, 'to_qualify') < 0 ? 'to_qualify' : base.ai_act_level;
          const where = `${c.id}, ${field} : ${value} → unknown`;
          assert.ok(compareAiAct(unknown.ai_act_level, floor) <= 0,
            `${where} : ${base.ai_act_level} → ${unknown.ai_act_level}`);
          if (base.data_to_qualify) assert.equal(unknown.data_to_qualify, true, `${where} : data_to_qualify redevenu faux`);
          if (unknown.data_level < base.data_level) {
            assert.equal(unknown.data_to_qualify, true, `${where} : exposition en baisse sans « à qualifier »`);
          }
          checks += 1;
        }
        assert.ok(unknown.questions_to_confirm.length > 0, `${c.id}, ${field} = unknown : aucune question à confirmer`);
        if (field === 'account_type') assert.equal(unknown.data_to_qualify, true);
        else assert.ok(compareAiAct(unknown.ai_act_level, 'to_qualify') <= 0, `${c.id}, ${field} = unknown : sous to_qualify`);
      }
    }
    assert.ok(checks > 100);
  });

  test('remplacer la réponse de la fixture par « unknown » ne la fait jamais passer sous to_qualify', () => {
    for (const c of fixtures.cases) {
      const base = classify(c.usage);
      for (const field of unknownFields) {
        if (c.usage[field] === 'unknown') continue;
        const unknown = classify({ ...c.usage, [field]: 'unknown' });
        const floor = compareAiAct(base.ai_act_level, 'to_qualify') < 0 ? 'to_qualify' : base.ai_act_level;
        assert.ok(compareAiAct(unknown.ai_act_level, floor) <= 0, `${c.id}, ${field}`);
        assert.ok(unknown.data_to_qualify || !base.data_to_qualify, `${c.id}, ${field} : data_to_qualify`);
      }
    }
  });
});

describe('classifyUsage : sortie', () => {
  test('forme de la sortie et déclencheurs expliqués', () => {
    const r = classify(makeUsage({ account_type: 'personal_free' }));
    assert.deepEqual(Object.keys(r).sort(), ['action_ids', 'ai_act_level', 'data_level', 'data_to_qualify', 'deadlines',
      'questions_to_confirm', 'role', 'signals', 'triggers'].sort());
    for (const t of r.triggers) {
      assert.equal(typeof t.rule_id, 'string');
      assert.ok(['ai_act', 'data'].includes(t.axis));
      assert.ok(t.label && t.legal_ref && t.explanation, t.rule_id);
    }
    const perso = r.triggers.find((t) => t.rule_id === 'R-DAT-PERSO');
    assert.equal(perso.kind, 'modifier');
    assert.equal(perso.delta, 1);
  });

  test('cumul de déclencheurs : niveau le plus grave affiché, tous listés', () => {
    const r = classify(makeUsage({
      business_domain: 'rh', task_types: ['chatbot_externe'], direct_interaction: 'yes', affects_people: 'yes_input',
      data_types: ['donnees_candidats'], output_audience: 'external_clients',
    }));
    assert.equal(r.ai_act_level, 'high');
    const levels = r.triggers.filter((t) => t.axis === 'ai_act' && t.level).map((t) => t.level);
    assert.ok(levels.includes('high') && levels.includes('limited'));
    assert.ok(!r.triggers.some((t) => t.rule_id === 'R-AIA-MIN'), 'le repli « minimal » ne s\'ajoute pas');
  });

  test('échéances résolues depuis le calendrier et triées par date', () => {
    const r = classify(makeUsage({ task_types: ['generation_media'], output_audience: 'public', direct_interaction: 'yes' }));
    const ids = r.deadlines.map((d) => d.id);
    assert.ok(ids.includes('transparency_art50') && ids.includes('literacy_art4'));
    assert.equal(new Set(ids).size, ids.length);
    const dates = r.deadlines.map((d) => d.date);
    assert.deepEqual(dates, [...dates].sort());
    const d = r.deadlines.find((x) => x.id === 'transparency_art50');
    const source = calendar.deadlines.find((x) => x.id === 'transparency_art50');
    assert.deepEqual(d, {
      id: source.id, date: source.date, label: source.label, status: source.status,
      source_url: source.source_url, last_verified: source.last_verified,
    });
  });

  // CDC §13 : le délai de grâce du 2 décembre 2026 (nouvel art. 111, § 4) ne vise que le marquage
  // de l'art. 50, § 2, par les FOURNISSEURS ; les obligations des déployeurs s'appliquent depuis le 2 août 2026.
  test('échéance réservée à un rôle (applies_to_roles) : délai de grâce du marquage pour les seuls fournisseurs', () => {
    const grace = calendar.deadlines.find((d) => d.id === 'marking_grace_art50_2');
    assert.deepEqual(grace.applies_to_roles, ['potential_provider']);
    const media = { task_types: ['generation_media'], output_audience: 'public', output_review: 'partial' };
    const deployer = classify(makeUsage(media));
    assert.equal(deployer.role, 'deployer');
    assert.ok(deployer.triggers.some((t) => t.rule_id === 'R-AIA-LIM-02'));
    assert.deepEqual(deployer.deadlines.map((d) => d.id), ['literacy_art4', 'transparency_art50']);
    const provider = classify(makeUsage({ ...media, built_or_customized: 'built_own' }));
    assert.equal(provider.role, 'potential_provider');
    assert.ok(provider.deadlines.some((d) => d.id === 'marking_grace_art50_2'));
    assert.ok(!('applies_to_roles' in provider.deadlines.find((d) => d.id === 'marking_grace_art50_2')), 'forme de sortie inchangée');
    // Sans restriction dans le calendrier, l'échéance vaut pour tous les rôles.
    const open = { ...calendar, deadlines: calendar.deadlines.map(({ applies_to_roles, ...d }) => d) };
    assert.ok(classifyUsage(makeUsage(media), rules, open).deadlines.some((d) => d.id === 'marking_grace_art50_2'));
    assert.equal(deadlineAppliesToRole({ applies_to_roles: [] }, 'deployer'), true);
    assert.equal(deadlineAppliesToRole(grace), false, 'rôle par défaut : déployeur');
    assert.deepEqual(resolveDeadlines(['marking_grace_art50_2', 'transparency_art50'], calendar).map((d) => d.id), ['transparency_art50']);
    assert.deepEqual(resolveDeadlines(['marking_grace_art50_2'], calendar, { role: 'potential_provider' }).map((d) => d.id), ['marking_grace_art50_2']);
  });

  test('les dates viennent du calendrier passé en paramètre', () => {
    const shifted = { ...calendar, deadlines: calendar.deadlines.map((d) => ({ ...d, date: '2099-01-01' })) };
    const r = classifyUsage(makeUsage(), rules, shifted);
    assert.ok(r.deadlines.length > 0);
    assert.ok(r.deadlines.every((d) => d.date === '2099-01-01'));
    assert.deepEqual(classifyUsage(makeUsage(), rules, null).deadlines, []);
  });

  test('questions et signaux dédoublonnés', () => {
    const r = classify(makeUsage({ account_type: 'unknown', affects_people: 'unknown', biometric_emotion: 'unknown' }));
    assert.deepEqual(r.questions_to_confirm.map((q) => q.rule_id).sort(), ['R-AIA-Q-AFF', 'R-AIA-Q-BIO', 'R-DAT-Q-ACCOUNT']);
    assert.equal(r.signals.filter((s) => s.id === 'shadow_ai').length, 1);
    assert.equal(r.signals[0].label, rules.signals.shadow_ai);
    assert.equal(r.action_ids.filter((a) => a === 'ACT-QUAL-01').length, 1);
  });

  test('le modificateur respecte min_base et cap', () => {
    assert.equal(classify(makeUsage({ account_type: 'personal_free', data_types: ['aucune'] })).data_level, 0);
    assert.equal(classify(makeUsage({ account_type: 'personal_free', data_types: ['docs_internes'] })).data_level, 2);
    assert.equal(classify(makeUsage({ account_type: 'personal_paid', data_types: ['donnees_clients'] })).data_level, 3);
    assert.equal(classify(makeUsage({ account_type: 'personal_paid', data_types: ['identifiants'] })).data_level, 3);
  });

  test('algorithme générique : les seuils viennent des règles passées en paramètre', () => {
    const custom = {
      data_base: { docs_internes: 2 },
      rules: [
        { id: 'X-1', axis: 'ai_act', kind: 'level', level: 'high', condition: { field: 'tool', eq: 'claude' }, action_ids: ['A'], deadline_ids: [] },
        { id: 'X-2', axis: 'ai_act', kind: 'level', level: 'minimal', fallback: true, condition: { all: [] } },
        { id: 'X-3', axis: 'data', kind: 'modifier', delta: 2, cap: 3, condition: { field: 'frequency', eq: 'daily' } },
        { id: 'X-4', axis: 'data', kind: 'question', question: 'Q ?', condition: { field: 'status', eq: 'pilot' } },
      ],
    };
    const a = classifyUsage(makeUsage({ tool: 'claude', frequency: 'daily', status: 'pilot' }), custom, null);
    assert.equal(a.ai_act_level, 'high');
    assert.equal(a.data_level, 3);
    assert.equal(a.data_to_qualify, true);
    assert.deepEqual(a.triggers.map((t) => t.rule_id), ['X-1', 'X-3', 'X-4']);
    const b = classifyUsage(makeUsage({ tool: 'gemini' }), custom, null);
    assert.equal(b.ai_act_level, 'minimal');
    assert.equal(b.data_level, 2);
    assert.deepEqual(b.triggers.map((t) => t.rule_id), ['X-2']);
    assert.deepEqual(classifyUsage(makeUsage(), { rules: [] }, null).ai_act_level, 'minimal');
  });
});

describe('labels', () => {
  test('optionLabel et formatUsageValue', () => {
    assert.equal(optionLabel(questionnaire, 'tool', 'chatgpt'), 'ChatGPT');
    assert.equal(optionLabel(questionnaire, 'affects_people', 'unknown'), 'Je ne sais pas');
    assert.equal(optionLabel(questionnaire, 'tool', 'inexistant'), 'inexistant');
    assert.equal(optionLabel(questionnaire, 'department', 'Direction'), 'Direction');
    assert.equal(optionLabel(questionnaire, 'tool', null), '');
    assert.equal(optionLabel(null, 'tool', 'chatgpt'), 'chatgpt');
    assert.equal(formatUsageValue(questionnaire, 'task_types', ['redaction', 'resume']), 'Rédaction ou reformulation, Résumé');
    assert.equal(formatUsageValue(questionnaire, 'task_types', []), '');
    assert.equal(formatUsageValue(questionnaire, 'frequency', 'daily'), 'Tous les jours');
    assert.equal(formatUsageValue(questionnaire, 'model', null), '');
  });
});

// Caractères invisibles ou bidi interdits en clair dans le code source (attaque « Trojan Source »).
const INVISIBLE_CODES = [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c,
  0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];

describe('pureté des modules du moteur', () => {
  const files = readdirSync(new URL('../src/engine/', import.meta.url)).filter((f) => f.endsWith('.js'));

  test('les huit modules du contrat existent', () => {
    for (const f of ['levels.js', 'labels.js', 'evaluate.js', 'validate.js', 'classify.js', 'consolidate.js', 'actions.js', 'stats.js']) {
      assert.ok(files.includes(f), f);
    }
  });

  for (const f of files) {
    test(`${f} : ni DOM, ni réseau, ni eval, ni date réglementaire en dur`, () => {
      const src = readText(`src/engine/${f}`);
      for (const bad of [/\bdocument\./, /\bwindow\./, /\bfetch\s*\(/, /innerHTML|outerHTML|insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function/, /localStorage|sessionStorage|indexedDB/]) {
        assert.ok(!bad.test(src), `${f} : ${bad}`);
      }
      assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(src), `${f} : date en dur`);
      const invisible = [...src].find((ch) => INVISIBLE_CODES.includes(ch.codePointAt(0)));
      assert.equal(invisible, undefined, `${f} : caractère invisible ou bidi littéral (utiliser une séquence d'échappement)`);
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) assert.ok(/^\.\/[a-z-]+\.js$/.test(m[1]), `${f} : import ${m[1]}`);
    });
  }
});
