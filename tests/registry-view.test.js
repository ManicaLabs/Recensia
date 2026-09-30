// Onglets Registre et Tableau de bord : filtres et tri purs, calculs d'affichage (masquage,
// mentions « surchargé » / « à qualifier »), évaluation tracée, regroupements, demandes
// d'ouverture entre onglets, textes dynamiques présents dans les catalogues, axe des badges de
// niveau et encart d'erreur persistant (faux document).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { consolidate, groupId, usageKey } from '../src/engine/consolidate.js';
import { suggestActions } from '../src/engine/actions.js';
import { computeStats } from '../src/engine/stats.js';
import {
  defaultFilters, sanitizeFilters, activeFilterCount, isFiltering, normalizeSearch, toolFilterKey, toolLabel,
  searchTextOf, isToQualify, questionsOf, openQuestions, countDisplay, isCountMasked, aiActDisplay, dataDisplay,
  matchesFilters, sortGroups, applyFilters, filterOptions, entryGroupKey, excludedEntries, excludedForGroup,
  splitKey, mergeTargets, priorityGroups, minGroupSize, NO_DEPARTMENT, SORTS, VALIDATION_STATUSES,
  isPriority, usedGroupKeys, reconcileFilters,
} from '../src/views/console/registry/filters.js';
import {
  updateAssessment, revertOverrides, normalizeAssessment, emptyAssessment, cleanText, parseAiOverride, parseDataOverride,
  historyNewestFirst, JUSTIFICATION_MIN, HISTORY_MAX, TRACKED_FIELDS, OWNER_MAX,
} from '../src/views/console/registry/assessment.js';
import { requestRegistryDetail, takeRegistryDetail, requestRegistryFilters, takeRegistryFilters } from '../src/views/console/registry/focus.js';
import { ANSWER_FIELDS, SOURCES, historyValue, createDetailDialog } from '../src/views/console/registry/detail.js';
import { levelCell, alertSlot, setAlert } from '../src/views/console/registry/cells.js';
import {
  aiActItems, dataItems, toolItems, departmentItems, actionItems, actionsSummary, shadowSummary, shadowItems,
  maskedItem, priorityReason, verificationSourceKey, ACTION_STATUSES, TOP_TOOLS_LIMIT,
} from '../src/views/console/dashboard.js';
import { loadRules, loadCalendar, loadActions, loadQuestionnaire, loadDemo, makeEntry, readJson } from './helpers/load-data.js';
import { t as i18nT, register as i18nRegister } from '../src/i18n.js';
import { installFakeDocument } from './helpers/fake-dom.js';
import { listFiles, readSource } from './helpers/source-scan.js';

const rules = loadRules();
const calendar = loadCalendar();
const actionsData = loadActions();
const questionnaire = loadQuestionnaire();
const demo = loadDemo();
const catalogs = {
  common: readJson('src/i18n/fr/common.json'),
  registry: readJson('src/i18n/fr/registry.json'),
  dashboard: readJson('src/i18n/fr/dashboard.json'),
  report: readJson('src/i18n/fr/report.json'),
};

