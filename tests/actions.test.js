// Suggestions d'actions et conversion en actions (§3.5).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { suggestActions, actionFromSuggestion, suggestionActionId } from '../src/engine/actions.js';
import { consolidate, usageKey } from '../src/engine/consolidate.js';
import { loadRules, loadCalendar, loadActions, makeEntry } from './helpers/load-data.js';

const rules = loadRules();
const calendar = loadCalendar();
const actionsData = loadActions();

function groupsOf(...usages) {
  return consolidate(usages.map((u) => makeEntry(u)), rules, calendar);
}

describe('suggestActions', () => {
  test('aucun usage : aucune suggestion', () => {
    assert.deepEqual(suggestActions([], actionsData, []), []);
    assert.deepEqual(suggestActions(undefined, actionsData, undefined), []);
  });

  test('dès un usage : charte, littératie et revue du registre, une seule fois (portée campagne)', () => {
    const groups = groupsOf({ tool: 'claude' }, { tool: 'gemini' });
    const s = suggestActions(groups, actionsData, []);
    const campaign = s.filter((x) => x.usage_key === null);
    assert.deepEqual(campaign.map((x) => x.template_id), ['ACT-POL-01', 'ACT-LIT-01', 'ACT-INV-01']);
    for (const x of campaign) {
      assert.equal(x.group_id, null);
      assert.ok(x.rule_ids.length > 0);
    }
    assert.deepEqual(s.slice(0, 3), campaign, 'actions de campagne en tête');
  });

  test('actions par usage selon les règles déclenchées', () => {
    const groups = groupsOf(
      { usage_name: 'Émotions', tool: 'other', tool_other: 'X', biometric_emotion: 'yes', business_domain: 'rh', data_types: ['donnees_collaborateurs'] },
      { usage_name: 'Script', tool: 'chatgpt', task_types: ['code'], data_types: ['identifiants'], account_type: 'personal_free' },
      { usage_name: 'Inconnu', tool: 'gemini', affects_people: 'unknown' },
    );
    const s = suggestActions(groups, actionsData, []);
    const byGroup = (name) => s.filter((x) => x.group_id === groups.find((g) => g.name === name).id).map((x) => x.template_id);
    assert.ok(byGroup('Émotions').includes('ACT-PRO-01'));
    assert.ok(byGroup('Émotions').includes('ACT-DPA-01'));
    assert.deepEqual(byGroup('Script').slice(0, 2).sort(), ['ACT-SEC-01', 'ACT-SHADOW-01'], 'priorité haute d\'abord');
    assert.deepEqual(byGroup('Inconnu'), ['ACT-QUAL-01']);
    const sec = s.find((x) => x.template_id === 'ACT-SEC-01');
    const tpl = actionsData.templates.find((t) => t.id === 'ACT-SEC-01');
    assert.deepEqual(sec, {
      template_id: 'ACT-SEC-01', usage_key: groups.find((g) => g.name === 'Script').usage_key,
      group_id: groups.find((g) => g.name === 'Script').id, title: tpl.title, description: tpl.description,
      priority: 'high', effort: 'S', suggested_role: 'DSI', horizon: 'Immédiat', rule_ids: ['R-DAT-CREDENTIALS'],
    });
    for (const x of s) assert.equal(new Set(s.map((y) => `${y.template_id}|${y.usage_key}`)).size, s.length, x.template_id);
  });

  test('ACT-QUAL-01 pour chaque usage à qualifier (AI Act ou données)', () => {
    const groups = groupsOf(
      { usage_name: 'A', tool: 'claude', built_or_customized: 'built_own' },
      { usage_name: 'B', tool: 'gemini', account_type: 'unknown' },
      { usage_name: 'C', tool: 'deepl', biometric_emotion: 'unknown' },
      { usage_name: 'D', tool: 'perplexity' },
    );
    const s = suggestActions(groups, actionsData, []);
    const qual = s.filter((x) => x.template_id === 'ACT-QUAL-01').map((x) => groups.find((g) => g.id === x.group_id).name).sort();
    assert.deepEqual(qual, ['A', 'B', 'C']);
    for (const g of groups) {
      const toQualify = g.computed.ai_act_level === 'to_qualify' || g.computed.data_to_qualify;
      assert.equal(qual.includes(g.name), toQualify, g.name);
    }
  });

  test('les actions déjà enregistrées (même modèle + même usage) ne reviennent pas, même rejetées', () => {
    const groups = groupsOf({ usage_name: 'Visuels', tool: 'midjourney', task_types: ['generation_media'], output_audience: 'public', account_type: 'personal_paid', data_types: ['aucune'] });
    const key = groups[0].usage_key;
    const stored = [
      { id: 'a', template_id: 'ACT-POL-01', usage_key: null, status: 'done' },
      { id: 'b', template_id: 'ACT-TRANS-02', usage_key: key, status: 'rejected' },
      { id: 'c', template_id: 'ACT-SHADOW-01', usage_key: 'autre-usage', status: 'todo' },
      { id: 'd', template_id: null, usage_key: key, title: 'Action manuelle', status: 'todo' },
    ];
    const s = suggestActions(groups, actionsData, stored).map((x) => `${x.template_id}@${x.usage_key}`);
    assert.ok(!s.includes('ACT-POL-01@null'));
    assert.ok(!s.includes(`ACT-TRANS-02@${key}`));
    assert.ok(s.includes(`ACT-SHADOW-01@${key}`), 'une action sur un autre usage ne bloque pas');
    assert.ok(s.includes('ACT-LIT-01@null'));
  });

  test('accepte la bibliothèque complète ou le tableau des modèles', () => {
    const groups = groupsOf({ tool: 'claude' });
    assert.deepEqual(suggestActions(groups, actionsData, []), suggestActions(groups, actionsData.templates, []));
  });

  test('ignore un identifiant d\'action absent de la bibliothèque', () => {
    const [g] = groupsOf({ tool: 'claude' });
    const fake = { ...g, computed: { ...g.computed, action_ids: ['ACT-INEXISTANTE', ...g.computed.action_ids] } };
    assert.ok(suggestActions([fake], actionsData, []).every((x) => x.template_id !== 'ACT-INEXISTANTE'));
  });
});

