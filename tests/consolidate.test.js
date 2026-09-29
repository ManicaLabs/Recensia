// Consolidation des déclarations en lignes de registre.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { usageKey, groupId, consolidate, fnv1a32, normalizeToolOther } from '../src/engine/consolidate.js';
import { classifyUsage } from '../src/engine/classify.js';
import { compareAiAct } from '../src/engine/levels.js';
import { loadRules, loadCalendar, makeEntry } from './helpers/load-data.js';

const rules = loadRules();
const calendar = loadCalendar();

describe('usageKey et groupId', () => {
  test('FNV-1a 32 bits : vecteurs de référence', () => {
    assert.equal(fnv1a32(''), 0x811c9dc5);
    assert.equal(fnv1a32('a'), 0xe40c292c);
    assert.equal(fnv1a32('foobar'), 0xbf9cf968);
  });

  test('groupId : format et valeur figée', () => {
    assert.equal(groupId('a'), 'U-0C29C8');
    const id = groupId('chatgpt|redaction|commercial_devis');
    assert.match(id, /^U-[0-9A-F]{6}$/);
    assert.equal(groupId('chatgpt|redaction|commercial_devis'), id, 'déterministe');
    assert.notEqual(groupId('chatgpt|redaction|rh'), id);
  });

  test('clé : outil + tâches triées + domaine', () => {
    const base = { tool: 'chatgpt', task_types: ['resume', 'redaction'], business_domain: 'direction', department: 'Direction' };
    assert.equal(usageKey(base), 'chatgpt|redaction,resume|direction');
    assert.equal(usageKey({ ...base, task_types: ['redaction', 'resume'] }), usageKey(base), 'ordre des tâches indifférent');
    assert.equal(usageKey(base, { byDepartment: true }), 'chatgpt|redaction,resume|direction|Direction');
    assert.equal(usageKey({ ...base, department: null }, { byDepartment: true }), 'chatgpt|redaction,resume|direction|');
    assert.notEqual(usageKey({ ...base, data_types: ['aucune'] }), undefined);
    assert.equal(usageKey({ ...base, data_types: ['aucune'], account_type: 'personal_free' }), usageKey(base), 'données et compte hors clé');
  });

  test('clé : précision « autre » normalisée en minuscules', () => {
    const a = { tool: 'other', tool_other: '  Chatbot   Tiers ', task_types: ['chatbot_externe'], business_domain: 'service_client' };
    const b = { ...a, tool_other: 'chatbot tiers' };
    assert.equal(usageKey(a), 'other:chatbot tiers|chatbot_externe|service_client');
    assert.equal(usageKey(a), usageKey(b));
    assert.notEqual(usageKey(a), usageKey({ ...a, tool_other: 'Autre chatbot' }));
    assert.equal(usageKey({ ...a, tool: 'chatgpt' }), 'chatgpt|chatbot_externe|service_client', 'précision ignorée hors « autre »');
    assert.equal(normalizeToolOther(null), '');
  });

  test('clé : les séparateurs saisis en texte libre ne créent pas de collision', () => {
    const a = { tool: 'other', tool_other: 'x|code', task_types: ['redaction'], business_domain: 'rh' };
    const b = { tool: 'other', tool_other: 'x', task_types: ['code'], business_domain: 'rh' };
    assert.notEqual(usageKey(a), usageKey(b));
  });
});