function lookup(key) {
  const [ns, ...path] = key.split('.');
  let node = catalogs[ns];
  for (const part of path) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/** Traduction de test : texte du catalogue (pluriel « other »), variables interpolées. */
function t(key, vars = {}) {
  let value = lookup(key);
  if (value && typeof value === 'object') value = value.other ?? value.one;
  if (typeof value !== 'string') return key;
  return value.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
}

const anonymous = { id: 'demo', mode: 'anonymous', departments: demo.campaign.departments, settings: { min_group_size: 5 } };
const open = { ...anonymous, mode: 'open' };
const demoEntries = demo.entries.map((e) => ({ ...e, campaign_id: 'demo' }));

function groupsOf(entries, assessments = []) {
  return consolidate(entries, rules, calendar, { assessments });
}

const demoGroups = groupsOf(demoEntries);
const byName = (groups, name) => groups.find((g) => g.name === name);

// Ligne minimale au format de consolidate(), pour les cas ciblés.
function fakeGroup(over = {}) {
  return {
    usage_key: over.usage_key ?? `k-${Math.random()}`,
    id: over.id ?? 'U-000000',
    name: 'Usage',
    names: [over.name ?? 'Usage'],
    members: [],
    count: 1,
    tool: 'chatgpt',
    tool_other: null,
    departments: [],
    computed: { ai_act_level: 'minimal', data_level: 1, data_to_qualify: false, triggers: [], questions_to_confirm: [], signals: [], deadlines: [] },
    assessment: null,
    effective: { ai_act_level: 'minimal', data_level: 1, overridden: false },
    validation_status: 'to_review',
    ...over,
  };
}

describe('filtres : normalisation', () => {
  test('filtres par défaut et nettoyage des valeurs inconnues', () => {
    assert.deepEqual(defaultFilters(), { q: '', ai_act: [], data: '', department: '', tool: '', validation: '', to_qualify: false, priority: false, sort: 'severity' });
    const f = sanitizeFilters({ q: 'x'.repeat(300), ai_act: ['high', 'nope', 'minimal'], data: 7, validation: 'bof', sort: 'random', to_qualify: 'yes', department: 3 });
    assert.equal(f.q.length, 100);
    assert.deepEqual(f.ai_act, ['high', 'minimal']);
    assert.equal(f.data, '');
    assert.equal(f.validation, '');
    assert.equal(f.sort, 'severity');
    assert.equal(f.to_qualify, false);
    assert.equal(f.department, '');
    assert.deepEqual(sanitizeFilters(null), defaultFilters());
    assert.equal(sanitizeFilters({ data: 2 }).data, '2');
    assert.equal(sanitizeFilters({ priority: 'yes' }).priority, false);
    assert.equal(sanitizeFilters({ priority: true }).priority, true);
  });

  test('filtres mémorisés : service ou outil disparu retiré (le menu afficherait « Tous »)', () => {
    const opts = filterOptions(demoGroups, { campaign: anonymous, questionnaire });
    const kept = reconcileFilters({ department: 'Marketing', tool: 'chatgpt', to_qualify: true }, opts);
    assert.equal(kept.department, 'Marketing');
    assert.equal(kept.tool, 'chatgpt');
    assert.equal(kept.to_qualify, true);
    const gone = reconcileFilters({ department: 'Service fermé', tool: 'other:outil retiré' }, opts);
    assert.equal(gone.department, '');
    assert.equal(gone.tool, '');
    assert.equal(reconcileFilters({ department: NO_DEPARTMENT }, opts).department, '', 'aucune ligne sans service dans la démo');
    assert.equal(reconcileFilters({ department: NO_DEPARTMENT }, { ...opts, hasNoDepartment: true }).department, NO_DEPARTMENT);
  });

  test('compteur de filtres actifs (hors recherche et tri)', () => {
    assert.equal(activeFilterCount(defaultFilters()), 0);
    assert.equal(activeFilterCount({ ai_act: ['high'], data: '3', to_qualify: true, q: 'abc', sort: 'name' }), 3);
    assert.equal(activeFilterCount({ priority: true }), 1);
    assert.equal(isFiltering({ q: '  ' }), false);
    assert.equal(isFiltering({ q: 'devis' }), true);
    assert.equal(isFiltering({ tool: 'chatgpt' }), true);
  });

  test('recherche insensible à la casse, aux accents et aux apostrophes typographiques', () => {
    assert.equal(normalizeSearch('  Évaluation  ANNUELLE '), 'evaluation annuelle');
    assert.equal(normalizeSearch('L’outil'), "l'outil");
  });
});

describe('filtres : correspondance', () => {
  test('recherche sur le nom, l’outil, le service et l’identifiant (tous les mots)', () => {
    const devis = byName(demoGroups, 'Rédaction de devis');
    assert.ok(matchesFilters(devis, { q: 'redaction' }, { questionnaire }));
    assert.ok(matchesFilters(devis, { q: 'préparation' }, { questionnaire }), 'intitulé secondaire');
    assert.ok(matchesFilters(devis, { q: 'copilot commercial' }, { questionnaire }));
    assert.ok(matchesFilters(devis, { q: devis.id.toLowerCase() }, { questionnaire }));
    assert.ok(!matchesFilters(devis, { q: 'copilot rh' }, { questionnaire }));
    const chatbot = byName(demoGroups, 'Chatbot du site web');
    assert.ok(matchesFilters(chatbot, { q: 'chatbot tiers' }, { questionnaire }), 'précision « autre »');
    assert.ok(searchTextOf(chatbot, questionnaire).includes('service client'));
  });

  test('niveau AI Act (plusieurs), exposition, validation, à qualifier', () => {
    const cv = byName(demoGroups, 'Tri automatique de CV');
    assert.ok(matchesFilters(cv, { ai_act: ['high', 'prohibited_suspected'] }));
    assert.ok(!matchesFilters(cv, { ai_act: ['minimal'] }));
    assert.ok(matchesFilters(cv, { data: String(cv.effective.data_level) }));
    assert.ok(!matchesFilters(cv, { data: '0' }));
    assert.ok(matchesFilters(cv, { validation: 'to_review' }));
    assert.ok(!matchesFilters(cv, { validation: 'validated' }));
    assert.ok(!matchesFilters(cv, { to_qualify: true }));
    const unsure = fakeGroup({ computed: { ...fakeGroup().computed, data_to_qualify: true } });
    assert.ok(matchesFilters(unsure, { to_qualify: true }));
  });

  test('service : valeur précise ou « non renseigné »', () => {
    const noDept = fakeGroup({ departments: [] });
    const rh = fakeGroup({ departments: ['RH', 'Direction'] });
    assert.ok(matchesFilters(noDept, { department: NO_DEPARTMENT }));
    assert.ok(!matchesFilters(rh, { department: NO_DEPARTMENT }));
    assert.ok(matchesFilters(rh, { department: 'Direction' }));
    assert.ok(!matchesFilters(noDept, { department: 'RH' }));
  });

  test('outil : clé propre à chaque précision « autre »', () => {
    const transcription = byName(demoGroups, 'Transcription de réunions');
    assert.equal(transcription.tool, 'other');
    assert.equal(toolFilterKey(transcription), 'other:outil de transcription');
    assert.ok(matchesFilters(transcription, { tool: 'other:outil de transcription' }));
    assert.ok(!matchesFilters(byName(demoGroups, 'Chatbot du site web'), { tool: 'other:outil de transcription' }));
    assert.equal(toolLabel(transcription, questionnaire), 'Autre (Outil de transcription)');
    assert.equal(toolLabel(byName(demoGroups, 'Aide au code du site'), questionnaire), 'GitHub Copilot');
  });

  test('options des filtres : services de la campagne d’abord, outils présents', () => {
    const opts = filterOptions([...demoGroups, fakeGroup({ departments: ['Zèbre'] }), fakeGroup({ departments: [] })], { campaign: anonymous, questionnaire });
    assert.deepEqual(opts.departments.slice(0, anonymous.departments.length).map((d) => d.value), anonymous.departments);
    assert.equal(opts.departments.at(-1).value, 'Zèbre');
    assert.equal(opts.hasNoDepartment, true);
    const tools = opts.tools.map((o) => o.value);
    assert.ok(tools.includes('chatgpt') && tools.includes('other:outil de transcription') && tools.includes('other:chatbot tiers'));
    assert.equal(new Set(tools).size, tools.length);
    assert.deepEqual(opts.tools.map((o) => o.label), [...opts.tools.map((o) => o.label)].sort((a, b) => a.localeCompare(b, 'fr')));
  });
});

describe('tri', () => {
  test('gravité par défaut : interdit suspecté, haut risque… (ordre du registre)', () => {
    const sorted = sortGroups([...demoGroups].reverse(), 'severity');
    assert.deepEqual(sorted.map((g) => g.id), demoGroups.map((g) => g.id));
    assert.equal(sorted[0].effective.ai_act_level, 'prohibited_suspected');
  });

  test('nom : ordre alphabétique français', () => {
    const names = sortGroups(demoGroups, 'name').map((g) => g.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })));
  });

  test('nombre de déclarations : décroissant ; en anonyme, les effectifs masqués ne sont pas départagés', () => {
    const big = fakeGroup({ id: 'U-BIG', count: 9, effective: { ai_act_level: 'minimal', data_level: 0 } });
    const small3 = fakeGroup({ id: 'U-S3', name: 'B', count: 3, effective: { ai_act_level: 'minimal', data_level: 0 } });
    const small1 = fakeGroup({ id: 'U-S1', name: 'A', count: 1, effective: { ai_act_level: 'high', data_level: 0 } });
    assert.deepEqual(sortGroups([small1, small3, big], 'count', { campaign: open }).map((g) => g.id), ['U-BIG', 'U-S3', 'U-S1']);
    // En anonyme, 3 et 1 sont tous deux « < 5 » : départagés par gravité, pas par effectif.
    assert.deepEqual(sortGroups([small3, big, small1], 'count', { campaign: anonymous }).map((g) => g.id), ['U-BIG', 'U-S1', 'U-S3']);
  });

  test('applyFilters : filtre puis trie, sans modifier la liste d’origine', () => {
    const before = demoGroups.map((g) => g.id);
    const list = applyFilters(demoGroups, { ai_act: ['minimal'], sort: 'name' }, { questionnaire, campaign: anonymous });
    assert.ok(list.length > 0 && list.every((g) => g.effective.ai_act_level === 'minimal'));
    assert.deepEqual(demoGroups.map((g) => g.id), before);
    assert.ok(SORTS.every((s) => applyFilters(demoGroups, { sort: s }).length === demoGroups.length));
  });
});

