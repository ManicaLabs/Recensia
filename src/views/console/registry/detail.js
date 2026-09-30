// Détail d'un usage du registre : boîte de dialogue accessible (<dialog> natif), qui survit aux
// rafraîchissements de l'onglet pour que l'admin enchaîne les vérifications sans perdre sa place.
// Contenu : description, déclencheurs, échéances, questions, signaux, actions liées, évaluation
// (surcharge justifiée, historique, statut, responsable), déclarations, fusion et scission.
// Tout texte venant d'un code est inséré via h() (textContent).

import { h } from '../../../ui/dom.js';
import { icon, button, field, setFieldError, levelBadge, callout, confirmDialog, disclaimer } from '../../../ui/components.js';
import { formatDate, formatDateTime } from '../../../i18n.js';
import { formatUsageValue, optionLabel } from '../../../engine/labels.js';
import { AI_ACT_ORDER, DATA_LEVELS, isAiActLevel, isDataLevel } from '../../../engine/levels.js';
import {
  aiActDisplay, dataDisplay, countDisplay, isCountMasked, questionsOf, toolLabel, mergeTargets,
  compareEntries, VALIDATION_STATUSES, campaignMode, minGroupSize,
} from './filters.js';
import { JUSTIFICATION_MIN, JUSTIFICATION_MAX, OWNER_MAX, historyNewestFirst } from './assessment.js';

/** Champs de l'usage affichés dans « Toutes les réponses » (ordre du questionnaire). */
export const ANSWER_FIELDS = Object.freeze([
  'usage_name', 'department', 'tool', 'tool_other', 'model', 'account_type', 'status', 'task_types',
  'business_domain', 'frequency', 'users_count', 'data_types', 'output_audience', 'output_review',
  'affects_people', 'direct_interaction', 'biometric_emotion', 'built_or_customized',
]);
export const SOURCES = Object.freeze(['code', 'manual', 'demo']);
const TITLE_ID = 'registry-detail-title';

// ---------------------------------------------------------------------------------------------
// Boîte de dialogue
// ---------------------------------------------------------------------------------------------

/**
 * Crée la boîte de dialogue (vide). onClose est appelé une fois, à la fermeture.
 * → { dialog, setContent({ eyebrow, title, nodes }), setStatus(text), focus(key), close(), isOpen() }
 */
