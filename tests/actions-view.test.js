// Logique pure des onglets « Plan d'actions » et « Rapport » de la console :
// regroupement des suggestions, filtres, tri, transitions de statut, validation de la saisie,
// usages prioritaires, principaux risques et masquage des graphiques en mode anonyme.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupSuggestions, nextSuggestionKey, suggestionKey, filterActions, sortActions, progressOf, isOverdue,
  normalizeActionInput, applyActionChanges, createManualAction, transitionStatus, acceptSuggestion,
  rejectSuggestion, acceptAllSuggestions, normalizeView, usageOptions, isValidDay, DEFAULT_VIEW, LIMITS,
  USAGE_CAMPAIGN, bucketIdOf, initialOpenBuckets, visibleActions, usageLockedKey, statusControl,
  axisBadges, saveErrorSlot, saveErrorPresenter,
} from '../src/views/console/actions.js';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './helpers/fake-dom.js';
import {
  priorityUsages, keyTriggers, mainRisks, maskedBarItems, questionsByUsage, planActions, entrySources, TOP_TOOLS,
} from '../src/views/console/report.js';
import { toolItems as dashboardToolItems, departmentItems as dashboardDepartmentItems } from '../src/views/console/dashboard.js';
import { register, t } from '../src/i18n.js';
import { suggestActions } from '../src/engine/actions.js';
import { consolidate } from '../src/engine/consolidate.js';
import { computeStats } from '../src/engine/stats.js';
import { buildDemoRecords } from '../src/services/demo.js';
import { loadAll, makeEntry } from './helpers/load-data.js';

const { demo, rules, calendar, actions: actionsData, questionnaire } = loadAll();
const NOW = new Date('2026-09-29T10:00:00.000Z');
const TODAY = '2026-09-29';
const records = buildDemoRecords(demo, null, NOW);
const groups = consolidate(records.entries, rules, calendar);
const suggestions = suggestActions(groups, actionsData, records.actions);

function action(overrides = {}) {
  return {
    id: overrides.id ?? 'A1', campaign_id: 'c1', usage_key: null, template_id: null, title: 'Action', description: '',
    owner: '', due_date: null, priority: 'medium', status: 'todo', suggested: false, suggested_role: null,
    created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z', ...overrides,
  };
}

describe('suggestions : regroupement par portée', () => {
  const buckets = groupSuggestions(suggestions, groups);

  test('actions transverses d\'abord, puis une rubrique par usage dans l\'ordre du registre', () => {
    assert.equal(buckets[0].id, USAGE_CAMPAIGN);
    assert.equal(buckets[0].group, null);
    assert.ok(buckets[0].items.every((s) => s.usage_key === null));
    const order = new Map(groups.map((g, i) => [g.usage_key, i]));
    const positions = buckets.slice(1).map((b) => order.get(b.usage_key));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    for (const b of buckets.slice(1)) {
      assert.equal(b.group.usage_key, b.usage_key);
      assert.ok(b.items.every((s) => s.usage_key === b.usage_key));
    }
    assert.equal(buckets.reduce((n, b) => n + b.items.length, 0), suggestions.length, 'aucune suggestion perdue');
  });

  test('sans suggestion transverse : pas de rubrique vide ; usage inconnu conservé en fin de liste', () => {
    const perUsage = suggestions.filter((s) => s.usage_key !== null);
    const orphan = { ...perUsage[0], usage_key: 'inconnu|x|y' };
    const b = groupSuggestions([...perUsage, orphan], groups);
    assert.notEqual(b[0].id, USAGE_CAMPAIGN);
    assert.equal(b.at(-1).usage_key, 'inconnu|x|y');
    assert.equal(b.at(-1).group, null);
    assert.deepEqual(groupSuggestions([], groups), []);
    assert.deepEqual(groupSuggestions(undefined, undefined), []);
  });

  test('focus après acceptation : suggestion suivante, sinon précédente, sinon aucune', () => {
    const keys = buckets.flatMap((b) => b.items.map(suggestionKey));
    assert.equal(nextSuggestionKey(buckets, keys[0]), keys[1]);
    assert.equal(nextSuggestionKey(buckets, keys.at(-1)), keys.at(-2));
    const single = [{ id: 'x', items: [suggestions[0]] }];
    assert.equal(nextSuggestionKey(single, suggestionKey(suggestions[0])), null);
    assert.equal(nextSuggestionKey(buckets, 'absente'), keys[0]);
  });
});

describe('suggestions : rubriques dépliées', () => {
  const buckets = groupSuggestions(suggestions, groups);

  test('beaucoup de suggestions : seule la première rubrique est dépliée ; peu : toutes', () => {
    assert.deepEqual([...initialOpenBuckets(buckets)], [buckets[0].id]);
    const few = groupSuggestions(suggestions.slice(0, 4), groups);
    assert.deepEqual([...initialOpenBuckets(few)], few.map((b) => b.id));
    assert.deepEqual([...initialOpenBuckets([])], []);
  });

  test('rubrique d\'une suggestion (pour la déplier avant d\'y placer le focus)', () => {
    const last = buckets.at(-1);
    assert.equal(bucketIdOf(buckets, suggestionKey(last.items[0])), last.id);
    assert.equal(bucketIdOf(buckets, 'absente'), null);
  });
});

