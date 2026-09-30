import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PATHS, ALLOWED_EVENTS, initAnalytics, trackView, trackEvent, trackRoute, pathForRoute,
  isValidCode, isLocalHost, shouldLoad, isAnalyticsEnabled, publicPath, publicTitle, SITE_PREFIX, isOptedOut, setOptOut,
} from '../src/analytics.js';
import { config } from '../config.js';
import { listFiles, readSource, lineOf } from './helpers/source-scan.js';

const PROD = { protocol: 'https:', hostname: 'manicalabs.github.io' };

function fakeEnv() {
  const scripts = [];
  const document = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        attributes: {},
        listeners: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
      };
      return el;
    },
    head: { appendChild(el) { scripts.push(el); } },
  };
  const calls = [];
  const window = {};
  const load = () => {
    window.goatcounter = { ...window.goatcounter, count: (vars) => calls.push(vars) };
    scripts.at(-1).listeners.load();
  };
  return { document, window, scripts, calls, load };
}

describe('listes blanches (CDC §11)', () => {
  test('chemins et événements exactement conformes au CDC', () => {
    assert.deepEqual([...ALLOWED_PATHS], ['/home', '/new', '/form', '/admin/registre', '/admin/actions', '/admin/rapport', '/demo', '/privacy']);
    assert.deepEqual([...ALLOWED_EVENTS], [
      'event/campaign_created', 'event/code_generated', 'event/share_link', 'event/share_code',
      'event/import_link', 'event/export_xlsx', 'event/export_csv', 'event/export_print',
    ]);
    assert.ok(Object.isFrozen(ALLOWED_PATHS) && Object.isFrozen(ALLOWED_EVENTS));
  });

  test('correspondance route ⇒ chemin fixe', () => {
    assert.equal(pathForRoute({ name: 'home', params: {} }), '/home');
    assert.equal(pathForRoute({ name: 'new', params: {} }), '/new');
    assert.equal(pathForRoute({ name: 'form', params: { payload: 'secret-payload' } }), '/form');
    assert.equal(pathForRoute({ name: 'demo', params: {} }), '/demo');
    assert.equal(pathForRoute({ name: 'privacy', params: {} }), '/privacy');
    assert.equal(pathForRoute({ name: 'console', params: { id: 'abc', tab: 'registre' } }), '/admin/registre');
    assert.equal(pathForRoute({ name: 'console', params: { id: 'abc', tab: 'actions' } }), '/admin/actions');
    assert.equal(pathForRoute({ name: 'console', params: { id: 'abc', tab: 'rapport' } }), '/admin/rapport');
    for (const tab of [null, 'tableau', 'import', 'saisir', 'diffuser', 'parametres', '__proto__', 'constructor']) {
      assert.equal(pathForRoute({ name: 'console', params: { id: 'abc', tab } }), null, String(tab));
    }
    for (const name of ['admin', 'import_link', 'not_found', 'toString', '__proto__']) {
      assert.equal(pathForRoute({ name, params: {} }), null, name);
    }
    assert.equal(pathForRoute(null), null);
  });

  test('chaque chemin produit par une route est dans la liste blanche', () => {
    const routes = ['home', 'new', 'form', 'demo', 'privacy'].map((name) => ({ name, params: {} }))
      .concat(['registre', 'actions', 'rapport'].map((tab) => ({ name: 'console', params: { id: 'x', tab } })));
    for (const route of routes) assert.ok(ALLOWED_PATHS.includes(pathForRoute(route)));
  });
});

