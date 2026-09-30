#!/usr/bin/env node
// Validation avant push (CDC §12). Usage : node tools/check.mjs [--fix]
//   --fix : régénère sw-precache.js avant de le vérifier.
// Code de sortie non nul si au moins une vérification échoue.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPrecache, OUTPUT as PRECACHE_FILE, readAppVersion, ROOT } from './precache.mjs';

// ---------------------------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.github-cache']);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|avif|pdf|zip|gz|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

let gitAvailable = null;
function git(args) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    gitAvailable = true;
    return out.split('\0').filter(Boolean);
  } catch {
    gitAvailable = false;
    return null;
  }
}

/** Fichiers suivis ou non ignorés (repli : parcours du dépôt). */
function repoFiles() {
  const listed = git(['ls-files', '-z', '-co', '--exclude-standard']);
  const files = listed ?? walkFiles('');
  return [...new Set(files)].filter((file) => existsSync(join(ROOT, file))).sort();
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function srcFiles(extensions) {
  return walkFiles('src').filter((file) => extensions.some((ext) => file.endsWith(ext))).sort();
}

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * Remplace les commentaires JavaScript par des espaces (sauts de ligne conservés, donc numéros
 * de ligne inchangés). Chaînes, gabarits (avec ${…} imbriqués) et expressions régulières sont
 * reconnus pour ne pas prendre un « // » d'URL ou de regex pour un commentaire.
 */
export function stripJsComments(source) {
  const text = String(source);
  const n = text.length;
  let out = '';
  let i = 0;
  let last = ''; // dernier caractère significatif du code
  let word = ''; // dernier mot du code (mots-clés précédant une regex)
  let gap = false; // espace depuis le dernier caractère significatif
  const stack = []; // profondeurs d'accolades des ${…} ouverts dans des gabarits
  const blank = (chunk) => chunk.replace(/[^\n]/g, ' ');

  const readQuoted = (quote) => {
    let j = i + 1;
    while (j < n && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, n);
  };

  // Gabarit à partir de i (après « ` » ou « } » fermant un ${…}) : renvoie la fin et l'état.
  const readTemplate = (start) => {
    let j = start;
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '`') return { end: j + 1, open: false };
      if (text[j] === '$' && text[j + 1] === '{') return { end: j + 2, open: true };
      j += 1;
    }
    return { end: n, open: false };
  };

  const readRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n && text[j] !== '\n') {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j += 1;
        while (j < n && /[a-z]/i.test(text[j])) j += 1;
        return j;
      }
      j += 1;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const stop = readQuoted(c);
      out += text.slice(i, stop);
      i = stop;
      last = c;
      word = '';
      continue;
    }
    if (c === '`' || (c === '}' && stack.length && stack.at(-1) === 0)) {
      if (c === '}') stack.pop();
      const { end, open } = readTemplate(i + 1);
      out += text.slice(i, end);
      i = end;
      if (open) stack.push(0);
      last = '`';
      word = '';
      continue;
    }
    if (c === '/' && (last === '' || REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.has(word))) {
      const stop = readRegex();
      out += text.slice(i, stop);
      i = stop;
      last = '/';
      word = '';
      continue;
    }
    if (stack.length) {
      if (c === '{') stack[stack.length - 1] += 1;
      else if (c === '}') stack[stack.length - 1] -= 1;
    }
    out += c;
    i += 1;
    if (/\s/.test(c)) {
      gap = true;
      continue;
    }
    word = /[A-Za-z0-9_$]/.test(c) ? (!gap && /[A-Za-z0-9_$]/.test(last) ? word + c : c) : '';
    gap = false;
    last = c;
  }
  return out;
}

/** Retire les commentaires CSS (numéros de ligne conservés). */
export function stripCssComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, (chunk) => chunk.replace(/[^\n]/g, ' '));
}

function pngSize(rel) {
  const buf = readFileSync(join(ROOT, rel));
  const signature = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== signature || buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const sections = [];

function section(id, title) {
  const s = { id, title, errors: [], warnings: [], notes: [] };
  sections.push(s);
  return s;
}

function printSection(s) {
  const status = s.errors.length
    ? paint('31;1', 'ÉCHEC')
    : s.warnings.length ? paint('33;1', 'OK (avertissements)') : paint('32;1', 'OK');
  console.log(`\n[${s.id}] ${s.title} — ${status}`);
  for (const note of s.notes) console.log(`    ${paint('2', note)}`);
  for (const warning of s.warnings) console.log(`    ${paint('33', 'avertissement')} ${warning}`);
  for (const error of s.errors) console.log(`    ${paint('31', 'erreur')} ${error}`);
}

// ---------------------------------------------------------------------------------------------
// (1) Syntaxe JavaScript
// ---------------------------------------------------------------------------------------------

function nodeCheck(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { cwd: ROOT }, (err, _stdout, stderr) => {
      resolve(err ? (stderr || err.message).trim().split('\n').slice(0, 6).join('\n      ') : null);
    });
  });
}

