// Éléments d'affichage partagés par le registre et son détail : niveau d'une ligne (badge et
// mentions « surchargé » / « à qualifier ») et encart d'erreur persistant. Aucun accès au document
// à l'import (testés sous Node avec un faux document).

import { h } from '../../../ui/dom.js';
import { levelBadge, callout } from '../../../ui/components.js';
import { aiActDisplay, dataDisplay } from './filters.js';

/**
 * Niveau retenu d'une ligne sur un axe ('ai_act' | 'data'), avec ses mentions.
 * axisLabel (voir levelBadge) : 'visible' sur les cartes mobiles, 'none' sous un en-tête de colonne
 * ou un intitulé qui nomme déjà l'axe.
 */
export function levelCell(axis, group, t, { axisLabel = 'hidden' } = {}) {
  const isData = axis === 'data';
  const shown = isData ? dataDisplay(group) : aiActDisplay(group);
  return h('span', { class: 'registry-level' },
    levelBadge(isData ? 'data' : 'ai_act', shown.level, t, { axisLabel }),
    shown.overridden ? h('span', { class: 'registry-flag' }, t('registry.table.overridden')) : null,
    isData && shown.toQualify ? h('span', { class: 'registry-flag is-warn' }, t('registry.table.to_qualify')) : null);
}

/** Emplacement (vide et masqué) d'un encart d'erreur persistant. */
export function alertSlot(className) {
  const slot = h('div', { class: className });
  slot.hidden = true;
  return slot;
}

/**
 * Affiche dans slot un encart « danger » annoncé (role="alert"), ou le vide avec null. L'encart reste
 * affiché jusqu'à la prochaine opération (contrairement à une notification, qui peut être fermée ou
 * masquée par une boîte de dialogue). → l'encart créé, ou null.
 */
export function setAlert(slot, message) {
  if (!slot) return null;
  if (!message) {
    slot.replaceChildren();
    slot.hidden = true;
    return null;
  }
  const node = callout('danger', h('p', null, String(message)));
  node.setAttribute('role', 'alert');
  slot.replaceChildren(node);
  slot.hidden = false;
  return node;
}