export function createDetailDialog({ t, onClose }) {
  const eyebrow = h('p', { class: 'eyebrow registry-detail-eyebrow' });
  const heading = h('h2', { class: 'modal-title', id: TITLE_ID, tabindex: '-1' });
  const status = h('p', { class: 'registry-detail-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const body = h('div', { class: 'modal-content registry-detail-body' });
  let closed = false;
  let statusTimer = null;

  const dialog = h('dialog', { class: 'modal modal-lg registry-detail', 'aria-labelledby': TITLE_ID },
    h('div', { class: 'modal-inner' },
      h('div', { class: 'modal-header registry-detail-header' },
        h('div', { class: 'registry-detail-heading' }, eyebrow, heading),
        h('button', {
          type: 'button',
          class: 'btn btn-ghost btn-icon modal-close',
          'aria-label': t('registry.detail.close'),
          onClick: () => close(),
        }, icon('close'))),
      status,
      body));

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(statusTimer);
    if (dialog.open) dialog.close();
    dialog.remove();
    onClose?.();
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => close());

  return {
    dialog,
    open() {
      if (!dialog.isConnected) globalThis.document.body.appendChild(dialog);
      if (!dialog.open) dialog.showModal();
    },
    setContent({ eyebrow: eyebrowText, title, nodes }) {
      eyebrow.textContent = eyebrowText ?? '';
      heading.textContent = title ?? '';
      body.replaceChildren(...nodes.filter(Boolean));
    },
    setStatus(text) {
      clearTimeout(statusTimer);
      status.textContent = '';
      status.classList.toggle('is-visible', Boolean(text));
      if (!text) return;
      // Léger délai : un message identique au précédent est de nouveau annoncé.
      statusTimer = setTimeout(() => { status.textContent = String(text); }, 60);
    },
    focus(key) {
      const target = (key && Array.from(body.querySelectorAll('[data-focus]')).find((el) => el.dataset.focus === key && !el.disabled)) || heading;
      target.focus({ preventScroll: false });
    },
    scrollTop() {
      body.scrollTop = 0;
    },
    close,
    isOpen: () => !closed,
  };
}

// ---------------------------------------------------------------------------------------------
// Aides d'affichage
// ---------------------------------------------------------------------------------------------

function aiLabel(t, level) {
  return isAiActLevel(level) ? t(`common.levels.ai_act.${level}`) : t('registry.history.computed');
}

function dataLabel(t, level) {
  return isDataLevel(level) ? `${level} — ${t(`common.levels.data.${level}`)}` : t('registry.history.computed');
}

/** Valeur d'un historique lisible. */
export function historyValue(t, fieldName, value) {
  if (fieldName === 'override_ai_act_level') return aiLabel(t, value);
  if (fieldName === 'override_data_level') return dataLabel(t, value);
  if (fieldName === 'validation_status') return VALIDATION_STATUSES.includes(value) ? t(`common.validation.${value}`) : String(value ?? '');
  if (fieldName === 'owner') return typeof value === 'string' && value !== '' ? value : t('registry.history.no_owner');
  return String(value ?? '');
}

function section(key, title, ...children) {
  return h('section', { class: 'registry-detail-section', id: `reg-sec-${key}`, 'aria-labelledby': `reg-sec-${key}-title` },
    h('h3', { id: `reg-sec-${key}-title`, tabindex: '-1', 'data-focus': `section-${key}` }, title),
    children);
}

function metaList(rows) {
  return h('dl', { class: 'meta-list registry-meta' }, rows.filter(Boolean).flatMap(([label, value]) => [
    h('dt', null, label),
    h('dd', null, value === null || value === undefined || value === '' ? '—' : value),
  ]));
}

function externalLink(href, text, label) {
  if (typeof href !== 'string' || !/^https:\/\//.test(href)) return null;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'registry-external' },
    h('span', null, text), label ? h('span', { class: 'visually-hidden' }, ` ${label}`) : null, icon('external'));
}

function emptyLine(text) {
  return h('p', { class: 'muted registry-detail-empty' }, text);
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/** Statut de validation affichable (valeur stockée inconnue ⇒ « à valider »). */
function validationOf(group) {
  return VALIDATION_STATUSES.includes(group?.validation_status) ? group.validation_status : 'to_review';
}

function summary(group, campaign, t) {
  const ai = aiActDisplay(group);
  const data = dataDisplay(group);
  const count = countDisplay(group, campaign);
  const n = group.count ?? group.members?.length ?? 0;
  return h('div', { class: 'registry-detail-summary stack-sm' },
    h('div', { class: 'cluster registry-detail-badges' },
      h('span', { class: 'registry-axis' },
        h('span', { class: 'registry-axis-label' }, t('registry.detail.ai_act')),
        levelBadge('ai_act', ai.level, t),
        ai.overridden ? h('span', { class: 'registry-flag' }, t('registry.detail.overridden_from', { level: aiLabel(t, ai.computed) })) : null),
      h('span', { class: 'registry-axis' },
        h('span', { class: 'registry-axis-label' }, t('registry.detail.data')),
        levelBadge('data', data.level, t),
        data.overridden ? h('span', { class: 'registry-flag' }, t('registry.detail.overridden_from', { level: dataLabel(t, data.computed) })) : null,
        data.toQualify ? h('span', { class: 'registry-flag is-warn' }, t('registry.table.to_qualify')) : null)),
    h('p', { class: 'cluster registry-detail-facts' },
      h('span', { class: ['tag', 'registry-validation', `is-${validationOf(group)}`] }, t(`common.validation.${validationOf(group)}`)),
      h('span', null, isCountMasked(group, campaign) ? t('registry.detail.count_masked', { display: count }) : t('registry.detail.count', { count: n })),
      group.computed?.role === 'potential_provider' ? h('span', { class: 'tag registry-role' }, t('registry.detail.role_provider')) : null,
      group.assessment?.owner ? h('span', null, t('registry.detail.owner_line', { owner: group.assessment.owner })) : null,
      group.last_review ? h('span', { class: 'muted' }, t('registry.detail.last_review', { date: formatDateTime(group.last_review) })) : null),
    disclaimer(t));
}

function jumpNav(t, onJump) {
  const items = [['assessment', t('registry.detail.jump_assessment')], ['members', t('registry.detail.jump_members')], ['grouping', t('registry.detail.jump_grouping')]];
  return h('nav', { class: 'registry-jump', 'aria-label': t('registry.detail.jump_label') },
    h('ul', { class: 'cluster', role: 'list' }, items.map(([key, label]) => h('li', null,
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => onJump(key) }, label)))));
}