describe('chargement du script', () => {
  test('validation du code et de l\'hôte', () => {
    assert.ok(isValidCode('recensia'));
    assert.ok(isValidCode('mon-site-2'));
    for (const bad of ['', 'Recensia', 'a b', 'a.b', 'x'.repeat(64), 'évian', null, undefined, 42]) assert.equal(isValidCode(bad), false, String(bad));
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'app.localhost', 'LOCALHOST', '']) assert.ok(isLocalHost(host), host);
    assert.equal(isLocalHost('manicalabs.github.io'), false);
    assert.equal(shouldLoad({ goatcounterCode: 'recensia' }, PROD), true);
    assert.equal(shouldLoad({ goatcounterCode: 'recensia' }, { protocol: 'http:', hostname: 'example.com' }), false);
    assert.equal(shouldLoad({ goatcounterCode: 'recensia' }, { protocol: 'file:', hostname: '' }), false);
  });

  test('code vide ⇒ aucun script, rien n\'est envoyé', () => {
    const env = fakeEnv();
    const api = initAnalytics({ goatcounterCode: '' }, PROD, env);
    assert.equal(api.enabled, false);
    assert.equal(env.scripts.length, 0);
    assert.equal(trackView('/home'), false);
    assert.equal(trackEvent('event/share_link'), false);
    assert.equal(isAnalyticsEnabled(), false);
  });

  test('code invalide ⇒ aucun script', () => {
    const env = fakeEnv();
    initAnalytics({ goatcounterCode: 'x"><img src=x>' }, PROD, env);
    assert.equal(env.scripts.length, 0);
  });

  test('en local (localhost, 127.0.0.1, [::1]) ⇒ aucun script, rien n\'est envoyé', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      for (const protocol of ['http:', 'https:']) {
        const env = fakeEnv();
        const api = initAnalytics({ goatcounterCode: 'recensia' }, { protocol, hostname }, env);
        assert.equal(api.enabled, false, hostname);
        assert.equal(env.scripts.length, 0, hostname);
        assert.equal(trackView('/home'), false);
        assert.equal(env.calls.length, 0);
      }
    }
  });

  test('production : script GoatCounter configuré sans envoi automatique', () => {
    const env = fakeEnv();
    const api = initAnalytics({ goatcounterCode: 'recensia' }, PROD, env);
    assert.equal(api.enabled, true);
    assert.equal(env.scripts.length, 1);
    const [script] = env.scripts;
    assert.equal(script.tagName, 'SCRIPT');
    assert.equal(script.src, 'https://gc.zgo.at/count.v5.js');
    assert.match(script.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
    assert.equal(script.crossOrigin, 'anonymous');
    assert.equal(script.async, true);
    assert.equal(script.attributes['data-goatcounter'], 'https://recensia.goatcounter.com/count');
    assert.deepEqual(JSON.parse(script.attributes['data-goatcounter-settings']), { no_onload: true });
    assert.equal(env.window.goatcounter.no_onload, true);
  });

  test('file d\'attente jusqu\'au chargement, puis appels sans aucune donnée', () => {
    const env = fakeEnv();
    initAnalytics({ goatcounterCode: 'recensia' }, PROD, env);
    assert.equal(trackView('/home'), true);
    assert.equal(trackEvent('event/code_generated'), true);
    assert.equal(env.calls.length, 0);
    env.load();
    assert.deepEqual(env.calls, [
      { path: '/recensia/home', title: 'Recensia · Accueil', referrer: '', event: false },
      { path: 'recensia/event/code_generated', title: 'Recensia · Code de réponse généré', referrer: '', event: true },
    ]);
    assert.equal(trackRoute({ name: 'console', params: { id: 'k3J9xQ2mP0aZ', tab: 'rapport' } }), true);
    assert.deepEqual(env.calls.at(-1), { path: '/recensia/admin/rapport', title: 'Recensia · Console : rapport', referrer: '', event: false });
    assert.equal(trackRoute({ name: 'form', params: { payload: 'contenu-du-lien' } }), true);
    assert.deepEqual(env.calls.at(-1), { path: '/recensia/form', title: 'Recensia · Formulaire répondant', referrer: '', event: false });
    for (const call of env.calls) assert.deepEqual(Object.keys(call).sort(), ['event', 'path', 'referrer', 'title']);
  });

  test('refus de tout chemin ou événement hors liste', () => {
    const env = fakeEnv();
    initAnalytics({ goatcounterCode: 'recensia' }, PROD, env);
    env.load();
    const rejectedPaths = ['/admin', '/admin/k3J9xQ2mP0aZ/registre', '/c/eJxLTEpOSU1T', '/form?x=1', '/home/', 'home', '', null, undefined, {}, '/i/RCN1.abc'];
    for (const path of rejectedPaths) assert.equal(trackView(path), false, String(path));
    const rejectedEvents = ['event/other', 'event/share_link?id=1', 'event/campaign_created/abc', '/home', '', null];
    for (const name of rejectedEvents) assert.equal(trackEvent(name), false, String(name));
    assert.equal(trackView('event/share_link'), false);
    assert.equal(trackEvent('/home'), false);
    assert.equal(trackRoute({ name: 'import_link', params: { codes: ['RCN1.abc'] } }), false);
    assert.equal(trackRoute({ name: 'console', params: { id: 'abc', tab: 'import' } }), false);
    assert.equal(env.calls.length, 0);
  });

  test('échec du chargement (bloqueur, hors ligne) : silencieux et désactivé', () => {
    const env = fakeEnv();
    initAnalytics({ goatcounterCode: 'recensia' }, PROD, env);
    trackView('/home');
    env.scripts[0].listeners.error();
    assert.equal(isAnalyticsEnabled(), false);
    assert.equal(trackView('/demo'), false);
    assert.doesNotThrow(() => env.load());
    assert.equal(env.calls.length, 0);
  });

  test('une exception de goatcounter.count ne remonte jamais', () => {
    const env = fakeEnv();
    initAnalytics({ goatcounterCode: 'recensia' }, PROD, env);
    env.load();
    env.window.goatcounter.count = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => trackView('/privacy'));
  });

  test('création du script impossible ⇒ désactivé sans erreur', () => {
    const env = fakeEnv();
    env.document.createElement = () => { throw new Error('bloqué'); };
    const api = initAnalytics({ goatcounterCode: 'recensia' }, PROD, env);
    assert.equal(api.enabled, false);
    assert.equal(isAnalyticsEnabled(), false);
    assert.equal(trackView('/home'), false);
  });
});