describe('calculs d’affichage', () => {
  test('masquage « < k » en mode anonyme seulement', () => {
    const reformulation = byName(demoGroups, 'Reformulation de mails');
    const cv = byName(demoGroups, 'Tri automatique de CV');
    assert.equal(reformulation.count, 5);
    assert.equal(countDisplay(reformulation, anonymous), '5');
    assert.equal(countDisplay(cv, anonymous), '< 5');
    assert.equal(isCountMasked(cv, anonymous), true);
    assert.equal(countDisplay(cv, open), String(cv.count));
    assert.equal(isCountMasked(cv, open), false);
    assert.equal(countDisplay(cv, null), '< 5', 'sans campagne : règle la plus prudente');
    assert.equal(countDisplay(cv, { ...anonymous, settings: { min_group_size: 2 } }), String(cv.count));
    assert.equal(minGroupSize({ settings: { min_group_size: 0 } }), 5);
  });

  test('mentions « surchargé » et « à qualifier »', () => {
    const entries = demoEntries.filter((e) => e.usage.usage_name.startsWith('Reformul'));
    const key = usageKey(entries[0].usage);
    const plain = groupsOf(entries)[0];
    assert.deepEqual(aiActDisplay(plain), { level: 'minimal', computed: 'minimal', overridden: false });
    const over = groupsOf(entries, [{ campaign_id: 'demo', usage_key: key, override_ai_act_level: 'limited', override_data_level: 3 }])[0];
    assert.deepEqual(aiActDisplay(over), { level: 'limited', computed: 'minimal', overridden: true });
    const data = dataDisplay(over);
    assert.equal(data.level, 3);
    assert.equal(data.overridden, true);
    assert.equal(data.toQualify, false);
    // Surcharge invalide : ignorée
    const bad = groupsOf(entries, [{ campaign_id: 'demo', usage_key: key, override_ai_act_level: 'foo', override_data_level: 9 }])[0];
    assert.equal(aiActDisplay(bad).overridden, false);
    assert.equal(dataDisplay(bad).overridden, false);
  });

  test('« à qualifier » : exposition inconnue non tranchée, questions ouvertes ou résolues', () => {
    const unknown = groupsOf([makeEntry({ account_type: 'unknown' })])[0];
    assert.equal(unknown.computed.data_to_qualify, true);
    assert.equal(isToQualify(unknown), true);
    assert.equal(dataDisplay(unknown).toQualify, true);
    assert.ok(openQuestions(unknown).length > 0);
    const key = unknown.usage_key;
    const settled = groupsOf([makeEntry({ account_type: 'unknown' })], [{ campaign_id: 'test', usage_key: key, override_data_level: 2 }])[0];
    assert.equal(isToQualify(settled), false);
    assert.equal(dataDisplay(settled).toQualify, false);
    const qs = questionsOf(settled);
    assert.ok(qs.some((q) => q.resolved), 'question de l’axe données tranchée par la surcharge');
    assert.equal(openQuestions(settled).length, qs.filter((q) => !q.resolved).length);
  });

  test('usages prioritaires : interdits, haut risque puis à qualifier', () => {
    const list = priorityGroups([...demoGroups, groupsOf([makeEntry({ account_type: 'unknown' })])[0]]);
    assert.deepEqual(list.map((g) => g.effective.ai_act_level).slice(0, 3), ['prohibited_suspected', 'high', 'high']);
    assert.ok(list.every((g) => ['prohibited_suspected', 'high', 'to_qualify'].includes(g.effective.ai_act_level) || isToQualify(g)));
    assert.equal(list.length, 4);
    assert.equal(priorityGroups(demoGroups, { limit: 1 }).length, 1);
    assert.deepEqual(list.map(priorityReason), ['prohibited', 'high', 'high', 'data_to_qualify']);
    assert.equal(priorityReason(fakeGroup({ effective: { ai_act_level: 'to_qualify' } })), 'to_qualify');
  });

  test('filtre « prioritaires » : exactement les usages prioritaires du tableau de bord', () => {
    // Exposition à qualifier avec un niveau AI Act minimal : prioritaire, mais absent d'un filtre par niveau.
    const unsure = groupsOf([makeEntry({ account_type: 'unknown' })])[0];
    assert.equal(unsure.effective.ai_act_level, 'minimal');
    const all = [...demoGroups, unsure];
    const filtered = applyFilters(all, { priority: true }, { questionnaire, campaign: anonymous });
    assert.deepEqual(filtered.map((g) => g.usage_key), priorityGroups(all).map((g) => g.usage_key));
    assert.ok(filtered.some((g) => g.usage_key === unsure.usage_key));
    assert.ok(all.filter(isPriority).length === filtered.length);
    const byLevel = applyFilters(all, { ai_act: ['prohibited_suspected', 'high', 'to_qualify'] }, { questionnaire, campaign: anonymous });
    assert.ok(byLevel.length < filtered.length, 'un filtre par niveau ne suffit pas');
  });
});