function description(group, model, t) {
  const q = model.questionnaire;
  const roleKey = group.computed?.role === 'potential_provider' ? 'role_provider' : 'role_deployer';
  return section('description', t('registry.detail.description'),
    metaList([
      [t('registry.fields.names'), (group.names ?? [group.name]).join(' · ')],
      [t('registry.fields.departments'), (group.departments ?? []).length ? group.departments.join(', ') : t('registry.detail.no_department')],
      [t('registry.fields.tool'), toolLabel(group, q)],
      [t('registry.fields.model'), (group.models ?? []).join(', ') || t('registry.detail.not_specified')],
      [t('registry.fields.account_type'), formatUsageValue(q, 'account_type', group.account_types ?? [])],
      [t('registry.fields.task_types'), formatUsageValue(q, 'task_types', group.task_types ?? [])],
      [t('registry.fields.business_domain'), optionLabel(q, 'business_domain', group.business_domain)],
      [t('registry.fields.data_types'), formatUsageValue(q, 'data_types', group.data_types ?? [])],
      [t('registry.fields.frequency'), formatUsageValue(q, 'frequency', group.frequencies ?? [])],
      [t('registry.fields.output_audience'), formatUsageValue(q, 'output_audience', group.output_audiences ?? [])],
      [t('registry.fields.status'), formatUsageValue(q, 'status', group.statuses ?? [])],
      [t('registry.fields.users_count'), formatUsageValue(q, 'users_count', group.users_counts ?? [])],
      [t('registry.fields.role'), t(`registry.detail.${roleKey}`)],
      group.comments_count ? [t('registry.fields.comments'), t('registry.detail.comments_count', { count: group.comments_count })] : null,
    ]));
}

function triggerBadge(trigger, t) {
  if (trigger.axis === 'ai_act' && isAiActLevel(trigger.level)) return levelBadge('ai_act', trigger.level, t, { short: true });
  if (trigger.axis === 'data' && isDataLevel(trigger.level)) return levelBadge('data', trigger.level, t);
  if (trigger.kind === 'modifier' && Number.isInteger(trigger.delta) && trigger.delta !== 0) {
    return h('span', { class: 'tag' }, t('registry.detail.trigger_delta', { delta: trigger.delta > 0 ? `+${trigger.delta}` : String(trigger.delta) }));
  }
  if (trigger.kind === 'transverse') return h('span', { class: 'tag' }, t('registry.detail.trigger_transverse'));
  if (trigger.kind === 'signal') return h('span', { class: 'tag' }, t('registry.detail.trigger_signal'));
  if (trigger.kind === 'question') return h('span', { class: 'tag' }, t('registry.detail.trigger_question'));
  return null;
}

