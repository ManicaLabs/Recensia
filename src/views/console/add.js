// Onglet « Saisir un usage » de la console (#/admin/<id>/saisir, CDC §14 phase 1) : le responsable
// saisit lui-même un usage (entretien, atelier). Mode ouvert : déclarant facultatif (prénom, nom) ;
// mode anonyme : aucun déclarant. L'entrée (§3.3, source 'manual') est enregistrée dans le store.

import { h, mount, loadCss, announce } from '../../ui/dom.js';
import { button, callout, field, setFieldError, toast, levelBadge, disclaimer } from '../../ui/components.js';
import { renderQuestionnaire } from '../../ui/questionnaire.js';
import { randomId } from '../../crypto/random.js';
import { NAME_MAX } from '../../engine/validate.js';
import { classifyUsage } from '../../engine/classify.js';
import { buildManualEntry, declarantFrom } from '../form/entry.js';

// Saisie en cours par campagne, en mémoire seulement (changement d'onglet sans perte ;
// rien n'est écrit sur le disque avant l'enregistrement).
const pending = new Map();
// Dernier enregistrement, affiché après le rafraîchissement de l'onglet.
let lastSaved = null;

function registryHref(campaign) {
  return `#/admin/${campaign.id}/registre`;
}

/**
 * Confirmation affichée après l'enregistrement (exportée pour les tests) : nom de l'usage, classement
 * indicatif sur les deux axes, avertissement, lien vers le registre.
 * @param {{ id: string }} campaign
 * @param {{ name: string, classification: { ai_act_level: string, data_level: number } | null }} saved
 * @param {Function} t
 * @returns {HTMLElement}
 */
export function savedNotice(campaign, saved, t) {
  const badges = saved.classification
    ? h('p', { class: 'cluster add-levels' },
      h('span', null, t('add.saved.levels')),
      // Deux axes distincts (CDC D5) : l'axe est écrit à l'écran, pas seulement pour les lecteurs d'écran.
      levelBadge('ai_act', saved.classification.ai_act_level, t, { axisLabel: 'visible' }),
      levelBadge('data', saved.classification.data_level, t, { axisLabel: 'visible' }))
    : null;
  return h('div', { class: 'add-saved', role: 'status', tabindex: '-1' },
    callout('success',
      h('p', null, h('strong', null, t('add.saved.title', { name: saved.name }))),
      badges,
      saved.classification ? disclaimer(t) : null,
      h('p', null, h('a', { href: registryHref(campaign) }, t('add.saved.registry_link')))));
}

function declarantCard(t, initial, { onLastEnter } = {}) {
  // Entrée : champ suivant plutôt qu'un envoi implicite de tout le formulaire.
  const onEnter = (next) => (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    next();
  };
  const first = h('input', { type: 'text', name: 'declarant_first_name', autocomplete: 'off', enterkeyhint: 'next', maxlength: String(NAME_MAX), value: initial?.first_name ?? '', onKeydown: onEnter(() => last.focus()) });
  const last = h('input', { type: 'text', name: 'declarant_last_name', autocomplete: 'off', enterkeyhint: 'next', maxlength: String(NAME_MAX), value: initial?.last_name ?? '', onKeydown: onEnter(() => onLastEnter?.()) });
  const fields = {
    first_name: field({ id: 'add-first-name', label: t('add.declarant.first_name'), control: first }),
    last_name: field({ id: 'add-last-name', label: t('add.declarant.last_name'), control: last }),
  };
  const node = h('section', { class: 'card card-compact add-declarant', 'aria-labelledby': 'add-declarant-title' },
    h('h3', { id: 'add-declarant-title' }, t('add.declarant.title')),
    h('p', { class: 'muted small' }, t('add.declarant.help')),
    h('div', { class: 'add-declarant-grid' }, fields.first_name, fields.last_name));
  return {
    node,
    read: () => ({ first_name: first.value, last_name: last.value }),
    reset: () => { first.value = ''; last.value = ''; },
    showErrors(errors) {
      setFieldError(fields.first_name, null);
      setFieldError(fields.last_name, null);
      let target = null;
      for (const error of errors) {
        const key = error.field === 'last_name' ? 'last_name' : 'first_name';
        const message = error.code === 'required'
          ? (key === 'last_name' ? t('add.declarant.errors.last_name_required') : t('add.declarant.errors.first_name_required'))
          : error.code === 'too_long' ? t('add.declarant.errors.too_long', { max: NAME_MAX }) : t('add.declarant.errors.invalid');
        setFieldError(fields[key], message);
        if (!target) target = key === 'last_name' ? last : first;
      }
      target?.focus();
      return Boolean(target);
    },
  };
}