describe('regroupement : clés, entrées écartées, cibles de fusion', () => {
  test('clé d’une entrée : regroupement manuel prioritaire', () => {
    const e = makeEntry();
    assert.equal(entryGroupKey(e), usageKey(e.usage));
    assert.equal(entryGroupKey({ ...e, group_override: 'manual:x' }), 'manual:x');
    assert.equal(entryGroupKey({ ...e, group_override: '' }), usageKey(e.usage));
    assert.equal(entryGroupKey({ ...e, usage: { ...e.usage, department: 'RH' } }, { byDepartment: true }), usageKey({ ...e.usage, department: 'RH' }, { byDepartment: true }));
  });

  test('scission : nouvelle clé stable, groupe distinct après consolidation', () => {
    const entries = demoEntries.filter((x) => x.usage.usage_name.startsWith('Reformul'));
    const moved = { ...entries[0], group_override: splitKey(entries[0].entry_id) };
    assert.equal(moved.group_override, `manual:${entries[0].entry_id}`);
    const groups = groupsOf([moved, ...entries.slice(1)]);
    assert.equal(groups.length, 2);
    assert.ok(groups.some((g) => g.id === groupId(splitKey(entries[0].entry_id)) && g.count === 1));
  });

  test('scission après fusion : la clé déjà prise est suffixée, la déclaration change bien de ligne', () => {
    const entries = demoEntries.filter((x) => x.usage.usage_name.startsWith('Reformul'));
    const first = entries[0];
    const manual = splitKey(first.entry_id);
    // 1re scission, puis une autre déclaration fusionnée dans la ligne « manual:<id> ».
    let state = [{ ...first, group_override: manual }, { ...entries[1], group_override: manual }, ...entries.slice(2)];
    const merged = groupsOf(state).find((g) => g.usage_key === manual);
    assert.equal(merged.count, 2);
    // 2e scission de la même déclaration : nouvelle clé, distincte de toutes les clés prises.
    const used = usedGroupKeys(state);
    const again = splitKey(first.entry_id, used);
    assert.equal(again, `${manual}~2`);
    assert.ok(!used.includes(again));
    state = [{ ...state[0], group_override: again }, ...state.slice(1)];
    const groups = groupsOf(state);
    assert.equal(groups.find((g) => g.usage_key === manual).count, 1);
    assert.equal(groups.find((g) => g.usage_key === again).count, 1);
    assert.equal(splitKey('x', ['manual:x', 'manual:x~2']), 'manual:x~3');
    assert.ok(usedGroupKeys([{ ...first, excluded: true, group_override: 'manual:y' }]).includes('manual:y'), 'entrées écartées comprises');
  });

  test('fusion : toutes les entrées vers la clé cible', () => {
    const source = byName(demoGroups, 'Reformulation de mails');
    const target = byName(demoGroups, 'Rédaction de devis');
    const merged = demoEntries.map((e) => (source.members.some((m) => m.entry_id === e.entry_id) ? { ...e, group_override: target.usage_key } : e));
    const groups = groupsOf(merged);
    assert.equal(groups.length, demoGroups.length - 1);
    assert.equal(groups.find((g) => g.usage_key === target.usage_key).count, source.count + target.count);
    const targets = mergeTargets(demoGroups, source.usage_key);
    assert.equal(targets.length, demoGroups.length - 1);
    assert.ok(!targets.some((g) => g.usage_key === source.usage_key));
  });

  test('entrées écartées : liste générale et par ligne', () => {
    const [a, b, c] = [makeEntry({}, { submitted_day: '2026-09-01' }), makeEntry({}, { submitted_day: '2026-09-10' }), makeEntry({ tool: 'claude' })];
    const entries = [{ ...a, excluded: true }, { ...b, excluded: true }, { ...c, excluded: true }, makeEntry()];
    assert.deepEqual(excludedEntries(entries).map((e) => e.entry_id), [c.entry_id, b.entry_id, a.entry_id].sort((x, y) => {
      const day = (id) => entries.find((e) => e.entry_id === id).submitted_day;
      return day(y).localeCompare(day(x)) || x.localeCompare(y);
    }));
    assert.deepEqual(excludedForGroup(entries, usageKey(a.usage)).map((e) => e.entry_id).sort(), [a.entry_id, b.entry_id].sort());
    assert.equal(groupsOf(entries).length, 1, 'les entrées écartées ne forment pas de ligne');
  });
});

