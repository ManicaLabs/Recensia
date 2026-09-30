// Invariants de sécurité du socle : interdits dans src/, CSP d'index.html, h() sûr,
// service worker et précache. Les analyses statiques ignorent les commentaires.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { listFiles, readSource } from './helpers/source-scan.js';
import { installFakeDocument } from './helpers/fake-dom.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  stripJsComments, findForbiddenCode, findThirdPartyUrls, findI18nKeys, parseHtml, findSecrets, isForbiddenFile,
  cdcVersions, versionIssues, projectPathOf, pagesBasePath,
} from '../tools/check.mjs';
import {
  buildPrecache, listPrecacheFiles, readAppVersion, MIME_TYPES, extensionOf, integrityOf,
} from '../tools/precache.mjs';
import { openStore } from '../src/storage/store.js';
import { register, t } from '../src/i18n.js';
import { render as renderPrivacy, originScope } from '../src/views/privacy.js';

const CSP = "default-src 'self'; script-src 'self' https://gc.zgo.at; connect-src 'self' https://manica.goatcounter.com; "
  + "img-src 'self' data: blob: https://manica.goatcounter.com; style-src 'self'; font-src 'self'; object-src 'none'; "
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

  test('régions live polie et assertive présentes dès le chargement (première annonce jamais perdue)', () => {
    const region = (id) => tags.find((tag) => !tag.closing && tag.attrs.get('id') === id);
    const polite = region('live-region');
    const assertive = region('live-region-assertive');
    assert.ok(polite && assertive);
    assert.equal(polite.attrs.get('aria-live'), 'polite');
    assert.equal(assertive.attrs.get('aria-live'), 'assertive');
    for (const tag of [polite, assertive]) {
      assert.equal(tag.attrs.get('aria-atomic'), 'true');
      assert.equal(tag.attrs.get('class'), 'visually-hidden');
    }
  });

  test('identifiants uniques', () => {
    const ids = tags.filter((tag) => !tag.closing && tag.attrs.has('id')).map((tag) => tag.attrs.get('id'));
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('404.html : liens dont le « # » a été encodé', () => {
  const html = readSource('404.html');
  const tags = parseHtml(html);
  const opened = tags.filter((tag) => !tag.closing);

  test('même CSP qu\'index.html, aucun style ni script inline', () => {
    const meta = opened.find((tag) => tag.name === 'meta' && tag.attrs.get('http-equiv') === 'Content-Security-Policy');
    assert.equal(meta?.attrs.get('content'), CSP);
    assert.equal(tags.malformed.length, 0);
    for (const tag of opened) {
      assert.notEqual(tag.name, 'style', `<style> ligne ${tag.line}`);
      assert.equal(tag.attrs.has('style'), false, `style= ligne ${tag.line}`);
      for (const name of tag.attrs.keys()) assert.doesNotMatch(name, /^on/, `${name}= ligne ${tag.line}`);
      if (tag.name === 'script') assert.equal(tag.content.trim(), '', `script inline ligne ${tag.line}`);
    }
  });

  test('un seul script, /Recensia/404.js, en module', () => {
    const scripts = opened.filter((tag) => tag.name === 'script');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].attrs.get('type'), 'module');
    assert.equal(scripts[0].attrs.get('src'), `${pagesBasePath()}404.js`);
  });

  test('origine partagée : aucune adresse relative ni hors de /Recensia/ (page servie à toute profondeur)', () => {
    // Un chemin relatif (« ../404.js ») remonte au-dessus de /Recensia/ pour …/Recensia/x ou …/Recensia/x/y
    // et vise https://manicalabs.github.io/404.js, qui appartient au site racine d'un autre dépôt.
    const base = pagesBasePath(); // « /Recensia/ », ou « / » avec un domaine dédié (fichier CNAME)
    const local = [];
    for (const tag of opened) {
      for (const name of ['href', 'src']) {
        const value = tag.attrs.get(name);
        if (value && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value)) local.push(value);
      }
    }
    assert.ok(local.length >= 4, local.join(' '));
    for (const value of local) {
      assert.doesNotMatch(value, /^\/\//, `adresse sans schéma : ${value}`);
      assert.deepEqual(projectPathOf(value, base).ok, true, `${value} doit commencer par ${base}`);
    }
    for (const bad of ['404.js', '../404.js', '../../404.js', '/404.js', '/src/styles/app.css', '/Recensia/../404.js', '/Recensia/%2e%2e/404.js', '/RecensiaBis/404.js']) {
      assert.equal(projectPathOf(bad, base).ok, false, bad);
    }
    assert.deepEqual(projectPathOf('/Recensia/src/styles/app.css?v=1', base), { ok: true, path: 'src/styles/app.css' });
    assert.deepEqual(projectPathOf('/404.js', '/'), { ok: true, path: '404.js' }, 'domaine dédié (CNAME)');
  });

  test('balises équilibrées, identifiants uniques, sans référent, non indexée', () => {
    const VOID = new Set(['meta', 'link', 'img', 'br', 'input', 'hr']);
    const stack = [];
    for (const tag of tags) {
      if (tag.closing) assert.equal(stack.pop(), tag.name, `ligne ${tag.line}`);
      else if (!VOID.has(tag.name)) stack.push(tag.name);
    }
    assert.deepEqual(stack, []);
    const ids = opened.filter((tag) => tag.attrs.has('id')).map((tag) => tag.attrs.get('id'));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['nf-generic', 'nf-broken', 'nf-redirect', 'nf-home', 'nf-repaired', 'nf-css']) assert.ok(ids.includes(id), id);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<html lang="fr"/);
  });

  test('404.js : aucun interdit, aucune requête, aucune journalisation', () => {
    const source = readSource('404.js');
    assert.deepEqual(findForbiddenCode('404.js', source), []);
    assert.deepEqual(findThirdPartyUrls('404.js', source), []);
    const code = stripJsComments(source);
    assert.doesNotMatch(code, /\bconsole\.|\bfetch\s*\(|XMLHttpRequest|sendBeacon|goatcounter|localStorage|sessionStorage|indexedDB/);
  });

  test('ni 404.html ni 404.js dans le précache', async () => {
    const files = await listPrecacheFiles();
    assert.equal(files.includes('./404.html'), false);
    assert.equal(files.includes('./404.js'), false);
  });
});