function triggers(group, t) {
  const list = group.computed?.triggers ?? [];
  const axisTitle = (axis) => t(axis === 'data' ? 'registry.detail.axis_data' : 'registry.detail.axis_ai_act');
  const byAxis = ['ai_act', 'data'].map((axis) => [axis, list.filter((x) => (x.axis === 'data' ? 'data' : 'ai_act') === axis)]).filter(([, items]) => items.length > 0);
  return section('triggers', t('registry.detail.triggers'),
    list.length === 0 ? emptyLine(t('registry.detail.no_trigger')) : byAxis.map(([axis, items]) => h('div', { class: 'registry-trigger-group' },
      h('h4', null, axisTitle(axis)),
      h('ul', { class: 'registry-triggers', role: 'list' }, items.map((trigger) => h('li', { class: 'registry-trigger' },
        h('div', { class: 'registry-trigger-head' },
          h('strong', null, trigger.label || trigger.rule_id),
          triggerBadge(trigger, t)),
        h('p', { class: 'registry-trigger-ref muted' },
          h('code', null, trigger.rule_id),
          trigger.legal_ref && trigger.legal_ref !== '—' ? h('span', null, ` · ${trigger.legal_ref}`) : null),
        trigger.explanation ? h('p', { class: 'registry-trigger-text' }, trigger.explanation) : null))))));
}

function deadlines(group, model, t) {
  const list = group.computed?.deadlines ?? [];
  const today = model.today;
  return section('deadlines', t('registry.detail.deadlines'),
    list.length === 0 ? emptyLine(t('registry.detail.no_deadline')) : h('ul', { class: 'registry-deadlines', role: 'list' }, list.map((d) => {
      const past = typeof d.date === 'string' && typeof today === 'string' && d.date < today;
      return h('li', { class: ['registry-deadline', past ? 'is-past' : 'is-upcoming'] },
        h('span', { class: 'registry-deadline-date' }, d.date ? formatDate(d.date) : '—'),
        h('span', { class: 'registry-deadline-label' }, d.label ?? d.id,
          h('span', { class: 'muted' }, ` — ${t(past ? 'registry.detail.deadline_in_force' : 'registry.detail.deadline_upcoming')}`)),
        externalLink(d.source_url, t('registry.detail.source'), d.label ?? d.id));
    })),
    model.calendar?.last_verified ? h('p', { class: 'muted small' }, t('registry.detail.calendar_verified', { date: formatDate(model.calendar.last_verified) })) : null);
}

function questions(group, t) {
  const list = questionsOf(group);
  return section('questions', t('registry.detail.questions'),
    list.length === 0 ? emptyLine(t('registry.detail.no_question')) : h('ul', { class: 'registry-questions' }, list.map((q) => h('li', { class: q.resolved ? 'is-resolved' : null },
      h('span', null, q.question),
      q.resolved ? h('span', { class: 'tag registry-resolved' }, t('registry.detail.question_resolved')) : null))));
}

function signals(group, t) {
  const list = group.computed?.signals ?? [];
  return section('signals', t('registry.detail.signals'),
    list.length === 0 ? emptyLine(t('registry.detail.no_signal')) : h('ul', { class: 'cluster registry-signals', role: 'list' }, list.map((s) => h('li', null,
      h('span', { class: 'tag registry-signal' }, icon('alert'), h('span', null, s.label ?? s.id))))));
}

function linkedActions(group, model, campaign, t) {
  const actions = (model.actions ?? []).filter((a) => a && a.usage_key === group.usage_key);
  const suggestions = (model.suggestions ?? []).filter((s) => s && s.usage_key === group.usage_key);
  const href = `#/admin/${campaign.id}/actions`;
  return section('actions', t('registry.detail.actions'),
    actions.length === 0 && suggestions.length === 0 ? emptyLine(t('registry.detail.no_action')) : null,
    actions.length ? h('ul', { class: 'registry-actions', role: 'list' }, actions.map((a) => h('li', { class: 'registry-action' },
      h('strong', null, a.title ?? a.template_id ?? ''),
      h('span', { class: 'cluster registry-action-meta' },
        h('span', { class: 'tag' }, t(`common.action_status.${['todo', 'in_progress', 'done', 'rejected'].includes(a.status) ? a.status : 'todo'}`)),
        ['high', 'medium', 'low'].includes(a.priority) ? h('span', { class: 'muted' }, t('registry.detail.priority', { priority: t(`common.priority.${a.priority}`) })) : null,
        a.owner ? h('span', { class: 'muted' }, t('registry.detail.action_owner', { owner: a.owner })) : null,
        a.due_date ? h('span', { class: 'muted' }, t('registry.detail.action_due', { date: formatDate(a.due_date) })) : null)))) : null,
    suggestions.length ? h('div', { class: 'stack-sm' },
      h('h4', null, t('registry.detail.suggestions', { count: suggestions.length })),
      h('ul', { class: 'registry-actions', role: 'list' }, suggestions.map((s) => h('li', { class: 'registry-action is-suggestion' },
        h('strong', null, s.title),
        h('span', { class: 'cluster registry-action-meta' },
          h('span', { class: 'tag' }, t('registry.detail.suggested')),
          ['high', 'medium', 'low'].includes(s.priority) ? h('span', { class: 'muted' }, t('registry.detail.priority', { priority: t(`common.priority.${s.priority}`) })) : null,
          s.suggested_role ? h('span', { class: 'muted' }, t('registry.detail.suggested_role', { role: s.suggested_role })) : null))))) : null,
    h('p', null, h('a', { href, class: 'btn btn-secondary btn-sm' }, h('span', null, t('registry.detail.open_actions')), icon('arrow-right'))));
}

