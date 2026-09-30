import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  t, load, has, register, isLoaded, setLoader, formatDate, formatDateTime, formatNumber, i18n,
} from '../src/i18n.js';

const I18N_DIR = new URL('../src/i18n/fr/', import.meta.url);

function readCatalog(ns) {
  return JSON.parse(readFileSync(new URL(`${ns}.json`, I18N_DIR), 'utf8'));
}

const loads = [];

before(async () => {
  setLoader(async (ns) => {
    loads.push(ns);
    return readCatalog(ns);
  });
  await load('common');
  register('testns', {
    greeting: 'Bonjour {name}, bienvenue chez {org}.',
    partial: 'Valeur : {missing}',
    same: '{a} et {a}',
    usages: { one: '{count} usage recensé', other: '{count} usages recensés' },
    codes: { zero: 'Aucun code', one: 'Un code', other: '{count} codes' },
    nested: { deep: { leaf: 'Feuille' } },
    list: ['a', 'b'],
  });
});

after(() => setLoader());

describe('t() : recherche et interpolation', () => {
  test('clé simple et imbriquée', () => {
    assert.equal(t('common.nav.home'), 'Accueil');
    assert.equal(t('testns.nested.deep.leaf'), 'Feuille');
  });

  test('interpolation {var}', () => {
    assert.equal(t('testns.greeting', { name: 'Camille', org: 'Menuiserie Alpine Concept' }),
      'Bonjour Camille, bienvenue chez Menuiserie Alpine Concept.');
    assert.equal(t('testns.same', { a: 'x' }), 'x et x');
    assert.equal(t('common.app.version', { version: '0.1.0' }), 'version 0.1.0');
  });

  test('variable absente ou nulle : le jeton reste visible', () => {
    assert.equal(t('testns.partial'), 'Valeur : {missing}');
    assert.equal(t('testns.partial', { missing: null }), 'Valeur : {missing}');
    assert.equal(t('testns.partial', { missing: 0 }), 'Valeur : 0');
  });

  test('les valeurs interpolées ne sont pas réinterprétées', () => {
    assert.equal(t('testns.greeting', { name: '{org}', org: '<b>' }), 'Bonjour {org}, bienvenue chez <b>.');
  });

  test('pluriels simples selon vars.count', () => {
    assert.equal(t('testns.usages', { count: 1 }), '1 usage recensé');
    assert.equal(t('testns.usages', { count: 0 }), '0 usage recensé'); // français : 0 est au singulier
    assert.equal(t('testns.usages', { count: 2 }), '2 usages recensés');
    assert.equal(t('testns.usages', { count: 40 }), '40 usages recensés');
    assert.equal(t('testns.codes', { count: 0 }), 'Aucun code');
    assert.equal(t('testns.codes', { count: 1 }), 'Un code');
    assert.equal(t('testns.codes', { count: 3 }), '3 codes');
  });

  test('clé absente : la clé est renvoyée', () => {
    assert.equal(t('common.inexistante'), 'common.inexistante');
    assert.equal(t('espace_inconnu.cle'), 'espace_inconnu.cle');
    assert.equal(t('sanspoint'), 'sanspoint');
    assert.equal(t('testns.nested'), 'testns.nested', 'un groupe de clés n\'est pas un texte');
    assert.equal(t('testns.list'), 'testns.list');
    assert.equal(t('testns.usages'), 'testns.usages', 'pluriel sans count');
    assert.equal(t('testns.__proto__'), 'testns.__proto__');
    assert.equal(t('testns.greeting.toString'), 'testns.greeting.toString');
  });

  test('has()', () => {
    assert.equal(has('common.disclaimer'), true);
    assert.equal(has('testns.usages'), true);
    assert.equal(has('common.nope'), false);
    assert.equal(has('nope.nope'), false);
  });
});

describe('load()', () => {
  test('chargement unique et mis en cache', async () => {
    const before = loads.filter((ns) => ns === 'home').length;
    const [a, b] = await Promise.all([load('home'), load('home')]);
    await load('home');
    assert.equal(a, b);
    assert.equal(loads.filter((ns) => ns === 'home').length - before, 1);
    assert.ok(isLoaded('home'));
    assert.equal(t('home.steps.create.title'), 'Créer une campagne');
  });

  test('espace de noms invalide refusé sans appel au chargeur', async () => {
    const count = loads.length;
    for (const bad of ['../secret', 'Home', 'a/b', '', 'fr.json', null]) {
      await assert.rejects(load(bad), TypeError, String(bad));
    }
    assert.equal(loads.length, count);
  });

  test('un échec de chargement n\'est pas mis en cache', async () => {
    let calls = 0;
    setLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('hors ligne');
      return { ok: 'Rechargé' };
    });
    try {
      await assert.rejects(load('flaky'), /hors ligne/);
      assert.equal(isLoaded('flaky'), false);
      await load('flaky');
      assert.equal(t('flaky.ok'), 'Rechargé');
    } finally {
      setLoader(async (ns) => {
        loads.push(ns);
        return readCatalog(ns);
      });
    }
  });

  test('i18n expose l\'API attendue par les vues', () => {
    for (const name of ['load', 't', 'has', 'formatDate', 'formatDateTime']) assert.equal(typeof i18n[name], 'function', name);
    assert.equal(i18n.locale, 'fr-FR');
  });
});