describe('version de l\'application', () => {
  const CDC = [
    '# CDC', '', '## 5bis. État d\'avancement', '',
    '- ✅ **v0.1 — socle** : …', '- ✅ **v0.9 — registre** : …', '- 🚧 **Recette v1.0** : …', '- ⚠️ **Points**', '',
    '---', '', '- ✅ **v9.9 — hors section** : ignoré',
  ].join('\n');

  test('cdcVersions : versions livrées et en cours de la section 5bis', () => {
    assert.deepEqual(cdcVersions(CDC), { released: [[0, 1], [0, 9]], inProgress: [[1, 0]] });
    assert.deepEqual(cdcVersions('pas de section'), { released: [], inProgress: [] });
  });

  test('versionIssues : config.js = package.json, et pas en retard sur le CDC', () => {
    assert.deepEqual(versionIssues({ appVersion: '0.9.0', packageVersion: '0.9.0', cdcText: CDC }).errors, []);
    assert.deepEqual(versionIssues({ appVersion: '1.0.0', packageVersion: '1.0.0', cdcText: CDC }).warnings, []);
    const late = versionIssues({ appVersion: '0.1.0', packageVersion: '0.1.0', cdcText: CDC });
    assert.equal(late.errors.length, 1);
    assert.match(late.errors[0], /en retard.*v0\.9/);
    assert.match(versionIssues({ appVersion: '0.9.0', packageVersion: '0.1.0', cdcText: CDC }).errors[0], /package\.json \(0\.1\.0\)/);
    assert.equal(versionIssues({ appVersion: '1.3.0', packageVersion: '1.3.0', cdcText: CDC }).warnings.length, 1);
    assert.equal(versionIssues({ appVersion: 'v1', packageVersion: 'v1', cdcText: CDC }).errors.length, 1);
  });

  test('dépôt : version cohérente (pied de page, sauvegardes, nom du cache)', async () => {
    const appVersion = await readAppVersion();
    const pkg = JSON.parse(readSource('package.json'));
    const result = versionIssues({ appVersion, packageVersion: pkg.version, cdcText: readSource('docs/CDC.md') });
    assert.deepEqual(result.errors, []);
    assert.equal(pkg.version, appVersion);
    assert.ok((await buildPrecache()).version.startsWith(`${appVersion}-`));
  });

  test('une sauvegarde d\'une version antérieure (app_version 0.1.0) reste importable', async () => {
    const campaign = {
      id: 'k3J9xQ2mP0aZ', title: 'Recensement', org_name: 'Exemple', mode: 'anonymous', departments: ['Direction'],
      settings: { min_group_size: 5, department_required: false, comments_exportable: false, closes_on: null, group_by_department: false, channels: [{ type: 'copy', target: 'consigne' }] },
      public_key: 'BPk5x0Wq7iB4m3YQmFf6pYyYx9o0Cz6sQYQy2l3lC2m8R4f3rXk1jC5o6k9v1a2b3c4d5e6f7g8h9i0j1k2l3m4',
      private_key_jwk: null, fingerprint: 'A1B2C3D4', created_at: '2026-09-29T10:00:00.000Z', demo: false,
      last_backup_at: null, recovery_saved_at: null,
    };
    const old = await openStore({ forceMemory: true, appVersion: '0.1.0' });
    await old.putCampaign(campaign);
    const backup = await old.exportCampaignData(campaign.id);
    assert.equal(backup.app_version, '0.1.0');
    const current = await openStore({ forceMemory: true, appVersion: await readAppVersion() });
    const result = await current.importCampaignData(JSON.parse(JSON.stringify(backup)));
    assert.equal(result.campaign_id, campaign.id);
    assert.equal((await current.getCampaign(campaign.id)).title, 'Recensement');
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

  test('sw.js : GET de même origine uniquement, seul un contenu vérifié est mis en cache', () => {
    assert.match(sw, /request\.method !== 'GET'\) return;/);
    assert.match(sw, /url\.origin !== self\.location\.origin\) return;/);
    assert.match(sw, /if \(!EXPECTED\.has\(url\.href\)\) return;/);
    assert.doesNotMatch(sw, /goatcounter|zgo\.at/i);
    const puts = [...sw.matchAll(/cache\.put\(([^;]*)\)/g)];
    assert.ok(puts.length >= 2);
    for (const put of puts) assert.match(put[1], /^url, verifiedResponse\(expected, body\)/, `cache.put non vérifié : ${put[0]}`);
    assert.match(sw, /if \(!response\.ok\) throw/);
  });

  test('précache déterministe, trié, chemins relatifs', async () => {
    const [a, b] = await Promise.all([buildPrecache(), buildPrecache()]);
    assert.equal(a.content, b.content);
    assert.deepEqual(a.files, [...a.files].sort());
    for (const file of a.files) assert.match(file, /^\.\/[^'\\]+$/);
    assert.match(a.version, /^\d+\.\d+\.\d+-[0-9a-f]{8}$/);
    assert.match(a.content, /^self\.__RECENSIA_PRECACHE = \{$/m);
  });

  test('précache : empreinte SHA-256 de chaque fichier et type MIME de chaque extension', async () => {
    const { files, integrity, content } = await buildPrecache();
    assert.deepEqual(Object.keys(integrity).sort(), files);
    for (const file of files) {
      const expected = `sha256-${createHash('sha256').update(readFileSync(new URL(`../${file.slice(2)}`, import.meta.url))).digest('base64')}`;
      assert.equal(integrity[file], expected, file);
      assert.ok(content.includes(`    '${file}': '${expected}',`), file);
      assert.ok(Object.hasOwn(MIME_TYPES, extensionOf(file)), file);
    }
    assert.equal(integrityOf(Buffer.from('abc')), 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    assert.equal(extensionOf('./src/app.JS'), '.js');
    assert.equal(extensionOf('./LICENSE'), '');
    assert.equal(extensionOf('./.nojekyll'), '');
    assert.match(content, /^ {2}types: \{$/m);
    assert.match(content, /^ {4}'\.js': 'text\/javascript; charset=utf-8',$/m);
    assert.match(content, /^ {4}'\.html': 'text\/html; charset=utf-8',$/m);
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

// Service worker exécuté sous Node (vm) avec un CacheStorage et un réseau simulés : le cache est commun
// à toute l'origine (…github.io), un autre site peut y écrire ; seule une copie conforme à l'empreinte
// de sw-precache.js est servie, avec le seul type MIME de son extension.
describe('service worker : intégrité du cache (origine partagée)', () => {
  const SCOPE = 'https://manicalabs.github.io/Recensia/';
  const ROOT_URL = new URL('../', import.meta.url);
  const swSource = readSource('sw.js');
  let precache;

  before(async () => { precache = await buildPrecache(); });

  class BasicResponse extends Response {
    get type() { return 'basic'; }
  }

  function repoFile(url) {
    const { pathname } = new URL(url);
    if (!pathname.startsWith('/Recensia/')) return null;
    const rel = pathname.slice('/Recensia/'.length) || 'index.html';
    try {
      return readFileSync(new URL(rel, ROOT_URL));
    } catch {
      return null;
    }
  }

  // network(url, input) → Response | null (null : fichier du dépôt) ; offline : TypeError comme fetch.
  function startWorker({ network = () => null } = {}) {
    const state = { offline: false, requests: [] };
    const listeners = {};
    const store = new Map();
    const keyOf = (request) => (typeof request === 'string' ? request : request.url);
    const cacheFor = (entries) => ({
      async match(request) { const hit = entries.get(keyOf(request)); return hit ? hit.clone() : undefined; },
      async put(request, response) { entries.set(keyOf(request), response); },
      async delete(request) { return entries.delete(keyOf(request)); },
      async keys() { return [...entries.keys()]; },
    });
    const caches = {
      async open(name) { if (!store.has(name)) store.set(name, new Map()); return cacheFor(store.get(name)); },
      async keys() { return [...store.keys()]; },
      async delete(name) { return store.delete(name); },
    };
    async function fetchStub(input) {
      const url = keyOf(input);
      state.requests.push(url);
      if (state.offline) throw new TypeError('Failed to fetch');
      const custom = await network(url, input);
      if (custom) return custom;
      const body = repoFile(url);
      return body ? new BasicResponse(body, { status: 200 }) : new BasicResponse('introuvable', { status: 404 });
    }
    const self = {
      location: new URL(`${SCOPE}sw.js`),
      addEventListener(type, fn) { listeners[type] = fn; },
      skipWaiting() {},
      clients: { claim: async () => {} },
    };
    const context = vm.createContext({
      self, caches, fetch: fetchStub, Request, Response, Headers, URL, crypto: globalThis.crypto, btoa, Uint8Array,
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
      importScripts: (path) => {
        assert.equal(path, './sw-precache.js');
        vm.runInContext(precache.content, context);
      },
    });
    vm.runInContext(swSource, context);
    const cacheName = `recensia-${precache.version}`;
    return {
      state,
      store,
      cacheName,
      cache: () => caches.open(cacheName),
      async install() {
        let pending;
        listeners.install({ waitUntil(promise) { pending = promise; } });
        return pending;
      },
      // → undefined si la requête n'est pas interceptée, sinon la réponse (promesse) du service worker.
      dispatch(request) {
        let pending;
        listeners.fetch({ request, respondWith(promise) { pending = promise; } });
        return pending;
      },
    };
  }

  const url = (rel) => `${SCOPE}${rel}`;
  const get = (rel) => new Request(url(rel));
  const navigate = (rel) => ({ url: url(rel), method: 'GET', mode: 'navigate' });
  const genuine = (rel) => readFileSync(new URL(rel, ROOT_URL), 'utf8');
  const poison = async (worker, rel, body, headers = { 'content-type': 'text/javascript' }) => {
    await (await worker.cache()).put(url(rel), new Response(body, { headers }));
  };

  test('installation : chaque fichier précaché, vérifié, servi avec son seul type MIME', async () => {
    const worker = startWorker();
    await worker.install();
    const cache = await worker.cache();
    assert.equal((await cache.keys()).length, precache.files.length);
    const home = await cache.match(url('src/views/home.js'));
    assert.deepEqual([...home.headers], [['content-type', 'text/javascript; charset=utf-8']]);
    assert.equal(await home.text(), genuine('src/views/home.js'));
    const icon = await cache.match(url('icon-192.png'));
    assert.equal(icon.headers.get('content-type'), 'image/png');
  });

  test('module remplacé par un autre site de l\'origine : copie écartée, vrai fichier servi et remis en cache', async () => {
    const worker = startWorker();
    await worker.install();
    await poison(worker, 'src/views/home.js', 'export async function render(root) { root.textContent = "MODIFIÉ"; }');
    const response = await worker.dispatch(get('src/views/home.js'));
    assert.equal(await response.text(), genuine('src/views/home.js'));
    assert.equal(await (await (await worker.cache()).match(url('src/views/home.js'))).text(), genuine('src/views/home.js'));
  });

  test('index.html remplacé avec un en-tête Refresh : contenu et en-têtes du cache ignorés', async () => {
    const worker = startWorker();
    await worker.install();
    await poison(worker, 'index.html', '<h1>MODIFIÉ</h1>', { 'content-type': 'text/html', refresh: '0; url=https://example.org/' });
    for (const rel of ['', 'index.html', 'index.html?utm=x']) {
      const response = await worker.dispatch(navigate(rel));
      assert.equal(await response.text(), genuine('index.html'), rel);
      assert.equal(response.headers.get('refresh'), null, rel);
    }
    // En-têtes seuls altérés (contenu intact) : réponse reconstruite, sans Refresh.
    await poison(worker, 'index.html', genuine('index.html'), { 'content-type': 'text/html', refresh: '0; url=https://example.org/' });
    worker.state.offline = true;
    const offline = await worker.dispatch(navigate(''));
    assert.deepEqual([...offline.headers], [['content-type', 'text/html; charset=utf-8']]);
    assert.equal(await offline.text(), genuine('index.html'));
  });

  test('hors ligne : une copie altérée n\'est jamais servie (échec réseau), puis le cache se répare', async () => {
    const worker = startWorker();
    await worker.install();
    await poison(worker, 'src/views/home.js', 'export const pirate = true;');
    worker.state.offline = true;
    await assert.rejects(worker.dispatch(get('src/views/home.js')), /Failed to fetch/);
    assert.equal(await (await worker.cache()).match(url('src/views/home.js')), undefined, 'copie altérée supprimée');
    const shell = await worker.dispatch(navigate('src/views/inconnu')) ;
    assert.equal(shell, undefined, 'navigation hors du shell : non interceptée');
    worker.state.offline = false;
    assert.equal(await (await worker.dispatch(get('src/views/home.js'))).text(), genuine('src/views/home.js'));
    worker.state.offline = true;
    assert.equal(await (await worker.dispatch(get('src/views/home.js'))).text(), genuine('src/views/home.js'));
  });

  test('fichiers hors précache, query string, autre origine, autre projet, POST : non interceptés', async () => {
    const worker = startWorker();
    await worker.install();
    for (const request of [
      get('404.html'), get('logo_manica_hd.svg'), get('src/router.js?x=1'), get('src/inexistant.js'),
      new Request('https://manicalabs.github.io/Autre-site/app.js'), new Request('https://gc.zgo.at/count.js'),
      new Request(url('src/app.js'), { method: 'POST', body: 'x' }),
    ]) assert.equal(worker.dispatch(request), undefined, request.url);
    const cached = (await (await worker.cache()).keys()).filter((key) => !precache.files.some((file) => url(file.slice(2)) === key));
    assert.deepEqual(cached, []);
  });

  test('config.js : réseau d\'abord, jamais remis en cache ; hors ligne, seule la copie vérifiée sert', async () => {
    let served = null;
    const worker = startWorker({ network: (target) => (served && target.startsWith(url('config.js')) ? new BasicResponse(served) : null) });
    await worker.install();
    served = "export const config = { appVersion: '9.9.9', goatcounterCode: '' };";
    assert.equal(await (await worker.dispatch(get('config.js?v=2'))).text(), served);
    assert.equal(await (await (await worker.cache()).match(url('config.js'))).text(), genuine('config.js'));
    worker.state.offline = true;
    assert.equal(await (await worker.dispatch(get('config.js'))).text(), genuine('config.js'));
    await poison(worker, 'config.js', "export const config = { goatcounterCode: 'pirate' };");
    await assert.rejects(worker.dispatch(get('config.js')), /Failed to fetch/);
  });

  test('CDN en retard juste après un déploiement : second essai avec la version en query string', async () => {
    const stale = (target) => (target === url('src/router.js') ? new BasicResponse('// ancien contenu') : null);
    const worker = startWorker({ network: stale });
    await worker.install();
    assert.equal(await (await (await worker.cache()).match(url('src/router.js'))).text(), genuine('src/router.js'));
    assert.ok(worker.state.requests.includes(`${url('src/router.js')}?v=${encodeURIComponent(precache.version)}`));
  });

  test('contenu toujours différent de l\'empreinte : installation refusée, sans cache partiel', async () => {
    const worker = startWorker({ network: (target) => (target.startsWith(url('src/router.js')) ? new BasicResponse('// autre contenu') : null) });
    await assert.rejects(worker.install(), /src\/router\.js \(contenu différent de son empreinte\)/);
    assert.equal(worker.store.has(worker.cacheName), false);
    const failing = startWorker({ network: (target) => (target === url('data/rules.json') ? new BasicResponse('', { status: 503 }) : null) });
    await assert.rejects(failing.install(), /data\/rules\.json \(HTTP 503\)/);
  });
});

describe('page de confidentialité : origine partagée annoncée d\'après l\'adresse réelle', () => {
  let fake;
  before(() => {
    fake = installFakeDocument();
    for (const ns of ['common', 'privacy']) register(ns, JSON.parse(readSource(`src/i18n/fr/${ns}.json`)));
  });
  after(() => fake.restore());

  async function pageText(baseUrl) {
    const root = globalThis.document.createElement('main');
    root.querySelectorAll = () => [];
    await renderPrivacy(root, { ctx: { t, baseUrl, setTitle: () => {} } });
    return root.textContent;
  }

  test('originScope : partagée dès que l\'application n\'est pas à la racine de son origine', () => {
    assert.deepEqual(originScope('https://manicalabs.github.io/Recensia/'),
      { origin: 'https://manicalabs.github.io', url: 'https://manicalabs.github.io/Recensia/', shared: true });
    assert.deepEqual(originScope('https://recensia.example.fr/'),
      { origin: 'https://recensia.example.fr', url: 'https://recensia.example.fr/', shared: false });
    assert.equal(originScope('http://localhost:8765/Recensia/').shared, true);
    assert.equal(originScope('http://localhost:8000/').shared, false);
    assert.equal(originScope('https://recensia.example.fr/?x=1#/privacy').url, 'https://recensia.example.fr/');
    for (const bad of ['', 'pas une adresse', 'file:///tmp/index.html', null]) assert.equal(originScope(bad).shared, true, String(bad));
  });

  test('sous …github.io/Recensia/ : avertissement, données exposées et conseil, avec l\'origine réelle', async () => {
    const text = await pageText('https://manicalabs.github.io/Recensia/');
    assert.match(text, /Origine partagée\. Recensia est publié à l'adresse https:\/\/manicalabs\.github\.io\/Recensia\//);
    assert.match(text, /tout autre site publié sous https:\/\/manicalabs\.github\.io partage ce compartiment/);
    assert.match(text, /clés privées/);
    assert.match(text, /Recensia partage son origine \(https:\/\/manicalabs\.github\.io\)/);
    assert.match(text, /empreinte SHA-256/);
    assert.doesNotMatch(text, /racine de son origine|\{(?:origin|url)\}|privacy\./);
  });

  test('domaine dédié (racine de l\'origine) : pas d\'avertissement', async () => {
    const text = await pageText('https://recensia.example.fr/');
    assert.match(text, /publié à la racine de son origine \(https:\/\/recensia\.example\.fr\)/);
    assert.doesNotMatch(text, /Origine partagée|partage son origine|\{(?:origin|url)\}/);
    assert.match(text, /empreinte SHA-256/);
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

describe('feuilles de style : pas de variante de mise en page orpheline', () => {
  test('chaque variante de largeur .page-* d\'app.css est utilisée par une vue ou une page HTML', () => {
    const css = readSource('src/styles/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // Variantes de largeur de .page (.page-narrow…) ; .page-header* et .page-break sont des blocs, pas des largeurs.
    const variants = [...new Set([...css.matchAll(/\.(page-[a-z]+)(?![\w-])/g)].map((m) => m[1]))]
      .filter((name) => !['page-header', 'page-break'].includes(name));
    assert.ok(variants.includes('page-narrow'), 'variante .page-narrow introuvable (expression à revoir)');
    const code = [...listFiles('src', ['.js']), 'index.html', '404.html', '404.js']
      .map((file) => stripJsComments(readSource(file))).join('\n');
    const unused = variants.filter((name) => !new RegExp(`(^|[\\s'"\`])${name}($|[\\s'"\`])`).test(code));
    assert.deepEqual(unused, [], `règles sans utilisateur dans app.css : ${unused.join(', ')}`);
  });
});

describe('docs/TESTS-MANUELS.md : protocoles de vérification manuelle', () => {
  const doc = readSource('docs/TESTS-MANUELS.md');
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  test('les protocoles attendus sont présents (messageries, Safe Links, QR, Excel, chronométrage, mobile)', () => {
    for (const [label, re] of [
      ['Outlook', /Outlook/], ['Gmail', /Gmail/], ['Teams', /Teams/], ['WhatsApp', /WhatsApp/], ['Slack', /Slack/],
      ['Safe Links', /^### Safe Links/m], ['QR imprimé', /QR code imprimé et projeté/], ['QR projeté', /Projeter en plein écran/],
      ['Microsoft Excel', /Microsoft Excel/], ['5 personnes', /\*\*5 personnes\*\*/],
      ['installation mobile', /^### 6\.2 Installation sur mobile/m], ['iPhone', /Sur l'écran d'accueil/], ['Android', /Installer l'application/],
    ]) assert.match(doc, re, `protocole manquant : ${label}`);
  });

  test('chaque section numérotée (hors conventions) a au moins un tableau de résultats bien formé', () => {
    const sections = doc.split(/^## (?=\d+\. )/m).slice(1).filter((s) => !s.startsWith('0.'));
    assert.ok(sections.length >= 6, `${sections.length} sections numérotées`);
    for (const section of sections) {
      const title = section.split('\n')[0];
      const tables = section.split(/^### (?:Résultats|Synthèse)[^\n]*\n/m).slice(1);
      assert.ok(tables.length > 0, `${title} : aucun tableau « Résultats »`);
      for (const block of tables) {
        // Premier tableau sous l'intertitre : lignes « | … | » consécutives.
        const table = [];
        for (const line of block.split('\n').map((l) => l.trim())) {
          if (line.startsWith('|')) table.push(line);
          else if (table.length) break;
        }
        assert.ok(table.length >= 3, `${title} : tableau sans ligne à remplir`);
        const width = cells(table[0]).length;
        assert.match(table[1], /^\|(\s*:?-+:?\s*\|)+$/, `${title} : ligne de séparation attendue sous l'en-tête`);
        for (const row of table) assert.equal(cells(row).length, width, `${title} : ligne de ${cells(row).length} cellules au lieu de ${width} : ${row.slice(0, 80)}`);
      }
    }
  });
});
