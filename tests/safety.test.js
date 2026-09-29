// Invariants de sécurité du socle : interdits dans src/, CSP d'index.html, h() sûr,
// service worker et précache. Les analyses statiques ignorent les commentaires.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { listFiles, readSource } from './helpers/source-scan.js';
import { installFakeDocument } from './helpers/fake-dom.js';
import {
  stripJsComments, findForbiddenCode, findThirdPartyUrls, findI18nKeys, parseHtml, findSecrets, isForbiddenFile,
} from '../tools/check.mjs';
import { buildPrecache, listPrecacheFiles } from '../tools/precache.mjs';

const CSP = "default-src 'self'; script-src 'self' https://gc.zgo.at; connect-src 'self' https://*.goatcounter.com; "
  + "img-src 'self' data: blob: https://*.goatcounter.com; style-src 'self'; font-src 'self'; object-src 'none'; "
  + "base-uri 'self'; form-action 'none'; manifest-src 'self'; worker-src 'self'";

const SRC_JS = listFiles('src', ['.js', '.mjs']);

function scan(patterns, { allow = () => false } = {}) {
  const problems = [];
  for (const file of SRC_JS) {
    if (allow(file)) continue;
    const code = stripJsComments(readSource(file));
    for (const [label, re] of patterns) {
      const match = re.exec(code);
      if (match) problems.push(`${file}:${code.slice(0, match.index).split('\n').length} : ${label}`);
    }
  }
  return problems;
}