function assessmentSection(group, campaign, t, ops) {
  const current = group.assessment ?? {};
  const ai = aiActDisplay(group);
  const data = dataDisplay(group);
  const aiSelect = h('select', { name: 'override_ai_act_level', 'data-focus': 'assessment-ai' },
    h('option', { value: '' }, t('registry.assessment.computed_option', { level: aiLabel(t, ai.computed) })),
    AI_ACT_ORDER.map((level) => h('option', { value: level }, t(`common.levels.ai_act.${level}`))));
  aiSelect.value = isAiActLevel(current.override_ai_act_level) ? current.override_ai_act_level : '';
  const dataSelect = h('select', { name: 'override_data_level', 'data-focus': 'assessment-data' },
    h('option', { value: '' }, t('registry.assessment.computed_option', { level: dataLabel(t, data.computed) })),
    DATA_LEVELS.map((level) => h('option', { value: String(level) }, dataLabel(t, level))));
  dataSelect.value = isDataLevel(current.override_data_level) ? String(current.override_data_level) : '';
  const justification = h('textarea', { name: 'justification', rows: '3', maxlength: String(JUSTIFICATION_MAX), 'data-focus': 'assessment-justification' });
  const owner = h('input', { type: 'text', name: 'owner', maxlength: String(OWNER_MAX), autocomplete: 'off', value: current.owner ?? '', 'data-focus': 'assessment-owner' });
  const status = validationOf(group);
  const radios = VALIDATION_STATUSES.map((value) => h('li', null, h('label', { class: 'choice registry-choice' },
    h('input', { type: 'radio', name: 'validation_status', value, checked: value === status, 'data-focus': `assessment-status-${value}` }),
    h('span', { class: 'choice-text' },
      h('span', { class: 'choice-label' }, t(`common.validation.${value}`)),
      h('span', { class: 'choice-help' }, t(`registry.assessment.status_help.${value}`))))));

  const fields = {
    override_ai_act_level: field({ id: 'reg-override-ai', label: t('registry.assessment.ai_act'), control: aiSelect }),
    override_data_level: field({ id: 'reg-override-data', label: t('registry.assessment.data'), control: dataSelect }),
    justification: field({ id: 'reg-justification', label: t('registry.assessment.justification'), help: t('registry.assessment.justification_help', { min: JUSTIFICATION_MIN }), control: justification }),
    validation_status: field({ id: 'reg-assess-status', label: t('registry.assessment.validation'), group: true, control: h('ul', { class: 'choice-grid', role: 'list' }, radios) }),
    owner: field({ id: 'reg-owner', label: t('registry.assessment.owner'), help: t('registry.assessment.owner_help'), control: owner }),
  };

  const form = h('form', {
    class: 'registry-assessment',
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      Object.values(fields).forEach((node) => setFieldError(node, null));
      const checked = form.querySelector('input[name="validation_status"]:checked');
      const result = await ops.saveAssessment(group, {
        override_ai_act_level: aiSelect.value,
        override_data_level: dataSelect.value,
        justification: justification.value,
        validation_status: checked ? checked.value : status,
        owner: owner.value,
      });
      if (!result) return;
      if (!result.ok) {
        for (const error of result.errors) {
          const node = fields[error.field];
          if (node) setFieldError(node, t(`registry.assessment.errors.${error.code}`, { min: JUSTIFICATION_MIN }));
        }
        const first = result.errors.map((e) => fields[e.field]).find(Boolean);
        first?.querySelector('input, select, textarea')?.focus();
      }
    },
  },
  h('div', { class: 'grid grid-2 registry-assessment-levels' }, fields.override_ai_act_level, fields.override_data_level),
  fields.justification,
  fields.validation_status,
  fields.owner,
  h('div', { class: 'form-actions registry-assessment-actions' },
    button(t('registry.assessment.save'), null, { variant: 'primary', type: 'submit', icon: 'check', attrs: { 'data-focus': 'assessment-save' } }),
    ai.overridden || data.overridden
      ? button(t('registry.assessment.revert'), () => ops.revert(group), { variant: 'secondary', icon: 'refresh', attrs: { 'data-focus': 'assessment-revert' } })
      : null));

  return section('assessment', t('registry.assessment.title'),
    h('p', { class: 'muted small' }, t('registry.assessment.lead')),
    form,
    history(group, t));
}

