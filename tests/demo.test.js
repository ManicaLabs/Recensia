// Jeu de démonstration (CDC annexe A) : forme des données et consolidation en exactement 10 lignes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateUsage, validateRespondent, SCHEMA_VERSION } from '../src/engine/validate.js';
import { consolidate } from '../src/engine/consolidate.js';
import { suggestActions } from '../src/engine/actions.js';
import { computeStats } from '../src/engine/stats.js';
import { applicableDeadline, registryRows } from '../src/export/registry.js';
import { loadAll } from './helpers/load-data.js';

const { demo, questionnaire, rules, calendar, actions: actionsData } = loadAll();
const { company, campaign, entries } = demo;

// Annexe A : nom de la ligne → niveaux attendus (échelle numérique : 2 = élevé).
const EXPECTED = [
  ['Reformulation de mails', 'minimal', 2],
  ['Rédaction de devis', 'minimal', 2],
  ['Chatbot du site web', 'limited', 2],
  ['Tri automatique de CV', 'high', 2],
  ['Aide à l\'évaluation annuelle', 'high', 3],
  ['Visuels marketing', 'limited', 0],
  ['Résumé de contrats fournisseurs', 'minimal', 2],
  ['Transcription de réunions', 'minimal', 1],
  ['Analyse d\'émotions en visio (test)', 'prohibited_suspected', 2],
  ['Aide au code du site', 'minimal', 2],
];

const groups = consolidate(entries, rules, calendar, { byDepartment: campaign.settings.group_by_department, assessments: demo.assessments ?? [] });

describe('entreprise et campagne fictives', () => {
  test('Menuiserie Alpine Concept, 40 personnes réparties dans les 7 services de l\'annexe A', () => {
    assert.equal(company.name, 'Menuiserie Alpine Concept');
    assert.equal(company.headcount, 40);
    assert.ok(company.sector);
    assert.deepEqual(company.departments_headcount, {
      'Direction': 2, 'Commercial et devis': 8, 'Production': 18, 'RH et administratif': 4,
      'Comptabilité': 3, 'Service client': 3, 'Marketing': 2,
    });
    assert.equal(Object.values(company.departments_headcount).reduce((a, b) => a + b, 0), 40);
  });

  test('campagne §3.2 sans clés, anonyme, identifiant « demo »', () => {
    assert.equal(campaign.id, 'demo');
    assert.equal(campaign.mode, 'anonymous');
    assert.equal(campaign.org_name, company.name);
    assert.ok(campaign.title);
    assert.deepEqual(campaign.departments, Object.keys(company.departments_headcount));
    assert.equal(campaign.public_key, null);
    assert.equal(campaign.private_key_jwk, null);
    assert.equal(campaign.demo, true);
    const s = campaign.settings;
    assert.equal(s.min_group_size, 5);
    assert.equal(typeof s.department_required, 'boolean');
    assert.equal(s.comments_exportable, false);
    assert.equal(s.group_by_department, false);
    assert.ok(s.channels.length >= 1 && s.channels.length <= 3);
    const mail = s.channels.find((c) => c.type === 'mailto');
    assert.ok(mail && /^[a-z0-9.-]+@[a-z0-9.-]+\.example$/.test(mail.target), 'adresse fictive en .example');
  });

  test('aucune donnée réelle : ni clé, ni e-mail hors .example, ni nom de personne', () => {
    const text = JSON.stringify(demo);
    assert.ok(!/"d"\s*:/.test(text), 'aucune clé privée');
    for (const m of text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) assert.ok(m[0].endsWith('.example'), m[0]);
    assert.ok(entries.every((e) => e.respondent === null));
  });
});