describe('actionFromSuggestion', () => {
  test('action §3.5 suggérée, sans responsable', () => {
    const [g] = groupsOf({ tool: 'chatgpt', data_types: ['identifiants'] });
    const suggestion = suggestActions([g], actionsData, []).find((x) => x.template_id === 'ACT-SEC-01');
    const now = new Date('2026-09-29T08:00:00.000Z');
    const a = actionFromSuggestion(suggestion, 'camp1', { now });
    assert.deepEqual(a, {
      id: suggestionActionId('camp1', 'ACT-SEC-01', g.usage_key),
      campaign_id: 'camp1',
      usage_key: g.usage_key,
      template_id: 'ACT-SEC-01',
      title: suggestion.title,
      description: suggestion.description,
      owner: '',
      due_date: null,
      priority: 'high',
      status: 'todo',
      suggested: true,
      suggested_role: 'DSI',
      created_at: '2026-09-29T08:00:00.000Z',
      updated_at: '2026-09-29T08:00:00.000Z',
    });
    assert.equal(actionFromSuggestion(suggestion, 'camp1', { status: 'in_progress' }).status, 'in_progress');
  });

  test('identifiant déterministe, distinct par campagne, modèle et usage', () => {
    const id = suggestionActionId('c', 'ACT-POL-01', null);
    assert.match(id, /^S-[0-9a-f]{16}$/);
    assert.equal(suggestionActionId('c', 'ACT-POL-01', null), id);
    assert.notEqual(suggestionActionId('d', 'ACT-POL-01', null), id);
    assert.notEqual(suggestionActionId('c', 'ACT-LIT-01', null), id);
    assert.notEqual(suggestionActionId('c', 'ACT-POL-01', usageKey({ tool: 'claude', task_types: [], business_domain: 'rh' })), id);
  });

  test('l\'action créée fait disparaître la suggestion', () => {
    const groups = groupsOf({ tool: 'claude' });
    const first = suggestActions(groups, actionsData, []);
    const stored = [actionFromSuggestion(first[0], 'c')];
    const next = suggestActions(groups, actionsData, stored);
    assert.equal(next.length, first.length - 1);
    assert.ok(!next.some((x) => x.template_id === first[0].template_id && x.usage_key === first[0].usage_key));
  });
});