describe('consolidate', () => {
  test('regroupe les déclarations identiques, niveau = maximum des membres', () => {
    const entries = [
      makeEntry({ usage_name: 'Reformulation de mails', account_type: 'enterprise_provided', data_types: ['docs_internes'], department: 'Commercial' }),
      makeEntry({ usage_name: 'Reformulation de mails', account_type: 'personal_free', data_types: ['donnees_clients'], department: 'Direction', model: 'GPT' }),
      makeEntry({ usage_name: 'Reformuler des e-mails', task_types: ['redaction'], data_types: ['docs_internes'], department: 'Commercial', model: 'gpt', comment: 'Pratique.' }),
      makeEntry({ usage_name: 'Traduction', tool: 'deepl', task_types: ['traduction'], data_types: ['aucune'] }),
    ];
    const groups = consolidate(entries, rules, calendar);
    assert.equal(groups.length, 2);
    const g = groups.find((x) => x.tool === 'chatgpt');
    assert.equal(g.count, 3);
    assert.equal(g.members.length, 3);
    assert.equal(g.name, 'Reformulation de mails');
    assert.deepEqual(g.names, ['Reformulation de mails', 'Reformuler des e-mails']);
    assert.equal(g.computed.data_level, 3, '2 + 1 (compte personnel) pour le membre le plus exposé');
    assert.equal(g.computed.ai_act_level, 'minimal');
    assert.deepEqual(g.departments, ['Commercial', 'Direction']);
    assert.deepEqual(g.account_types, ['enterprise_provided', 'personal_free']);
    assert.deepEqual(g.data_types, ['docs_internes', 'donnees_clients']);
    assert.deepEqual(g.models, ['GPT'], 'modèles dédoublonnés sans tenir compte de la casse');
    assert.equal(g.comments_count, 1);
    assert.ok(g.computed.signals.some((s) => s.id === 'shadow_ai'));
    assert.ok(g.computed.action_ids.includes('ACT-SHADOW-01') && g.computed.action_ids.includes('ACT-DPA-01'));
    assert.equal(g.id, groupId(g.usage_key));
    assert.equal(g.usage_key, 'chatgpt|redaction|commercial_devis');
  });

  test('niveau AI Act du groupe = le plus grave ; unions sans doublon', () => {
    const entries = [
      makeEntry({ business_domain: 'rh', task_types: ['redaction'], affects_people: 'no', data_types: ['docs_internes'] }),
      makeEntry({ business_domain: 'rh', task_types: ['redaction'], affects_people: 'yes_input', data_types: ['donnees_collaborateurs'] }),
      makeEntry({ business_domain: 'rh', task_types: ['redaction'], affects_people: 'unknown', data_types: ['docs_internes'], account_type: 'unknown' }),
    ];
    const [g] = consolidate(entries, rules, calendar);
    assert.equal(g.computed.ai_act_level, 'high');
    assert.equal(g.computed.data_to_qualify, true);
    const ids = g.computed.triggers.map((t) => t.rule_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('R-AIA-HI-EMP') && ids.includes('R-AIA-Q-AFF') && ids.includes('R-AIA-MIN'));
    const order = rules.rules.map((r) => r.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'ordre du fichier de règles');
    const qs = g.computed.questions_to_confirm.map((q) => q.rule_id);
    assert.deepEqual(qs.sort(), ['R-AIA-Q-AFF', 'R-DAT-Q-ACCOUNT']);
    assert.equal(new Set(g.computed.deadlines.map((d) => d.id)).size, g.computed.deadlines.length);
    assert.equal(new Set(g.computed.action_ids).size, g.computed.action_ids.length);
    assert.equal(g.effective.ai_act_level, 'high');
    assert.equal(g.effective.overridden, false);
  });

  test('le groupe n\'est jamais moins grave que chacun de ses membres', () => {
    const entries = [
      makeEntry({ direct_interaction: 'yes', data_types: ['aucune'] }),
      makeEntry({ built_or_customized: 'built_own', data_types: ['identifiants'] }),
    ];
    const [g] = consolidate(entries, rules, calendar);
    for (const e of entries) {
      const c = classifyUsage(e.usage, rules, calendar);
      assert.ok(compareAiAct(g.computed.ai_act_level, c.ai_act_level) <= 0);
      assert.ok(g.computed.data_level >= c.data_level);
    }
    assert.equal(g.computed.ai_act_level, 'to_qualify');
    assert.equal(g.computed.data_level, 3);
    assert.equal(g.computed.role, 'potential_provider');
  });

  test('entrées exclues ignorées', () => {
    const entries = [
      makeEntry({ usage_name: 'A' }),
      makeEntry({ usage_name: 'B', biometric_emotion: 'yes', business_domain: 'rh' }, { excluded: true }),
    ];
    const groups = consolidate(entries, rules, calendar);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 1);
    assert.equal(groups[0].computed.ai_act_level, 'minimal');
    assert.deepEqual(consolidate([], rules, calendar), []);
    assert.deepEqual(consolidate([makeEntry({}, { excluded: true })], rules, calendar), []);
  });

  test('group_override prioritaire sur la clé calculée', () => {
    const target = makeEntry({ tool: 'other', tool_other: 'Outil de transcription', task_types: ['resume', 'transcription'], business_domain: 'direction' });
    const key = usageKey(target.usage);
    const merged = makeEntry(
      { usage_name: 'Transcription atelier', tool: 'other', tool_other: 'outil de transcription', task_types: ['transcription'], business_domain: 'production', department: 'Production' },
      { group_override: key },
    );
    const split = makeEntry({ tool: 'claude' }, { group_override: 'manuel-1' });
    const groups = consolidate([target, merged, split], rules, calendar);
    assert.equal(groups.length, 2);
    const g = groups.find((x) => x.usage_key === key);
    assert.equal(g.count, 2);
    assert.deepEqual(g.task_types, ['resume', 'transcription'], 'union des tâches');
    assert.deepEqual(g.departments, ['Production']);
    assert.equal(g.tool_other, 'Outil de transcription', 'graphie majuscule à égalité');
    assert.ok(groups.some((x) => x.usage_key === 'manuel-1' && x.id === groupId('manuel-1')));
  });

  test('regroupement par service (byDepartment)', () => {
    const entries = [makeEntry({ department: 'A' }), makeEntry({ department: 'B' }), makeEntry({ department: 'A' })];
    assert.equal(consolidate(entries, rules, calendar).length, 1);
    const byDept = consolidate(entries, rules, calendar, { byDepartment: true });
    assert.equal(byDept.length, 2);
    assert.deepEqual(byDept.map((g) => g.count).sort(), [1, 2]);
  });

  test('nom : le plus fréquent, départage alphabétique', () => {
    const entries = [makeEntry({ usage_name: 'Zèbre' }), makeEntry({ usage_name: 'Écrire' }), makeEntry({ usage_name: 'Avion' })];
    assert.equal(consolidate(entries, rules, calendar)[0].name, 'Avion');
    const tie = [makeEntry({ usage_name: 'Écrire' }), makeEntry({ usage_name: 'Zèbre' })];
    assert.equal(consolidate(tie, rules, calendar)[0].name, 'Écrire', 'ordre alphabétique français (É avant Z)');
    const freq = [makeEntry({ usage_name: 'Zèbre' }), makeEntry({ usage_name: 'Zèbre' }), makeEntry({ usage_name: 'Avion' })];
    assert.equal(consolidate(freq, rules, calendar)[0].name, 'Zèbre');
  });

  test('identifiants stables quel que soit l\'ordre des entrées', () => {
    const entries = [
      makeEntry({ tool: 'claude' }), makeEntry({ tool: 'gemini' }), makeEntry({ tool: 'chatgpt' }), makeEntry({ tool: 'claude' }),
    ];
    const a = consolidate(entries, rules, calendar);
    const b = consolidate([...entries].reverse(), rules, calendar);
    assert.deepEqual(a.map((g) => [g.usage_key, g.id]), b.map((g) => [g.usage_key, g.id]));
    assert.equal(new Set(a.map((g) => g.id)).size, a.length);
  });

  test('tri par gravité, puis exposition, puis nom', () => {
    const entries = [
      makeEntry({ usage_name: 'B minimal 1', tool: 'claude', data_types: ['docs_internes'] }),
      makeEntry({ usage_name: 'A minimal 1', tool: 'gemini', data_types: ['docs_internes'] }),
      makeEntry({ usage_name: 'Z minimal 3', tool: 'deepl', data_types: ['identifiants'] }),
      makeEntry({ usage_name: 'Chatbot', tool: 'perplexity', direct_interaction: 'yes' }),
      makeEntry({ usage_name: 'Émotions', tool: 'other', tool_other: 'X', biometric_emotion: 'yes', business_domain: 'rh' }),
      makeEntry({ usage_name: 'Inconnu', tool: 'mistral_le_chat', affects_people: 'unknown' }),
    ];
    const names = consolidate(entries, rules, calendar).map((g) => g.name);
    assert.deepEqual(names, ['Émotions', 'Inconnu', 'Chatbot', 'Z minimal 3', 'A minimal 1', 'B minimal 1']);
  });

  test('évaluation de l\'admin : surcharge effective, statut et date de revue', () => {
    const entries = [makeEntry({ tool: 'claude' }), makeEntry({ tool: 'gemini' })];
    const key = usageKey(entries[0].usage);
    const assessments = [{
      campaign_id: 'test', usage_key: key, override_ai_act_level: 'limited', override_data_level: 0, justification: 'Revu avec le DPO.',
      owner: '', validation_status: 'validated', history: [], updated_at: '2026-09-28T10:00:00.000Z',
    }];
    const groups = consolidate(entries, rules, calendar, { assessments });
    const g = groups.find((x) => x.usage_key === key);
    assert.deepEqual(g.effective, { ai_act_level: 'limited', data_level: 0, overridden: true });
    assert.equal(g.computed.ai_act_level, 'minimal', 'le calcul reste visible');
    assert.equal(g.computed.data_level, 1);
    assert.equal(g.validation_status, 'validated');
    assert.equal(g.last_review, '2026-09-28T10:00:00.000Z');
    assert.equal(g.assessment, assessments[0]);
    assert.equal(groups[0].usage_key, key, 'le tri suit le niveau effectif');
    const other = groups.find((x) => x.usage_key !== key);
    assert.equal(other.assessment, null);
    assert.equal(other.validation_status, 'to_review');
    assert.equal(other.last_review, null);
  });

  test('surcharge vide ou invalide ignorée (jamais de niveau effectif hors échelle)', () => {
    const entries = [makeEntry({ direct_interaction: 'yes', data_types: ['donnees_clients'] })];
    const key = usageKey(entries[0].usage);
    for (const [ai, data] of [['', ''], ['medium', '3'], ['constructor', 7], [undefined, -1]]) {
      const [g] = consolidate(entries, rules, calendar, {
        assessments: [{ usage_key: key, override_ai_act_level: ai, override_data_level: data, validation_status: 'to_review' }],
      });
      assert.deepEqual(g.effective, { ai_act_level: 'limited', data_level: 2, overridden: false }, JSON.stringify([ai, data]));
    }
    const [zero] = consolidate(entries, rules, calendar, { assessments: [{ usage_key: key, override_ai_act_level: null, override_data_level: 0 }] });
    assert.deepEqual(zero.effective, { ai_act_level: 'limited', data_level: 0, overridden: true }, 'le niveau 0 est une surcharge valide');
  });

  test('rôle du groupe : le rôle non par défaut d\'un membre l\'emporte', () => {
    const custom = { ...rules, default_role: 'deployer' };
    const [g] = consolidate([makeEntry(), makeEntry({ built_or_customized: 'built_own' }), makeEntry()], custom, calendar);
    assert.equal(g.computed.role, 'potential_provider');
    const [h] = consolidate([makeEntry(), makeEntry()], custom, calendar);
    assert.equal(h.computed.role, 'deployer');
  });

  test('surcharge partielle : seul le niveau surchargé change', () => {
    const entries = [makeEntry({ data_types: ['donnees_clients'] })];
    const key = usageKey(entries[0].usage);
    const [g] = consolidate(entries, rules, calendar, {
      assessments: [{ usage_key: key, override_ai_act_level: null, override_data_level: 3, validation_status: 'to_revise' }],
    });
    assert.deepEqual(g.effective, { ai_act_level: 'minimal', data_level: 3, overridden: true });
    assert.equal(g.validation_status, 'to_revise');
  });
});