describe('déclarations', () => {
  test('20 à 25 entrées §3.3, source « demo », sans campaign_id', () => {
    assert.ok(entries.length >= 20 && entries.length <= 25, `${entries.length} entrées`);
    const keys = ['entry_id', 'rev', 'submitted_day', 'submitted_at', 'respondent', 'usage', 'schema_version', 'code_hash', 'source',
      'imported_at', 'after_close', 'excluded', 'group_override'].sort();
    for (const e of entries) {
      assert.deepEqual(Object.keys(e).sort(), keys, e.entry_id);
      assert.equal(e.source, 'demo');
      assert.ok(!('campaign_id' in e));
      assert.match(e.entry_id, /^[A-Za-z0-9_-]{16}$/);
      assert.equal(e.rev, 1);
      assert.equal(e.schema_version, SCHEMA_VERSION);
      assert.match(e.submitted_day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(e.submitted_at, null, 'mode anonyme : jour seulement');
      assert.equal(e.code_hash, null);
      assert.ok(!Number.isNaN(Date.parse(e.imported_at)));
    }
    assert.equal(new Set(entries.map((e) => e.entry_id)).size, entries.length);
  });

  test('chaque usage est valide et déjà normalisé pour cette campagne', () => {
    const options = { departments: campaign.departments, department_required: campaign.settings.department_required, mode: campaign.mode };
    for (const e of entries) {
      const r = validateUsage(e.usage, questionnaire, options);
      assert.deepEqual(r.errors, [], e.entry_id);
      assert.deepEqual(r.value, e.usage, `${e.entry_id} : usage non normalisé`);
      assert.equal(validateRespondent(e.respondent, campaign.mode).ok, true);
    }
  });

  test('usages répandus déclarés par plusieurs collègues', () => {
    const mails = groups.find((g) => g.name === 'Reformulation de mails');
    assert.ok(mails.count >= 5, 'au moins 5 personnes reformulent leurs mails');
    assert.ok(groups.filter((g) => g.count > 1).length >= 5);
  });
});

describe('consolidation de la démo', () => {
  test('exactement les 10 lignes de l\'annexe A', () => {
    assert.equal(groups.length, 10);
    assert.deepEqual(groups.map((g) => g.name).sort(), EXPECTED.map(([n]) => n).sort());
    assert.equal(groups.reduce((n, g) => n + g.count, 0), entries.filter((e) => !e.excluded).length);
  });

  for (const [name, ai, data] of EXPECTED) {
    test(`${name} : ${ai} / ${data}`, () => {
      const g = groups.find((x) => x.name === name);
      assert.ok(g, name);
      assert.equal(g.computed.ai_act_level, ai);
      assert.equal(g.computed.data_level, data);
      assert.equal(g.effective.ai_act_level, ai);
      assert.equal(g.effective.data_level, data);
    });
  }

  test('détails attendus : service marketing pour le code, fusion manuelle, précision « autre » normalisée', () => {
    assert.deepEqual(groups.find((g) => g.name === 'Aide au code du site').departments, ['Marketing']);
    assert.equal(groups.find((g) => g.name === 'Aide au code du site').business_domain, 'it_dev');
    const transcription = groups.find((g) => g.name === 'Transcription de réunions');
    assert.deepEqual(transcription.departments, ['Direction', 'Production']);
    assert.ok(transcription.members.some((m) => m.group_override === transcription.usage_key));
    const chatbot = groups.find((g) => g.name === 'Chatbot du site web');
    assert.equal(chatbot.count, 2);
    assert.equal(chatbot.tool_other, 'Chatbot tiers');
    const emotions = groups.find((g) => g.name.startsWith('Analyse d\'émotions'));
    assert.deepEqual(emotions.statuses, ['pilot']);
    assert.ok(groups.find((g) => g.name === 'Visuels marketing').computed.signals.some((s) => s.id === 'shadow_ai'));
  });

  test('actions de démonstration : modèles et usages existants, sans responsable nominatif', () => {
    const keys = new Set(groups.map((g) => g.usage_key));
    const templates = new Map(actionsData.templates.map((t) => [t.id, t]));
    assert.ok((demo.actions ?? []).length > 0);
    for (const a of demo.actions) {
      const t = templates.get(a.template_id);
      assert.ok(t, a.template_id);
      if (t.scope === 'campaign') assert.equal(a.usage_key, null, a.id);
      else assert.ok(keys.has(a.usage_key), `${a.id} : usage ${a.usage_key}`);
      assert.ok(['', 'Direction', 'DSI', 'RH', 'DPO/juriste', 'Métier'].includes(a.owner), `${a.id} : responsable générique`);
      assert.ok(['todo', 'in_progress', 'done', 'rejected'].includes(a.status));
      assert.ok(['high', 'medium', 'low'].includes(a.priority));
      assert.equal(a.suggested, true);
      assert.equal(a.campaign_id, 'demo');
      assert.ok(a.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(a.due_date));
    }
    assert.equal(new Set(demo.actions.map((a) => a.id)).size, demo.actions.length);
    assert.deepEqual(demo.assessments, []);
  });

  test('tableau de bord vivant : suggestions restantes et effectifs masqués', () => {
    const suggestions = suggestActions(groups, actionsData, demo.actions);
    assert.ok(suggestions.length > 0);
    for (const a of demo.actions) {
      assert.ok(!suggestions.some((s) => s.template_id === a.template_id && s.usage_key === a.usage_key), a.id);
    }
    const stats = computeStats({ campaign, entries, groups, actions: demo.actions, suggestions, calendar, today: '2026-09-29', questionnaire });
    assert.equal(stats.usages, 10);
    assert.equal(stats.responses, entries.length);
    assert.deepEqual(stats.by_ai_act, { prohibited_suspected: 1, high: 2, to_qualify: 0, limited: 2, minimal: 5 });
    assert.ok(stats.by_department.some((d) => d.masked), 'au moins un service masqué (< 5)');
    assert.ok(stats.by_department.some((d) => !d.masked && d.count >= 5), 'au moins un service affiché');
    assert.ok(stats.actions_progress.done + stats.actions_progress.in_progress > 0);
  });

  // CDC §13 : le délai de grâce du 2 décembre 2026 ne vise que le marquage par les fournisseurs.
  test('échéances : un déployeur (R-AIA-LIM-02) relève de l\'art. 50 en vigueur, pas du délai de grâce des fournisseurs', () => {
    const visuals = groups.find((g) => g.name === 'Visuels marketing');
    assert.equal(visuals.computed.role, 'deployer');
    assert.ok(visuals.computed.triggers.some((t) => t.rule_id === 'R-AIA-LIM-02'));
    assert.ok(!visuals.computed.deadlines.some((d) => d.id === 'marking_grace_art50_2'));
    const found = applicableDeadline(visuals.computed.deadlines, '2026-09-30', calendar);
    assert.equal(found.deadline.id, 'transparency_art50');
    assert.equal(found.in_force, true);
    const row = registryRows([visuals], { campaign, actions: [], questionnaire, rules, calendar, today: '2026-09-30' })[0];
    assert.equal(row.deadline, '02/08/2026 — Obligations de transparence (art. 50) (en vigueur)');
    assert.ok(groups.every((g) => g.computed.role !== 'deployer' || !g.computed.deadlines.some((d) => d.id === 'marking_grace_art50_2')));
    const stats = computeStats({ campaign, entries, groups, actions: [], suggestions: [], calendar, today: '2026-09-30', questionnaire });
    const grace = stats.upcoming_deadlines.find((d) => d.id === 'marking_grace_art50_2');
    assert.equal(grace.usages_count, 0, 'aucun usage de déployeur compté');
    assert.deepEqual(grace.applies_to_roles, ['potential_provider']);
    assert.equal(stats.upcoming_deadlines.find((d) => d.id === 'high_risk_annex_iii').applies_to_roles, null);
  });
});
