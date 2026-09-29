// Indicateurs du tableau de bord : masquage des petits effectifs, parts, échéances, actions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { maskCount, computeStats, toDay } from '../src/engine/stats.js';
import { consolidate } from '../src/engine/consolidate.js';
import { suggestActions } from '../src/engine/actions.js';
import { loadRules, loadCalendar, loadActions, loadQuestionnaire, makeEntry } from './helpers/load-data.js';

const rules = loadRules();
const calendar = loadCalendar();
const actionsData = loadActions();
const questionnaire = loadQuestionnaire();

function campaign(mode, departments = ['A', 'B', 'C'], k = 5) {
  return { id: 'c', mode, departments, settings: { min_group_size: k } };
}

function build(mode, entries, { actions = [], k = 5, today = '2026-09-29' } = {}) {
  const groups = consolidate(entries, rules, calendar);
  const suggestions = suggestActions(groups, actionsData, actions);
  return computeStats({ campaign: campaign(mode, ['A', 'B', 'C'], k), entries, groups, actions, suggestions, calendar, today, questionnaire });
}

function sampleEntries() {
  const out = [];
  for (let i = 0; i < 6; i += 1) out.push(makeEntry({ department: 'A', account_type: i < 2 ? 'personal_free' : 'enterprise_provided' }));
  out.push(makeEntry({ department: 'B', tool: 'claude' }));
  out.push(makeEntry({ department: 'B', tool: 'claude', direct_interaction: 'yes' }));
  out.push(makeEntry({ department: null, tool: 'other', tool_other: 'Outil X', data_types: ['identifiants'] }));
  out.push(makeEntry({ department: 'C', tool: 'gemini' }, { excluded: true }));
  return out;
}

describe('maskCount', () => {
  test('masque 0 < n < k en mode anonyme seulement', () => {
    assert.equal(maskCount(3, 5, 'anonymous'), '< 5');
    assert.equal(maskCount(1, 5, 'anonymous'), '< 5');
    assert.equal(maskCount(4, 5, 'anonymous'), '< 5');
    assert.equal(maskCount(5, 5, 'anonymous'), '5');
    assert.equal(maskCount(12, 5, 'anonymous'), '12');
    assert.equal(maskCount(0, 5, 'anonymous'), '0');
    assert.equal(maskCount(3, 5, 'open'), '3');
    assert.equal(maskCount(2, 3, 'anonymous'), '< 3');
  });
});