describe('formatDate / formatDateTime / formatNumber', () => {
  test('jour YYYY-MM-DD en toutes lettres', () => {
    assert.equal(formatDate('2026-10-31'), '31 octobre 2026');
    assert.equal(formatDate('2027-12-02'), '2 décembre 2027');
    assert.equal(formatDate('2026-08-02'), '2 août 2026');
    assert.equal(formatDate('2026-10-01'), '1er octobre 2026');
  });

  test('indépendant du fuseau horaire', () => {
    assert.equal(formatDate('2026-01-01'), '1er janvier 2026');
    assert.equal(formatDate('2026-12-31'), '31 décembre 2026');
    assert.equal(formatDate(new Date(2026, 9, 31, 23, 59)), '31 octobre 2026');
  });

  test('horodatage ISO complet : date du fuseau local (comme formatDateTime)', () => {
    const iso = '2026-09-29T23:30:00.000Z';
    const local = new Date(iso);
    assert.equal(formatDate(iso), formatDate(new Date(local.getFullYear(), local.getMonth(), local.getDate())));
    assert.equal(formatDate('2026-10-31T12:00:00'), '31 octobre 2026');
  });

  test('valeur invalide renvoyée telle quelle', () => {
    assert.equal(formatDate('2026-02-30'), '2026-02-30');
    assert.equal(formatDate('bientôt'), 'bientôt');
    assert.equal(formatDate(null), '');
    assert.equal(formatDate(new Date('x')), '');
  });

  test('horodatage', () => {
    assert.equal(formatDateTime('2026-10-31T13:05:00Z', { timeZone: 'Europe/Paris' }), '31 octobre 2026 à 14:05');
    assert.equal(formatDateTime('2026-10-01T08:00:00Z', { timeZone: 'UTC' }), '1er octobre 2026 à 08:00');
    assert.equal(formatDateTime('pas une date'), 'pas une date');
    assert.equal(formatDateTime(undefined), '');
  });

  test('nombres au format français', () => {
    assert.equal(formatNumber(1500).replace(/\s/g, ' '), '1 500');
    assert.equal(formatNumber('abc'), 'abc');
  });
});

describe('catalogues src/i18n/fr/*.json', () => {
  const files = readdirSync(I18N_DIR).filter((name) => name.endsWith('.json')).sort();

  test('noms de fichiers = espaces de noms valides', () => {
    for (const file of files) assert.match(file, /^[a-z][a-z0-9_]*\.json$/, file);
  });

  test('chaque catalogue est un objet JSON', () => {
    for (const file of files) {
      const catalog = readCatalog(file.slice(0, -5));
      assert.ok(catalog && typeof catalog === 'object' && !Array.isArray(catalog), file);
    }
  });

  test('catalogues du socle : espaces insécables avant « : ; ? ! » et dans les guillemets', () => {
    const problems = [];
    const walk = (value, path) => {
      if (typeof value === 'string') {
        if (/ [:;?!]| »|« /.test(value)) problems.push(`${path} : « ${value.slice(0, 60)} »`);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    for (const ns of ['common', 'home', 'privacy', 'not_found']) walk(readCatalog(ns), ns);
    assert.deepEqual(problems, []);
  });

  test('catalogues du socle : seulement des textes non vides (ou des formes de pluriel)', () => {
    const problems = [];
    const walk = (value, path) => {
      if (typeof value === 'string') {
        if (value.trim() === '') problems.push(`${path} : texte vide`);
        return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
        return;
      }
      problems.push(`${path} : ${Array.isArray(value) ? 'tableau' : typeof value} au lieu d'un texte`);
    };
    for (const ns of ['common', 'home', 'privacy', 'not_found']) walk(readCatalog(ns), ns);
    assert.deepEqual(problems, []);
  });

  test('common.json : libellés partagés du contrat (§5.5 d\'ARCHITECTURE.md)', () => {
    const expected = {
      'levels.ai_act.prohibited_suspected': 'Interdit suspecté',
      'levels.ai_act.high': 'Haut risque',
      'levels.ai_act.to_qualify': 'À qualifier',
      'levels.ai_act.limited': 'Risque limité',
      'levels.ai_act.minimal': 'Risque minimal',
      'levels.data.0': 'Faible',
      'levels.data.1': 'Modéré',
      'levels.data.2': 'Élevé',
      'levels.data.3': 'Critique',
      'validation.to_review': 'À valider',
      'validation.validated': 'Validé',
      'validation.to_revise': 'À revoir',
      'action_status.todo': 'À faire',
      'action_status.in_progress': 'En cours',
      'action_status.done': 'Fait',
      'action_status.rejected': 'Rejeté',
      disclaimer: 'Classification indicative, à confirmer — ceci n\'est pas un avis juridique.',
    };
    for (const [key, label] of Object.entries(expected)) assert.equal(t(`common.${key}`), label, key);
    for (const level of ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']) {
      assert.ok(has(`common.levels.ai_act_short.${level}`), level);
    }
    for (const priority of ['high', 'medium', 'low']) assert.ok(has(`common.priority.${priority}`), priority);
    const memory = t('common.storage.memory').replace(/\u00a0/g, ' ');
    assert.ok(memory.startsWith('Stockage temporaire : vos données seront perdues à la fermeture de l\'onglet'), memory);
    assert.equal(t('common.coming_soon.title'), 'Cette section arrive bientôt');
  });
});