async function checkSyntax() {
  const s = section('1', 'Syntaxe JavaScript (node --check)');
  const files = repoFiles().filter((file) => /\.(m|c)?js$/.test(file) && !file.startsWith('vendor/'));
  const queue = [...files];
  const workers = Array.from({ length: Math.max(2, Math.min(8, cpus().length)) }, async () => {
    while (queue.length) {
      const file = queue.shift();
      const problem = await nodeCheck(file);
      if (problem) s.errors.push(`${file}\n      ${problem}`);
    }
  });
  await Promise.all(workers);
  s.notes.push(`${files.length} fichiers vérifiés (vendor/ exclu).`);
  return s;
}

// ---------------------------------------------------------------------------------------------
// (3) JSON, manifest et cohérence des données
// ---------------------------------------------------------------------------------------------

function parseJson(rel, s) {
  try {
    return JSON.parse(read(rel));
  } catch (err) {
    s.errors.push(`${rel} : JSON invalide (${err.message})`);
    return undefined;
  }
}

function asList(json, keys) {
  if (Array.isArray(json)) return json;
  for (const key of keys) if (json && Array.isArray(json[key])) return json[key];
  return null;
}

function checkUniqueIds(list, rel, s) {
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item.id !== 'string') continue;
    if (seen.has(item.id)) s.errors.push(`${rel} : identifiant en double « ${item.id} »`);
    seen.add(item.id);
  }
  return seen;
}

function checkI18nLeaves(value, rel, path, s) {
  if (typeof value === 'string') return;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) checkI18nLeaves(child, rel, path ? `${path}.${key}` : key, s);
    return;
  }
  s.warnings.push(`${rel} : « ${path} » n'est pas un texte (t() ne renvoie que des chaînes)`);
}

function checkManifest(s) {
  const rel = 'manifest.webmanifest';
  if (!existsSync(join(ROOT, rel))) {
    s.errors.push(`${rel} absent`);
    return;
  }
  const manifest = parseJson(rel, s);
  if (!manifest) return;
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color', 'lang']) {
    if (manifest[key] === undefined || manifest[key] === '') s.errors.push(`${rel} : champ « ${key} » manquant`);
  }
  if (manifest.start_url !== undefined && manifest.start_url !== './') s.errors.push(`${rel} : start_url doit valoir "./" (site servi sous /<dépôt>/)`);
  if (manifest.scope !== undefined && manifest.scope !== './') s.errors.push(`${rel} : scope doit valoir "./"`);
  if (manifest.display && !['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) {
    s.errors.push(`${rel} : display « ${manifest.display} » ne permet pas l'installation`);
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const purposes = new Map();
  for (const iconDef of icons) {
    const src = String(iconDef.src ?? '');
    if (!src || /^[a-z]+:/i.test(src) || src.startsWith('/')) {
      s.errors.push(`${rel} : icône « ${src} » : chemin relatif attendu`);
      continue;
    }
    if (!existsSync(join(ROOT, src))) {
      s.errors.push(`${rel} : icône introuvable « ${src} »`);
      continue;
    }
    const match = /^(\d+)x(\d+)$/.exec(String(iconDef.sizes ?? ''));
    if (!match) {
      s.errors.push(`${rel} : icône « ${src} » : attribut sizes invalide`);
      continue;
    }
    if (src.endsWith('.png')) {
      const size = pngSize(src);
      if (!size) s.errors.push(`${rel} : « ${src} » n'est pas un PNG valide`);
      else if (size.width !== Number(match[1]) || size.height !== Number(match[2])) {
        s.errors.push(`${rel} : « ${src} » mesure ${size.width}x${size.height}, déclaré ${iconDef.sizes}`);
      }
    }
    for (const purpose of String(iconDef.purpose ?? 'any').split(/\s+/)) {
      if (!purposes.has(purpose)) purposes.set(purpose, new Set());
      purposes.get(purpose).add(Number(match[1]));
    }
  }
  const any = purposes.get('any') ?? new Set();
  if (!any.has(192) || !any.has(512)) s.errors.push(`${rel} : icônes 192x192 et 512x512 (purpose any) requises`);
  if (!purposes.has('maskable')) s.warnings.push(`${rel} : aucune icône maskable`);
}

function checkDataCoherence(json, s) {
  const actions = json.get('data/actions.json');
  const rules = json.get('data/rules.json');
  let actionIds = null;
  if (actions !== undefined) {
    const list = asList(actions, ['actions', 'templates', 'items']);
    if (list) actionIds = checkUniqueIds(list, 'data/actions.json', s);
    else s.warnings.push('data/actions.json : structure non reconnue (liste d\'actions attendue)');
  }
  if (rules !== undefined) {
    const list = asList(rules, ['rules', 'items']);
    if (!list) {
      s.warnings.push('data/rules.json : structure non reconnue (liste de règles attendue)');
    } else {
      checkUniqueIds(list, 'data/rules.json', s);
      for (const rule of list) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.axis !== undefined && !['ai_act', 'data'].includes(rule.axis)) {
          s.errors.push(`data/rules.json : règle « ${rule.id} » : axe inconnu « ${rule.axis} »`);
        }
        if (actionIds && Array.isArray(rule.action_ids)) {
          for (const id of rule.action_ids) {
            if (!actionIds.has(id)) s.errors.push(`data/rules.json : règle « ${rule.id} » : action inconnue « ${id} »`);
          }
        }
      }
    }
  }
  const calendar = json.get('data/regulatory-calendar.json');
  if (calendar !== undefined) {
    const list = asList(calendar, ['deadlines', 'entries', 'items', 'events']);
    if (!list) {
      s.warnings.push('data/regulatory-calendar.json : structure non reconnue (liste d\'échéances attendue)');
    } else {
      for (const entry of list) {
        if (entry && entry.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) {
          s.errors.push(`data/regulatory-calendar.json : date invalide « ${entry.date} » (YYYY-MM-DD attendu)`);
        }
        for (const key of ['date', 'label', 'status', 'source_url', 'last_verified']) {
          if (entry && entry[key] === undefined) {
            s.warnings.push(`data/regulatory-calendar.json : « ${entry.id ?? entry.label ?? '?'} » sans champ « ${key} »`);
          }
        }
      }
    }
  }
}

