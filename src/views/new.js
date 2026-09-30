// Création de campagne (#/new) : formulaire, génération des clés, puis étape « Protégez votre clé »
// (fichier de récupération) sans quitter la vue, avant la page « Diffuser » de la console.
// Logique pure (validation, construction de la campagne, aperçu du lien) : ./new/build-campaign.js.

import { h, mount, loadCss, announce } from '../ui/dom.js';
import { button, field, setFieldError, callout, icon, confirmDialog } from '../ui/components.js';
import { downloadText } from '../ui/download.js';
import { generateCampaignKeys, formatFingerprint } from '../crypto/keys.js';
import { randomId } from '../crypto/random.js';
import { listChannelTypes, anonymityWarning } from '../share/channels.js';
import { formatDate, formatNumber } from '../i18n.js';
import { localDay } from '../services/model.js';
import { buildRecoveryFile, markRecoverySaved } from '../services/recovery.js';
import {
  defaultForm, validateCampaignForm, buildCampaign, draftCampaign, collectUrlLength, linkLengthStatus,
  departmentIssue, departmentKey, passwordStrength,
  DEPARTMENT_SUGGESTION_KEYS, DEPARTMENTS_MAX, DEPARTMENT_MAX, TITLE_MAX, ORG_MAX, CHANNELS_MAX,
  MIN_GROUP_SIZE, PASSWORD_MIN_LENGTH, LINK_TARGET_LENGTH,
} from './new/build-campaign.js';

const CSS = 'src/styles/new.css';
const STEP_KEYS = ['settings', 'key', 'share'];
const PHONE_TYPES = new Set(['phone']);

let rowCounter = 0;

function stepper(t, current) {
  return h('ol', { class: 'stepper stepper-inline new-steps', 'aria-label': t('new.steps.label') },
    STEP_KEYS.map((key, i) => {
      const index = STEP_KEYS.indexOf(current);
      const state = i < index ? 'done' : i === index ? 'current' : null;
      return h('li', {
        class: ['stepper-item', state === 'done' ? 'is-done' : null],
        'aria-current': state === 'current' ? 'step' : null,
      }, h('span', null, t(`new.steps.${key}`)),
      state ? h('span', { class: 'visually-hidden' }, ` ${t(`new.steps.${state}`)}`) : null);
    }));
}

function pageHeader(t, step) {
  return h('header', { class: 'page-header new-header' },
    h('div', null,
      h('p', { class: 'eyebrow' }, t('new.eyebrow')),
      h('h1', null, t('new.title')),
      step === 'settings' ? h('p', { class: 'lead' }, t('new.lead')) : null,
      stepper(t, step)));
}

function sectionTitle(number, text, id) {
  return h('h2', { class: 'new-section-title', id },
    h('span', { class: 'new-section-num', 'aria-hidden': 'true' }, String(number)), h('span', null, text));
}

function groupError(id) {
  return h('p', { class: 'field-error', id, hidden: true });
}

function setGroupError(node, message) {
  if (!node) return;
  if (message) {
    node.replaceChildren(icon('alert'), h('span', null, message));
    node.hidden = false;
  } else {
    node.replaceChildren();
    node.hidden = true;
  }
}

function describe(control, ...ids) {
  const existing = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  control.setAttribute('aria-describedby', [...new Set([...existing, ...ids.filter(Boolean)])].join(' '));
}

function checkbox(id, { checked = false, onChange } = {}) {
  return h('input', { type: 'checkbox', id, checked, onChange });
}

function choiceCheckbox({ id, label, help, checked, onChange }) {
  const helpId = help ? `${id}-help` : null;
  const input = checkbox(id, { checked, onChange });
  input.setAttribute('aria-labelledby', `${id}-label`);
  if (helpId) input.setAttribute('aria-describedby', helpId);
  const helpNode = help ? h('span', { class: 'choice-help', id: helpId }, help) : null;
  const node = h('label', { class: 'choice new-check', for: id }, input,
    h('span', { class: 'choice-text' }, h('span', { class: 'choice-label', id: `${id}-label` }, label), helpNode));
  return { node, input, helpNode };
}

// ---------------------------------------------------------------------------------------------

export async function render(root, { ctx }) {
  const { t, store } = ctx;
  loadCss(CSS);
  ctx.setTitle(t('new.meta.title'));

  if (!store) {
    mount(root, h('div', { class: 'page page-narrow' },
      h('div', { class: 'empty-state' },
        h('span', { class: 'empty-state-icon empty-state-danger' }, icon('alert')),
        h('h1', null, t('new.no_store.title')),
        h('p', { class: 'lead' }, t('new.no_store.text')),
        h('p', null, h('a', { class: 'btn btn-primary', href: '#/' }, t('common.actions.back_home'))))));
    return undefined;
  }

  let channelsData;
  try {
    channelsData = await ctx.data.get('channels');
  } catch (err) {
    console.error('[Recensia] Données des canaux indisponibles.', err);
    mount(root, h('div', { class: 'page page-narrow' },
      h('h1', null, t('new.title')),
      callout('danger', h('p', null, t('common.errors.data_unavailable')))));
    return undefined;
  }

  let disposed = false;
  const view = createFormView({ root, ctx, channelsData, isDisposed: () => disposed });
  view.mountForm();
  return () => {
    disposed = true;
  };
}

// ---------------------------------------------------------------------------------------------
// Étape 1 : formulaire
// ---------------------------------------------------------------------------------------------

