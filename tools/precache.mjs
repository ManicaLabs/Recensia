#!/usr/bin/env node
// Génère sw-precache.js : liste triée des fichiers du shell, empreinte SHA-256 de chacun, type MIME par
// extension et version dérivée du contenu. Le service worker ne sert une copie du cache que si son
// empreinte correspond : CacheStorage est partagé par toute l'origine (…github.io), un autre site publié
// sous la même origine peut y écrire. sw.js et ce fichier, eux, ne passent pas par CacheStorage.
// Usage : node tools/precache.mjs   (déterministe : même contenu ⇒ même fichier)

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUTPUT = 'sw-precache.js';

const ROOT_FILES = [
  'index.html', 'manifest.webmanifest', 'config.js',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon-32.png', 'apple-touch-icon.png',
];
const TREES = ['src', 'data'];

/** Type MIME servi par le service worker pour une copie vérifiée (les en-têtes du cache ne sont pas repris). */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

/** Extension en minuscules (« .js »), ou chaîne vide. */
export function extensionOf(file) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Empreinte au format SRI : « sha256- » + base64 du SHA-256 du contenu. */
export function integrityOf(content) {
  return `sha256-${createHash('sha256').update(content).digest('base64')}`;
}

function ignoredName(name) {
  return name.startsWith('.') || name.endsWith('~') || /\.(swp|swo|tmp|bak|orig|rej)$/i.test(name) || name === 'Thumbs.db';
}

async function walk(root, dir, out) {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (ignoredName(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Fichiers à précacher, chemins relatifs « ./… » triés. */
export async function listPrecacheFiles(root = ROOT) {
  const files = ROOT_FILES.filter((name) => existsSync(join(root, name)));
  for (const tree of TREES) await walk(root, tree, files);
  try {
    const vendor = await readdir(join(root, 'vendor'), { withFileTypes: true });
    for (const entry of vendor) {
      if (entry.isFile() && entry.name.endsWith('.mjs') && !ignoredName(entry.name)) files.push(`vendor/${entry.name}`);
    }
  } catch {
    // pas de dossier vendor
  }
  for (const file of files) {
    if (/['\\\n\r]/.test(file)) throw new Error(`Nom de fichier non pris en charge dans le précache : ${file}`);
    if (!Object.hasOwn(MIME_TYPES, extensionOf(file))) {
      throw new Error(`Type de fichier non pris en charge dans le précache : ${file} (ajouter son extension à MIME_TYPES, tools/precache.mjs)`);
    }
  }
  return [...new Set(files)].map((file) => `./${file}`).sort();
}

/** Version de l'application lue dans config.js (sans l'exécuter). */
export async function readAppVersion(root = ROOT) {
  const source = await readFile(join(root, 'config.js'), 'utf8');
  const match = /appVersion\s*:\s*(['"])([^'"]+)\1/.exec(source);
  if (!match) throw new Error('appVersion introuvable dans config.js');
  return match[2];
}

/**
 * Texte de sw-precache.js. integrity : { './fichier': 'sha256-…' } ; types : { '.ext': 'type MIME' }
 * (seulement les extensions présentes).
 */
export function renderPrecache(version, files, integrity = {}) {
  const extensions = [...new Set(files.map(extensionOf))].sort();
  const lines = [
    '// Fichier généré par tools/precache.mjs : ne pas modifier à la main.',
    '// Régénérer avec « node tools/precache.mjs » ou « node tools/check.mjs --fix ».',
    '// integrity : empreinte SHA-256 de chaque fichier, vérifiée par sw.js avant de servir une copie du cache.',
    'self.__RECENSIA_PRECACHE = {',
    `  version: '${version}',`,
    '  files: [',
    ...files.map((file) => `    '${file}',`),
    '  ],',
    '  integrity: {',
    ...files.filter((file) => integrity[file]).map((file) => `    '${file}': '${integrity[file]}',`),
    '  },',
    '  types: {',
    ...extensions.map((ext) => `    '${ext}': '${MIME_TYPES[ext]}',`),
    '  },',
    '};',
    '',
  ];
  return lines.join('\n');
}

/**
 * Calcule la liste, l'empreinte de chaque fichier, la version (appVersion + 8 hex du SHA-256 du contenu)
 * et le texte du fichier. → { version, files, integrity, content }
 */
export async function buildPrecache(root = ROOT) {
  const appVersion = await readAppVersion(root);
  const files = await listPrecacheFiles(root);
  const hash = createHash('sha256');
  const integrity = {};
  // sw.js est inclus dans l'empreinte : une évolution de sa logique crée aussi un cache neuf.
  const hashed = existsSync(join(root, 'sw.js')) ? [...files, './sw.js'] : files;
  for (const file of hashed) {
    const content = await readFile(join(root, file.slice(2)));
    if (file !== './sw.js') integrity[file] = integrityOf(content);
    hash.update(file);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  const version = `${appVersion}-${hash.digest('hex').slice(0, 8)}`;
  return { version, files, integrity, content: renderPrecache(version, files, integrity) };
}

export async function writePrecache(root = ROOT) {
  const result = await buildPrecache(root);
  await writeFile(join(root, OUTPUT), result.content);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, files } = await writePrecache();
  console.log(`${OUTPUT} : ${files.length} fichiers, version ${version}`);
}
