// Presse-papiers : API asynchrone quand elle est disponible, repli sur une zone de texte temporaire.

import { h } from './dom.js';

function fallbackCopy(text) {
  const d = globalThis.document;
  if (!d?.body) return false;
  // Dans une boîte de dialogue modale, le reste de la page est inerte : y placer la zone de texte.
  const host = d.querySelector('dialog[open]') ?? d.body;
  const previous = d.activeElement;
  const area = h('textarea', { class: 'clipboard-buffer', readonly: true, 'aria-hidden': 'true', tabindex: '-1', value: text });
  host.appendChild(area);
  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    ok = d.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    area.remove();
    if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
  }
  return ok;
}

/** Copie du texte brut. Renvoie true en cas de succès. */
export async function copyText(text) {
  const value = String(text ?? '');
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // permission refusée ou contexte non sécurisé : repli
    }
  }
  return fallbackCopy(value);
}

/**
 * Copie en texte riche (lien cliquable dans Outlook, Teams…) avec une version texte brut.
 * Repli sur copyText(text) si l'API n'est pas disponible.
 */
export async function copyRich(html, text) {
  const clipboard = globalThis.navigator?.clipboard;
  const Item = globalThis.ClipboardItem;
  if (clipboard && typeof clipboard.write === 'function' && typeof Item === 'function') {
    try {
      await clipboard.write([new Item({
        'text/html': new Blob([String(html ?? '')], { type: 'text/html' }),
        'text/plain': new Blob([String(text ?? '')], { type: 'text/plain' }),
      })]);
      return true;
    } catch {
      // repli texte brut
    }
  }
  return copyText(text);
}
