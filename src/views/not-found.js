// Page introuvable (route inconnue ou lien tronqué).

import { h, mount } from '../ui/dom.js';
import { icon } from '../ui/components.js';

export async function render(root, { ctx }) {
  const { t } = ctx;
  ctx.setTitle(t('not_found.title'));
  mount(root, h('div', { class: 'page page-narrow' },
    h('div', { class: 'empty-state' },
      h('span', { class: 'empty-state-icon' }, icon('alert')),
      h('h1', null, t('not_found.title')),
      h('p', { class: 'lead' }, t('not_found.text')),
      h('p', { class: 'muted' }, t('not_found.hint')),
      h('p', null, h('a', { class: 'btn btn-primary', href: '#/' }, icon('arrow-left'), h('span', null, t('not_found.back_home')))))));
}