function createFormView({ root, ctx, channelsData, isDisposed }) {
  const { t, store } = ctx;
  const form = defaultForm();
  const departments = []; // [{ key, value }]
  const targets = {}; // cible saisie par type de canal (conservée si le canal est décoché)
  const selected = new Set();
  const channelTypes = listChannelTypes(channelsData);
  const nodes = {};
  let submitted = false;
  let busy = false;
  let lastOver = false;

  const k = () => {
    const n = Number(nodes.minGroup?.value);
    return Number.isInteger(n) && n >= MIN_GROUP_SIZE.min && n <= MIN_GROUP_SIZE.max ? n : MIN_GROUP_SIZE.default;
  };

  function readForm() {
    return {
      ...form,
      departments: departments.map((d) => d.value),
      min_group_size: nodes.minGroup?.value ?? MIN_GROUP_SIZE.default,
      channels: channelTypes.filter((c) => selected.has(c.type))
        .map((c) => (c.target ? { type: c.type, target: targets[c.type] ?? '' } : { type: c.type })),
    };
  }

  // --- Section 1 : la campagne ------------------------------------------------------------------

  function campaignSection() {
    nodes.title = h('input', {
      type: 'text', id: 'new-title', maxlength: String(TITLE_MAX), autocomplete: 'off',
      placeholder: t('new.fields.title.placeholder'),
      onInput: (event) => { form.title = event.target.value; changed(); },
    });
    nodes.org = h('input', {
      type: 'text', id: 'new-org', maxlength: String(ORG_MAX), autocomplete: 'organization',
      onInput: (event) => { form.org_name = event.target.value; changed(); },
    });
    nodes.closes = h('input', {
      type: 'date', id: 'new-closes', min: localDay(),
      onInput: (event) => { form.closes_on = event.target.value; changed(); },
      onChange: (event) => { form.closes_on = event.target.value; changed(); },
    });
    nodes.titleField = field({ id: 'new-title', label: t('new.fields.title.label'), help: t('new.fields.title.help'), required: true, control: nodes.title });
    nodes.orgField = field({ id: 'new-org', label: t('new.fields.org_name.label'), help: t('new.fields.org_name.help'), control: nodes.org });
    nodes.closesField = field({ id: 'new-closes', label: t('new.fields.closes_on.label'), help: t('new.fields.closes_on.help'), control: nodes.closes });
    nodes.closesField.classList.add('new-date');
    return h('section', { class: 'card new-section', 'aria-labelledby': 'new-s1' },
      sectionTitle(1, t('new.sections.campaign'), 'new-s1'),
      nodes.titleField,
      nodes.orgField,
      nodes.closesField);
  }

  // --- Section 2 : mode -------------------------------------------------------------------------

  function modeOption(mode, points) {
    const id = `new-mode-${mode}`;
    const input = h('input', {
      type: 'radio', name: 'new-mode', id, value: mode, checked: form.mode === mode,
      onChange: () => { form.mode = mode; modeChanged(); },
    });
    // Nom accessible court (le libellé), détails en description ; la carte entière reste cliquable.
    const pointsNode = h('span', { class: 'new-mode-points', id: `${id}-points` },
      points.map((p) => h('span', { class: 'new-mode-point' }, p)));
    input.setAttribute('aria-labelledby', `${id}-label`);
    input.setAttribute('aria-describedby', `${id}-points ${id}-limit`);
    return h('li', null,
      h('label', { class: ['choice', 'new-mode-choice'], for: id }, input,
        h('span', { class: 'choice-text' },
          h('span', { class: 'choice-label', id: `${id}-label` }, icon(mode === 'open' ? 'users' : 'shield'), h('span', null, t(`new.mode.${mode}.label`))),
          pointsNode,
          h('span', { class: ['new-mode-limit', mode === 'anonymous' ? 'is-warn' : null], id: `${id}-limit` },
            icon(mode === 'anonymous' ? 'alert' : 'info'), h('span', null, t(`new.mode.${mode}.limit`))))));
  }

  function modeSection() {
    nodes.modeMask = h('span', null, t('new.mode.anonymous.mask', { k: k() }));
    nodes.modeError = groupError('new-mode-error');
    const list = h('ul', { class: 'choice-grid new-mode-grid', role: 'list' },
      modeOption('anonymous', [t('new.mode.anonymous.identity'), t('new.mode.anonymous.day'), nodes.modeMask]),
      modeOption('open', [t('new.mode.open.identity'), t('new.mode.open.time'), t('new.mode.open.department')]));
    nodes.modeGroup = h('fieldset', { class: 'field field-group new-fieldset', id: 'new-mode', 'aria-describedby': 'new-mode-help new-mode-error' },
      h('legend', { class: 'visually-hidden' }, t('new.sections.mode.legend')),
      list, nodes.modeError);
    return h('section', { class: 'card new-section', 'aria-labelledby': 'new-s2' },
      sectionTitle(2, t('new.sections.mode.title'), 'new-s2'),
      h('p', { class: 'field-help', id: 'new-mode-help' }, t('new.sections.mode.help')),
      nodes.modeGroup);
  }

  // --- Section 3 : services ---------------------------------------------------------------------

  function departmentRow(dept, index) {
    const id = `new-dept-${dept.key}`;
    const errorId = `${id}-error`;
    const removeLabel = () => (dept.value.trim()
      ? t('new.departments.remove', { name: dept.value.trim() })
      : t('new.departments.remove_empty', { n: index + 1 }));
    const remove = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon new-dept-remove', 'aria-label': removeLabel(), title: removeLabel(),
      onClick: () => removeDepartment(dept.key),
    }, icon('trash'));
    const input = h('input', {
      type: 'text', id, value: dept.value, maxlength: String(DEPARTMENT_MAX), autocomplete: 'off',
      'aria-describedby': errorId,
      onInput: (event) => {
        dept.value = event.target.value;
        remove.setAttribute('aria-label', removeLabel());
        remove.setAttribute('title', removeLabel());
        changed();
      },
    });
    return h('li', { class: 'new-dept-row', 'data-key': dept.key },
      h('div', { class: 'new-dept-line' },
        h('label', { class: 'visually-hidden', for: id }, t('new.fields.department_row', { n: index + 1 })),
        h('span', { class: 'new-dept-index', 'aria-hidden': 'true' }, String(index + 1)),
        input,
        remove),
      h('p', { class: 'field-error', id: errorId, hidden: true }));
  }

  function renderDepartments() {
    mount(nodes.deptList, departments.map((d, i) => departmentRow(d, i)));
    nodes.deptList.hidden = departments.length === 0;
    updateDepartmentUi();
  }

  function updateDepartmentUi() {
    const count = departments.length;
    nodes.deptCount.textContent = t('new.departments.count', { count, max: DEPARTMENTS_MAX });
    nodes.deptCount.hidden = count === 0;
    nodes.deptEmpty.hidden = count > 0;
    nodes.deptEmpty.textContent = form.mode === 'open' ? t('new.departments.empty_open') : t('new.departments.empty');
    const full = count >= DEPARTMENTS_MAX;
    nodes.deptAdd.disabled = full;
    nodes.deptAddButton.disabled = full;
    const present = new Set(departments.map((d) => departmentKey(d.value)));
    let visible = 0;
    for (const item of nodes.suggestionItems) {
      const hide = present.has(departmentKey(item.dataset.name)) || full;
      item.hidden = hide;
      if (!hide) visible += 1;
    }
    nodes.suggestions.hidden = visible === 0;
    updateRequiredUi();
  }

  function addDepartment(raw, { fromSuggestion = null } = {}) {
    const issue = departmentIssue(departments.map((d) => d.value), raw);
    if (issue === 'empty') {
      setFieldError(nodes.deptAddField, null);
      return false;
    }
    if (issue) {
      setFieldError(nodes.deptAddField, t(`new.errors.department.${issue}`));
      return false;
    }
    setFieldError(nodes.deptAddField, null);
    rowCounter += 1;
    const value = String(raw).trim();
    departments.push({ key: `r${rowCounter}`, value });
    renderDepartments();
    changed({ departments: true });
    announce(t('new.departments.added', { name: value, count: departments.length, max: DEPARTMENTS_MAX }));
    if (fromSuggestion) {
      // La suggestion ajoutée disparaît : le focus passe à la suivante encore visible, sinon au champ d'ajout.
      const items = nodes.suggestionItems;
      const start = items.indexOf(fromSuggestion);
      const next = [...items.slice(start + 1), ...items.slice(0, start)].find((item) => !item.hidden);
      (next?.querySelector('button') ?? nodes.deptAdd).focus();
    }
    return true;
  }

  function removeDepartment(key) {
    const index = departments.findIndex((d) => d.key === key);
    if (index < 0) return;
    const [removed] = departments.splice(index, 1);
    renderDepartments();
    changed({ departments: true });
    announce(t('new.departments.removed', { name: removed.value.trim() || '—' }));
    const next = departments[index] ?? departments[index - 1];
    const target = next ? nodes.deptList.querySelector(`[data-key="${next.key}"] input`) : nodes.deptAdd;
    (target ?? nodes.deptAdd).focus();
  }

  function departmentsSection() {
    nodes.deptList = h('ol', { class: 'new-dept-list', role: 'list', 'aria-label': t('new.departments.list_label'), hidden: true });
    nodes.deptCount = h('p', { class: 'new-dept-count muted', id: 'new-dept-count' });
    nodes.deptEmpty = h('p', { class: 'new-dept-empty muted' });
    nodes.deptError = groupError('new-depts-error');
    nodes.deptAdd = h('input', {
      type: 'text', id: 'new-dept-add', maxlength: String(DEPARTMENT_MAX), autocomplete: 'off',
      placeholder: t('new.fields.department_new.placeholder'),
      onKeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (addDepartment(nodes.deptAdd.value)) nodes.deptAdd.value = '';
      },
      onInput: () => setFieldError(nodes.deptAddField, null),
    });
    nodes.deptAddButton = button(t('new.departments.add'), () => {
      if (addDepartment(nodes.deptAdd.value)) nodes.deptAdd.value = '';
      nodes.deptAdd.focus();
    }, { icon: 'plus' });
    nodes.deptAddField = field({ id: 'new-dept-add', label: t('new.fields.department_new.label'), control: nodes.deptAdd });
    // Champ et bouton « Ajouter » côte à côte : le champ texte reste le contrôle étiqueté.
    const addLine = h('div', { class: 'new-dept-add' });
    nodes.deptAdd.replaceWith(addLine);
    addLine.append(nodes.deptAdd, nodes.deptAddButton);
    describe(nodes.deptAdd, 'new-dept-count', 'new-depts-error');

    nodes.suggestionItems = DEPARTMENT_SUGGESTION_KEYS.map((key) => {
      const name = t(`new.departments.suggestions.${key}`);
      const item = h('li', { 'data-name': name },
        h('button', {
          type: 'button', class: 'btn btn-secondary btn-sm new-suggestion',
          'aria-label': t('new.departments.suggestion_add', { name }),
          onClick: () => addDepartment(name, { fromSuggestion: item }),
        }, icon('plus'), h('span', null, name)));
      return item;
    });
    nodes.suggestions = h('div', { class: 'new-suggestions' },
      h('p', { class: 'new-suggestions-label', id: 'new-suggestions-label' }, t('new.departments.suggestions.label')),
      h('ul', { class: 'cluster new-suggestion-list', role: 'list', 'aria-labelledby': 'new-suggestions-label' }, nodes.suggestionItems));

    const required = choiceCheckbox({
      id: 'new-dept-required',
      label: t('new.fields.department_required.label'),
      help: '',
      checked: form.department_required,
      onChange: (event) => { form.department_required = event.target.checked; changed(); },
    });
    nodes.required = required.input;
    nodes.requiredHelp = h('span', { class: 'choice-help', id: 'new-dept-required-help' });
    required.node.querySelector('.choice-text').appendChild(nodes.requiredHelp);
    nodes.required.setAttribute('aria-describedby', 'new-dept-required-help');
    nodes.requiredNode = required.node;

    return h('section', { class: 'card new-section', 'aria-labelledby': 'new-s3' },
      sectionTitle(3, t('new.sections.departments.title'), 'new-s3'),
      h('p', { class: 'field-help' }, t('new.sections.departments.help')),
      nodes.deptList,
      nodes.deptEmpty,
      nodes.deptError,
      nodes.deptAddField,
      nodes.suggestions,
      nodes.deptCount,
      nodes.requiredNode);
  }

  function updateRequiredUi() {
    if (!nodes.required) return;
    const open = form.mode === 'open';
    const none = departments.length === 0;
    nodes.required.disabled = open || none;
    nodes.required.checked = open ? true : (!none && form.department_required);
    nodes.requiredHelp.textContent = open
      ? t('new.fields.department_required.help_open')
      : none ? t('new.fields.department_required.help_empty')
        : t('new.fields.department_required.help_anonymous', { k: k() });
  }

  // --- Section 4 : canaux -----------------------------------------------------------------------

  function channelOption(info) {
    const id = `new-channel-${info.type}`;
    const input = checkbox(id, {
      checked: selected.has(info.type),
      onChange: (event) => {
        if (event.target.checked) selected.add(info.type);
        else selected.delete(info.type);
        updateChannelsUi();
        changed({ channels: true });
        if (event.target.checked) option.querySelector('.new-channel-extra input')?.focus();
      },
    });
    const flagId = `${id}-flag`;
    const helpId = `${id}-help`;
    input.setAttribute('aria-labelledby', `${id}-label`);
    input.setAttribute('aria-describedby', `${flagId} ${helpId}`);
    const flag = h('span', { class: ['new-channel-flag', `is-${info.identifies_sender}`], id: flagId },
      icon(info.identifies_sender === 'yes' ? 'users' : 'info'), h('span', null, info.identifies_sender_label));

    let targetField = null;
    if (info.target) {
      const targetId = `${id}-target`;
      const control = h('input', {
        type: info.target === 'email' ? 'email' : PHONE_TYPES.has(info.target) ? 'tel' : 'text',
        id: targetId,
        autocomplete: info.target === 'email' ? 'email' : info.target === 'phone' ? 'tel' : 'off',
        inputmode: info.target === 'email' ? 'email' : info.target === 'phone' ? 'tel' : null,
        maxlength: String(info.target === 'instruction' ? info.target_max : Math.max(info.target_max, 32)),
        placeholder: info.target_placeholder || null,
        value: targets[info.type] ?? '',
        onInput: (event) => { targets[info.type] = event.target.value; changed({ channels: true }); },
      });
      targetField = field({ id: targetId, label: info.target_label, required: info.target_required, control });
      targetField.classList.add('new-channel-target');
      nodes[`target:${info.type}`] = targetField;
    }
    const warning = h('div', { class: 'new-channel-warning', hidden: true });
    nodes[`warning:${info.type}`] = warning;
    const extra = h('div', { class: 'new-channel-extra', hidden: !selected.has(info.type) },
      targetField,
      info.runtime_detection === 'web_share' ? h('p', { class: 'field-help' }, t('new.channels.web_share')) : null,
      warning);
    nodes[`extra:${info.type}`] = extra;
    nodes[`check:${info.type}`] = input;

    const option = h('li', { class: 'new-channel', 'data-type': info.type },
      h('label', { class: 'choice new-channel-choice', for: id }, input,
        h('span', { class: 'choice-text' },
          h('span', { class: 'choice-label', id: `${id}-label` }, info.label),
          flag,
          h('span', { class: 'choice-help', id: helpId }, info.help))),
      extra);
    return option;
  }

  function channelsSection() {
    nodes.channelError = groupError('new-channels-error');
    nodes.channelCount = h('p', { class: 'muted new-channel-count', id: 'new-channels-count' });
    nodes.channelMax = h('p', { class: 'field-help new-channel-max', hidden: true }, t('new.channels.max_reached'));
    nodes.channelRequired = h('p', { class: 'new-channel-required' },
      h('span', { class: 'field-required', 'aria-hidden': 'true' }, '* '), t('new.channels.required'));
    nodes.channelNone = h('div', { hidden: true }, callout('info', h('p', null, t('new.channels.none_open'))));
    nodes.channelGroup = h('fieldset', {
      class: 'field field-group new-fieldset', id: 'new-channels',
      'aria-describedby': 'new-channels-help new-channels-count new-channels-error',
    },
    h('legend', { class: 'visually-hidden' }, t('new.sections.channels.legend')),
    h('ul', { class: 'new-channel-list', role: 'list' }, channelTypes.map(channelOption)),
    nodes.channelMax,
    nodes.channelError);
    return h('section', { class: 'card new-section', 'aria-labelledby': 'new-s4' },
      sectionTitle(4, t('new.sections.channels.title'), 'new-s4'),
      h('p', { class: 'field-help', id: 'new-channels-help' }, t('new.sections.channels.help')),
      nodes.channelRequired,
      nodes.channelGroup,
      nodes.channelCount,
      nodes.channelNone);
  }

  function updateChannelsUi() {
    const full = selected.size >= CHANNELS_MAX;
    for (const info of channelTypes) {
      const input = nodes[`check:${info.type}`];
      const isOn = selected.has(info.type);
      input.checked = isOn;
      input.disabled = full && !isOn;
      nodes[`extra:${info.type}`].hidden = !isOn;
      const warningNode = nodes[`warning:${info.type}`];
      const text = form.mode === 'anonymous' && isOn ? anonymityWarning('anonymous', info.type, channelsData) : null;
      warningNode.hidden = !text;
      mount(warningNode, text
        ? h('p', { class: 'new-channel-warning-text' },
          icon('alert'),
          h('span', null, h('strong', null, t('new.channels.respondent_warning')), ' «\u00a0', text, '\u00a0»'))
        : null);
    }
    nodes.channelMax.hidden = !full;
    nodes.channelCount.textContent = t('new.channels.count', { count: selected.size });
    nodes.channelRequired.hidden = form.mode !== 'anonymous';
    nodes.channelNone.hidden = !(form.mode === 'open' && selected.size === 0);
  }

  // --- Section 5 : paramètres avancés -----------------------------------------------------------

  function advancedSection() {
    nodes.minGroup = h('input', {
      type: 'number', id: 'new-min-group', inputmode: 'numeric', step: '1',
      min: String(MIN_GROUP_SIZE.min), max: String(MIN_GROUP_SIZE.max), value: String(MIN_GROUP_SIZE.default),
      onInput: () => { modeMaskText(); updateRequiredUi(); changed(); },
    });
    nodes.minGroupHelp = h('p', { class: 'field-help', id: 'new-min-group-help' });
    nodes.minGroupField = field({ id: 'new-min-group', label: t('new.fields.min_group_size.label'), control: nodes.minGroup });
    nodes.minGroupField.insertBefore(nodes.minGroupHelp, nodes.minGroup);
    describe(nodes.minGroup, 'new-min-group-help');
    nodes.minGroupField.classList.add('new-min-group');

    const comments = choiceCheckbox({
      id: 'new-comments', label: t('new.fields.comments_exportable.label'), help: t('new.fields.comments_exportable.help'),
      checked: form.comments_exportable,
      onChange: (event) => { form.comments_exportable = event.target.checked; changed(); },
    });
    const byDept = choiceCheckbox({
      id: 'new-group-dept', label: t('new.fields.group_by_department.label'), help: t('new.fields.group_by_department.help'),
      checked: form.group_by_department,
      onChange: (event) => { form.group_by_department = event.target.checked; changed(); },
    });
    nodes.advanced = h('details', { class: 'card new-section new-advanced' },
      h('summary', { class: 'new-advanced-summary' },
        h('h2', { class: 'new-section-title', id: 'new-s5' },
          h('span', { class: 'new-section-num', 'aria-hidden': 'true' }, '5'),
          h('span', null, t('new.sections.advanced'))),
        h('span', { class: 'muted new-advanced-hint' }, t('new.sections.advanced_hint'))),
      h('div', { class: 'stack new-advanced-body' }, nodes.minGroupField, comments.node, byDept.node));
    return nodes.advanced;
  }

  function modeMaskText() {
    if (nodes.modeMask) nodes.modeMask.textContent = t('new.mode.anonymous.mask', { k: k() });
  }

  function updateMinGroupUi() {
    const open = form.mode === 'open';
    nodes.minGroup.disabled = open;
    nodes.minGroupHelp.textContent = open
      ? t('new.fields.min_group_size.help_open')
      : t('new.fields.min_group_size.help', { min: MIN_GROUP_SIZE.min, max: MIN_GROUP_SIZE.max });
  }

  // --- Aperçu -----------------------------------------------------------------------------------

  function previewAside() {
    nodes.linkLength = h('p', { class: 'new-link-length' });
    nodes.meterBar = h('span', { class: 'new-meter-bar' });
    nodes.meter = h('span', { class: 'new-meter', 'aria-hidden': 'true' }, nodes.meterBar, h('span', { class: 'new-meter-mark' }));
    nodes.linkOver = h('div', { hidden: true }, callout('warn', h('p', null, t('new.preview.over'))));
    nodes.summary = h('dl', { class: 'meta-list new-summary' });
    return h('aside', { class: 'new-aside', 'aria-labelledby': 'new-preview-title' },
      h('div', { class: 'card new-preview' },
        h('h2', { class: 'new-preview-title', id: 'new-preview-title' }, icon('lock'), h('span', null, t('new.preview.title'))),
        nodes.linkLength,
        nodes.meter,
        h('p', { class: 'field-help' }, t('new.preview.target', { target: formatNumber(LINK_TARGET_LENGTH) })),
        nodes.linkOver,
        nodes.summary),
      callout('info',
        h('p', null, h('strong', null, t('new.preview.local_title'))),
        h('p', null, t('new.preview.local_text'))));
  }

  function updatePreview() {
    const current = readForm();
    let length = null;
    try {
      length = collectUrlLength(ctx.baseUrl, draftCampaign(current, channelsData));
    } catch (err) {
      console.warn('[Recensia] Aperçu du lien impossible.', err);
    }
    if (length !== null) {
      const status = linkLengthStatus(length);
      nodes.linkLength.textContent = t('new.preview.length', { length: formatNumber(length) });
      nodes.meterBar.style.setProperty('width', `${Math.min(100, Math.round((length / (LINK_TARGET_LENGTH * 1.25)) * 100))}%`);
      nodes.meter.classList.toggle('is-over', status.over);
      nodes.linkOver.hidden = !status.over;
      // Région distincte (assertive) : l'annonce « service ajouté », émise juste après, ne l'écrase pas.
      if (status.over && !lastOver) announce(t('new.preview.over_announce', { target: formatNumber(LINK_TARGET_LENGTH) }), { assertive: true });
      lastOver = status.over;
    }
    const names = current.channels.map((c) => channelTypes.find((x) => x.type === c.type)?.label).filter(Boolean);
    const valid = current.departments.map((d) => d.trim()).filter(Boolean);
    mount(nodes.summary,
      h('dt', null, t('new.preview.summary.mode')), h('dd', null, t(`common.mode.${form.mode}`)),
      h('dt', null, t('new.preview.summary.departments')), h('dd', null, valid.length ? String(valid.length) : t('new.preview.summary.none')),
      h('dt', null, t('new.preview.summary.channels')), h('dd', null, names.length ? names.join(', ') : t('new.preview.summary.none')),
      h('dt', null, t('new.preview.summary.closes')), h('dd', null, form.closes_on ? formatDate(form.closes_on) : t('new.preview.summary.no_date')));
  }

  // --- Erreurs ----------------------------------------------------------------------------------

  function errorMessage(error) {
    const vars = { min: MIN_GROUP_SIZE.min, max: MIN_GROUP_SIZE.max };
    const group = error.field.startsWith('departments.') ? 'department'
      : error.field.startsWith('channels.') ? 'channel' : error.field;
    const key = `new.errors.${group}.${error.code}`;
    return ctx.i18n.has(key) ? t(key, vars) : t('new.errors.generic');
  }

  function locate(error) {
    const f = error.field;
    if (f === 'title') return { label: t('new.fields.title.label'), control: nodes.title, node: nodes.titleField };
    if (f === 'org_name') return { label: t('new.fields.org_name.label'), control: nodes.org, node: nodes.orgField };
    if (f === 'closes_on') return { label: t('new.fields.closes_on.label'), control: nodes.closes, node: nodes.closesField };
    if (f === 'min_group_size') return { label: t('new.fields.min_group_size.label'), control: nodes.minGroup, node: nodes.minGroupField, advanced: true };
    if (f === 'department_add') {
      return { label: t('new.fields.department_new.label'), control: nodes.deptAdd, node: nodes.deptAddField, message: t(`new.errors.department.${error.code}`) };
    }
    if (f === 'mode') return { label: t('new.sections.mode.title'), control: root.querySelector('input[name="new-mode"]'), group: nodes.modeError };
    if (f === 'departments') return { label: t('new.sections.departments.title'), control: nodes.deptList.querySelector('input') ?? nodes.deptAdd, group: nodes.deptError };
    if (f === 'channels') return { label: t('new.sections.channels.title'), control: nodes.channelGroup.querySelector('input:not(:disabled)'), group: nodes.channelError };
    let m = /^departments\.(\d+)$/.exec(f);
    if (m) {
      const dept = departments[Number(m[1])];
      const row = dept ? nodes.deptList.querySelector(`[data-key="${dept.key}"]`) : null;
      return {
        label: t('new.fields.department_row', { n: Number(m[1]) + 1 }),
        control: row?.querySelector('input') ?? nodes.deptAdd,
        row,
      };
    }
    m = /^channels\.([a-z_]+)$/.exec(f);
    if (m) {
      const info = channelTypes.find((c) => c.type === m[1]);
      const targetField = nodes[`target:${m[1]}`];
      return {
        label: info?.label ?? m[1],
        control: targetField?.querySelector('input') ?? nodes[`check:${m[1]}`],
        node: targetField ?? null,
        group: targetField ? null : nodes.channelError,
      };
    }
    return { label: t('new.title'), control: nodes.title, group: nodes.formError };
  }

  function clearErrors() {
    for (const node of [nodes.titleField, nodes.orgField, nodes.closesField, nodes.minGroupField, nodes.deptAddField]) setFieldError(node, null);
    for (const info of channelTypes) if (nodes[`target:${info.type}`]) setFieldError(nodes[`target:${info.type}`], null);
    for (const group of [nodes.modeError, nodes.deptError, nodes.channelError, nodes.formError]) setGroupError(group, null);
    nodes.channelGroup.classList.remove('has-error');
    for (const row of nodes.deptList.querySelectorAll('.new-dept-row')) {
      row.classList.remove('has-error');
      row.querySelector('input')?.removeAttribute('aria-invalid');
      setGroupError(row.querySelector('.field-error'), null);
    }
  }

  function showErrors(errors, { focus = false } = {}) {
    clearErrors();
    const items = [];
    const seen = new Set();
    for (const error of errors) {
      if (seen.has(error.field)) continue;
      seen.add(error.field);
      const where = locate(error);
      const message = where.message ?? errorMessage(error);
      if (where.node) setFieldError(where.node, message);
      else if (where.row) {
        where.row.classList.add('has-error');
        where.row.querySelector('input')?.setAttribute('aria-invalid', 'true');
        setGroupError(where.row.querySelector('.field-error'), message);
      } else if (where.group) {
        setGroupError(where.group, message);
        if (where.group === nodes.channelError) nodes.channelGroup.classList.add('has-error');
      }
      if (where.advanced && nodes.advanced) nodes.advanced.open = true;
      items.push({ ...where, message });
    }
    if (!items.length) {
      nodes.summaryBox.hidden = true;
      mount(nodes.summaryBox);
      return;
    }
    if (!focus && nodes.summaryBox.hidden) return;
    const heading = h('h2', { class: 'new-errors-title', id: 'new-errors-title', tabindex: '-1' },
      t('new.errors.summary', { count: items.length }));
    mount(nodes.summaryBox, callout('danger', heading,
      h('ul', { class: 'new-errors-list' }, items.map((item) => h('li', null,
        h('a', {
          href: `#${item.control?.id ?? 'new-title'}`,
          onClick: (event) => {
            event.preventDefault();
            item.control?.focus();
          },
        }, `${item.label}\u00a0: ${item.message}`))))));
    nodes.summaryBox.hidden = false;
    if (focus) heading.focus();
  }

  // --- Cycle de vie -----------------------------------------------------------------------------

  function changed() {
    updatePreview();
    if (submitted) {
      const result = validateCampaignForm(readForm(), { channelsData, today: localDay() });
      showErrors(result.errors);
    }
  }

  function modeChanged() {
    updateDepartmentUi();
    updateChannelsUi();
    updateMinGroupUi();
    changed();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    submitted = true;
    // Service saisi mais pas encore ajouté : il est ajouté s'il est valide, sinon signalé.
    const pending = nodes.deptAdd.value;
    if (pending.trim() && addDepartment(pending)) nodes.deptAdd.value = '';
    const result = validateCampaignForm(readForm(), { channelsData, today: localDay() });
    const addIssue = nodes.deptAdd.value.trim() ? departmentIssue(departments.map((d) => d.value), nodes.deptAdd.value) : null;
    const errors = addIssue ? [...result.errors, { field: 'department_add', code: addIssue }] : result.errors;
    showErrors(errors, { focus: true });
    if (!result.ok || addIssue) return;

    busy = true;
    nodes.submit.disabled = true;
    nodes.submit.setAttribute('aria-busy', 'true');
    nodes.submitLabel.textContent = t('new.submitting');
    try {
      const keys = await generateCampaignKeys();
      let id = randomId(9);
      for (let i = 0; i < 5 && (await store.getCampaign(id)); i += 1) id = randomId(9);
      const built = buildCampaign(result.value, {
        id,
        publicKey: keys.publicKeyB64,
        privateKeyJwk: keys.privateKeyJwk,
        fingerprint: keys.fingerprint,
        createdAt: new Date().toISOString(),
      });
      if (!built.ok) {
        showErrors(built.errors, { focus: true });
        return;
      }
      await store.putCampaign(built.campaign);
      ctx.track.event('event/campaign_created');
      if (isDisposed()) return;
      mountKeyStep({ root, ctx, campaign: built.campaign });
      announce(t('new.created_announce'));
    } catch (err) {
      console.error('[Recensia] Création de la campagne impossible.', err);
      setGroupError(nodes.formError, t('new.create_failed'));
      nodes.formError.focus?.();
    } finally {
      busy = false;
      if (nodes.submit.isConnected) {
        nodes.submit.disabled = false;
        nodes.submit.removeAttribute('aria-busy');
        nodes.submitLabel.textContent = t('new.submit');
      }
    }
  }

  function mountForm() {
    nodes.summaryBox = h('div', { class: 'new-errors', hidden: true });
    nodes.formError = h('p', { class: 'field-error new-form-error', id: 'new-form-error', hidden: true, tabindex: '-1', role: 'alert' });
    nodes.submitLabel = h('span', { class: 'btn-label' }, t('new.submit'));
    nodes.submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('key'), nodes.submitLabel);

    // Entrée dans un champ ne crée pas la campagne : seule l'activation du bouton le fait
    // (la génération des clés ne doit pas partir avant d'avoir relu les sections suivantes).
    const onKeydown = (event) => {
      const el = event.target;
      if (event.key === 'Enter' && el instanceof HTMLInputElement && !['submit', 'button', 'reset'].includes(el.type)) event.preventDefault();
    };
    const formNode = h('form', { class: 'new-form stack', novalidate: true, onSubmit, onKeydown, 'aria-labelledby': 'new-form-title' },
      h('h2', { class: 'visually-hidden', id: 'new-form-title' }, t('new.steps.settings')),
      nodes.summaryBox,
      h('p', { class: 'muted new-legend' }, t('common.field.required_legend')),
      campaignSection(),
      modeSection(),
      departmentsSection(),
      channelsSection(),
      advancedSection(),
      nodes.formError,
      h('div', { class: 'form-actions new-actions' },
        nodes.submit,
        h('a', { class: 'btn btn-ghost', href: '#/' }, t('new.cancel'))));

    mount(root, h('div', { class: 'page new-page' },
      pageHeader(t, 'settings'),
      store.kind === 'memory' ? callout('warn', h('p', null, t('new.memory_store'))) : null,
      h('div', { class: 'new-layout' }, formNode, previewAside())));

    renderDepartments();
    updateChannelsUi();
    updateMinGroupUi();
    updatePreview();
  }

  return { mountForm };
}

