// Composants partagés (src/ui/components.js) : axe des badges de niveau, notifications, dialogues.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './helpers/fake-dom.js';
import { register } from '../src/i18n.js';
import {
  levelBadge, toast, toastTimeout, toastsToEvict, toastLimit, confirmDialog, modal, TOAST_LIMIT, TOAST_LIMIT_NARROW,
} from '../src/ui/components.js';

const common = JSON.parse(readFileSync(new URL('../src/i18n/fr/common.json', import.meta.url), 'utf8'));
register('common', common);
const NB = ' ';

function byClass(node, cls, out = []) {
  for (const child of node.childNodes ?? []) {
    if ((child.getAttribute?.('class') ?? '').split(' ').includes(cls)) out.push(child);
    byClass(child, cls, out);
  }
  return out;
}

// Texte lu par un lecteur d'écran : nœuds aria-hidden exclus, texte masqué visuellement inclus.
function spokenText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.getAttribute?.('aria-hidden') === 'true') return '';
  return (node.childNodes ?? []).map(spokenText).join('');
}

describe('levelBadge : axe exposé en texte (WCAG 1.3.1, 1.4.1)', () => {
  let fake;
  before(() => { fake = installFakeDocument(); });
  after(() => fake.restore());

  test('par défaut : préfixe masqué visuellement, lu par les lecteurs d\'écran', () => {
    const ai = levelBadge('ai_act', 'prohibited_suspected');
    assert.equal(spokenText(ai), `AI Act${NB}: Interdit suspecté`);
    const [prefix] = byClass(ai, 'visually-hidden');
    assert.equal(prefix.textContent, `AI Act${NB}: `);
    assert.equal(ai.getAttribute('data-level'), 'prohibited_suspected');
    assert.match(ai.getAttribute('class'), /\bbadge-aia-prohibited_suspected\b/);

    const data = levelBadge('data', 3);
    assert.equal(spokenText(data), `Exposition des données${NB}: Critique`);
    assert.equal(levelBadge('data', '2').getAttribute('data-level'), '2');
  });

  test('axisLabel « visible » : préfixe affiché ; « none » : niveau seul', () => {
    const visible = levelBadge('ai_act', 'high', undefined, { axisLabel: 'visible' });
    assert.equal(byClass(visible, 'badge-axis').length, 1);
    assert.equal(byClass(visible, 'visually-hidden').length, 0);
    assert.equal(spokenText(visible), `AI Act${NB}: Haut risque`);

    const none = levelBadge('data', 1, undefined, { axisLabel: 'none' });
    assert.equal(none.textContent, 'Modéré');
    assert.equal(levelBadge('ai_act', 'minimal', undefined, { axisLabel: 'none' }).textContent, 'Risque minimal');
  });

  test('libellé court : affiché court, lu en entier', () => {
    const badge = levelBadge('ai_act', 'high', undefined, { short: true });
    assert.equal(badge.getAttribute('title'), 'Haut risque');
    assert.equal(spokenText(badge), `AI Act${NB}: Haut risque`);
    const shown = badge.childNodes.find((n) => n.getAttribute?.('aria-hidden') === 'true');
    assert.equal(shown.textContent, 'Haut');
    assert.equal(spokenText(levelBadge('ai_act', 'high', undefined, { short: true, axisLabel: 'none' })), 'Haut risque');
  });

  test('niveau inconnu : badge neutre, axe conservé ; axe inconnu : aucun préfixe', () => {
    assert.equal(spokenText(levelBadge('data', null)), `Exposition des données${NB}: —`);
    assert.equal(levelBadge('data', 9, undefined, { axisLabel: 'none' }).textContent, '9');
    assert.equal(levelBadge('autre', 'x').textContent, 'x');
    assert.equal(spokenText(levelBadge('ai_act', 'high', undefined, { axisLabel: 'n\'importe quoi' })), `AI Act${NB}: Haut risque`);
  });
});