describe('évaluation (surcharges tracées)', () => {
  const opts = { campaignId: 'c1', usageKey: 'k1', now: '2026-09-29T10:00:00.000Z' };

  test('surcharge sans justification refusée, justification trop courte refusée', () => {
    const r1 = updateAssessment(null, { override_ai_act_level: 'high', justification: '' }, opts);
    assert.equal(r1.ok, false);
    assert.deepEqual(r1.errors, [{ field: 'justification', code: 'justification_required' }]);
    const r2 = updateAssessment(null, { override_data_level: '3', justification: 'trop court' .slice(0, JUSTIFICATION_MIN - 1) }, opts);
    assert.deepEqual(r2.errors, [{ field: 'justification', code: 'justification_short' }]);
    const r3 = updateAssessment(null, { override_ai_act_level: 'high', justification: `  ${'a'.repeat(JUSTIFICATION_MIN)}  ` }, opts);
    assert.equal(r3.ok, true);
  });

  test('valeurs inconnues refusées', () => {
    const r = updateAssessment(null, { override_ai_act_level: 'catastrophic', override_data_level: '7', validation_status: 'maybe' }, opts);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map((e) => e.field).sort(), ['override_ai_act_level', 'override_data_level', 'validation_status']);
  });

  test('historique : une ligne par champ modifié, justification sur les surcharges seulement', () => {
    const r = updateAssessment(null, {
      override_ai_act_level: 'limited', override_data_level: '', justification: 'Contenu relu avant publication.',
      validation_status: 'validated', owner: '  Direction\u0007 commerciale ',
    }, opts);
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    const v = r.value;
    assert.equal(v.campaign_id, 'c1');
    assert.equal(v.usage_key, 'k1');
    assert.equal(v.override_ai_act_level, 'limited');
    assert.equal(v.override_data_level, null);
    assert.equal(v.validation_status, 'validated');
    assert.equal(v.owner, 'Direction commerciale');
    assert.equal(v.justification, 'Contenu relu avant publication.');
    assert.equal(v.updated_at, opts.now);
    assert.deepEqual(v.history, [
      { at: opts.now, field: 'override_ai_act_level', from: null, to: 'limited', justification: 'Contenu relu avant publication.' },
      { at: opts.now, field: 'validation_status', from: 'to_review', to: 'validated', justification: '' },
      { at: opts.now, field: 'owner', from: '', to: 'Direction commerciale', justification: '' },
    ]);
  });

  test('statut ou responsable seuls : pas de justification exigée ; aucune modification : rien d’écrit', () => {
    const base = updateAssessment(null, { validation_status: 'to_revise' }, opts);
    assert.equal(base.ok, true);
    assert.equal(base.value.history.length, 1);
    const same = updateAssessment(base.value, { validation_status: 'to_revise', owner: '', override_ai_act_level: '', override_data_level: '' }, { ...opts, now: '2026-09-30T00:00:00.000Z' });
    assert.equal(same.ok, true);
    assert.equal(same.changed, false);
    assert.equal(same.value.updated_at, opts.now);
  });

  test('conserve les champs inconnus et l’historique précédent ; annulation tracée', () => {
    const first = updateAssessment({ extra: 'keep', history: [{ at: '2026-01-01T00:00:00.000Z', field: 'owner', from: '', to: 'X', justification: '' }] },
      { override_data_level: '0', justification: 'Aucune donnée réellement envoyée.' }, opts).value;
    assert.equal(first.extra, 'keep');
    assert.equal(first.history.length, 2);
    const reverted = revertOverrides(first, { ...opts, justification: 'Retour aux niveaux calculés par les règles.', now: '2026-09-30T08:00:00.000Z' });
    assert.equal(reverted.ok, true);
    assert.equal(reverted.value.override_data_level, null);
    assert.equal(reverted.value.history.at(-1).field, 'override_data_level');
    assert.equal(reverted.value.history.at(-1).from, 0);
    assert.equal(reverted.value.history.at(-1).to, null);
    const nothing = revertOverrides(reverted.value, { ...opts, justification: 'Retour aux niveaux calculés.' });
    assert.equal(nothing.changed, false);
    assert.equal(revertOverrides(first, { ...opts, justification: '' }).ok, false);
  });

  test('normalisation : surcharge stockée invalide ignorée, historique borné', () => {
    const n = normalizeAssessment({ override_ai_act_level: 'foo', override_data_level: 5, validation_status: 'x', history: 'bad' }, 'c', 'k');
    assert.deepEqual({ ...n }, { ...emptyAssessment('c', 'k'), override_ai_act_level: null, override_data_level: null, history: [] });
    let a = null;
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) a = updateAssessment(a, { owner: `Personne ${i}` }, opts).value;
    assert.equal(a.history.length, HISTORY_MAX);
    assert.equal(a.owner, `Personne ${HISTORY_MAX + 4}`);
  });

  test('saisies : nettoyage et analyse des listes', () => {
    assert.equal(cleanText('a\u0000b\u2028c   d', 50), 'a b c d');
    assert.equal(cleanText('ligne 1\r\n\r\n\r\nligne 2\t', 50, { multiline: true }), 'ligne 1\n\nligne 2');
    assert.equal(Array.from(cleanText('é'.repeat(OWNER_MAX + 20), OWNER_MAX)).length, OWNER_MAX);
    assert.equal(parseAiOverride(''), null);
    assert.equal(parseAiOverride('high'), 'high');
    assert.equal(parseAiOverride('x'), undefined);
    assert.equal(parseDataOverride('2'), 2);
    assert.equal(parseDataOverride(3), 3);
    assert.equal(parseDataOverride('12'), undefined);
    assert.equal(parseDataOverride(null), null);
  });

  test('historique affiché du plus récent au plus ancien', () => {
    const list = historyNewestFirst({ history: [
      { at: '2026-09-01T00:00:00.000Z', field: 'owner' },
      { at: '2026-09-03T00:00:00.000Z', field: 'validation_status' },
      { at: '2026-09-03T00:00:00.000Z', field: 'override_ai_act_level' },
    ] });
    assert.deepEqual(list.map((h) => h.field), ['override_ai_act_level', 'validation_status', 'owner']);
    assert.deepEqual(historyNewestFirst(null), []);
  });

  test('valeurs d’historique lisibles', () => {
    assert.equal(historyValue(t, 'override_ai_act_level', null), 'niveau calculé');
    assert.equal(historyValue(t, 'override_ai_act_level', 'high'), 'Haut risque');
    assert.equal(historyValue(t, 'override_data_level', 2), '2 — Élevé');
    assert.equal(historyValue(t, 'validation_status', 'validated'), 'Validé');
    assert.equal(historyValue(t, 'owner', ''), 'aucun');
  });
});