describe('interdits dans src/ (commentaires exclus)', () => {
  test('aucun HTML interprété, eval, Function ni style inline', () => {
    const problems = scan([
      ['innerHTML', /\binnerHTML\b/],
      ['outerHTML', /\bouterHTML\b/],
      ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
      ['document.write', /\bdocument\s*\.\s*write(?:ln)?\b/],
      ['eval(', /\beval\s*\(/],
      ['new Function', /\bnew\s+Function\b/],
      ["setAttribute('style'", /\.setAttribute\s*\(\s*['"`]style['"`]/],
      ['createContextualFragment', /\bcreateContextualFragment\b/],
      ['DOMParser', /\bDOMParser\b/],
      ['setTimeout/setInterval avec une chaîne', /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
    ]);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('fetch( uniquement dans src/data.js et src/i18n.js', () => {
    const problems = scan([['fetch(', /\bfetch\s*\(/]], { allow: (file) => ['src/data.js', 'src/i18n.js'].includes(file) });
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('aucun autre moyen de requête réseau', () => {
    const problems = scan([
      ['XMLHttpRequest', /\bXMLHttpRequest\b/],
      ['sendBeacon', /\bsendBeacon\b/],
      ['WebSocket', /\bWebSocket\b/],
      ['EventSource', /\bEventSource\b/],
      ['import() distant', /\bimport\s*\(\s*['"`]https?:/],
    ]);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('aucune URL tierce hors liste autorisée', () => {
    const problems = [];
    for (const file of listFiles('src', ['.js', '.mjs', '.css', '.json', '.html'])) {
      for (const p of findThirdPartyUrls(file, readSource(file))) problems.push(`${file}:${p.line} : ${p.url}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('stockage du navigateur : seulement via safe-storage.js (et IndexedDB dans src/storage/)', () => {
    const web = scan([['localStorage/sessionStorage', /\b(?:localStorage|sessionStorage)\b/]], {
      allow: (file) => file === 'src/ui/safe-storage.js',
    });
    const idb = scan([['indexedDB', /\bindexedDB\b/]], { allow: (file) => file.startsWith('src/storage/') });
    assert.deepEqual([...web, ...idb], []);
  });

  test('src/analytics.js est le seul à connaître GoatCounter', () => {
    const problems = scan([['GoatCounter', /gc\.zgo\.at|goatcounter\.com|\bgoatcounter\s*\.\s*count\b/i]], {
      allow: (file) => file === 'src/analytics.js',
    });
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('aucune feuille de style avec @import distant ni url() tierce', () => {
    const problems = [];
    for (const file of listFiles('src', ['.css'])) {
      const css = readSource(file).replace(/\/\*[\s\S]*?\*\//g, '');
      if (/@import\s+(?:url\()?\s*['"]?https?:/i.test(css)) problems.push(`${file} : @import distant`);
      if (/url\(\s*['"]?https?:/i.test(css)) problems.push(`${file} : url() distante`);
      if (/expression\s*\(|javascript:/i.test(css)) problems.push(`${file} : expression exécutable`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('outils d\'analyse (tools/check.mjs)', () => {
  test('stripJsComments : commentaires retirés, chaînes, gabarits et regex préservés', () => {
    assert.equal(stripJsComments("a(); // x.innerHTML = y").trimEnd(), 'a();');
    const block = stripJsComments('a(); /* innerHTML\n */ b();');
    assert.equal(block.replace(/ +/g, ' '), 'a(); \n b();');
    assert.equal(block.length, 'a(); /* innerHTML\n */ b();'.length, 'positions conservées');
    assert.equal(stripJsComments("const u = 'https://exemple.fr/a'; // c").trimEnd(), "const u = 'https://exemple.fr/a';");
    assert.equal(stripJsComments('const r = /\\/\\//g; // c').trimEnd(), 'const r = /\\/\\//g;');
    assert.equal(stripJsComments('return /[/]x/.test(s) // c').trimEnd(), 'return /[/]x/.test(s)');
    const template = 'const t = `a ${b ? `// pas un commentaire` : "c"} d // toujours du texte`;';
    assert.equal(stripJsComments(template), template);
    assert.equal(stripJsComments('x = a / b / c; // fin').trimEnd(), 'x = a / b / c;');
  });

  test('findForbiddenCode signale le code, pas les commentaires', () => {
    assert.deepEqual(findForbiddenCode('src/x.js', '// jamais innerHTML\nconst ok = 1;'), []);
    assert.deepEqual(findForbiddenCode('src/x.js', 'el.innerHTML = s;').map((p) => p.label), ['innerHTML']);
    assert.deepEqual(findForbiddenCode('src/x.js', "el.setAttribute('style', 'x')").map((p) => p.label), ["setAttribute('style'"]);
    assert.deepEqual(findForbiddenCode('src/x.js', 'fetch(url)').map((p) => p.line), [1]);
    assert.deepEqual(findForbiddenCode('src/data.js', 'fetch(url)'), []);
  });

  test('findThirdPartyUrls : listes autorisées par dossier', () => {
    assert.equal(findThirdPartyUrls('src/views/a.js', "const u = 'https://tiers.example.net.evil.io/x';").length, 1);
    assert.equal(findThirdPartyUrls('src/views/a.js', '// https://tiers.io/ en commentaire').length, 0);
    assert.equal(findThirdPartyUrls('src/analytics.js', "'https://gc.zgo.at/count.js'").length, 0);
    assert.equal(findThirdPartyUrls('src/views/a.js', "'https://gc.zgo.at/count.js'").length, 1);
    assert.equal(findThirdPartyUrls('src/share/urls.js', "'https://wa.me/?text='").length, 0);
    assert.equal(findThirdPartyUrls('src/ui/dom.js', "'http://www.w3.org/2000/svg'").length, 0);
  });

  test('findI18nKeys : clés littérales hors commentaires', () => {
    const keys = findI18nKeys('src/x.js', "t('home.title'); ctx.t(\"common.nav.home\", { a }); // t('x.y')\nt(`dyn.${k}`)");
    assert.deepEqual(keys.map((k) => k.key), ['home.title', 'common.nav.home']);
  });

  test('findI18nKeys : alias translate() / tr() et gabarit sans interpolation', () => {
    const keys = findI18nKeys('src/x.js', "translate('common.a'); tr(\"common.b\"); t(`common.c`); start('common.d'); attr('common.e')");
    assert.deepEqual(keys.map((k) => k.key), ['common.a', 'common.b', 'common.c']);
  });

  test('parseHtml repère attributs et contenu des scripts', () => {
    const tags = parseHtml('<div id="a" style="x"><script src="s.js"></script><script>alert(1)</script></div>');
    assert.equal(tags[0].attrs.get('style'), 'x');
    assert.equal(tags.filter((tag) => tag.name === 'script' && !tag.closing)[1].content, 'alert(1)');
    assert.deepEqual(tags.malformed, []);
  });

  test('parseHtml relève les balises de syntaxe inhabituelle (on*= ne peut pas passer inaperçu)', () => {
    for (const html of ['<img/src="x"/onerror="alert(1)">', '<p a="1"onclick="y">x</p>', '<img src=x alt="a"onerror="b">']) {
      const { malformed } = parseHtml(`<div>${html}</div>`);
      assert.equal(malformed.length >= 1, true, html);
    }
    assert.deepEqual(parseHtml('<p>a < b, <br/> et <img src="x" alt=""></p><script>if (a<b) x();</script>').malformed, []);
  });

  test('findSecrets : jetons connus et affectations littérales, y compris composées', () => {
    // Les valeurs pièges sont assemblées à l'exécution : ce fichier ne contient aucun motif de secret.
    const labels = (text, file = 'src/x.js') => findSecrets(file, text).map((p) => p.label);
    const fake = (...parts) => parts.join('');
    assert.equal(labels(fake("const t = '", 'ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', "';")).length, 1);
    assert.equal(labels(fake('-----BEGIN EC ', 'PRIVATE KEY-----')).length, 1);
    for (const [name, value] of [
      ['const apiToken = ', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqR'],
      ['const secretKey = ', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'],
      ['DB_PASSWORD: ', 'Qw3rTy8UiOp2AsDf5GhJk'],
    ]) assert.equal(labels(fake(name, "'", value, "';")).length, 1, name);
    assert.deepEqual(labels(fake("const exampleToken = '", 'example-token-000000000000', "';")), []);
    assert.deepEqual(labels("const tokenPrefix = 'recensia';"), []);
    const jwk = fake('{ ', 'd', ": '", 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456', "' }");
    assert.equal(labels(jwk).length, 1);
    assert.deepEqual(labels(jwk, 'tests/vectors/keys.json'), []);
    for (const file of ['a.rcn', 'x/b.recensia-key', 'recensia-sauvegarde-2026-09-29.json']) assert.ok(isForbiddenFile(file), file);
    assert.equal(isForbiddenFile('data/rules.json'), false);
  });
});

describe('index.html', () => {
  const html = readSource('index.html');
  const tags = parseHtml(html);

  test('CSP exacte en <meta>', () => {
    const meta = tags.find((tag) => tag.name === 'meta' && tag.attrs.get('http-equiv') === 'Content-Security-Policy');
    assert.ok(meta, 'CSP absente');
    assert.equal(meta.attrs.get('content'), CSP);
  });

  test('aucun style ni script inline, aucun gestionnaire on*=', () => {
    for (const tag of tags) {
      if (tag.closing) continue;
      assert.notEqual(tag.name, 'style', `<style> ligne ${tag.line}`);
      assert.equal(tag.attrs.has('style'), false, `style= ligne ${tag.line}`);
      for (const name of tag.attrs.keys()) assert.doesNotMatch(name, /^on/, `${name}= ligne ${tag.line}`);
      if (tag.name === 'script') assert.equal(tag.content.trim(), '', `script inline ligne ${tag.line}`);
    }
  });

  test('un seul script : le module src/app.js', () => {
    const scripts = tags.filter((tag) => tag.name === 'script' && !tag.closing);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].attrs.get('type'), 'module');
    assert.equal(scripts[0].attrs.get('src'), 'src/app.js');
  });

  test('en-têtes attendus', () => {
    assert.match(html, /<html lang="fr"/);
    assert.match(html, /<meta name="referrer" content="strict-origin">/);
    assert.match(html, /<main id="app"[^>]*tabindex="-1"/);
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
    assert.match(html, /<link rel="stylesheet" href="src\/export\/print.css" media="print">/);
  });
});

describe('h() : construction sûre du DOM', () => {
  let fake;
  let dom;

  before(async () => {
    fake = installFakeDocument();
    dom = await import('../src/ui/dom.js');
  });

  after(() => fake.restore());

  test('le texte n\'est jamais interprété comme du HTML', () => {
    const el = dom.h('p', null, '<img src=x onerror=alert(1)>');
    assert.equal(el.childNodes.length, 1);
    assert.equal(el.childNodes[0].nodeType, 3);
    assert.equal(el.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(dom.h('p', { text: '<b>gras</b>' }).childNodes[0].nodeType, 3);
  });

  test('attribut style refusé (CSP)', () => {
    assert.throws(() => dom.h('div', { style: 'color: red' }), /style/);
    assert.throws(() => dom.h('div', { STYLE: 'color: red' }), /style/i);
    assert.throws(() => dom.svg('rect', { style: 'fill: red' }), /style/);
  });

  test('gestionnaires on* : fonctions seulement', () => {
    assert.throws(() => dom.h('button', { onclick: 'alert(1)' }), TypeError);
    assert.throws(() => dom.h('img', { onError: 'alert(1)' }), TypeError);
    let clicked = 0;
    const btn = dom.h('button', { onClick: () => { clicked += 1; } });
    btn.dispatch('click');
    assert.equal(clicked, 1);
    assert.equal(btn.hasAttribute('onClick'), false);
    assert.equal(btn.hasAttribute('onclick'), false);
  });

  test('URL javascript: refusée, même déguisée', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\u0000script:x', 'vbscript:x']) {
      assert.throws(() => dom.h('a', { href: url }), /javascript/, JSON.stringify(url));
    }
    assert.throws(() => dom.h('img', { src: 'javascript:alert(1)' }));
    assert.throws(() => dom.svg('a', { 'xlink:href': 'javascript:alert(1)' }));
    assert.equal(dom.h('a', { href: '#/privacy' }).getAttribute('href'), '#/privacy');
    assert.equal(dom.h('a', { href: 'mailto:ia@exemple.fr?subject=Recensia%3A' }).getAttribute('href'), 'mailto:ia@exemple.fr?subject=Recensia%3A');
  });

  test('balises script et style refusées', () => {
    assert.throws(() => dom.h('script'));
    assert.throws(() => dom.h('STYLE'));
    assert.throws(() => dom.h('div onclick=x'));
  });

  test('enfants : aplatis, valeurs vides ignorées, objets refusés', () => {
    const el = dom.h('ul', null, [dom.h('li', null, 'a'), [null, dom.h('li', null, 'b')]], false, undefined, null, 0);
    assert.equal(el.children.length, 2);
    assert.equal(el.textContent, 'ab0');
    assert.throws(() => dom.h('p', null, { toString: () => '<b>' }), TypeError);
  });

  test('classes, booléens, aria-*, data-*, propriétés', () => {
    const input = dom.h('input', { class: ['field', null, ['x', '']], required: true, disabled: false, 'aria-invalid': 'true', 'data-id': 7, value: 'v' });
    assert.equal(input.getAttribute('class'), 'field x');
    assert.equal(input.getAttribute('required'), '');
    assert.equal(input.hasAttribute('disabled'), false);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.getAttribute('data-id'), '7');
    assert.equal(input.value, 'v');
    assert.equal(input.hasAttribute('value'), false);
  });

  test('mount remplace le contenu', () => {
    const root = dom.h('div', null, 'ancien');
    dom.mount(root, dom.h('p', null, 'nouveau'), 'texte', null);
    assert.equal(root.textContent, 'nouveautexte');
  });
});

describe('service worker et précache', () => {
  const sw = stripJsComments(readSource('sw.js'));

  test('sw.js : pas d\'activation automatique, activation sur demande', () => {
    assert.match(sw, /importScripts\('\.\/sw-precache\.js'\)/);
    const skip = [...sw.matchAll(/skipWaiting\s*\(/g)];
    assert.equal(skip.length, 1, 'un seul appel à skipWaiting()');
    assert.match(sw, /SKIP_WAITING'\)\s*self\.skipWaiting\(\)/);
    assert.match(sw, /clients\.claim\(\)/);
  });

  test('sw.js : GET de même origine uniquement, réponses non ok jamais mises en cache', () => {
    assert.match(sw, /request\.method !== 'GET'\) return;/);
    assert.match(sw, /url\.origin !== self\.location\.origin\) return;/);
    assert.doesNotMatch(sw, /goatcounter|zgo\.at/i);
    for (const put of sw.matchAll(/cache\.put\(/g)) {
      const before = sw.slice(Math.max(0, put.index - 200), put.index);
      assert.match(before, /\.ok\b/, 'cache.put sans contrôle de response.ok');
    }
  });

  test('précache déterministe, trié, chemins relatifs', async () => {
    const [a, b] = await Promise.all([buildPrecache(), buildPrecache()]);
    assert.equal(a.content, b.content);
    assert.deepEqual(a.files, [...a.files].sort());
    for (const file of a.files) assert.match(file, /^\.\/[^'\\]+$/);
    assert.match(a.version, /^\d+\.\d+\.\d+-[0-9a-f]{8}$/);
    assert.match(a.content, /^self\.__RECENSIA_PRECACHE = \{$/m);
  });

  test('précache : shell complet, sans fichiers de développement', async () => {
    const files = await listPrecacheFiles();
    for (const required of ['./index.html', './config.js', './manifest.webmanifest', './src/app.js', './src/styles/app.css',
      './src/export/print.css', './src/i18n/fr/common.json', './icon-192.png', './vendor/fflate.mjs']) {
      assert.ok(files.includes(required), required);
    }
    for (const file of files) {
      assert.doesNotMatch(file, /^\.\/(tests|tools|docs|\.github)\//, file);
      assert.ok(!['./sw.js', './sw-precache.js', './package.json', './README.md'].includes(file), file);
      assert.doesNotMatch(file, /\.(recensia-key|rcn)$/, file);
    }
  });
});

describe('safe-storage : accès protégés et repli mémoire', () => {
  let saved;
  let storage;

  function fakeStorage({ failWrites = false } = {}) {
    const map = new Map();
    return {
      map,
      failWrites,
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem(key, value) {
        if (this.failWrites) throw new Error('QuotaExceededError');
        map.set(key, String(value));
      },
      removeItem: (key) => map.delete(key),
    };
  }

  before(async () => {
    saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    storage = await import('../src/ui/safe-storage.js');
  });

  after(() => {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  });

  test('valeurs JSON préfixées, lecture illisible ⇒ valeur par défaut', () => {
    const fake = fakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => fake });
    assert.equal(storage.local.set('a', { n: 1 }), true);
    assert.equal(fake.map.get('recensia:a'), '{"n":1}');
    assert.deepEqual(storage.local.get('a'), { n: 1 });
    fake.map.set('recensia:b', '{pas du json');
    assert.equal(storage.local.get('b', 'défaut'), 'défaut');
    storage.local.remove('a');
    assert.equal(storage.local.get('a'), null);
  });

  test('stockage inaccessible (contexte sandboxé) : aucune exception, repli mémoire', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    assert.equal(storage.local.available(), false);
    assert.equal(storage.local.set('c', [1, 2]), false);
    assert.deepEqual(storage.local.get('c'), [1, 2]);
    storage.local.remove('c');
    assert.equal(storage.local.get('c', 'x'), 'x');
  });

  test('écriture refusée (quota) : la nouvelle valeur l\'emporte, jamais l\'ancienne', () => {
    const fake = fakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => fake });
    storage.local.set('d', 'ancienne');
    fake.failWrites = true;
    assert.equal(storage.local.set('d', 'nouvelle'), false);
    assert.equal(storage.local.get('d'), 'nouvelle');
    assert.equal(fake.map.has('recensia:d'), false, 'valeur périmée retirée du navigateur');
    fake.failWrites = false;
    assert.equal(storage.local.set('d', 'rétablie'), true);
    assert.equal(storage.local.get('d'), 'rétablie');
    storage.local.remove('d');
  });
});

describe('feuilles de style : contrastes (WCAG AA) et impression', () => {
  const css = readSource('src/styles/app.css');
  const lightBlock = /:root \{([\s\S]*?)\n\}/.exec(css)[1];
  const darkBlock = /@media screen and \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/.exec(css)?.[1];
  const tokens = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
  const light = tokens(lightBlock);
  const dark = { ...light, ...tokens(darkBlock ?? '') };
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const TEXT_PAIRS = [
    ['aia-prohibited-fg', 'aia-prohibited-bg'], ['aia-high-fg', 'aia-high-bg'], ['aia-qualify-fg', 'aia-qualify-bg'],
    ['aia-limited-fg', 'aia-limited-bg'], ['aia-minimal-fg', 'aia-minimal-bg'],
    ['data-0-fg', 'data-0-bg'], ['data-1-fg', 'data-1-bg'], ['data-2-fg', 'data-2-bg'], ['data-3-fg', 'data-3-bg'],
    ['text', 'bg'], ['text-muted', 'bg'], ['text-muted', 'surface-3'], ['link', 'surface'], ['link', 'bg'],
    ['primary-contrast', 'primary'], ['header-muted', 'header-bg'], ['danger', 'surface'],
    ['success', 'success-soft'], ['warn', 'warn-soft'], ['info', 'info-soft'], ['danger', 'danger-soft'],
  ];

  test('thème sombre réservé à l\'écran (l\'impression garde la palette claire)', () => {
    assert.ok(darkBlock, 'bloc @media screen and (prefers-color-scheme: dark) introuvable');
    assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(readSource('src/export/print.css'), /color-scheme:\s*light/);
  });

  for (const [name, palette] of [['clair', light], ['sombre', dark]]) {
    test(`thème ${name} : textes et badges ≥ 4,5:1`, () => {
      const problems = TEXT_PAIRS
        .map(([fg, bg]) => [fg, bg, ratio(palette[fg], palette[bg])])
        .filter(([, , r]) => !(r >= 4.5))
        .map(([fg, bg, r]) => `${fg} / ${bg} : ${r.toFixed(2)}`);
      assert.deepEqual(problems, []);
    });

    test(`thème ${name} : contour des champs ≥ 3:1 (WCAG 1.4.11)`, () => {
      for (const bg of ['surface', 'surface-2', 'surface-3', 'bg']) {
        const r = ratio(palette['border-strong'], palette[bg]);
        assert.ok(r >= 3, `border-strong / ${bg} : ${r.toFixed(2)}`);
      }
    });
  }
});