describe('notifications : durée, nombre, erreurs persistantes', () => {
  test('danger et warn restent jusqu\'à leur fermeture ; info et success s\'effacent', () => {
    assert.equal(toastTimeout('danger'), null);
    assert.equal(toastTimeout('error'), null);
    assert.equal(toastTimeout('warn'), null);
    assert.equal(toastTimeout('warning'), null);
    assert.equal(toastTimeout('success'), 5000);
    assert.equal(toastTimeout('info'), 5000);
    assert.equal(toastTimeout('inconnu'), 5000);
  });

  test('timeout explicite : délai imposé, 0 ou null ⇒ jusqu\'à la fermeture', () => {
    assert.equal(toastTimeout('danger', 3000), 3000);
    assert.equal(toastTimeout('info', 0), null);
    assert.equal(toastTimeout('info', null), null);
    assert.equal(toastTimeout('info', Infinity), null);
  });

  test('limite : 2 sur écran étroit, 4 sinon', () => {
    assert.equal(toastLimit({ matchMedia: () => ({ matches: true }) }), TOAST_LIMIT_NARROW);
    assert.equal(toastLimit({ matchMedia: () => ({ matches: false }) }), TOAST_LIMIT);
    assert.equal(toastLimit({}), TOAST_LIMIT);
    assert.equal(toastLimit({ matchMedia: () => { throw new Error('x'); } }), TOAST_LIMIT);
    assert.ok(TOAST_LIMIT_NARROW <= 2);
  });

  test('éviction : les plus anciennes passagères d\'abord, jamais la dernière arrivée', () => {
    const p = (persistent) => ({ persistent });
    assert.deepEqual(toastsToEvict([p(false), p(false)], 2), []);
    assert.deepEqual(toastsToEvict([p(false), p(false), p(false)], 2), [0]);
    assert.deepEqual(toastsToEvict([p(true), p(false), p(false)], 2), [1]);
    assert.deepEqual(toastsToEvict([p(true), p(true), p(false)], 2), [0]);
    assert.deepEqual(toastsToEvict([p(false), p(true), p(false), p(false), p(true)], 2), [0, 2, 3]);
    assert.deepEqual(toastsToEvict([p(true), p(true)], 1), [0]);
    assert.deepEqual(toastsToEvict([p(false)], 0), []);
  });

  describe('toast() (faux DOM)', () => {
    let fake;
    let container;
    let timers;
    let realSetTimeout;
    let realClearTimeout;
    beforeEach(() => {
      fake = installFakeDocument();
      container = null;
      fake.document.getElementById = (id) => (id === 'toasts' ? container : null);
      const append = fake.document.body.appendChild.bind(fake.document.body);
      fake.document.body.appendChild = (node) => {
        if (node.getAttribute?.('id') === 'toasts') container = node;
        return append(node);
      };
      timers = [];
      realSetTimeout = globalThis.setTimeout;
      realClearTimeout = globalThis.clearTimeout;
      globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
      globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
    });
    afterEach(() => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      fake.restore();
    });

    test('erreur : aucun minuteur ; succès : effacé après 5 s', () => {
      toast('Enregistrement impossible.', 'danger');
      assert.equal(timers.length, 0);
      assert.equal(container.children.length, 1);
      assert.equal(container.children[0].getAttribute('data-persistent'), 'true');
      toast('Enregistré.', 'success');
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, 5000);
      timers[0].fn();
      assert.equal(container.children.length, 1);
      assert.match(container.children[0].getAttribute('class'), /toast-danger/);
    });

    test('bouton Fermer étiqueté et fonction de fermeture renvoyée', () => {
      const dismiss = toast('Copie impossible.', 'warn');
      const close = byClass(container, 'toast-close')[0];
      assert.equal(close.getAttribute('aria-label'), 'Fermer la notification');
      dismiss();
      assert.equal(container.children.length, 0);
      dismiss();
    });
  });
});

describe('dialogues : message relié (aria-describedby)', () => {
  let fake;
  beforeEach(() => {
    fake = installFakeDocument();
    const create = fake.document.createElement;
    fake.document.createElement = (tag) => {
      const el = create(tag);
      el.querySelector = () => null;
      if (tag === 'dialog') {
        el.open = false;
        el.showModal = () => { el.open = true; };
        el.close = () => { el.open = false; };
      }
      return el;
    };
    fake.document.activeElement = null;
  });
  afterEach(() => fake.restore());

  const openDialog = () => fake.document.body.children.find((n) => n.tagName === 'DIALOG');
  const contentOf = (dialog) => byClass(dialog, 'modal-content')[0];

  test('confirmDialog : aria-describedby vers le message ; alertdialog si danger', async () => {
    const pending = confirmDialog({ title: 'Reporter la sauvegarde ?', message: 'Sans fichier de récupération, une clé perdue rend les données illisibles.', danger: true });
    const dialog = openDialog();
    const described = dialog.getAttribute('aria-describedby');
    assert.ok(described);
    assert.equal(contentOf(dialog).getAttribute('id'), described);
    assert.match(contentOf(dialog).textContent, /clé perdue/);
    assert.equal(dialog.getAttribute('role'), 'alertdialog');
    assert.ok(dialog.getAttribute('aria-labelledby'));
    dialog.dispatch('close');
    assert.equal(await pending, false);
  });

  test('confirmDialog sans danger : dialogue ordinaire, message relié', async () => {
    const pending = confirmDialog({ title: 'Continuer ?', message: 'Texte.' });
    const dialog = openDialog();
    assert.equal(dialog.getAttribute('role'), null);
    assert.ok(dialog.getAttribute('aria-describedby'));
    dialog.dispatch('close');
    await pending;
  });

  test('modal({ describe: nœud }) : seul l\'avertissement est relié (dialogue avec formulaire)', async () => {
    const warning = fake.document.createElement('p');
    warning.textContent = 'Action définitive.';
    const pending = modal({ title: 'Supprimer la campagne ?', content: [warning, 'champ'], describe: warning, alert: true });
    const dialog = openDialog();
    assert.ok(warning.getAttribute('id'));
    assert.equal(dialog.getAttribute('aria-describedby'), warning.getAttribute('id'));
    assert.equal(contentOf(dialog).getAttribute('id'), null);
    assert.equal(dialog.getAttribute('role'), 'alertdialog');
    dialog.dispatch('close');
    await pending;
  });

  test('modal() : pas de description par défaut (formulaires)', async () => {
    const pending = modal({ title: 'Modifier', content: 'Formulaire' });
    const dialog = openDialog();
    assert.equal(dialog.getAttribute('aria-describedby'), null);
    assert.equal(contentOf(dialog).getAttribute('id'), null);
    dialog.dispatch('close');
    assert.equal(await pending, null);
  });
});