describe('computeStats', () => {
  test('mode anonyme : services masqués sous k, aucun répondant compté', () => {
    const s = build('anonymous', sampleEntries());
    assert.deepEqual(s.mask, { k: 5, active: true });
    assert.equal(s.respondents, null);
    assert.deepEqual(s.by_department, [
      { department: 'A', count: 6, display: '6', masked: false },
      { department: 'B', count: 2, display: '< 5', masked: true },
      { department: 'C', count: 0, display: '0', masked: false },
      { department: null, count: 1, display: '< 5', masked: true },
    ]);
    const claude = s.top_tools.find((t) => t.tool === 'claude');
    assert.equal(claude.display, '< 5');
    assert.equal(claude.masked, true);
  });

  test('mode ouvert : aucun masquage, répondants distincts', () => {
    const entries = sampleEntries().map((e, i) => ({
      ...e, respondent: { first_name: i % 2 ? 'Camille' : 'Dominique', last_name: 'Martin', email: null },
    }));
    const s = build('open', entries);
    assert.deepEqual(s.mask, { k: 5, active: false });
    assert.ok(s.by_department.every((d) => d.masked === false && d.display === String(d.count)));
    assert.ok(s.top_tools.every((t) => t.masked === false));
    assert.equal(s.respondents, 2);
  });

  test('k configurable par la campagne', () => {
    const s = build('anonymous', sampleEntries(), { k: 2 });
    assert.equal(s.by_department.find((d) => d.department === 'B').display, '2');
    assert.equal(s.by_department.find((d) => d.department === null).display, '< 2');
  });

  test('compteurs, répartitions et parts (ratio 0..1)', () => {
    const s = build('anonymous', sampleEntries());
    assert.equal(s.responses, 9, 'entrée exclue non comptée');
    assert.equal(s.usages, 3, 'les deux déclarations Claude forment une seule ligne');
    assert.deepEqual(Object.keys(s.by_ai_act), ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']);
    assert.deepEqual(s.by_ai_act, { prohibited_suspected: 0, high: 0, to_qualify: 0, limited: 1, minimal: 2 });
    assert.deepEqual(s.by_data, { 0: 0, 1: 1, 2: 1, 3: 1 });
    assert.deepEqual(s.shadow_ai, { count: 1, share: 1 / 3 });
    assert.equal(s.top_tools[0].tool, 'chatgpt');
    assert.equal(s.top_tools[0].count, 6);
    assert.equal(s.top_tools[0].label, 'ChatGPT');
    assert.ok(s.top_tools.some((t) => t.tool === 'other' && t.label === 'Outil X'));
    assert.equal(s.to_qualify, 0);
    assert.deepEqual(s.questions, []);
  });

  test('à qualifier et questions', () => {
    const entries = [makeEntry({ affects_people: 'unknown' }), makeEntry({ tool: 'claude', account_type: 'unknown' }), makeEntry({ tool: 'gemini' })];
    const s = build('anonymous', entries);
    assert.equal(s.to_qualify, 2);
    assert.equal(s.questions.length, 2);
    for (const q of s.questions) assert.deepEqual(Object.keys(q).sort(), ['group_id', 'name', 'question', 'rule_id', 'usage_key']);
  });

  test('un axe surchargé par l\'admin n\'est plus « à qualifier » et ses questions sont tranchées', () => {
    const entries = [
      makeEntry({ usage_name: 'A', account_type: 'unknown', affects_people: 'unknown' }),
      makeEntry({ usage_name: 'B', tool: 'claude', account_type: 'unknown' }),
    ];
    const plain = consolidate(entries, rules, calendar);
    const keyA = plain.find((g) => g.name === 'A').usage_key;
    const keyB = plain.find((g) => g.name === 'B').usage_key;
    const assessments = [
      { usage_key: keyA, override_ai_act_level: 'minimal', override_data_level: null, validation_status: 'validated' },
      { usage_key: keyB, override_ai_act_level: null, override_data_level: 1, validation_status: 'validated' },
    ];
    const groups = consolidate(entries, rules, calendar, { assessments });
    const s = computeStats({ campaign: campaign('anonymous'), entries, groups, actions: [], suggestions: [], calendar, today: '2026-09-29' });
    assert.equal(s.to_qualify, 1, 'A reste à qualifier pour les données, B est tranché');
    assert.deepEqual(s.questions.map((q) => `${q.name}:${q.rule_id}`).sort(), ['A:R-DAT-Q-ACCOUNT']);
    const before = computeStats({ campaign: campaign('anonymous'), entries, groups: plain, actions: [], suggestions: [], calendar, today: '2026-09-29' });
    assert.equal(before.to_qualify, 2);
    assert.equal(before.questions.length, 3);
  });

  test('valeurs hors échelle ou héritées ignorées dans les compteurs', () => {
    const groups = consolidate([makeEntry()], rules, calendar);
    const hostile = [{ ...groups[0], effective: { ai_act_level: 'constructor', data_level: 'toString', overridden: true } }];
    const actions = [{ id: 'x', status: 'constructor' }, { id: 'y', status: '__proto__' }, { id: 'z', status: 'done' }];
    const s = computeStats({ campaign: campaign('anonymous'), entries: [], groups: hostile, actions, suggestions: [], calendar, today: '2026-09-29' });
    assert.deepEqual(Object.keys(s.by_ai_act), ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']);
    assert.ok(Object.values(s.by_ai_act).every((n) => n === 0));
    assert.deepEqual(Object.keys(s.by_data), ['0', '1', '2', '3']);
    assert.deepEqual(Object.keys(s.actions_progress).sort(), ['done', 'in_progress', 'pending_suggestions', 'rejected', 'todo', 'total']);
    assert.equal(s.actions_progress.done, 1);
    assert.equal(typeof s.actions_progress.constructor, 'function', 'aucune propriété propre ajoutée');
  });

  test('échéances à venir et passées selon la date du jour (paramètre)', () => {
    const s = build('anonymous', sampleEntries(), { today: '2026-09-29' });
    const up = s.upcoming_deadlines.map((d) => d.id);
    const past = s.past_deadlines.map((d) => d.id);
    assert.equal(up.length + past.length, calendar.deadlines.length);
    for (const d of s.upcoming_deadlines) assert.ok(d.date >= '2026-09-29' && d.days >= 0, d.id);
    for (const d of s.past_deadlines) assert.ok(d.date < '2026-09-29' && d.days < 0, d.id);
    const dates = s.upcoming_deadlines.map((d) => d.date);
    assert.deepEqual(dates, [...dates].sort());
    const lit = [...s.upcoming_deadlines, ...s.past_deadlines].find((d) => d.id === 'literacy_art4');
    assert.equal(lit.usages_count, 3, 'la littératie concerne tous les usages');

    const later = build('anonymous', sampleEntries(), { today: '2099-01-01' });
    assert.equal(later.upcoming_deadlines.length, 0);
    const earlier = build('anonymous', sampleEntries(), { today: '2000-01-01' });
    assert.equal(earlier.past_deadlines.length, 0);
    const first = calendar.deadlines.map((d) => d.date).sort()[0];
    const sameDay = build('anonymous', sampleEntries(), { today: first });
    assert.ok(sameDay.upcoming_deadlines.some((d) => d.date === first && d.days === 0), 'le jour même compte comme à venir');
  });

  test('avancement du plan d\'actions', () => {
    const actions = [
      { id: '1', template_id: 'ACT-POL-01', usage_key: null, status: 'done' },
      { id: '2', template_id: 'ACT-LIT-01', usage_key: null, status: 'in_progress' },
      { id: '3', template_id: null, usage_key: null, status: 'todo' },
      { id: '4', template_id: null, usage_key: null, status: 'rejected' },
    ];
    const s = build('anonymous', sampleEntries(), { actions });
    const { pending_suggestions, ...rest } = s.actions_progress;
    assert.deepEqual(rest, { todo: 1, in_progress: 1, done: 1, rejected: 1, total: 4 });
    assert.ok(pending_suggestions > 0);
  });

  test('entrées vides : indicateurs à zéro', () => {
    const s = computeStats({ campaign: campaign('anonymous'), entries: [], groups: [], actions: [], suggestions: [], calendar, today: '2026-09-29' });
    assert.equal(s.usages, 0);
    assert.equal(s.responses, 0);
    assert.deepEqual(s.shadow_ai, { count: 0, share: 0 });
    assert.deepEqual(s.top_tools, []);
    assert.equal(s.actions_progress.total, 0);
    assert.ok(s.by_department.every((d) => d.count === 0));
  });

  test('toDay', () => {
    assert.equal(toDay('2026-09-29'), '2026-09-29');
    assert.equal(toDay(new Date(2026, 8, 29, 23, 30)), '2026-09-29');
    assert.match(toDay(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