describe('suggestions : accepter, rejeter, tout accepter', () => {
  const s = suggestions.find((x) => x.usage_key !== null);

  test('accepter : action « à faire », suggérée, sans responsable, identifiant déterministe', () => {
    const a = acceptSuggestion(s, 'demo', NOW);
    assert.equal(a.status, 'todo');
    assert.equal(a.suggested, true);
    assert.equal(a.owner, '', 'jamais de responsable prérempli');
    assert.equal(a.suggested_role, s.suggested_role);
    assert.equal(a.usage_key, s.usage_key);
    assert.equal(a.template_id, s.template_id);
    assert.equal(a.created_at, NOW.toISOString());
    assert.equal(acceptSuggestion(s, 'demo', NOW).id, a.id);
  });

  test('rejeter : action enregistrée « rejetée », qui n\'est plus suggérée', () => {
    const r = rejectSuggestion(s, 'demo', NOW);
    assert.equal(r.status, 'rejected');
    assert.equal(r.id, acceptSuggestion(s, 'demo', NOW).id, 'même identifiant : accepter ensuite remplace le rejet');
    const after = suggestActions(groups, actionsData, [...records.actions, r]);
    assert.equal(after.length, suggestions.length - 1);
    assert.ok(!after.some((x) => suggestionKey(x) === suggestionKey(s)));
  });

  test('tout accepter : une action par suggestion, sans doublon, puis plus aucune suggestion', () => {
    const all = acceptAllSuggestions([...suggestions, suggestions[0]], 'demo', NOW);
    assert.equal(all.length, suggestions.length);
    assert.equal(new Set(all.map((a) => a.id)).size, all.length);
    assert.ok(all.every((a) => a.status === 'todo' && a.owner === ''));
    assert.deepEqual(suggestActions(groups, actionsData, [...records.actions, ...all]), []);
  });
});

