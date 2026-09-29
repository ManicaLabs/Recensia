// Lecture des sources du dépôt pour les analyses statiques des tests.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Fichiers (chemins relatifs au dépôt) sous dir, filtrés par extension, triés. */
export function listFiles(dir, extensions = ['.js', '.mjs']) {
  const out = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) out.push(child);
    }
  };
  walk(dir);
  return out.sort();
}

export function readSource(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

export function readJson(rel) {
  return JSON.parse(readSource(rel));
}

export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}
