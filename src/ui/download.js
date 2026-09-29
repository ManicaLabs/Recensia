// Téléchargement de fichiers générés dans le navigateur (aucun envoi réseau).

import { h } from './dom.js';

const REVOKE_DELAY_MS = 60_000;

/** Nom de fichier sûr : sans séparateurs de chemin ni caractères de contrôle. */
export function safeFilename(name, fallback = 'recensia') {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .slice(0, 150);
  return cleaned || fallback;
}

/** Propose le téléchargement d'un Blob. */
export function downloadBlob(blob, filename) {
  const d = globalThis.document;
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: safeFilename(filename), class: 'visually-hidden', tabindex: '-1' });
  d.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Révocation différée : certains navigateurs lisent l'URL après le clic.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/** Propose le téléchargement d'un texte (UTF-8 par défaut). */
export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([String(text ?? '')], { type: mime }), filename);
}