function checkJson() {
  const s = section('3', 'JSON, manifest et cohérence des données');
  const files = [
    ...walkFiles('data').filter((file) => file.endsWith('.json')),
    ...walkFiles('src/i18n').filter((file) => file.endsWith('.json')),
  ].sort();
  const parsed = new Map();
  for (const file of files) {
    const value = parseJson(file, s);
    if (value === undefined) continue;
    parsed.set(file, value);
    if (file.startsWith('src/i18n/')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) s.errors.push(`${file} : un objet est attendu`);
      else checkI18nLeaves(value, file, '', s);
    }
  }
  checkDataCoherence(parsed, s);
  checkManifest(s);
  s.notes.push(`${files.length} fichiers JSON lus, manifest vérifié.`);
  return s;
}

// ---------------------------------------------------------------------------------------------
// (4) Structure de index.html
// ---------------------------------------------------------------------------------------------

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const TOKEN_RE = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/gi;
const ATTR_TOKEN_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Découpe un document HTML en balises. Tout « <lettre » ou « </lettre » que l'analyseur ne sait pas
 * lire (syntaxe inhabituelle : « <img/onerror=…> », attributs collés…) est relevé dans
 * tags.malformed : un attribut on*= ou style= ne peut ainsi pas passer inaperçu.
 */
