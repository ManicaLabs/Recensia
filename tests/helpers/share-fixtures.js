// Données et générateurs communs aux tests du module de partage (src/share/).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadJson(relPath) {
  return JSON.parse(readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf8'));
}

export const BASE_URL = 'https://manicalabs.github.io/Recensia/';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Chaîne base64url pseudo-aléatoire déterministe. */
export function b64urlString(length, seed = 1) {
  let s = seed >>> 0 || 1;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out += B64[(s >>> 16) & 63];
  }
  return out;
}

/** Faux code de réponse RCN1.… de `length` caractères au total. */
export function fakeCode(length = 650, seed = 1) {
  return `RCN1.${b64urlString(length - 5, seed)}`;
}

/** Lien de collecte fictif de `length` caractères. */
export function fakeCollectLink(length = 1500, seed = 3) {
  const base = `${BASE_URL}#/c/`;
  return base + b64urlString(length - base.length, seed);
}

/** Faux JWK privé : la valeur de « d » ne doit apparaître dans aucune sortie. */
export const FAKE_JWK = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'FAUX_d_prive_qui_ne_doit_jamais_apparaitre_dans_un_message',
});

export const PRIVATE_MARKERS = Object.freeze([FAKE_JWK.d, '"d"', 'private_key_jwk', 'SECRET-DO-NOT-LEAK']);

/** Cibles représentatives, et cibles de longueur maximale. */
export const TARGETS = Object.freeze({
  mailto: 'ia@exemple.fr',
  copy: 'Collez votre code dans le formulaire anonyme « Boîte à idées IA »',
  file: 'Déposez le fichier dans le dossier partagé « Recensement IA »',
  whatsapp: '+33 6 12 34 56 78',
});

export const LONG_TARGETS = Object.freeze({
  mailto: `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.exemple.fr`,
  copy: `Consigne ${'é'.repeat(191)}`,
  file: `Dépôt ${'x'.repeat(194)}`,
  whatsapp: '+33 6 12 34 56 78 90 12',
});

function combinations(list, k) {
  if (k === 0) return [[]];
  const out = [];
  list.forEach((item, i) => {
    for (const rest of combinations(list.slice(i + 1), k - 1)) out.push([item, ...rest]);
  });
  return out;
}

/**
 * Ensembles de canaux : aucun, chaque type seul, toutes les combinaisons de 2 et 3 types,
 * chacun avec et sans cible (et avec cibles de longueur maximale).
 * → [{ name, channels }]
 */
export function channelSets(channelsData) {
  const types = Object.keys(channelsData.types);
  const sets = [{ name: 'aucun', channels: [] }];
  for (const k of [1, 2, 3]) {
    for (const combo of combinations(types, k)) {
      const withTarget = combo.map((type) => (TARGETS[type] ? { type, target: TARGETS[type] } : { type }));
      const longTarget = combo.map((type) => (LONG_TARGETS[type] ? { type, target: LONG_TARGETS[type] } : { type }));
      const noTarget = combo.map((type) => ({ type }));
      sets.push({ name: `${combo.join('+')} (cibles)`, channels: withTarget });
      sets.push({ name: `${combo.join('+')} (sans cible)`, channels: noTarget });
      sets.push({ name: `${combo.join('+')} (cibles longues)`, channels: longTarget });
    }
  }
  return sets;
}