export async function render(root, { campaign, model, ctx, refresh }) {
  const { t, store } = ctx;
  await Promise.all([
    loadCss('src/styles/questionnaire.css'),
    loadCss('src/styles/form.css'),
    ctx.i18n.load('questionnaire').catch((err) => console.info('[Recensia] Textes « questionnaire » indisponibles.', err)),
  ]);

  const open = campaign.mode === 'open';
  const campaignOpts = {
    mode: campaign.mode,
    departments: Array.isArray(campaign.departments) ? campaign.departments : [],
    department_required: campaign.settings?.department_required === true,
  };
  const memo = pending.get(campaign.id) ?? { usage: null, declarant: null };
  const saved = lastSaved && lastSaved.campaignId === campaign.id ? lastSaved : null;
  lastSaved = null;

  const qRoot = h('div', { class: 'add-questionnaire' });
  const declarant = open ? declarantCard(t, memo.declarant, { onLastEnter: () => qRoot.querySelector('input, select, textarea')?.focus() }) : null;
  const status = h('p', { class: 'visually-hidden', role: 'status' });
  let saving = false;
  let disposed = false;

  const saveButton = button(t('add.save'), null, { variant: 'primary', type: 'submit', icon: 'check' });
  const form = h('form', {
    class: 'add-form',
    novalidate: true,
    'aria-labelledby': 'console-tab-title',
    onSubmit: (event) => {
      event.preventDefault();
      save();
    },
    onInput: () => {
      if (declarant) pending.set(campaign.id, { ...(pending.get(campaign.id) ?? {}), declarant: declarant.read() });
    },
  },
  declarant?.node ?? null,
  qRoot,
  h('div', { class: 'form-actions' },
    saveButton,
    button(t('add.reset'), () => resetForm(true), { icon: 'refresh' })));

  mount(root,
    h('div', { class: 'add-tab stack' },
      h('div', null,
        h('h2', { id: 'console-tab-title' }, t('add.title')),
        h('p', { class: 'lead' }, t('add.lead')),
        h('p', { class: 'muted' }, open ? t('add.mode_open') : t('add.mode_anonymous'))),
      saved ? savedNotice(campaign, saved, t) : null,
      campaign.demo ? callout('info', h('p', null, t('add.demo'))) : null,
      form,
      status));

  // Après l'enregistrement, la console restaure le défilement : le focus est déplacé ensuite
  // sur la confirmation, pour les utilisateurs du clavier et des lecteurs d'écran.
  let focusTimer = null;
  if (saved) {
    focusTimer = setTimeout(() => {
      if (!disposed) root.querySelector('.add-saved')?.focus();
    }, 0);
  }

  const q = renderQuestionnaire(qRoot, {
    questionnaire: model.questionnaire,
    campaign: campaignOpts,
    initial: memo.usage,
    t,
    idPrefix: 'add-q',
    headingLevel: 3,
    onChange: (value) => {
      pending.set(campaign.id, { ...(pending.get(campaign.id) ?? {}), usage: value });
    },
  });

  function resetForm(announceIt) {
    pending.delete(campaign.id);
    q.reset(null);
    declarant?.reset();
    declarant?.showErrors([]);
    if (announceIt) {
      announce(t('add.reset_done'));
      root.querySelector('#console-tab-title')?.scrollIntoView?.({ block: 'start' });
    }
  }

  async function save() {
    if (saving) return;
    const result = q.validate();
    const who = declarantFrom(declarant ? declarant.read() : {}, campaign.mode);
    // Le déclarant précède le questionnaire : s'il est en erreur, c'est lui qui reçoit le focus.
    const declarantInvalid = declarant ? declarant.showErrors(who.ok ? [] : who.errors) : false;
    if (declarantInvalid) return;
    if (!result.ok) {
      q.focusFirstError();
      return;
    }
    if (!store) {
      toast(t('add.errors.no_store'), 'danger');
      return;
    }
    saving = true;
    saveButton.disabled = true;
    status.textContent = t('add.saving');
    try {
      const current = await store.getCampaign(campaign.id);
      if (!current) throw new Error('Campagne introuvable.');
      const entry = buildManualEntry({ campaign: current, usage: result.value, respondent: who.value, now: new Date(), entryId: randomId(12) });
      await store.putEntry(entry);
      let classification = null;
      try {
        const c = classifyUsage(entry.usage, model.rules, model.calendar);
        classification = { ai_act_level: c.ai_act_level, data_level: c.data_level };
      } catch (err) {
        console.warn('[Recensia] Classification indicative indisponible.', err);
      }
      pending.delete(campaign.id);
      lastSaved = { campaignId: campaign.id, name: entry.usage.usage_name, classification };
      toast(h('span', null, t('add.toast', { name: entry.usage.usage_name }), ' ', h('a', { href: registryHref(campaign) }, t('add.saved.registry_link'))), 'success');
      if (disposed) return;
      await refresh();
    } catch (err) {
      console.error('[Recensia] Enregistrement de l’usage impossible.', err);
      toast(t('add.errors.save_failed'), 'danger');
      status.textContent = t('add.errors.save_failed');
    } finally {
      saving = false;
      if (saveButton.isConnected) saveButton.disabled = false;
    }
  }

  return () => {
    disposed = true;
    clearTimeout(focusTimer);
    q.destroy();
  };
}