describe('ouverture du registre depuis un autre onglet', () => {
  test('demande consommée une seule fois, pour la bonne campagne', () => {
    requestRegistryDetail('c1', 'key-1');
    assert.equal(takeRegistryDetail('c2'), null, 'autre campagne : ignorée et oubliée');
    assert.equal(takeRegistryDetail('c1'), null);
    requestRegistryDetail('c1', 'key-1');
    assert.equal(takeRegistryDetail('c1'), 'key-1');
    assert.equal(takeRegistryDetail('c1'), null);
    requestRegistryDetail('c1', '');
    assert.equal(takeRegistryDetail('c1'), null);
  });

  test('demande périmée ignorée ; filtres transmis par copie', () => {
    requestRegistryDetail('c1', 'key-1');
    assert.equal(takeRegistryDetail('c1', Date.now() + 120_000), null);
    const wanted = { to_qualify: true };
    requestRegistryFilters('c1', wanted);
    wanted.to_qualify = false;
    assert.deepEqual(takeRegistryFilters('c1'), { to_qualify: true });
    assert.equal(takeRegistryFilters('c1'), null);
  });
});

describe('tableau de bord : données des graphiques', () => {
  const suggestions = suggestActions(demoGroups, actionsData, demo.actions);
  const stats = computeStats({ campaign: anonymous, entries: demoEntries, groups: demoGroups, actions: demo.actions, suggestions, calendar, today: '2026-09-29', questionnaire });

  test('niveaux AI Act et exposition : toutes les catégories, dans l’ordre, avec leur couleur', () => {
    const ai = aiActItems(stats, t);
    assert.deepEqual(ai.map((i) => i.className), ['bar-aia-prohibited_suspected', 'bar-aia-high', 'bar-aia-to_qualify', 'bar-aia-limited', 'bar-aia-minimal']);
    assert.equal(ai.reduce((s, i) => s + i.value, 0), stats.usages);
    assert.equal(ai[0].label, 'Interdit suspecté');
    const data = dataItems(stats, t);
    assert.deepEqual(data.map((i) => i.className), ['bar-data-0', 'bar-data-1', 'bar-data-2', 'bar-data-3']);
    assert.equal(data.reduce((s, i) => s + i.value, 0), stats.usages);
    assert.equal(data[3].label, '3 — Critique');
  });

  test('masquage : barre à la borne k, jamais à la valeur réelle', () => {
    assert.deepEqual(maskedItem('A', { count: 2, display: '< 5', masked: true }, 5), { label: 'A', value: 5, display: '< 5', masked: true });
    assert.deepEqual(maskedItem('B', { count: 7, display: '7', masked: false }, 5), { label: 'B', value: 7, display: '7' });
    const depts = departmentItems(stats, t);
    assert.equal(depts.length, anonymous.departments.length);
    for (const [i, d] of stats.by_department.entries()) {
      assert.equal(depts[i].display, d.display);
      if (d.masked) assert.equal(depts[i].value, 5);
      else assert.equal(depts[i].value, d.count);
    }
    assert.ok(depts.some((d) => d.masked), 'la démo compte des services de moins de 5 déclarations');
  });

  test('outils : au plus TOP_TOOLS_LIMIT barres, le reste regroupé et masqué si faible', () => {
    const items = toolItems(stats, t);
    assert.ok(items.length <= TOP_TOOLS_LIMIT + 1);
    const many = { ...stats, top_tools: Array.from({ length: 12 }, (_, i) => ({ tool: `t${i}`, label: `Outil ${i}`, count: 1, display: '< 5', masked: true })) };
    const cut = toolItems(many, t, { limit: 8 });
    assert.equal(cut.length, 9);
    assert.equal(cut[8].label, '4 autres outils');
    assert.equal(cut[8].display, '< 5');
    assert.equal(cut[8].masked, true);
    assert.equal(cut[8].className, 'bar-muted');
    const openStats = { ...many, mask: { k: 5, active: false } };
    assert.equal(toolItems(openStats, t, { limit: 8 })[8].display, '4');
  });

  test('plan d’actions et comptes personnels', () => {
    assert.deepEqual(actionItems(stats, t).map((i) => i.className), ACTION_STATUSES.map((s) => `bar-status-${s}`));
    const plan = actionsSummary({ actions_progress: { todo: 2, in_progress: 1, done: 3, rejected: 2, total: 8, pending_suggestions: 4 } });
    assert.deepEqual(plan, { total: 8, done: 3, retained: 6, pending: 4, share: 0.5 });
    assert.deepEqual(actionsSummary({}), { total: 0, done: 0, retained: 0, pending: 0, share: 0 });
    const shadow = shadowSummary(stats);
    assert.equal(shadow.total, stats.usages);
    assert.equal(shadow.count, stats.shadow_ai.count);
    const items = shadowItems(stats, t);
    assert.equal(items[0].value + items[1].value, stats.usages);
    assert.deepEqual(shadowSummary({ usages: 0, shadow_ai: { count: 0 } }), { count: 0, total: 0, share: 0 });
  });

  test('source de vérification du calendrier', () => {
    assert.equal(verificationSourceKey(calendar), 'primary');
    assert.equal(verificationSourceKey({ verification_source: 'secondary' }), 'secondary');
    assert.equal(verificationSourceKey({ verification_source: 'autre' }), null);
    assert.equal(verificationSourceKey(null), null);
  });
});