function history(group, t) {
  const list = historyNewestFirst(group.assessment);
  return h('div', { class: 'registry-history' },
    h('h4', null, t('registry.history.title')),
    list.length === 0 ? emptyLine(t('registry.history.empty')) : h('ol', { class: 'registry-history-list', role: 'list' }, list.map((entry) => h('li', null,
      h('p', { class: 'registry-history-head' },
        h('time', { datetime: entry.at ?? '' }, entry.at ? formatDateTime(entry.at) : '—'),
        h('span', null, ' · ', h('strong', null, t(`registry.history.fields.${['override_ai_act_level', 'override_data_level', 'validation_status', 'owner'].includes(entry.field) ? entry.field : 'other'}`))),
        h('span', null, ` : ${historyValue(t, entry.field, entry.from)} → ${historyValue(t, entry.field, entry.to)}`)),
      entry.justification ? h('p', { class: 'registry-history-note' }, `« ${entry.justification} »`) : null))));
}

function memberAnswers(entry, model, t) {
  const usage = entry.usage ?? {};
  return h('details', { class: 'registry-answers' },
    h('summary', null, t('registry.members.answers')),
    metaList(ANSWER_FIELDS
      .filter((f) => f !== 'tool_other' || usage.tool === 'other')
      .map((f) => [t(`registry.fields.${f}`), formatUsageValue(model.questionnaire, f, usage[f]) || '—'])));
}

