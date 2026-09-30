// Console d'une campagne (src/views/console.js) : compteurs des onglets explicites (à l'écran et
// pour les lecteurs d'écran) et largeur de page alignée sur l'en-tête du site.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { register, t } from '../src/i18n.js';
import { tabCounter, tabsNav } from '../src/views/console.js';
import { installFakeDocument } from './helpers/fake-dom.js';
import { readJson, readSource } from './helpers/source-scan.js';

function walk(node, out = []) {
  if (!node || node.nodeType !== 1) return out;
  out.push(node);
  for (const child of node.childNodes) walk(child, out);
  return out;
}
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const hasClass = (node, cls) => classes(node).includes(cls);
const model = (groups, suggestions) => ({
  groups: Array.from({ length: groups }, (_, i) => ({ id: `U-${i}` })),
  suggestions: Array.from({ length: suggestions }, (_, i) => ({ template_id: `ACT-${i}` })),
});

describe('tabCounter : ce que compte chaque onglet', () => {
  test('registre : usages recensés, style neutre', () => {
    assert.deepEqual(tabCounter('registre', model(10, 19)), { count: 10, key: 'console.tabs.count_registry', attention: false });
  });

  test('plan d\'actions : suggestions en attente, badge d\'attention', () => {
    assert.deepEqual(tabCounter('actions', model(10, 19)), { count: 19, key: 'console.tabs.count_suggestions', attention: true });
  });

  test('aucun compteur à zéro, pour les autres onglets ou sans modèle', () => {
    assert.equal(tabCounter('registre', model(0, 3)), null);
    assert.equal(tabCounter('actions', model(4, 0)), null);
    for (const id of ['tableau', 'import', 'saisir', 'diffuser', 'rapport', 'parametres']) {
      assert.equal(tabCounter(id, model(10, 19)), null, id);
    }
    assert.equal(tabCounter('registre', {}), null);
    assert.equal(tabCounter('actions', undefined), null);
  });
});

describe('tabsNav : compteurs lisibles', () => {
  let dom;
  before(() => {
    dom = installFakeDocument();
    register('console', readJson('src/i18n/fr/console.json'));
  });
  after(() => dom.restore());

  const linkOf = (nav, id) => walk(nav).find((n) => n.localName === 'a' && n.getAttribute('href') === `#/admin/demo/${id}`);
  const countOf = (link) => walk(link).find((n) => hasClass(n, 'tab-count')) ?? null;

  test('nombre visible masqué aux lecteurs d\'écran, phrase complète en texte masqué et en infobulle', () => {
    const nav = tabsNav({ id: 'demo' }, 'tableau', model(10, 19), t);

    const registry = countOf(linkOf(nav, 'registre'));
    assert.ok(registry, 'compteur du registre');
    assert.equal(hasClass(registry, 'tab-count-attention'), false);
    assert.equal(registry.getAttribute('title'), '10 usages recensés');
    const [regVisible, regHidden] = registry.children;
    assert.equal(regVisible.getAttribute('aria-hidden'), 'true');
    assert.equal(regVisible.textContent, '10');
    assert.ok(hasClass(regHidden, 'visually-hidden'));
    assert.match(regHidden.textContent, /^ \(10 usages recensés\)$/);

    const actions = countOf(linkOf(nav, 'actions'));
    assert.ok(hasClass(actions, 'tab-count-attention'), 'badge d\'attention');
    assert.equal(actions.getAttribute('title'), '19 suggestions en attente');
    assert.equal(actions.children[0].textContent, '19');
    assert.equal(linkOf(nav, 'actions').textContent, 'Plan d\'actions19 (19 suggestions en attente)');
  });

  test('singulier et absence de compteur', () => {
    const nav = tabsNav({ id: 'demo' }, 'actions', model(1, 1), t);
    assert.equal(countOf(linkOf(nav, 'registre')).getAttribute('title'), '1 usage recensé');
    assert.equal(countOf(linkOf(nav, 'actions')).getAttribute('title'), '1 suggestion en attente');
    assert.equal(linkOf(nav, 'actions').getAttribute('aria-current'), 'page');

    const empty = tabsNav({ id: 'demo' }, 'tableau', model(0, 0), t);
    assert.equal(walk(empty).some((n) => hasClass(n, 'tab-count')), false);
  });
});

test('la console garde la largeur de l\'en-tête du site (pas de page-wide)', () => {
  const src = readSource('src/views/console.js');
  assert.doesNotMatch(src, /page-wide/);
  assert.match(src, /class: 'page console'/);
});