export function parseHtml(source) {
  const tags = [];
  const malformed = [];
  const flagGap = (from, to) => {
    const re = /<\/?[a-zA-Z]/g;
    const gap = source.slice(from, to);
    let found;
    while ((found = re.exec(gap))) {
      malformed.push({ line: lineOf(source, from + found.index), text: gap.slice(found.index, found.index + 60).split('\n')[0] });
    }
  };
  TOKEN_RE.lastIndex = 0;
  let lastEnd = 0;
  let match;
  while ((match = TOKEN_RE.exec(source))) {
    flagGap(lastEnd, match.index);
    const raw = match[0];
    lastEnd = TOKEN_RE.lastIndex;
    if (raw.startsWith('<!')) continue;
    const closing = raw.startsWith('</');
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    const name = nameMatch[1].toLowerCase();
    const attrs = new Map();
    const attrText = raw.slice(nameMatch[0].length).replace(/\/?>$/, '');
    ATTR_TOKEN_RE.lastIndex = 0;
    let attr;
    while ((attr = ATTR_TOKEN_RE.exec(attrText))) {
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const tag = { name, closing, attrs, line: lineOf(source, match.index), content: '' };
    tags.push(tag);
    if (!closing && RAW_TEXT.has(name)) {
      const end = source.toLowerCase().indexOf(`</${name}`, TOKEN_RE.lastIndex);
      const stop = end === -1 ? source.length : end;
      tag.content = source.slice(TOKEN_RE.lastIndex, stop);
      TOKEN_RE.lastIndex = stop;
      lastEnd = stop;
    }
  }
  flagGap(lastEnd, source.length);
  Object.defineProperty(tags, 'malformed', { value: malformed, enumerable: false });
  return tags;
}

/** Politique CSP (attribut content du <meta http-equiv>) d'un document analysé, ou null. */
function cspOf(tags) {
  const meta = tags.find((tag) => tag.name === 'meta' && (tag.attrs.get('http-equiv') ?? '').toLowerCase() === 'content-security-policy');
  return meta ? (meta.attrs.get('content') ?? '') : null;
}

// Chemin du site de projet GitHub Pages : https://<compte>.github.io/<dépôt>/.
const PROJECT_PATH = '/Recensia/';

/**
 * Chemin sous lequel GitHub Pages publie le site : « / » avec un domaine dédié (fichier CNAME),
 * « /Recensia/ » (nom du dépôt) sinon.
 */
export function pagesBasePath(root = ROOT) {
  return existsSync(join(root, 'CNAME')) ? '/' : PROJECT_PATH;
}

/**
 * Adresse locale d'une page servie à une profondeur inconnue (404.html) : elle doit être absolue et
 * rester sous basePath, sinon elle peut viser un autre site de la même origine (…github.io/404.js).
 * → { ok: true, path: 'chemin relatif au dépôt' } ou { ok: false, reason }
 */
export function projectPathOf(value, basePath) {
  const path = String(value).split(/[?#]/)[0];
  if (!path.startsWith('/')) return { ok: false, reason: 'relative' };
  if (!path.startsWith(basePath) || /(?:^|\/)\.\.?(?:\/|$)|%2e/i.test(path.slice(basePath.length))) return { ok: false, reason: 'outside' };
  return { ok: true, path: path.slice(basePath.length) };
}

/**
 * Structure d'une page HTML du site : balises équilibrées, id uniques, aucun style ni script inline,
 * ressources locales présentes, CSP stricte. basePath : page servie à une profondeur inconnue
 * (404.html) ; toute adresse locale doit être absolue et rester sous ce chemin (voir projectPathOf).
 * → { tags, ids, moduleScripts: [src…], policy }
 */
function checkHtmlStructure(rel, source, s, { basePath = null } = {}) {
  const tags = parseHtml(source);
  const where = (line) => `${rel}:${line}`;
  for (const bad of tags.malformed) {
    s.errors.push(`${where(bad.line)} : balise non analysable « ${bad.text} » (écrire les attributs séparés par des espaces)`);
  }
  const stack = [];
  const ids = new Map();
  const moduleScripts = [];
  for (const tag of tags) {
    if (tag.closing) {
      const open = stack.pop();
      if (!open) s.errors.push(`${where(tag.line)} : </${tag.name}> sans balise ouvrante`);
      else if (open.name !== tag.name) s.errors.push(`${where(tag.line)} : </${tag.name}> ferme <${open.name}> (ouverte ligne ${open.line})`);
      continue;
    }
    if (!VOID_ELEMENTS.has(tag.name)) stack.push(tag);
    for (const [name, value] of tag.attrs) {
      if (name === 'style') s.errors.push(`${where(tag.line)} : attribut style= interdit (CSP)`);
      if (/^on[a-z]/.test(name)) s.errors.push(`${where(tag.line)} : attribut ${name}= interdit (CSP)`);
      if (name === 'id') {
        if (ids.has(value)) s.errors.push(`${where(tag.line)} : id « ${value} » déjà utilisé ligne ${ids.get(value)}`);
        else ids.set(value, tag.line);
      }
    }
    if (tag.name === 'style') s.errors.push(`${where(tag.line)} : balise <style> interdite (CSP)`);
    if (tag.name === 'script') {
      if (!tag.attrs.has('src') || tag.content.trim() !== '') s.errors.push(`${where(tag.line)} : script inline interdit (CSP)`);
      if (tag.attrs.get('type') === 'module') moduleScripts.push(tag.attrs.get('src') ?? '');
    }
    // Ressources locales référencées : elles doivent exister.
    for (const attrName of ['href', 'src']) {
      const value = tag.attrs.get(attrName);
      if (!value || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value)) continue;
      let path = value.split(/[?#]/)[0];
      if (basePath !== null) {
        const local = projectPathOf(value, basePath);
        if (!local.ok) {
          s.errors.push(local.reason === 'relative'
            ? `${where(tag.line)} : chemin relatif « ${value} » interdit (page servie à une profondeur inconnue : écrire « ${basePath}… »)`
            : `${where(tag.line)} : « ${value} » sort du projet ${basePath} (un autre site de la même origine pourrait le servir)`);
          continue;
        }
        path = local.path;
      }
      if (['a'].includes(tag.name)) continue;
      if (path && !existsSync(join(ROOT, path))) s.errors.push(`${where(tag.line)} : ressource introuvable « ${value} »`);
      if (tag.name === 'link' && /\.png$/i.test(path) && existsSync(join(ROOT, path))) {
        // Sans attribut sizes, une icône apple-touch doit mesurer 180 × 180.
        const declared = tag.attrs.get('sizes') ?? (tag.attrs.get('rel') === 'apple-touch-icon' ? '180x180' : null);
        const size = pngSize(path);
        if (!size) s.errors.push(`${where(tag.line)} : « ${path} » n'est pas un PNG valide`);
        else if (declared && declared !== `${size.width}x${size.height}`) {
          s.errors.push(`${where(tag.line)} : « ${path} » mesure ${size.width}x${size.height}, attendu ${declared}`);
        }
      }
    }
  }
  for (const open of stack) s.errors.push(`${where(open.line)} : <${open.name}> jamais fermée`);

  const policy = cspOf(tags);
  if (policy === null) {
    s.errors.push(`${rel} : politique CSP absente (<meta http-equiv="Content-Security-Policy">)`);
  } else {
    if (/'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'/.test(policy)) s.errors.push(`${rel} : CSP : unsafe-inline / unsafe-eval interdits`);
    const scriptSrc = /(?:^|;)\s*script-src\s+([^;]*)/.exec(policy)?.[1].trim().split(/\s+/) ?? [];
    const extra = scriptSrc.filter((source) => !["'self'", 'https://gc.zgo.at'].includes(source));
    if (!scriptSrc.length) s.errors.push(`${rel} : CSP : directive script-src manquante`);
    if (extra.length) s.errors.push(`${rel} : CSP : sources de script non autorisées : ${extra.join(' ')}`);
    if (!/(?:^|;)\s*object-src\s+'none'/.test(policy)) s.warnings.push(`${rel} : CSP : object-src 'none' conseillé`);
  }
  return { tags, ids, moduleScripts, policy };
}

function checkIndexHtml() {
  const s = section('4', 'Structure de index.html et 404.html');
  const rel = 'index.html';
  if (!existsSync(join(ROOT, rel))) {
    s.errors.push(`${rel} absent`);
    return s;
  }
  const index = checkHtmlStructure(rel, read(rel), s);
  if (index.moduleScripts.length !== 1) s.warnings.push(`${index.moduleScripts.length} scripts de type module (un seul attendu : src/app.js)`);
  s.notes.push(`${rel} : ${index.tags.length} balises analysées, ${index.ids.size} identifiants uniques.`);

  // 404.html : page autonome servie par GitHub Pages pour les adresses inconnues (liens « %23 »).
  const notFound = '404.html';
  if (existsSync(join(ROOT, notFound))) {
    const basePath = pagesBasePath();
    const page = checkHtmlStructure(notFound, read(notFound), s, { basePath });
    if (page.policy !== null && index.policy !== null && page.policy !== index.policy) {
      s.errors.push(`${notFound} : la CSP doit être identique à celle d'index.html`);
    }
    if (!page.moduleScripts.length) s.errors.push(`${notFound} : aucun script (404.js attendu)`);
    for (const src of page.moduleScripts) {
      if (src !== `${basePath}404.js`) s.errors.push(`${notFound} : script inattendu « ${src} » (seul ${basePath}404.js est autorisé)`);
    }
    s.notes.push(`${notFound} : ${page.tags.length} balises analysées, ${page.ids.size} identifiants uniques.`);
  } else {
    s.warnings.push(`${notFound} absent : un lien dont le « # » a été encodé en « %23 » mène à la page 404 générique de GitHub`);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// (5) Secrets
// ---------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  { label: 'clé privée PEM', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'jeton GitHub', re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/ },
  { label: 'jeton GitHub (PAT)', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { label: 'clé AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'jeton Slack', re: /\bxox[bpas]-[A-Za-z0-9-]{10,}/ },
  { label: 'clé d\'API (sk-…)', re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'valeur JWK privée « d »', re: /["']?\bd["']?\s*:\s*["'][A-Za-z0-9_-]{43}["']/, allow: (file) => file.startsWith('tests/vectors/') },
];
// Affectation littérale longue à un identifiant qui contient token, secret, password… y compris
// composé (apiToken, secretKey, DB_PASSWORD) ; looksRandom() écarte les valeurs d'exemple.
const LITERAL_SECRET_RE = /\b[A-Za-z0-9_$]*?(?:api[_-]?key|token|secret|password|passwd|pwd)[A-Za-z0-9_$]*["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-+/=.]{20,})["'`]/gi;
const FORBIDDEN_FILES = [/\.recensia-key$/i, /\.rcn$/i, /(^|\/)recensia-sauvegarde-[^/]*\.json$/i];

function looksRandom(value) {
  if (/example|exemple|placeholder|changeme|xxxx|dummy|your[_-]/i.test(value)) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value) && new Set(value).size >= 10;
}

/** Secrets probables dans le texte d'un fichier du dépôt → [{ line, label }]. */
export function findSecrets(file, text) {
  const problems = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.allow?.(file)) continue;
    const match = pattern.re.exec(text);
    if (match) problems.push({ line: lineOf(text, match.index), label: `${pattern.label} détecté(e)` });
  }
  LITERAL_SECRET_RE.lastIndex = 0;
  let match;
  while ((match = LITERAL_SECRET_RE.exec(text))) {
    if (looksRandom(match[1])) problems.push({ line: lineOf(text, match.index), label: 'affectation littérale suspecte (secret, jeton ou mot de passe)' });
  }
  return problems;
}

/** Fichier dont le nom seul est interdit dans le dépôt (clé, codes, sauvegarde). */
export function isForbiddenFile(file) {
  return FORBIDDEN_FILES.some((re) => re.test(file));
}

function checkSecrets() {
  const s = section('5', 'Secrets et fichiers sensibles');
  const files = repoFiles();
  if (!gitAvailable) s.warnings.push('git indisponible : parcours complet du dossier (fichiers ignorés compris)');
  let scanned = 0;
  for (const file of files) {
    if (isForbiddenFile(file)) s.errors.push(`${file} : fichier sensible (clé ou codes de campagne) à ne pas committer`);
    if (BINARY_EXT.test(file)) continue;
    let text;
    try {
      if (statSync(join(ROOT, file)).size > 8 * 1024 * 1024) continue;
      text = read(file);
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    scanned += 1;
    for (const problem of findSecrets(file, text)) s.errors.push(`${file}:${problem.line} : ${problem.label}`);
  }
  // Même ignorés par git, ces fichiers n'ont rien à faire dans le dépôt (un « git add -f » suffirait).
  const ignored = git(['ls-files', '-z', '-o', '-i', '--exclude-standard']) ?? [];
  for (const file of ignored) {
    if (isForbiddenFile(file)) s.errors.push(`${file} : fichier sensible présent dans le dépôt (ignoré par git, mais à supprimer ou déplacer)`);
  }
  s.notes.push(`${scanned} fichiers texte analysés.`);
  return s;
}

// ---------------------------------------------------------------------------------------------
// (6) Précache du service worker
// ---------------------------------------------------------------------------------------------

async function checkPrecache() {
  const s = section('6', 'sw-precache.js à jour et version cohérente');
  const expected = await buildPrecache(ROOT);
  const path = join(ROOT, PRECACHE_FILE);
  let current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (FIX && current !== expected.content) {
    await writeFile(path, expected.content);
    s.notes.push(`${PRECACHE_FILE} régénéré (${expected.files.length} fichiers, version ${expected.version}).`);
    current = expected.content;
  }
  if (current === null) {
    s.errors.push(`${PRECACHE_FILE} absent : lancez « node tools/precache.mjs »`);
    return s;
  }
  for (const file of ['./404.html', './404.js']) {
    if (expected.files.includes(file)) s.errors.push(`${file.slice(2)} ne doit pas figurer dans le précache (page 404 autonome)`);
  }
  const appVersion = await readAppVersion(ROOT);
  const version = /version:\s*'([^']+)'/.exec(current)?.[1];
  if (!version || !version.startsWith(`${appVersion}-`)) {
    s.errors.push(`version du précache « ${version ?? '?'} » incohérente avec appVersion « ${appVersion} » (config.js)`);
  }
  if (current !== expected.content) {
    const listed = new Set([...current.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]));
    const added = expected.files.filter((file) => !listed.has(file));
    const removed = [...listed].filter((file) => !expected.files.includes(file));
    const detail = [
      added.length ? `à ajouter : ${added.slice(0, 5).join(', ')}${added.length > 5 ? '…' : ''}` : null,
      removed.length ? `à retirer : ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}` : null,
      !added.length && !removed.length ? 'contenu modifié' : null,
    ].filter(Boolean).join(' ; ');
    s.errors.push(`${PRECACHE_FILE} n'est pas à jour (${detail}) : lancez « node tools/precache.mjs » ou « node tools/check.mjs --fix »`);
  } else {
    s.notes.push(`${expected.files.length} fichiers, version ${expected.version}.`);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// (9) Version de l'application
// ---------------------------------------------------------------------------------------------

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function compareMinor(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * Versions citées dans l'état d'avancement du CDC (§5bis) : lignes « - ✅ **vX.Y … » (livrées) et
 * « - 🚧 **… vX.Y** » (en cours). → { released: [[X, Y]…], inProgress: [[X, Y]…] } dans l'ordre du texte.
 */
export function cdcVersions(text) {
  const released = [];
  const inProgress = [];
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => /^##\s+5bis\b/.test(line));
  if (start === -1) return { released, inProgress };
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line) || /^---\s*$/.test(line)) break;
    const match = /^\s*-\s*(✅|🚧)\s*\*\*[^*\n]*?\bv(\d+)\.(\d+)\b/u.exec(line);
    if (!match) continue;
    (match[1] === '✅' ? released : inProgress).push([Number(match[2]), Number(match[3])]);
  }
  return { released, inProgress };
}

/**
 * Cohérence de la version affichée (pied de page, sauvegardes, nom du cache) : appVersion de config.js
 * = version de package.json, et au moins égale à la dernière version livrée du CDC §5bis.
 * → { errors: [], warnings: [], notes: [] }
 */
export function versionIssues({ appVersion, packageVersion, cdcText }) {
  const out = { errors: [], warnings: [], notes: [] };
  const app = SEMVER_RE.exec(String(appVersion ?? ''));
  if (!app) {
    out.errors.push(`appVersion « ${appVersion ?? '?'} » (config.js) : format X.Y.Z attendu`);
    return out;
  }
  if (packageVersion === undefined || packageVersion === null) {
    out.warnings.push('package.json : champ « version » absent');
  } else if (packageVersion !== appVersion) {
    out.errors.push(`package.json (${packageVersion}) et config.js (${appVersion}) ont des versions différentes`);
  }
  if (cdcText === null || cdcText === undefined) {
    out.warnings.push('docs/CDC.md absent : version non comparée à l\'état d\'avancement (§5bis)');
    return out;
  }
  const { released, inProgress } = cdcVersions(cdcText);
  const current = [Number(app[1]), Number(app[2])];
  const fmt = ([major, minor]) => `v${major}.${minor}`;
  if (!released.length) {
    out.warnings.push('CDC §5bis : aucune ligne « ✅ vX.Y » trouvée');
    return out;
  }
  const last = released.reduce((max, v) => (compareMinor(v, max) > 0 ? v : max));
  const diff = compareMinor(current, last);
  if (diff < 0) {
    out.errors.push(`appVersion ${appVersion} en retard sur la dernière version livrée du CDC §5bis (${fmt(last)}) : incrémenter appVersion (config.js et package.json)`);
  } else if (diff > 0 && !inProgress.some((v) => compareMinor(v, current) === 0)) {
    out.warnings.push(`appVersion ${appVersion} en avance sur le CDC §5bis (dernière version livrée : ${fmt(last)}) : mettre à jour l'état d'avancement`);
  } else {
    out.notes.push(`appVersion ${appVersion} : cohérente avec package.json et le CDC §5bis (${diff > 0 ? `${fmt(current)} en cours` : fmt(last)}).`);
  }
  return out;
}

async function checkVersion() {
  const s = section('9', 'Version de l\'application (config.js, package.json, CDC §5bis)');
  const appVersion = await readAppVersion(ROOT);
  let packageVersion;
  try {
    packageVersion = JSON.parse(read('package.json')).version;
  } catch {
    s.warnings.push('package.json absent ou illisible');
  }
  const cdcText = existsSync(join(ROOT, 'docs/CDC.md')) ? read('docs/CDC.md') : null;
  const result = versionIssues({ appVersion, packageVersion, cdcText });
  s.errors.push(...result.errors);
  s.warnings.push(...result.warnings);
  s.notes.push(...result.notes);
  return s;
}

// ---------------------------------------------------------------------------------------------
// (7) Interdits dans src/
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_CODE = [
  { label: 'innerHTML', re: /\binnerHTML\b/g },
  { label: 'outerHTML', re: /\bouterHTML\b/g },
  { label: 'insertAdjacentHTML', re: /\binsertAdjacentHTML\b/g },
  { label: 'document.write', re: /\bdocument\s*\.\s*write(?:ln)?\b/g },
  { label: 'eval(', re: /\beval\s*\(/g },
  { label: 'new Function', re: /\bnew\s+Function\b/g },
  { label: "setAttribute('style'", re: /\.setAttribute\s*\(\s*['"`]style['"`]/g },
  { label: 'setTimeout/setInterval avec une chaîne', re: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/g },
];
const FETCH_ALLOWED = new Set(['src/data.js', 'src/i18n.js']);
const URL_RE = /\bhttps?:\/\/[^\s'"`<>()\\]+/g;
const ALWAYS_ALLOWED_HOSTS = [
  (host) => host === 'www.w3.org', // espaces de noms SVG / XLink
  (host) => /(^|\.)exemple\.(fr|com)$|(^|\.)example\.(com|org|net)$/.test(host),
  (host) => host === 'manicalabs.github.io',
];

function hostOf(url) {
  return (/^https?:\/\/([^/?#:]+)/.exec(url)?.[1] ?? '').toLowerCase();
}

function urlAllowed(file, url) {
  const host = hostOf(url);
  if (ALWAYS_ALLOWED_HOSTS.some((allow) => allow(host))) return true;
  if (file === 'src/analytics.js') return host === 'gc.zgo.at' || host === 'goatcounter.com' || host.endsWith('.goatcounter.com');
  if (file.startsWith('src/share/')) return true;
  return false;
}

/** Code source sans commentaires (JS ou CSS), pour les analyses statiques. */
export function codeOf(file, text) {
  if (/\.(m|c)?js$/.test(file)) return stripJsComments(text);
  if (file.endsWith('.css')) return stripCssComments(text);
  return text;
}

/** Interdits d'un module de src/ (commentaires exclus) → [{ line, label }]. */
export function findForbiddenCode(file, text) {
  const code = codeOf(file, text);
  const problems = [];
  for (const rule of FORBIDDEN_CODE) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(code))) problems.push({ line: lineOf(code, match.index), label: rule.label });
  }
  if (!FETCH_ALLOWED.has(file)) {
    const re = /\bfetch\s*\(/g;
    let match;
    while ((match = re.exec(code))) problems.push({ line: lineOf(code, match.index), label: 'fetch( réservé à src/data.js et src/i18n.js' });
  }
  return problems;
}

/** URL http(s) tierces non autorisées d'un fichier de src/ (commentaires exclus) → [{ line, url }]. */
export function findThirdPartyUrls(file, text) {
  const code = codeOf(file, text);
  const problems = [];
  URL_RE.lastIndex = 0;
  let match;
  while ((match = URL_RE.exec(code))) {
    if (!urlAllowed(file, match[0])) problems.push({ line: lineOf(code, match.index), url: match[0] });
  }
  return problems;
}

// Scripts de page hors de src/ soumis aux mêmes interdits.
const PAGE_SCRIPTS = ['404.js'];

function checkForbidden() {
  const s = section('7', 'Interdits dans src/ et 404.js (HTML brut, eval, style inline, réseau)');
  const code = [...srcFiles(['.js', '.mjs']), ...PAGE_SCRIPTS.filter((file) => existsSync(join(ROOT, file)))];
  for (const file of code) {
    for (const problem of findForbiddenCode(file, read(file))) s.errors.push(`${file}:${problem.line} : ${problem.label}`);
  }
  for (const file of [...srcFiles(['.js', '.mjs', '.css', '.json', '.html']), ...PAGE_SCRIPTS.filter((f) => existsSync(join(ROOT, f)))]) {
    for (const problem of findThirdPartyUrls(file, read(file))) {
      s.errors.push(`${file}:${problem.line} : URL tierce non autorisée « ${problem.url} »`);
    }
  }
  s.notes.push(`${code.length} modules analysés (commentaires exclus).`);
  return s;
}

// ---------------------------------------------------------------------------------------------
// (8) Clés i18n
// ---------------------------------------------------------------------------------------------

// t('…'), ainsi que ses alias usuels (translate, tr) ; un gabarit `…` sans ${…} compte comme littéral.
const T_CALL_RE = /\b(?:t|tr|translate)\(\s*(['"`])([a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)\1\s*[,)]/g;
const DATA_I18N_RE = /\sdata-i18n(?:-[a-z-]+)?\s*=\s*"([^"]*)"/g;

/** Clés littérales t('ns.clé') (ou translate / tr) d'un module, commentaires exclus → [{ key, line }]. */
export function findI18nKeys(file, text) {
  const code = codeOf(file, text);
  const keys = [];
  T_CALL_RE.lastIndex = 0;
  let match;
  while ((match = T_CALL_RE.exec(code))) keys.push({ key: match[2], line: lineOf(code, match.index) });
  return keys;
}

function lookupKey(catalog, path) {
  let current = catalog;
  for (const part of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function checkI18nKeys() {
  const s = section('8', 'Clés i18n utilisées dans src/');
  const catalogs = new Map();
  const missingNamespaces = new Map();
  const uses = srcFiles(['.js', '.mjs']).flatMap((file) => findI18nKeys(file, read(file)).map((use) => ({ file, ...use })));
  if (existsSync(join(ROOT, 'index.html'))) {
    const html = read('index.html');
    DATA_I18N_RE.lastIndex = 0;
    let match;
    while ((match = DATA_I18N_RE.exec(html))) uses.push({ file: 'index.html', key: match[1], line: lineOf(html, match.index) });
  }
  for (const use of uses) {
    const { file } = use;
    if (!/^[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)+$/.test(use.key)) {
      s.errors.push(`${file}:${use.line} : clé i18n mal formée « ${use.key} »`);
      continue;
    }
    const [ns, ...path] = use.key.split('.');
    if (!catalogs.has(ns)) {
      const rel = `src/i18n/fr/${ns}.json`;
      let catalog = null;
      if (existsSync(join(ROOT, rel))) {
        try {
          catalog = JSON.parse(read(rel));
        } catch {
          catalog = null; // signalé en (3)
        }
      }
      catalogs.set(ns, catalog);
    }
    const catalog = catalogs.get(ns);
    if (catalog === null) {
      if (!missingNamespaces.has(ns)) missingNamespaces.set(ns, new Set());
      missingNamespaces.get(ns).add(file);
      continue;
    }
    const value = lookupKey(catalog, path);
    const where = `${file}:${use.line}`;
    if (value === undefined) s.errors.push(`${where} : clé absente « ${use.key} » (src/i18n/fr/${ns}.json)`);
    else if (typeof value === 'object' && !(value && (typeof value.one === 'string' || typeof value.other === 'string'))) {
      s.errors.push(`${where} : « ${use.key} » désigne un groupe de clés, pas un texte`);
    }
  }
  for (const [ns, files] of missingNamespaces) {
    s.warnings.push(`espace de noms « ${ns} » : src/i18n/fr/${ns}.json absent (utilisé dans ${[...files].join(', ')})`);
  }
  s.notes.push(`${uses.length} clés littérales vérifiées (t('…') dans src/, data-i18n dans index.html).`);
  return s;
}

// ---------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------

const FIX = process.argv.includes('--fix');

async function main() {
  console.log(paint('1', 'Recensia — validation avant push (CDC §12)'));
  const steps = [checkSyntax, checkJson, checkIndexHtml, checkSecrets, checkPrecache, checkForbidden, checkI18nKeys, checkVersion];
  for (const step of steps) {
    try {
      printSection(await step());
    } catch (err) {
      const s = section('!', `Erreur interne (${step.name})`);
      s.errors.push(err.stack ?? String(err));
      printSection(s);
    }
  }
  const errors = sections.reduce((sum, s) => sum + s.errors.length, 0);
  const warnings = sections.reduce((sum, s) => sum + s.warnings.length, 0);
  console.log(`\n(2) Tests : lancer « node --test ».`);
  const summary = `Résultat : ${errors} erreur(s), ${warnings} avertissement(s).`;
  console.log(errors ? paint('31;1', summary) : paint('32;1', summary));
  process.exitCode = errors ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