describe('analyse statique de src/', () => {
  const files = listFiles('src', ['.js', '.mjs']);
  const CALL_RE = /\b(track\s*\??\.\s*(view|event)|trackView|trackEvent)\s*(?:\?\.)?\s*\(/g;

  // Appels de mesure d'un source → { calls, problems } (argument littéral de la liste blanche exigé).
  function scanTrackCalls(file, text) {
    const problems = [];
    let calls = 0;
    CALL_RE.lastIndex = 0;
    let match;
    while ((match = CALL_RE.exec(text))) {
      const before = text.slice(Math.max(0, match.index - 20), match.index);
      if (/function\s*\*?\s*$/.test(before)) continue; // déclaration, pas un appel
      calls += 1;
      const kind = match[2] ?? (match[1] === 'trackView' ? 'view' : 'event');
      const rest = text.slice(match.index + match[0].length);
      const literal = /^\s*(['"])([^'"\\\n]*)\1\s*[,)]/.exec(rest);
      const where = `${file}:${lineOf(text, match.index)}`;
      if (!literal) {
        problems.push(`${where} : argument non littéral`);
        continue;
      }
      const allowed = kind === 'view' ? ALLOWED_PATHS : ALLOWED_EVENTS;
      if (!allowed.includes(literal[2])) problems.push(`${where} : « ${literal[2]} » hors liste blanche`);
    }
    return { calls, problems };
  }

  test('l\'analyse repère les appels non conformes (auto-contrôle)', () => {
    const ok = scanTrackCalls('x.js', "ctx.track.view('/home'); track.event(\"event/share_link\"); ctx.track?.event('event/export_csv');");
    assert.deepEqual(ok, { calls: 3, problems: [] });
    const bad = scanTrackCalls('x.js', [
      'ctx.track.view(`/admin/${id}`);',
      "track.event('event/share_link?id=' + id);",
      "trackView('/c/' + payload);",
      "trackEvent('event/inconnu');",
      "ctx.track.view('event/share_link');",
    ].join('\n'));
    assert.equal(bad.calls, 5);
    assert.equal(bad.problems.length, 5, bad.problems.join('\n'));
    assert.deepEqual(scanTrackCalls('x.js', 'export function trackView(path) {}').calls, 0);
  });

  test('chaque appel de mesure reçoit un littéral de la liste blanche', () => {
    const problems = files.flatMap((file) => scanTrackCalls(file, readSource(file)).problems);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('aucun appel direct à goatcounter.count ni script GoatCounter hors de src/analytics.js', () => {
    const problems = [];
    for (const file of files) {
      if (file === 'src/analytics.js') continue;
      const text = readSource(file);
      const count = /\bgoatcounter\s*(?:\?\.|\.)\s*count\b|\bgoatcounter\s*\[\s*['"`]count['"`]\s*\]/i.exec(text);
      if (count) problems.push(`${file}:${lineOf(text, count.index)} : appel direct à goatcounter.count`);
      const host = /gc\.zgo\.at|goatcounter\.com/i.exec(text);
      if (host) problems.push(`${file}:${lineOf(text, host.index)} : référence au script GoatCounter`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('src/analytics.js n\'envoie ni URL, ni titre de page, ni référent', () => {
    const text = readSource('src/analytics.js');
    assert.doesNotMatch(text, /location\s*\.\s*(href|hash|search|pathname)/);
    assert.doesNotMatch(text, /document\s*\.\s*(title|referrer|URL)/);
    assert.match(text, /referrer:\s*''/);
    assert.match(text, /no_onload/);
  });
});

describe('compte partagé « manica » : Recensia se distingue par son préfixe', () => {
  test('tout chemin envoyé commence par « recensia », tout titre par « Recensia · »', () => {
    assert.equal(SITE_PREFIX, 'recensia');
    for (const path of ALLOWED_PATHS) {
      assert.equal(publicPath(path), `/recensia${path}`);
      assert.match(publicTitle(path), /^Recensia · \S/);
    }
    for (const name of ALLOWED_EVENTS) {
      assert.equal(publicPath(name), `recensia/${name}`);
      assert.match(publicTitle(name), /^Recensia · \S/);
    }
    const titles = [...ALLOWED_PATHS, ...ALLOWED_EVENTS].map(publicTitle);
    assert.equal(new Set(titles).size, titles.length, 'titres distincts');
  });

  test('config.js : compte manica, présent dans la CSP d\'index.html et de 404.html', () => {
    assert.equal(config.goatcounterCode, 'manica');
    assert.equal(isValidCode(config.goatcounterCode), true);
    for (const file of ['index.html', '404.html']) {
      const csp = /Content-Security-Policy" content="([^"]*)"/.exec(readSource(file))?.[1] ?? '';
      const host = `https://${config.goatcounterCode}.goatcounter.com`;
      assert.match(csp, new RegExp(`connect-src [^;]*${host.replace(/[.]/g, '\\.')}`), `${file} connect-src`);
      assert.match(csp, new RegExp(`img-src [^;]*${host.replace(/[.]/g, '\\.')}`), `${file} img-src`);
    }
  });
});

describe('refus de la mesure (clé skipgc, commune aux outils Manica)', () => {
  function withStorage(storage, fn) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { if (!storage) throw new Error('bloqué'); return storage; } });
    try { return fn(); } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
      else delete globalThis.localStorage;
    }
  }
  const memoryStorage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  };

  test('refus mémorisé : aucun script chargé, aucun envoi', () => withStorage(memoryStorage(), () => {
    assert.equal(isOptedOut(), false);
    assert.equal(setOptOut(true), true);
    assert.equal(globalThis.localStorage.getItem('skipgc'), 't');
    assert.equal(isOptedOut(), true);
    const env = fakeEnv();
    const api = initAnalytics({ goatcounterCode: 'manica' }, PROD, env);
    assert.equal(api.enabled, false);
    assert.equal(env.scripts.length, 0);
    assert.equal(trackView('/home'), false);
    assert.equal(setOptOut(false), true);
    assert.equal(globalThis.localStorage.getItem('skipgc'), null);
  }));

  test('refus exprimé pendant la visite : envois arrêtés immédiatement', () => withStorage(memoryStorage(), () => {
    const env = fakeEnv();
    initAnalytics({ goatcounterCode: 'manica' }, PROD, env);
    env.load();
    assert.equal(trackView('/home'), true);
    setOptOut(true);
    assert.equal(trackView('/privacy'), false);
    assert.equal(env.calls.length, 1);
  }));

  test('stockage bloqué : null, jamais d\'exception', () => withStorage(null, () => {
    assert.equal(isOptedOut(), null);
    assert.equal(setOptOut(true), false);
  }));
});