describe('liste des actions : filtres, tri, avancement', () => {
  const list = [
    action({ id: 'a', title: 'Charte', priority: 'high', status: 'done', due_date: '2026-09-30', usage_key: null }),
    action({ id: 'b', title: 'Bascule', priority: 'high', status: 'in_progress', due_date: '2026-10-30', usage_key: 'k1' }),
    action({ id: 'c', title: 'Contrat', priority: 'medium', status: 'todo', due_date: '2026-09-15', usage_key: 'k1', updated_at: '2026-09-20T08:00:00.000Z' }),
    action({ id: 'd', title: 'Ancienne', priority: 'low', status: 'rejected', usage_key: 'k2' }),
    action({ id: 'e', title: 'Former', priority: 'high', status: 'todo', due_date: null, usage_key: null, updated_at: '2026-09-28T08:00:00.000Z' }),
  ];
  const ids = (xs) => xs.map((x) => x.id);

  test('statut : par défaut toutes sauf rejetées ; « open » = à faire + en cours', () => {
    assert.deepEqual(ids(filterActions(list)), ['a', 'b', 'c', 'e']);
    assert.deepEqual(ids(filterActions(list, { status: 'open' })), ['b', 'c', 'e']);
    assert.deepEqual(ids(filterActions(list, { status: 'rejected' })), ['d']);
    assert.deepEqual(ids(filterActions(list, { status: 'all' })), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(ids(filterActions(list, { status: 'done' })), ['a']);
  });

  test('priorité et usage (transverses ou une ligne du registre), combinables', () => {
    assert.deepEqual(ids(filterActions(list, { priority: 'high' })), ['a', 'b', 'e']);
    assert.deepEqual(ids(filterActions(list, { usage: USAGE_CAMPAIGN })), ['a', 'e']);
    assert.deepEqual(ids(filterActions(list, { usage: 'k1' })), ['b', 'c']);
    assert.deepEqual(ids(filterActions(list, { usage: 'k1', priority: 'medium' })), ['c']);
    assert.deepEqual(ids(filterActions(list, { usage: 'k2', status: 'all' })), ['d']);
  });

  test('tri : priorité puis échéance ; échéance (sans date en dernier) ; statut ; modification ; titre', () => {
    assert.deepEqual(ids(sortActions(list, 'priority')), ['a', 'b', 'e', 'c', 'd']);
    assert.deepEqual(ids(sortActions(list, 'due_date')), ['c', 'a', 'b', 'e', 'd']);
    assert.deepEqual(ids(sortActions(list, 'status')), ['e', 'c', 'b', 'a', 'd']);
    assert.equal(sortActions(list, 'updated')[0].id, 'e');
    assert.deepEqual(ids(sortActions(list, 'title')), ['d', 'b', 'a', 'c', 'e']);
    assert.deepEqual(ids(sortActions(list, 'inconnu')), ids(sortActions(list, 'priority')));
    assert.notEqual(sortActions(list), list, 'copie : la liste d\'origine n\'est pas modifiée');
  });

  test('retard : échéance passée et action ni faite ni rejetée', () => {
    assert.equal(isOverdue(list[2], TODAY), true);
    assert.equal(isOverdue({ ...list[2], status: 'done' }, TODAY), false);
    assert.equal(isOverdue({ ...list[2], status: 'rejected' }, TODAY), false);
    assert.equal(isOverdue(list[0], TODAY), false, 'échéance demain');
    assert.equal(isOverdue(list[4], TODAY), false, 'sans échéance');
  });

  test('avancement : compteurs par statut, retard, pourcentage sur les actions non rejetées', () => {
    const p = progressOf(list, TODAY);
    assert.deepEqual(p, { todo: 2, in_progress: 1, done: 1, rejected: 1, overdue: 1, total: 5, active: 4, percent: 25 });
    assert.deepEqual(progressOf([], TODAY), { todo: 0, in_progress: 0, done: 0, rejected: 0, overdue: 0, total: 0, active: 0, percent: 0 });
  });

  test('vue normalisée : valeurs inconnues ou usage disparu ramenés aux valeurs par défaut', () => {
    assert.deepEqual(normalizeView(undefined), { ...DEFAULT_VIEW });
    assert.deepEqual(normalizeView({ status: 'x', priority: 'y', sort: 'z', usage: 'disparu' }, ['k1']), { ...DEFAULT_VIEW });
    assert.equal(normalizeView({ usage: 'k1' }, ['k1']).usage, 'k1');
    assert.equal(normalizeView({ usage: USAGE_CAMPAIGN }, []).usage, USAGE_CAMPAIGN);
    assert.deepEqual(usageOptions(groups).map((o) => o.value), groups.map((g) => g.usage_key));
  });
});

describe('sélecteur de statut : aucun enregistrement au simple changement d\'option (WCAG 3.2.2)', () => {
  const tr = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  // Contrôle relié à un faux store : « Appliquer » enregistre, comme changeStatus() dans la vue.
  function setup(status = 'done') {
    const dom = installFakeDocument();
    const puts = [];
    const store = { putAction: (a) => { puts.push(a); } };
    const a = action({ id: 'A1', title: 'Rédiger une charte', status });
    const control = statusControl(a, tr, {
      id: 'action-status-A1',
      onApply: (value) => store.putAction(transitionStatus(a, value, NOW).value),
    });
    return { dom, puts, control };
  }

  test('parcourir les options (événements change) n\'appelle jamais putAction', () => {
    const { dom, puts, control } = setup('done');
    try {
      assert.equal(control.select.getAttribute('id'), 'action-status-A1');
      assert.equal(control.apply.hidden, true, 'rien à appliquer au départ');
      for (const value of ['rejected', 'in_progress', 'todo']) {
        control.select.value = value;
        control.select.dispatch('change');
        control.select.dispatch('input');
      }
      assert.deepEqual(puts, [], 'aucun enregistrement pendant le parcours des options');
      assert.equal(control.apply.hidden, false, '« Appliquer » affiché : le statut choisi diffère');
      assert.match(control.apply.getAttribute('aria-label'), /actions\.item\.apply_label.*todo.*Rédiger une charte/);
      // Retour au statut enregistré : plus rien à appliquer.
      control.select.value = 'done';
      control.select.dispatch('change');
      assert.equal(control.apply.hidden, true);
      assert.equal(control.apply.getAttribute('aria-label'), null);
      assert.deepEqual(puts, []);
    } finally {
      dom.restore();
    }
  });

  test('« Appliquer » ou Entrée enregistre le statut choisi, une seule fois', () => {
    const { dom, puts, control } = setup('done');
    try {
      control.select.value = 'in_progress';
      control.select.dispatch('change');
      control.apply.dispatch('click');
      assert.equal(puts.length, 1);
      assert.equal(puts[0].status, 'in_progress');

      let prevented = false;
      control.select.value = 'rejected';
      control.select.dispatch('change');
      control.select.dispatch('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
      assert.equal(puts.length, 2);
      assert.equal(puts[1].status, 'rejected');
      assert.equal(prevented, true);

      control.select.dispatch('keydown', { key: 'ArrowDown', preventDefault: () => {} });
      assert.equal(puts.length, 2, 'une flèche n\'enregistre rien');
      control.reset();
      assert.equal(control.select.value, 'done', 'reset : retour au statut enregistré');
      control.select.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
      control.apply.dispatch('click');
      assert.equal(puts.length, 2, 'statut inchangé : ni Entrée ni « Appliquer » n\'enregistrent');
    } finally {
      dom.restore();
    }
  });

  test('reset après un échec : « Appliquer » masqué, le focus qu\'il avait passe au sélecteur', () => {
    const { dom, control } = setup('done');
    try {
      let focused = 0;
      control.select.focus = () => { focused += 1; dom.document.activeElement = control.select; };
      control.select.value = 'todo';
      control.select.dispatch('change');
      assert.equal(control.apply.hidden, false);
      dom.document.activeElement = control.apply; // clic sur « Appliquer »
      control.reset(); // enregistrement en échec (ou statut déjà enregistré)
      assert.equal(control.apply.hidden, true);
      assert.equal(control.select.value, 'done');
      assert.equal(focused, 1, 'focus rendu au sélecteur, pas à la page');
      assert.equal(dom.document.activeElement, control.select);
      // Focus ailleurs (Entrée sur le sélecteur, autre élément) : reset() ne le déplace pas.
      dom.document.activeElement = null;
      control.select.value = 'todo';
      control.select.dispatch('change');
      control.reset();
      assert.equal(focused, 1);
    } finally {
      dom.restore();
    }
  });

  test('la vue ne relie plus l\'enregistrement du statut à l\'événement change', () => {
    const source = readFileSync(new URL('../src/views/console/actions.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /onChange:\s*\([^)]*\)\s*=>\s*changeStatus\(/);
    assert.match(source, /statusControl\(action, t, \{/);
  });
});

describe('liste : action modifiée gardée à l\'écran jusqu\'au prochain changement de filtre', () => {
  const list = [
    action({ id: 'a', title: 'Charte', priority: 'high', status: 'rejected' }),
    action({ id: 'b', title: 'Bascule', priority: 'high', status: 'in_progress' }),
    action({ id: 'c', title: 'Contrat', priority: 'medium', status: 'todo' }),
    action({ id: 'd', title: 'Ancienne', priority: 'low', status: 'rejected' }),
  ];

  test('sans action gardée : exactement les actions filtrées, dans l\'ordre du tri', () => {
    const shown = visibleActions(list, DEFAULT_VIEW);
    assert.deepEqual(shown.map((x) => x.action.id), sortActions(filterActions(list, DEFAULT_VIEW), 'priority').map((a) => a.id));
    assert.ok(shown.every((x) => x.matches));
    assert.deepEqual(visibleActions(undefined, DEFAULT_VIEW), []);
  });

  test('action que l\'on vient de rejeter : toujours affichée, signalée comme hors filtre ; les autres rejetées restent masquées', () => {
    const shown = visibleActions(list, DEFAULT_VIEW, new Set(['a']));
    assert.deepEqual(shown.map((x) => [x.action.id, x.matches]), [['b', true], ['a', false], ['c', true]]);
    assert.deepEqual(visibleActions(list, { ...DEFAULT_VIEW, status: 'todo' }, ['b']).map((x) => [x.action.id, x.matches]), [['b', false], ['c', true]]);
    assert.deepEqual(visibleActions(list, { ...DEFAULT_VIEW, sort: 'title' }, new Set(['a', 'x'])).map((x) => x.action.id), ['b', 'a', 'c'], 'identifiant inconnu ignoré, tri respecté');
  });
});

describe('textes : suggestion acceptée, action transverse', () => {
  const catalog = JSON.parse(readFileSync(new URL('../src/i18n/fr/actions.json', import.meta.url), 'utf8'));
  register('actions', catalog);

  test('une action du plan issue d\'une suggestion ne porte pas le mot « Suggérée »', () => {
    assert.equal(t('actions.item.from_suggestion'), 'Issue d\'une suggestion');
    assert.notEqual(t('actions.item.from_suggestion'), t('actions.item.manual'));
    assert.equal(Object.hasOwn(catalog.item, 'suggested'), false, 'ancienne clé « Suggérée » retirée de la liste du plan');
    const source = readFileSync(new URL('../src/views/console/actions.js', import.meta.url), 'utf8');
    assert.match(source, /action\.suggested \? t\('actions\.item\.from_suggestion'\)/);
  });

  test('dialogue d\'édition : mention propre aux actions transverses issues d\'une suggestion', () => {
    const transverse = acceptSuggestion(suggestions.find((x) => x.usage_key === null), 'demo', NOW);
    const linked = acceptSuggestion(suggestions.find((x) => x.usage_key !== null), 'demo', NOW);
    assert.equal(usageLockedKey(transverse), 'actions.form.usage_locked_transverse');
    assert.equal(usageLockedKey(linked), 'actions.form.usage_locked');
    assert.equal(usageLockedKey({ ...linked, usage_key: undefined }), 'actions.form.usage_locked_transverse');
    assert.match(t(usageLockedKey(transverse)), /^Cette action vient d'une suggestion transverse : elle concerne toute la campagne/);
    assert.doesNotMatch(t(usageLockedKey(transverse)), /liée à cet usage/);
    assert.match(t(usageLockedKey(linked)), /liée à cet usage/);
  });
});

describe('résumés : badges des deux axes, axe affiché et libellé complet', () => {
  register('common', JSON.parse(readFileSync(new URL('../src/i18n/fr/common.json', import.meta.url), 'utf8')));
  const prefix = (axis) => t('common.levels.axis_prefix', { axis: t(`common.levels.axis.${axis}`) });

  test('axisBadges : « AI Act : Interdit suspecté » et « Exposition des données : Critique », axe visible', () => {
    const dom = installFakeDocument();
    try {
      const [ai, data] = axisBadges({ ai_act_level: 'prohibited_suspected', data_level: 3 }, t);
      assert.equal(ai.textContent, `${prefix('ai_act')}${t('common.levels.ai_act.prohibited_suspected')}`);
      assert.equal(data.textContent, `${prefix('data')}${t('common.levels.data.3')}`);
      for (const badge of [ai, data]) {
        assert.equal(badge.children[0].getAttribute('class'), 'badge-axis', 'axe affiché, pas seulement lu par les lecteurs d\'écran');
        assert.ok(!badge.children.some((c) => c.getAttribute('class') === 'visually-hidden'), 'libellé complet, pas de libellé court');
      }
      assert.doesNotMatch(ai.textContent, new RegExp(t('common.levels.ai_act_short.prohibited_suspected').replace('?', '\\?')));
      assert.equal(ai.getAttribute('title'), null);
      // Niveau inconnu : badge neutre, axe toujours nommé.
      const [none] = axisBadges(undefined, t);
      assert.equal(none.textContent, `${prefix('ai_act')}—`);
    } finally {
      dom.restore();
    }
  });

  test('rubriques de suggestions et fiches prioritaires du rapport : axisBadges, jamais le libellé court', () => {
    const actionsSource = readFileSync(new URL('../src/views/console/actions.js', import.meta.url), 'utf8');
    const reportSource = readFileSync(new URL('../src/views/console/report.js', import.meta.url), 'utf8');
    assert.match(actionsSource, /sugg-summary-badges' \}, axisBadges\(g\.effective, t\)\)/);
    assert.match(reportSource, /report-usage-levels' \},\s*axisBadges\(g\.effective, t\)/);
    assert.doesNotMatch(actionsSource, /short: true/);
    assert.doesNotMatch(reportSource, /levelBadge\(/, 'le rapport passe par axisBadges');
  });
});

describe('erreur d\'enregistrement : notification et encart persistant', () => {
  const tr = (key) => key;

  test('encart dans l\'emplacement de l\'élément concerné, déplacé par une autre erreur, retiré par clear()', () => {
    const dom = installFakeDocument();
    try {
      const fallback = saveErrorSlot();
      const item = saveErrorSlot();
      const dialog = saveErrorSlot({ live: true });
      assert.equal(item.getAttribute('class'), 'actions-save-error');
      assert.equal(item.getAttribute('role'), null, 'hors dialogue : la notification est déjà annoncée');
      assert.equal(dialog.getAttribute('role'), 'alert', 'dans un dialogue modal : annoncé par l\'encart');
      assert.equal(item.childNodes.length, 0, 'vide au départ (masqué par la feuille de style)');

      const errors = saveErrorPresenter(tr, fallback);
      assert.equal(errors.show(item), item);
      assert.equal(item.children.length, 1);
      assert.match(item.children[0].getAttribute('class'), /\bcallout-danger\b/);
      assert.equal(item.textContent, 'actions.toast.save_error');
      assert.equal(errors.current(), item);

      errors.show(dialog);
      assert.equal(item.childNodes.length, 0, 'un seul encart à la fois');
      assert.equal(dialog.textContent, 'actions.toast.save_error');

      errors.clear();
      assert.equal(dialog.childNodes.length, 0);
      assert.equal(errors.current(), null);
      errors.clear();

      assert.equal(errors.show(undefined), fallback, 'sans emplacement : encart en tête de l\'onglet');
      assert.equal(fallback.textContent, 'actions.toast.save_error');
      assert.equal(saveErrorPresenter(tr).show(null), null);
    } finally {
      dom.restore();
    }
  });

  test('la vue affiche l\'encart à chaque échec d\'enregistrement ; emplacement vide sans encombrement', () => {
    const source = readFileSync(new URL('../src/views/console/actions.js', import.meta.url), 'utf8');
    assert.match(source, /const reportError = \(err, slot\) => \{[^}]*toast\(t\('actions\.toast\.save_error'\), 'danger'\);\s*saveErrors\.show\(slot\);/);
    assert.doesNotMatch(source, /reportError\(err\)/, 'chaque échec indique où placer l\'encart');
    assert.equal((source.match(/reportError\(err, /g) ?? []).length, 6, 'accepter, rejeter, tout accepter, dialogue, supprimer, statut');
    assert.match(source, /saveErrorSlot\(\{ live: true \}\)/, 'dialogue d\'édition');
    assert.match(source, /const save = async \(\) => \{\s*saveErrors\.clear\(\);/, 'nouvelle tentative : encart retiré');
    const css = readFileSync(new URL('../src/styles/actions.css', import.meta.url), 'utf8');
    assert.match(css, /\.actions-save-error:empty\s*\{\s*display:\s*none;\s*\}/);
  });
});

describe('mise en page et typographie', () => {
  test('grilles d\'indicateurs (plan d\'actions, démo, rapport) en auto-fit : aucune piste vide', () => {
    const read = (file) => readFileSync(new URL(`../src/styles/${file}`, import.meta.url), 'utf8');
    const rule = (css, selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    const actionsCss = read('actions.css');
    const reportCss = read('report.css');
    assert.match(rule(actionsCss, '.kpi-grid-compact'), /grid-template-columns:\s*repeat\(auto-fit,/);
    assert.match(rule(reportCss, '.report-kpis'), /grid-template-columns:\s*repeat\(auto-fit,/);
    // Huit indicateurs : quatre colonnes au plus (deux rangées de quatre, jamais 6 + 2).
    assert.match(rule(reportCss, '.report-kpis'), /\(100% - 3 \* var\(--space-3\)\) \/ 4/);
    assert.doesNotMatch(actionsCss + reportCss, /auto-fill/);
  });

  test('fiche prioritaire du rapport : titre sans la marge haute des intertitres (.report-section h4)', () => {
    const css = readFileSync(new URL('../src/styles/report.css', import.meta.url), 'utf8');
    assert.match(css, /\.report-section h4 \{ margin-top:/, 'intertitres de section espacés');
    // Même spécificité que l'intertitre au moins (deux sélecteurs), sinon sa marge haute l'emporte.
    assert.match(css, /\n\.report-section \.report-usage-name \{ margin: 0 0 var\(--space-1\); \}/);
  });

  test('catalogues actions, report et demo : espaces insécables avant « : ; ? ! » et dans les guillemets', () => {
    const problems = [];
    const walk = (value, path) => {
      if (typeof value === 'string') {
        // Espace ordinaire au lieu de l'insécable, ou aucune espace (« mot: », « «mot» ») ; les
        // « : » d'une adresse (https://) ou d'une heure (10:30) ne sont pas de la ponctuation.
        if (/ [:;?!»]|« /.test(value)
          || /[^\s  !?][;?!](?=\s|$)|[^\s  ]:(?=\s|$)/.test(value)
          || /«(?![  ])|[^  ]»/.test(value)) problems.push(`${path} : ${value.slice(0, 60)}`);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    for (const ns of ['actions', 'report', 'demo']) {
      walk(JSON.parse(readFileSync(new URL(`../src/i18n/fr/${ns}.json`, import.meta.url), 'utf8')), ns);
    }
    assert.deepEqual(problems, []);
  });
});

describe('saisie et transitions', () => {
  test('validation : intitulé requis, longueurs, date réelle, énumérations, usage connu', () => {
    const ok = normalizeActionInput({ title: '  Former\u0007 les équipes ', description: 'L1\r\n\r\n\r\nL2', owner: ' Mme\tX ', due_date: '2026-12-15', priority: 'high', status: 'in_progress' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value, { title: 'Former les équipes', description: 'L1\n\nL2', owner: 'Mme X', due_date: '2026-12-15', priority: 'high', status: 'in_progress', usage_key: null });

    const bad = normalizeActionInput({ title: '   ', description: 'x'.repeat(LIMITS.description + 1), owner: 'o'.repeat(LIMITS.owner + 1),
      due_date: '2026-02-31', priority: 'urgent', status: 'archived', usage_key: 'absent' }, { usageKeys: ['k1'] });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors.map((e) => `${e.field}:${e.code}`).sort(), [
      'description:too_long', 'due_date:invalid_date', 'owner:too_long', 'priority:enum', 'status:enum', 'title:required', 'usage_key:unknown_usage',
    ]);
    assert.equal(normalizeActionInput({ title: 't'.repeat(LIMITS.title + 1) }).errors[0].code, 'too_long');
    assert.equal(normalizeActionInput({ title: 'T', due_date: '' }).value.due_date, null, 'échéance vide ⇒ aucune');
    assert.equal(isValidDay('2028-02-29'), true);
    assert.equal(isValidDay('2027-02-29'), false);
  });

  test('action manuelle : suggested false, sans modèle ni rôle suggéré, usage facultatif', () => {
    const r = createManualAction({ title: 'Nommer un référent IA', usage_key: 'k1' }, 'c1', { now: NOW, id: 'M-test', usageKeys: ['k1'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, {
      id: 'M-test', campaign_id: 'c1', usage_key: 'k1', template_id: null, title: 'Nommer un référent IA', description: '',
      owner: '', due_date: null, priority: 'medium', status: 'todo', suggested: false, suggested_role: null,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    });
    const free = createManualAction({ title: 'Sans usage' }, 'c1', { now: NOW });
    assert.equal(free.value.usage_key, null);
    assert.match(free.value.id, /^M-[A-Za-z0-9_-]{12}$/);
    assert.notEqual(createManualAction({ title: 'x' }, 'c1').value.id, free.value.id);
    assert.equal(createManualAction({ title: '' }, 'c1').ok, false);
  });

  test('modification : updated_at renouvelé, created_at et origine conservés ; usage figé pour une suggestion', () => {
    const suggested = acceptSuggestion(suggestions.find((x) => x.usage_key !== null), 'demo', new Date('2026-09-10T08:00:00Z'));
    const later = new Date('2026-09-29T12:00:00.000Z');
    const r = applyActionChanges(suggested, { title: 'Vérifier le DPA', owner: 'Mme Martin', due_date: '2026-11-30', priority: 'high', status: 'in_progress', usage_key: 'autre' }, { now: later, usageKeys: ['autre'] });
    assert.equal(r.ok, true);
    assert.equal(r.value.owner, 'Mme Martin');
    assert.equal(r.value.usage_key, suggested.usage_key, 'l\'usage d\'une action issue d\'un modèle ne change pas');
    assert.equal(r.value.created_at, suggested.created_at);
    assert.equal(r.value.updated_at, later.toISOString());
    assert.equal(r.value.suggested, true);
    assert.equal(r.value.template_id, suggested.template_id);
    assert.equal(r.value.id, suggested.id);

    const manual = action({ usage_key: 'k1' });
    const moved = applyActionChanges(manual, { title: 'Action', usage_key: 'k2' }, { now: later, usageKeys: ['k1', 'k2'] });
    assert.equal(moved.value.usage_key, 'k2');
    const cleared = applyActionChanges(manual, { title: 'Action', usage_key: '' }, { now: later, usageKeys: ['k1'] });
    assert.equal(cleared.value.usage_key, null);
    assert.equal(applyActionChanges(manual, { title: '' }, { now: later }).ok, false);
  });

  test('transitions de statut : toutes permises (dont restauration d\'un rejet), statut inconnu refusé', () => {
    const a = action();
    const later = new Date('2026-09-29T12:00:00.000Z');
    const steps = ['in_progress', 'done', 'todo', 'rejected', 'todo'];
    let current = a;
    for (const status of steps) {
      const { changed, value } = transitionStatus(current, status, later);
      assert.equal(changed, true);
      assert.equal(value.status, status);
      assert.equal(value.updated_at, later.toISOString());
      assert.equal(value.created_at, a.created_at);
      current = value;
    }
    const same = transitionStatus(current, 'todo', new Date('2030-01-01T00:00:00Z'));
    assert.equal(same.changed, false);
    assert.equal(same.value, current, 'même statut : action inchangée');
    assert.throws(() => transitionStatus(a, 'archived'), TypeError);
  });
});

describe('rapport : logique pure', () => {
  const stats = computeStats({ campaign: records.campaign, entries: records.entries, groups, actions: records.actions, suggestions, calendar, today: TODAY, questionnaire });

  test('usages prioritaires de la démo : interdit suspecté, deux hauts risques (dont une exposition critique)', () => {
    const p = priorityUsages(groups);
    assert.deepEqual(p.map((x) => x.group.name), ['Analyse d\'émotions en visio (test)', 'Aide à l\'évaluation annuelle', 'Tri automatique de CV']);
    assert.deepEqual(p.map((x) => x.reasons), [['prohibited_suspected'], ['high', 'data_critical'], ['high']]);
  });

  test('usages prioritaires : à qualifier (AI Act ou données) et exposition critique seule', () => {
    const g = consolidate([
      makeEntry({ usage_name: 'Script', task_types: ['code'], data_types: ['identifiants'] }),
      makeEntry({ usage_name: 'Interne', tool: 'claude', built_or_customized: 'built_own' }),
      makeEntry({ usage_name: 'Compte ?', tool: 'gemini', account_type: 'unknown' }),
      makeEntry({ usage_name: 'Banal', tool: 'deepl', task_types: ['traduction'] }),
    ], rules, calendar);
    const p = new Map(priorityUsages(g).map((x) => [x.group.name, x.reasons]));
    assert.deepEqual(p.get('Script'), ['data_critical']);
    assert.deepEqual(p.get('Interne'), ['to_qualify']);
    assert.ok(p.get('Compte ?').some((r) => r === 'data_to_qualify' || r === 'to_qualify'));
    assert.equal(p.has('Banal'), false);
  });

  test('déclencheurs cités : sans règles transverses, ni risque minimal par défaut, ni « aucune donnée »', () => {
    for (const g of groups) {
      const ids = keyTriggers(g).map((x) => x.rule_id);
      assert.ok(!ids.includes('R-AIA-LIT') && !ids.includes('R-GOV-01') && !ids.includes('R-AIA-MIN') && !ids.includes('R-DAT-LOW'), g.name);
    }
    const emotions = groups.find((g) => g.name.startsWith('Analyse d\'émotions'));
    assert.ok(keyTriggers(emotions).some((x) => x.rule_id === 'R-AIA-PRO-01' && x.legal_ref.includes('art. 5')));
  });

  test('principaux risques de la démo, du plus grave au moins grave', () => {
    assert.deepEqual(mainRisks(stats, groups), [
      { id: 'prohibited_suspected', count: 1 },
      { id: 'high', count: 2 },
      { id: 'data_critical', count: 1 },
      { id: 'shadow_ai', count: 3 },
      { id: 'limited', count: 2 },
    ]);
    assert.deepEqual(mainRisks({ by_ai_act: {}, by_data: {}, to_qualify: 0, shadow_ai: { count: 0 } }, []), []);
  });

  test('graphiques en mode anonyme : effectif masqué dessiné jusqu\'à la borne k en pointillés, affiché « < k », ordre sans fuite', () => {
    const tools = maskedBarItems(stats.top_tools, { order: 'count', k: 5 });
    const masked = tools.filter((x) => x.masked);
    assert.ok(masked.length > 0);
    assert.ok(masked.every((x) => x.value === 5 && x.display === '< 5'), 'longueur = borne, jamais la valeur réelle');
    const firstMasked = tools.findIndex((x) => x.masked);
    assert.ok(tools.slice(firstMasked).every((x) => x.masked), 'effectifs visibles d\'abord');
    const labels = masked.map((x) => x.label);
    assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, 'fr')), 'masqués par ordre alphabétique');
    assert.deepEqual(tools[0], { label: 'ChatGPT', value: 7, display: '7', className: 'bar-data-1' });

    const depts = maskedBarItems(stats.by_department.map((d) => ({ ...d, label: d.department })), { order: 'given', k: 5 });
    assert.deepEqual(depts.map((x) => x.label), records.campaign.departments, 'ordre de la campagne conservé');
    assert.deepEqual(depts.find((x) => x.label === 'Commercial et devis'), { label: 'Commercial et devis', value: 8, display: '8', className: 'bar-data-1' });
    assert.deepEqual(depts.find((x) => x.label === 'Direction'), { label: 'Direction', value: 5, display: '< 5', masked: true, className: 'bar-data-1' });
    assert.deepEqual(depts.find((x) => x.label === 'Comptabilité'), { label: 'Comptabilité', value: 0, display: '0', className: 'bar-data-1' }, 'zéro : pas de masque');
    assert.equal(maskedBarItems(stats.top_tools, { limit: 3 }).length, 3);
  });

  test('graphiques : même représentation des effectifs que le tableau de bord (maskedItem)', () => {
    const tr = (key, vars) => `${key}:${vars?.count ?? ''}`;
    const dashTools = new Map(dashboardToolItems(stats, tr, { limit: Infinity }).map((x) => [x.label, x]));
    const reportTools = maskedBarItems(stats.top_tools, { k: stats.mask.k, mode: 'anonymous' });
    assert.equal(reportTools.length, dashTools.size);
    for (const item of reportTools) {
      const { className, ...rest } = item;
      assert.deepEqual(rest, dashTools.get(item.label), item.label);
    }
    // Plus de TOP_TOOLS outils (9 dans la démo) : aucun n'est omis (un seul en trop : affiché tel quel).
    assert.equal(stats.top_tools.length, TOP_TOOLS + 1);
    const other = { label: (n) => `Autres (${n})` };
    const limited = maskedBarItems(stats.top_tools, { k: stats.mask.k, mode: 'anonymous', limit: TOP_TOOLS, other });
    assert.deepEqual(limited.map((x) => x.label).sort(), stats.top_tools.map((x) => x.label).sort());
    const grouped = maskedBarItems(stats.top_tools, { k: stats.mask.k, mode: 'anonymous', limit: TOP_TOOLS - 1, other });
    assert.equal(grouped.length, TOP_TOOLS);
    assert.equal(grouped.at(-1).label, 'Autres (2)');
    const dashDepts = dashboardDepartmentItems(stats, tr);
    const reportDepts = maskedBarItems(stats.by_department.map((d) => ({ ...d, label: d.department })), { order: 'given', k: stats.mask.k });
    assert.deepEqual(reportDepts.map(({ className, ...rest }) => rest), dashDepts);
  });

  test('graphiques : au-delà de la limite, les outils suivants sont regroupés (somme masquée si < k)', () => {
    const list = [
      { label: 'A', count: 9, display: '9', masked: false },
      { label: 'B', count: 6, display: '6', masked: false },
      { label: 'C', count: 3, display: '< 5', masked: true },
      { label: 'D', count: 1, display: '< 5', masked: true },
      { label: 'E', count: 2, display: '< 5', masked: true },
    ];
    const other = { label: (n) => `Autres (${n})` };
    const small = maskedBarItems(list, { limit: 3, k: 5, mode: 'anonymous', other });
    assert.deepEqual(small.map((x) => x.label), ['A', 'B', 'C', 'Autres (2)']);
    assert.deepEqual(small.at(-1), { label: 'Autres (2)', value: 5, display: '< 5', masked: true, className: 'bar-muted' }, '1 + 2 = 3 < 5 : masqué');
    const big = maskedBarItems(list, { limit: 2, k: 5, mode: 'anonymous', other });
    assert.deepEqual(big.at(-1), { label: 'Autres (3)', value: 6, display: '6', className: 'bar-muted' }, '3 + 1 + 2 = 6 ≥ 5 : affiché');
    assert.equal(maskedBarItems(list, { limit: 10, other }).length, list.length, 'sous la limite : aucun regroupement');
    assert.deepEqual(maskedBarItems(list, { limit: 4, other }).map((x) => x.label), ['A', 'B', 'C', 'D', 'E'], 'un seul en trop : affiché, pas regroupé');
    const open = maskedBarItems(list.map((x) => ({ ...x, display: String(x.count), masked: false })), { limit: 3, k: 5, mode: 'open', other });
    assert.deepEqual(open.at(-1), { label: 'Autres (2)', value: 3, display: '3', className: 'bar-muted' }, 'mode nominatif : jamais masqué');
  });

  test('origine des déclarations (méthode du rapport) : codes, saisie directe, démo ; exclues ignorées', () => {
    assert.deepEqual(entrySources(records.entries), { code: 0, manual: 0, demo: records.entries.length });
    assert.deepEqual(entrySources([
      { source: 'code' }, { source: 'manual' }, { source: 'manual' }, { source: 'manual', excluded: true }, { source: 'autre' }, null,
    ]), { code: 1, manual: 2, demo: 0 });
    assert.deepEqual(entrySources(undefined), { code: 0, manual: 0, demo: 0 });
  });

  test('libellés des indicateurs du rapport accordés au nombre (1 interdit suspecté, 2 interdits suspectés)', () => {
    register('report', JSON.parse(readFileSync(new URL('../src/i18n/fr/report.json', import.meta.url), 'utf8')));
    assert.equal(t('report.kpi.prohibited', { count: 1 }), 'interdit suspecté');
    assert.equal(t('report.kpi.prohibited', { count: 2 }), 'interdits suspectés');
    assert.equal(t('report.kpi.data_critical', { count: 1 }), 'exposition critique des données');
    assert.equal(t('report.kpi.to_qualify', { count: 0 }), 'usage à qualifier');
    assert.equal(t('report.kpi.responses', { count: 23 }), 'déclarations reçues');
    assert.equal(t('report.charts.other_tools', { count: 3 }), 'Autres outils (3)');
  });

  test('vocabulaire : « IA fantôme » (glosé une seule fois), comptes « non maîtrisés », exports nommés comme au registre', () => {
    const read = (ns) => JSON.parse(readFileSync(new URL(`../src/i18n/fr/${ns}.json`, import.meta.url), 'utf8'));
    const texts = (obj) => (typeof obj === 'string' ? [obj] : Object.values(obj ?? {}).flatMap(texts));
    const report = read('report');
    const all = texts(report);
    const glossed = all.filter((x) => /shadow ai/i.test(x));
    assert.equal(glossed.length, 1, glossed.join(' | '));
    assert.match(glossed[0], /IA fantôme \(shadow AI\)/);
    assert.ok(!all.some((x) => /non identifiés/i.test(x)), 'comptes « personnels ou non maîtrisés », jamais « non identifiés »');
    assert.ok(!texts(read('demo')).some((x) => /shadow ai/i.test(x) && !/IA fantôme \(shadow AI\)/.test(x)));
    // Mêmes fichiers, mêmes messages que les boutons d'export de l'onglet Registre.
    const registry = read('registry');
    assert.equal(report.export.csv_done, registry.export.done_csv);
    assert.equal(report.export.xlsx_done, registry.export.done_xlsx);
    assert.ok(!all.some((x) => /\bXLSX\b/.test(x)), 'le format est nommé « Excel (.xlsx) », jamais « XLSX » seul');
  });

  test('questions regroupées par usage, sans doublon', () => {
    const q = questionsByUsage([
      { group_id: 'U-1', name: 'A', question: 'Q1' },
      { group_id: 'U-2', name: 'B', question: 'Q2' },
      { group_id: 'U-1', name: 'A', question: 'Q3' },
      { group_id: 'U-1', name: 'A', question: 'Q1' },
    ]);
    assert.deepEqual(q, [{ group_id: 'U-1', name: 'A', questions: ['Q1', 'Q3'] }, { group_id: 'U-2', name: 'B', questions: ['Q2'] }]);
    assert.deepEqual(questionsByUsage(undefined), []);
  });

  test('plan d\'actions du rapport : actions retenues (sans les rejetées), par priorité', () => {
    const plan = planActions([...records.actions, action({ id: 'rej', status: 'rejected', priority: 'high' })]);
    assert.equal(plan.length, records.actions.length);
    assert.ok(plan.every((a) => a.status !== 'rejected'));
    const ranks = plan.map((a) => ['high', 'medium', 'low'].indexOf(a.priority));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });
});