describe('textes : clés construites dynamiquement présentes dans les catalogues', () => {
  const must = (key) => assert.notEqual(lookup(key), undefined, `clé absente : ${key}`);

  test('registre', () => {
    SORTS.forEach((s) => must(`registry.filters.sort_${s}`));
    ANSWER_FIELDS.forEach((f) => must(`registry.fields.${f}`));
    SOURCES.forEach((s) => must(`registry.members.source.${s}`));
    VALIDATION_STATUSES.forEach((s) => { must(`registry.assessment.status_help.${s}`); must(`common.validation.${s}`); });
    ['invalid', 'justification_required', 'justification_short'].forEach((c) => must(`registry.assessment.errors.${c}`));
    [...TRACKED_FIELDS, 'other'].forEach((f) => must(`registry.history.fields.${f}`));
    ['role_deployer', 'role_provider'].forEach((k) => must(`registry.detail.${k}`));
    ['confirm_text', 'confirm_text_masked'].forEach((k) => must(`registry.grouping.${k}`));
    must('registry.filters.priority');
  });

  test('tableau de bord', () => {
    ['prohibited', 'high', 'to_qualify', 'data_to_qualify', 'other'].forEach((r) => must(`dashboard.priority.reason.${r}`));
    ['to_confirm', 'to_verify', 'postponed', 'proposed'].forEach((s) => must(`dashboard.deadlines.status.${s}`));
    ['primary', 'secondary'].forEach((s) => must(`dashboard.deadlines.source.${s}`));
    ACTION_STATUSES.forEach((s) => must(`common.action_status.${s}`));
  });

  test('ponctuation française : espace insécable avant « : ; ? ! » et dans les guillemets', () => {
    const problems = [];
    const visit = (node, path) => {
      if (typeof node === 'string') {
        if (/ [:;?!»]|« /.test(node)) problems.push(`${path} : ${node}`);
        return;
      }
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    };
    visit(catalogs.registry, 'registry');
    visit(catalogs.dashboard, 'dashboard');
    assert.deepEqual(problems, []);
  });

  test('avancement du plan : accord correct quel que soit le total (règles de pluriel réelles)', () => {
    i18nRegister('dashboard', catalogs.dashboard);
    const cases = [
      [0, 5, '0 action faite sur 5 au plan'],
      [1, 5, '1 action faite sur 5 au plan'],
      [1, 1, '1 action faite sur 1 au plan'],
      [2, 5, '2 actions faites sur 5 au plan'],
      [5, 5, '5 actions faites sur 5 au plan'],
    ];
    for (const [count, total, expected] of cases) {
      assert.equal(i18nT('dashboard.actions.progress', { count, total }), expected);
    }
  });

  test('IA fantôme : note prudente, légende alignée sur l’indicateur clé', () => {
    const note = lookup('dashboard.shadow.note');
    assert.doesNotMatch(note, /sortent du cadre/);
    assert.match(note, /n'en maîtrise ni le contrat ni la conservation/);
    assert.match(note, /à vérifier pour les comptes de type inconnu/);
    assert.equal(lookup('dashboard.shadow.shadow'), lookup('dashboard.kpi.shadow'));
    assert.equal(shadowItems({ usages: 3, shadow_ai: { count: 1 } }, t)[0].label, t('dashboard.kpi.shadow'));
  });
});

describe('affichage : axe des niveaux, encart d’erreur, libellés d’export', () => {
  const NB = '\u00a0';
  let fake;
  before(() => {
    fake = installFakeDocument();
    // Le faux document n'a pas de classList (utilisée par le message d'état du détail) : ajout minimal.
    const create = fake.document.createElement;
    fake.document.createElement = (tag) => {
      const el = create(tag);
      const names = () => (el.getAttribute('class') ?? '').split(' ').filter(Boolean);
      el.classList = {
        contains: (name) => names().includes(name),
        toggle: (name, force) => {
          const on = force === undefined ? !names().includes(name) : Boolean(force);
          el.setAttribute('class', [...names().filter((n) => n !== name), ...(on ? [name] : [])].join(' '));
          return on;
        },
      };
      return el;
    };
  });
  after(() => fake.restore());

  const byClass = (node, cls, out = []) => {
    for (const child of node.childNodes ?? []) {
      if ((child.getAttribute?.('class') ?? '').split(' ').includes(cls)) out.push(child);
      byClass(child, cls, out);
    }
    return out;
  };

  test('niveau d’une ligne : axe écrit sur les cartes, absent sous un en-tête de colonne', () => {
    const group = fakeGroup({
      computed: { ai_act_level: 'minimal', data_level: 1, data_to_qualify: true, triggers: [], questions_to_confirm: [], signals: [], deadlines: [] },
      assessment: { override_ai_act_level: 'high' },
      effective: { ai_act_level: 'high', data_level: 1, overridden: true },
    });
    const card = levelCell('ai_act', group, t, { axisLabel: 'visible' });
    assert.equal(byClass(card, 'badge-axis')[0]?.textContent, `AI Act${NB}: `);
    assert.equal(card.textContent, `AI Act${NB}: Haut risquesurchargé`);
    const cell = levelCell('ai_act', group, t, { axisLabel: 'none' });
    assert.equal(cell.textContent, 'Haut risquesurchargé');
    assert.equal(byClass(cell, 'visually-hidden').length, 0);

    const data = levelCell('data', group, t, { axisLabel: 'visible' });
    assert.equal(data.textContent, `Exposition des données${NB}: Modéréà qualifier`);
    assert.equal(byClass(data, 'is-warn').length, 1);
    // Par défaut : axe lu par les lecteurs d'écran seulement.
    assert.equal(byClass(levelCell('data', group, t), 'visually-hidden')[0]?.textContent, `Exposition des données${NB}: `);
  });

  test('chaque badge de niveau du registre et du tableau de bord choisit explicitement l’affichage de l’axe', () => {
    const files = ['src/views/console/dashboard.js', 'src/views/console/registry.js', ...listFiles('src/views/console/registry')];
    const calls = [];
    for (const file of files) {
      readSource(file).split('\n').forEach((line, i) => {
        if (/\blevelBadge\(/.test(line) && !/^\s*(import|\/\/|\*)/.test(line)) calls.push({ where: `${file}:${i + 1}`, line });
      });
    }
    assert.ok(calls.length >= 6, 'appels de levelBadge attendus');
    assert.deepEqual(calls.filter((c) => !/axisLabel/.test(c.line)).map((c) => c.where), []);
    // Tableau de bord (usages prioritaires) : aucun en-tête ne nomme l'axe.
    assert.equal((readSource('src/views/console/dashboard.js').match(/axisLabel: 'visible'/g) ?? []).length, 2);
  });

  test('encart d’erreur : persistant, annoncé, effacé par null', () => {
    const slot = alertSlot('registry-alert');
    assert.equal(slot.hidden, true);
    const node = setAlert(slot, t('registry.errors.save'));
    assert.equal(slot.hidden, false);
    assert.equal(node.getAttribute('role'), 'alert');
    assert.match(node.getAttribute('class'), /\bcallout-danger\b/);
    assert.equal(slot.textContent, lookup('registry.errors.save'));
    // Même erreur une seconde fois : nouvel encart (annoncé de nouveau), jamais empilé.
    assert.notEqual(setAlert(slot, t('registry.errors.save')), node);
    assert.equal(slot.childNodes.length, 1);
    assert.equal(setAlert(slot, null), null);
    assert.equal(slot.hidden, true);
    assert.equal(slot.childNodes.length, 0);
    assert.equal(setAlert(null, 'x'), null);
  });

  test('détail : l’erreur s’affiche dans un encart de la boîte de dialogue, pas dans le message de réussite', () => {
    const controller = createDetailDialog({ t, onClose: () => {} });
    const [alert] = byClass(controller.dialog, 'registry-detail-alert');
    const [status] = byClass(controller.dialog, 'registry-detail-status');
    assert.ok(alert && status);
    // Hors de la zone qui défile : voisin du message d'état, avant le corps.
    assert.equal(alert.parentNode, status.parentNode);
    assert.equal(alert.hidden, true);

    controller.setError(t('registry.errors.save'));
    assert.equal(alert.hidden, false);
    assert.equal(alert.textContent, lookup('registry.errors.save'));
    assert.equal(byClass(alert, 'callout-danger').length, 1);
    assert.equal(status.textContent, '');

    // Un message de réussite ultérieur efface l'erreur.
    controller.setStatus(t('registry.assessment.saved'));
    assert.equal(alert.hidden, true);
    controller.setError(t('registry.errors.save'));
    controller.setError(null);
    assert.equal(alert.hidden, true);
    controller.setStatus(null);
  });

  test('tableau de bord : indicateurs en auto-fit (aucune piste vide à 1280 px)', () => {
    const css = readSource('src/styles/dashboard.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/(?:^|\n)\.dashboard-kpis\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /grid-template-columns:\s*repeat\(auto-fit,/);
    assert.doesNotMatch(css, /auto-fill/);
  });

  test('exports : mêmes libellés que la barre d’outils du Rapport', () => {
    assert.equal(lookup('registry.export.csv'), lookup('report.toolbar.csv'));
    assert.equal(lookup('registry.export.xlsx'), lookup('report.toolbar.xlsx'));
    assert.equal(lookup('registry.export.csv'), 'Exporter le registre en CSV');
    assert.equal(lookup('registry.export.xlsx'), 'Exporter en Excel (.xlsx)');
  });
});