function memberCard(entry, group, model, campaign, t, ops, { excluded = false } = {}) {
  const usage = entry.usage ?? {};
  const q = model.questionnaire;
  const open = campaignMode(campaign) === 'open';
  const who = open && entry.respondent
    ? [entry.respondent.first_name, entry.respondent.last_name].filter(Boolean).join(' ') + (entry.respondent.email ? ` (${entry.respondent.email})` : '')
    : null;
  const source = SOURCES.includes(entry.source) ? entry.source : 'code';
  const comment = typeof usage.comment === 'string' && usage.comment.trim() !== '' ? usage.comment : null;
  const id = entry.entry_id;
  const actions = excluded
    ? [
      button(t('registry.members.restore'), () => ops.restore(entry, group), { size: 'sm', icon: 'refresh', attrs: { 'data-focus': `member-restore-${id}` } }),
      button(t('registry.members.delete'), () => ops.remove(entry, group), { size: 'sm', variant: 'ghost', icon: 'trash', attrs: { 'data-focus': `member-delete-${id}`, class: 'registry-danger-link' } }),
    ]
    : [
      group && group.count > 1 ? button(t('registry.members.split'), () => ops.split(entry, group), { size: 'sm', attrs: { 'data-focus': `member-split-${id}` } }) : null,
      entry.group_override ? button(t('registry.members.ungroup'), () => ops.ungroup(entry, group), { size: 'sm', attrs: { 'data-focus': `member-ungroup-${id}` } }) : null,
      button(t('registry.members.exclude'), () => ops.exclude(entry, group), { size: 'sm', attrs: { 'data-focus': `member-exclude-${id}` } }),
      button(t('registry.members.delete'), () => ops.remove(entry, group), { size: 'sm', variant: 'ghost', icon: 'trash', attrs: { 'data-focus': `member-delete-${id}`, class: 'registry-danger-link' } }),
    ];
  return h('li', { class: ['registry-member', excluded ? 'is-excluded' : null] },
    h('div', { class: 'registry-member-head' },
      h('strong', { class: 'registry-member-name' }, usage.usage_name || '—'),
      h('span', { class: 'cluster registry-member-tags' },
        h('span', { class: 'tag' }, t(`registry.members.source.${source}`)),
        Number.isInteger(entry.rev) && entry.rev > 1 ? h('span', { class: 'tag' }, t('registry.members.rev', { rev: entry.rev })) : null,
        entry.after_close ? h('span', { class: 'tag registry-tag-warn' }, t('registry.members.after_close')) : null,
        entry.group_override && !excluded ? h('span', { class: 'tag' }, t('registry.members.manual_group')) : null)),
    metaList([
      [t('registry.members.day'), open && entry.submitted_at ? formatDateTime(entry.submitted_at) : (entry.submitted_day ? formatDate(entry.submitted_day) : '—')],
      who ? [t('registry.members.respondent'), who] : null,
      [t('registry.fields.department'), usage.department || t('registry.detail.no_department')],
      [t('registry.fields.account_type'), optionLabel(q, 'account_type', usage.account_type)],
      [t('registry.fields.model'), usage.model || t('registry.detail.not_specified')],
      [t('registry.fields.status'), optionLabel(q, 'status', usage.status)],
    ]),
    comment ? h('div', { class: 'registry-comment' },
      h('p', { class: 'registry-comment-warning' }, icon('alert'), h('span', null, t('registry.members.comment_warning'))),
      h('blockquote', { class: 'registry-comment-text' }, comment)) : null,
    memberAnswers(entry, model, t),
    h('div', { class: 'cluster registry-member-actions' }, actions));
}

function members(group, model, campaign, t, ops, excludedList, { revealMasked = false } = {}) {
  const list = [...(group.members ?? [])].sort(compareEntries);
  const masked = isCountMasked(group, campaign);
  const cards = h('ul', { class: 'registry-members', role: 'list' }, list.map((entry) => memberCard(entry, group, model, campaign, t, ops)));
  const excludedBlock = excludedList.length ? h('div', { class: 'registry-members-excluded stack-sm' },
    h('h4', null, t('registry.members.excluded_title', { count: excludedList.length })),
    h('p', { class: 'muted small' }, t('registry.members.excluded_help')),
    h('ul', { class: 'registry-members', role: 'list' }, excludedList.map((entry) => memberCard(entry, group, model, campaign, t, ops, { excluded: true })))) : null;
  return section('members', t('registry.members.title'),
    campaignMode(campaign) === 'open'
      ? h('p', { class: 'muted small' }, t('registry.members.open_note'))
      : h('p', { class: 'muted small' }, t('registry.members.anonymous_note')),
    masked
      ? h('details', { class: 'registry-members-masked', open: revealMasked || null },
        h('summary', null, t('registry.members.show_masked', { k: minGroupSize(campaign) })),
        callout('warn', h('p', null, t('registry.members.masked_warning', { k: minGroupSize(campaign) }))),
        cards)
      : cards,
    excludedBlock);
}

