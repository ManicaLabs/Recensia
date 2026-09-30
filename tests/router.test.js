import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, navigate, startRouter, baseUrlFrom, CONSOLE_TABS, ROUTE_NAMES } from '../src/router.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function longPayload(length) {
  let out = '';
  while (out.length < length) out += B64;
  return out.slice(0, length);
}

describe('parseHash', () => {
  test('hash vide ou racine ⇒ accueil', () => {
    for (const hash of ['', '#', '#/', '/', undefined, null]) {
      assert.deepEqual(parseHash(hash), { name: 'home', params: {} }, String(hash));
    }
  });

  test('routes simples, avec ou sans « / » final', () => {
    for (const name of ['new', 'demo', 'privacy']) {
      assert.deepEqual(parseHash(`#/${name}`), { name, params: {} });
      assert.deepEqual(parseHash(`#/${name}/`), { name, params: {} });
    }
    assert.deepEqual(parseHash('#/admin'), { name: 'admin', params: {} });
    assert.deepEqual(parseHash('#/admin/'), { name: 'admin', params: {} });
  });

  test('sans le « # » initial', () => {
    assert.equal(parseHash('/privacy').name, 'privacy');
  });

  test('formulaire répondant : charge utile conservée telle quelle', () => {
    const payload = 'eJxLTEpOSU1TVMhIzcnJBwAi5gSu';
    assert.deepEqual(parseHash(`#/c/${payload}`), { name: 'form', params: { payload } });
    assert.deepEqual(parseHash(`#/c/${payload}/`), { name: 'form', params: { payload } });
  });

  test('formulaire : charge utile très longue, analysée rapidement', () => {
    const payload = longPayload(200_000);
    const started = performance.now();
    const route = parseHash(`#/c/${payload}`);
    const elapsed = performance.now() - started;
    assert.equal(route.name, 'form');
    assert.equal(route.params.payload.length, 200_000);
    assert.ok(elapsed < 200, `analyse trop lente : ${elapsed} ms`);
  });

  test('formulaire : séquences %XX décodées, charge vide ou caractères interdits refusés', () => {
    assert.equal(parseHash('#/c/abc%2Ddef').params.payload, 'abc-def');
    assert.equal(parseHash('#/c/abc%E0%A4%A').params.payload, 'abc%E0%A4%A'); // séquence invalide : brute
    assert.equal(parseHash('#/c/').name, 'not_found');
    assert.equal(parseHash('#/c').name, 'not_found');
    for (const bad of ['#/c/abc def', '#/c/abc<script>', '#/c/abc"x', '#/c/abc?x=1', '#/c/abc/def', '#/c/abc+def=']) {
      assert.equal(parseHash(bad).name, 'not_found', bad);
    }
  });

  test('ponctuation finale ajoutée par une messagerie : retirée (formulaire et lien d\'import)', () => {
    assert.equal(parseHash('#/c/abc_DEF-1).').params.payload, 'abc_DEF-1');
    assert.equal(parseHash('#/c/abc%29').params.payload, 'abc');
    assert.equal(parseHash('#/c/abc»').params.payload, 'abc');
    assert.deepEqual(parseHash('#/i/RCN1.aaa~RCN1.bbb.').params.codes, ['RCN1.aaa', 'RCN1.bbb']);
    assert.equal(parseHash('#/c/).').name, 'not_found');
  });

  test('lien d\'import : un ou plusieurs codes séparés par « ~ »', () => {
    const a = `RCN1.${longPayload(420)}`;
    const b = `RCN1.${longPayload(380)}`;
    assert.deepEqual(parseHash(`#/i/${a}`), { name: 'import_link', params: { payload: a, codes: [a] } });
    const route = parseHash(`#/i/${a}~${b}`);
    assert.equal(route.name, 'import_link');
    assert.deepEqual(route.params.codes, [a, b]);
    assert.deepEqual(parseHash(`#/i/${a}~~${b}~`).params.codes, [a, b]);
    assert.deepEqual(parseHash(`#/i/${a}%7E${b}`).params.codes, [a, b]);
    assert.equal(parseHash('#/i/').name, 'not_found');
    assert.equal(parseHash('#/i/~~').name, 'not_found');
    assert.equal(parseHash('#/i/RCN1.abc def').name, 'not_found');
  });

  test('lien d\'import : très nombreux codes', () => {
    const codes = Array.from({ length: 100 }, (_, i) => `RCN1.${longPayload(400 + i)}`);
    const route = parseHash(`#/i/${codes.join('~')}`);
    assert.equal(route.name, 'import_link');
    assert.equal(route.params.codes.length, 100);
  });

  test('console : identifiant et onglet', () => {
    assert.deepEqual(parseHash('#/admin/k3J9xQ2mP0aZ'), { name: 'console', params: { id: 'k3J9xQ2mP0aZ', tab: null } });
    assert.deepEqual(parseHash('#/admin/demo/registre'), { name: 'console', params: { id: 'demo', tab: 'registre' } });
    assert.deepEqual(parseHash('#/admin/k3J9xQ2mP0aZ/rapport/'), { name: 'console', params: { id: 'k3J9xQ2mP0aZ', tab: 'rapport' } });
    for (const tab of CONSOLE_TABS) assert.equal(parseHash(`#/admin/abc/${tab}`).params.tab, tab);
  });

  test('console : onglet ou identifiant invalide ⇒ introuvable', () => {
    for (const bad of ['#/admin/abc/inconnu', '#/admin/abc/registre/x', '#/admin/a.b', '#/admin/a%20b', `#/admin/${'a'.repeat(65)}`, '#/admin/abc/__proto__']) {
      assert.equal(parseHash(bad).name, 'not_found', bad);
    }
  });

  test('routes inconnues ⇒ not_found', () => {
    for (const bad of ['#/inconnu', '#/new/x', '#/privacy/x', '#app', '#privacy-audience', '#//', '#/demo?x', '#/HOME']) {
      assert.deepEqual(parseHash(bad), { name: 'not_found', params: {} }, bad);
    }
  });

  test('toutes les routes produites sont déclarées', () => {
    const produced = ['#/', '#/new', '#/c/x', '#/admin', '#/admin/x', '#/i/RCN1.x', '#/demo', '#/privacy', '#/zz'].map((h) => parseHash(h).name);
    assert.deepEqual([...new Set(produced)].sort(), [...ROUTE_NAMES].sort());
  });
});