// ---------------------------------------------------------------------------------------------
// Étape 2 : protégez votre clé
// ---------------------------------------------------------------------------------------------

function mountKeyStep({ root, ctx, campaign }) {
  const { t, store } = ctx;
  const fp = formatFingerprint(campaign.fingerprint);
  let busy = false;

  const password = h('input', { type: 'password', id: 'new-key-password', autocomplete: 'new-password', spellcheck: 'false' });
  const confirm = h('input', { type: 'password', id: 'new-key-confirm', autocomplete: 'new-password', spellcheck: 'false' });
  const strengthText = h('span', { class: 'new-strength-text' });
  const strength = h('p', { class: 'new-strength', id: 'new-key-strength', 'data-level': 'empty' },
    h('span', { class: 'new-strength-bar', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
    h('span', null, h('span', { class: 'new-strength-label' }, t('new.key.strength.label')), ' ', strengthText));
  const passwordField = field({
    id: 'new-key-password',
    label: t('new.key.password.label'),
    help: t('new.key.password.help', { min: PASSWORD_MIN_LENGTH }),
    control: password,
  });
  passwordField.insertBefore(strength, passwordField.querySelector('.field-error'));
  describe(password, 'new-key-strength');
  const confirmField = field({ id: 'new-key-confirm', label: t('new.key.confirm.label'), control: confirm });

  const show = h('label', { class: 'new-inline-check', for: 'new-key-show' },
    h('input', {
      type: 'checkbox', id: 'new-key-show',
      onChange: (event) => {
        const type = event.target.checked ? 'text' : 'password';
        password.type = type;
        confirm.type = type;
      },
    }),
    h('span', null, t('new.key.show')));

  const noPasswordWarning = h('div', { hidden: true }, callout('danger', h('p', null, t('new.key.no_password_warning'))));
  const noPassword = h('input', {
    type: 'checkbox', id: 'new-key-none',
    onChange: (event) => {
      const off = event.target.checked;
      password.disabled = off;
      confirm.disabled = off;
      passwordFields.classList.toggle('is-disabled', off);
      noPasswordWarning.hidden = !off;
      setFieldError(passwordField, null);
      setFieldError(confirmField, null);
    },
  });
  const noPasswordNode = h('label', { class: 'choice new-check new-no-password', for: 'new-key-none' }, noPassword,
    h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, t('new.key.no_password'))));

  const passwordFields = h('div', { class: 'new-password-fields' },
    // Identifiant masqué : les gestionnaires de mots de passe rattachent ainsi le mot de passe à la campagne.
    h('input', { type: 'text', autocomplete: 'username', value: t('new.key.username', { fp }), hidden: true, 'aria-hidden': 'true', tabindex: '-1', readonly: true }),
    passwordField, confirmField, show);

  const updateStrength = () => {
    const s = passwordStrength(password.value);
    strength.dataset.level = s.level;
    strengthText.textContent = t(`new.key.strength.${s.level}`);
  };
  password.addEventListener('input', () => { updateStrength(); setFieldError(passwordField, null); });
  confirm.addEventListener('input', () => setFieldError(confirmField, null));
  updateStrength();

  const errorBox = h('p', { class: 'field-error', id: 'new-key-error', hidden: true, role: 'alert' });
  const downloadLabel = h('span', { class: 'btn-label' }, t('new.key.download'));
  const downloadButton = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('download'), downloadLabel);
  const laterButton = button(t('new.key.later'), onLater, { variant: 'ghost' });
  const continueButton = button(t('new.key.continue'), () => ctx.navigate(`/admin/${campaign.id}/diffuser`), { variant: 'primary', icon: 'arrow-right' });
  const doneName = h('span');
  const doneBox = h('div', { class: 'stack new-key-done', hidden: true },
    callout('success',
      h('p', null, h('strong', null, t('new.key.downloaded_title'))),
      h('p', null, doneName),
      h('p', null, t('new.key.moving'))),
    h('div', { class: 'cluster' }, continueButton));

  function validatePassword() {
    if (noPassword.checked) return { ok: true, value: null };
    const s = passwordStrength(password.value);
    let error = null;
    if (s.level === 'empty') error = t('new.key.errors.password_required');
    else if (s.level === 'too_short') error = t('new.key.errors.too_short', { min: PASSWORD_MIN_LENGTH });
    else if (!s.ok) error = t('new.key.errors.weak');
    if (error) {
      setFieldError(passwordField, error);
      password.focus();
      return { ok: false };
    }
    if (confirm.value !== password.value) {
      setFieldError(confirmField, t('new.key.errors.mismatch'));
      confirm.focus();
      return { ok: false };
    }
    return { ok: true, value: password.value };
  }

  async function onDownload(event) {
    event.preventDefault();
    if (busy) return;
    setGroupError(errorBox, null);
    const check = validatePassword();
    if (!check.ok) return;
    busy = true;
    downloadButton.disabled = true;
    downloadButton.setAttribute('aria-busy', 'true');
    downloadLabel.textContent = t('new.key.downloading');
    try {
      const stored = await store.getCampaign(campaign.id);
      if (!stored?.private_key_jwk) throw new Error(t('new.key.errors.missing'));
      // Même fichier (format, nom, type MIME) que l'onglet Paramètres : src/services/recovery.js.
      const file = await buildRecoveryFile(stored, check.value, { today: localDay() });
      const name = file.filename;
      downloadText(file.text, name, file.mime);
      // markRecoverySaved relit la campagne avant d'écrire (putCampaign écrase l'objet entier).
      await markRecoverySaved(store, campaign.id);
      password.value = '';
      confirm.value = '';
      updateStrength();
      doneName.textContent = t('new.key.downloaded', { name });
      doneBox.hidden = false;
      downloadLabel.textContent = t('new.key.download_again');
      downloadButton.classList.replace('btn-primary', 'btn-secondary');
      laterButton.hidden = true;
      announce(t('new.key.downloaded_announce'));
      continueButton.focus();
    } catch (err) {
      console.error('[Recensia] Fichier de récupération impossible.', err);
      setGroupError(errorBox, t('new.key.errors.failed'));
      if (!doneBox.hidden) return;
      downloadLabel.textContent = t('new.key.download');
    } finally {
      busy = false;
      downloadButton.disabled = false;
      downloadButton.removeAttribute('aria-busy');
    }
  }

  async function onLater() {
    const ok = await confirmDialog({
      title: t('new.key.later_confirm.title'),
      message: t('new.key.later_confirm.message'),
      confirmLabel: t('new.key.later_confirm.confirm'),
      danger: true,
    });
    if (ok) ctx.navigate(`/admin/${campaign.id}/diffuser`);
  }

  const heading = h('h2', { id: 'new-key-title', tabindex: '-1', class: 'new-key-title' }, icon('key'), h('span', null, t('new.key.title')));
  mount(root, h('div', { class: 'page page-narrow new-page new-key-page' },
    pageHeader(t, 'key'),
    store.kind === 'memory' ? callout('warn', h('p', null, t('new.memory_store'))) : null,
    h('section', { class: 'card new-key', 'aria-labelledby': 'new-key-title' },
      heading,
      h('p', { class: 'new-key-created' }, icon('success'), h('span', null, t('new.key.created', { title: campaign.title }))),
      h('p', null, t('new.key.lead')),
      callout('danger',
        h('p', null, h('strong', null, t('new.key.danger_title'))),
        h('p', null, t('new.key.danger'))),
      h('p', null, t('new.key.explain')),
      h('p', { class: 'new-key-fp' }, h('span', null, t('new.key.fingerprint')), ' ', h('span', { class: 'fingerprint' }, fp)),
      h('form', { class: 'new-key-form', novalidate: true, onSubmit: onDownload, 'aria-labelledby': 'new-key-title' },
        passwordFields,
        noPasswordNode,
        noPasswordWarning,
        errorBox,
        h('div', { class: 'form-actions' }, downloadButton, laterButton)),
      doneBox)));
  heading.focus();
  globalThis.scrollTo?.(0, 0);
}