function grouping(group, model, t, ops) {
  const targets = mergeTargets(model.groups, group.usage_key);
  const select = h('select', { name: 'merge_target', 'data-focus': 'merge-target', disabled: targets.length === 0 },
    h('option', { value: '' }, t('registry.grouping.choose')),
    targets.map((g) => h('option', { value: g.usage_key }, `${g.id} — ${g.name || '—'}`)));
  const fieldNode = field({ id: 'reg-merge-target', label: t('registry.grouping.merge_label'), help: t('registry.grouping.merge_help'), control: select });
  const submit = async (event) => {
    event.preventDefault();
    setFieldError(fieldNode, null);
    const target = targets.find((g) => g.usage_key === select.value);
    if (!target) {
      setFieldError(fieldNode, t('registry.grouping.choose_error'));
      select.focus();
      return;
    }
    await ops.merge(group, target);
  };
  return section('grouping', t('registry.grouping.title'),
    h('p', { class: 'muted small' }, t('registry.grouping.lead')),
    targets.length === 0 ? emptyLine(t('registry.grouping.no_target')) : h('form', { class: 'registry-merge', novalidate: true, onSubmit: submit },
      fieldNode,
      button(t('registry.grouping.merge'), null, { type: 'submit', attrs: { 'data-focus': 'merge-submit' } })),
    group.count > 1 ? h('p', { class: 'muted small' }, t('registry.grouping.split_help')) : null);
}

/**
 * Contenu complet du détail d'une ligne.
 * ops : { saveAssessment, revert, merge, split, ungroup, exclude, restore, remove } (asynchrones)
 * revealMasked : garder dépliée la liste des déclarations d'un effectif masqué (après une modification).
 * → { eyebrow, title, nodes }
 */
export function detailContent({ group, model, campaign, t, ops, excluded = [], onJump, revealMasked = false }) {
  return {
    eyebrow: t('registry.detail.eyebrow', { id: group.id }),
    title: group.name || group.id,
    nodes: [
      summary(group, campaign, t),
      jumpNav(t, onJump),
      description(group, model, t),
      triggers(group, t),
      questions(group, t),
      signals(group, t),
      deadlines(group, model, t),
      linkedActions(group, model, campaign, t),
      assessmentSection(group, campaign, t, ops),
      members(group, model, campaign, t, ops, excluded, { revealMasked }),
      grouping(group, model, t, ops),
    ],
  };
}

/** Carte d'une déclaration écartée (liste générale du registre). */
export function excludedCard(entry, model, campaign, t, ops) {
  return memberCard(entry, null, model, campaign, t, ops, { excluded: true });
}

/** Confirmation de suppression définitive d'une déclaration. */
export function confirmDelete(entry, t) {
  return confirmDialog({
    title: t('registry.members.delete_title'),
    message: h('div', { class: 'stack-sm' },
      h('p', null, t('registry.members.delete_text', { name: entry.usage?.usage_name || '—' })),
      // Seule une déclaration reçue par code peut revenir par un nouvel import.
      h('p', { class: 'muted' }, t(entry.source === 'code' ? 'registry.members.delete_hint' : 'registry.members.delete_hint_manual'))),
    confirmLabel: t('registry.members.delete_confirm'),
    danger: true,
  });
}

/** Confirmation de fusion (effectif masqué « < k » en mode anonyme, comme dans le registre). */
export function confirmMerge(group, target, t, campaign) {
  const names = { source: group.name || group.id, target: target.name || target.id };
  const text = isCountMasked(group, campaign)
    ? t('registry.grouping.confirm_text_masked', { ...names, display: countDisplay(group, campaign) })
    : t('registry.grouping.confirm_text', { ...names, count: group.count });
  return confirmDialog({
    title: t('registry.grouping.confirm_title'),
    message: h('div', { class: 'stack-sm' },
      h('p', null, text),
      h('p', { class: 'muted' }, t('registry.grouping.confirm_hint', { source: group.name || group.id, target: target.name || target.id }))),
    confirmLabel: t('registry.grouping.merge'),
  });
}

/** Confirmation d'annulation de surcharge. */
export function confirmRevert(t) {
  return confirmDialog({
    title: t('registry.assessment.revert_title'),
    message: t('registry.assessment.revert_text'),
    confirmLabel: t('registry.assessment.revert'),
  });
}