describe('baseUrlFrom', () => {
  test('retire hash, query et nom de fichier', () => {
    assert.equal(baseUrlFrom('https://manicalabs.github.io/Recensia/#/c/abc'), 'https://manicalabs.github.io/Recensia/');
    assert.equal(baseUrlFrom('https://manicalabs.github.io/Recensia/index.html?utm=x#/admin'), 'https://manicalabs.github.io/Recensia/');
    assert.equal(baseUrlFrom('http://localhost:8765/Recensia/'), 'http://localhost:8765/Recensia/');
    assert.equal(baseUrlFrom('http://localhost:8000/'), 'http://localhost:8000/');
  });
});

describe('navigate / startRouter', () => {
  const saved = {};

  function installFakeWindow(initialHash = '') {
    const listeners = new Set();
    const location = {
      _hash: initialHash,
      get hash() { return this._hash; },
      set hash(value) {
        this._hash = value.startsWith('#') ? value : `#${value}`;
        for (const fn of listeners) fn();
      },
    };
    const history = {
      state: null,
      calls: [],
      replaceState(state, _title, url) {
        this.calls.push(url);
        location._hash = url;
      },
    };
    for (const key of ['location', 'history', 'addEventListener', 'removeEventListener']) saved[key] = globalThis[key];
    globalThis.location = location;
    globalThis.history = history;
    globalThis.addEventListener = (type, fn) => { if (type === 'hashchange') listeners.add(fn); };
    globalThis.removeEventListener = (type, fn) => { if (type === 'hashchange') listeners.delete(fn); };
    return { location, history, listeners };
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });

  test('startRouter appelle immédiatement puis à chaque changement de hash', () => {
    const win = installFakeWindow('#/privacy');
    const seen = [];
    const stop = startRouter((route) => seen.push(route.name));
    assert.deepEqual(seen, ['privacy']);
    navigate('/demo');
    assert.equal(win.location.hash, '#/demo');
    assert.deepEqual(seen, ['privacy', 'demo']);
    stop();
    assert.equal(win.listeners.size, 0);
  });

  test('navigate({ replace }) remplace l\'entrée d\'historique et notifie', () => {
    const win = installFakeWindow('#/i/RCN1.abc');
    const seen = [];
    const stop = startRouter((route) => seen.push(route));
    navigate('/admin/abc/import', { replace: true });
    assert.deepEqual(win.history.calls, ['#/admin/abc/import']);
    assert.deepEqual(seen.at(-1), { name: 'console', params: { id: 'abc', tab: 'import' } });
    stop();
  });

  test('navigate vers le hash courant ré-affiche la route', () => {
    installFakeWindow('#/new');
    const seen = [];
    const stop = startRouter((route) => seen.push(route.name));
    navigate('#/new');
    assert.deepEqual(seen, ['new', 'new']);
    stop();
  });

  test('les ancres internes (sans « #/ ») sont ignorées', () => {
    const win = installFakeWindow('#/privacy');
    const seen = [];
    const stop = startRouter((route) => seen.push(route.name));
    win.location.hash = '#app';
    assert.deepEqual(seen, ['privacy']);
    stop();
  });
});
