// Formulaire répondant (#/c/<payload>, CDC §4, §5.1, §7.2, §7.4, §7.7) :
// notice (finalité, mode, limites, canal de retour, empreinte), identité en mode ouvert,
// description de 1 à n usages (brouillon local), un code chiffré par usage, envoi par les canaux
// choisis par le responsable. Aucune requête réseau pendant la saisie et le chiffrement : les
// données et textes sont chargés avant l'affichage, tout le reste est calculé sur l'appareil.

import { h, mount, loadCss, announce } from '../ui/dom.js';
import { button, callout, icon, field, setFieldError, confirmDialog, toast } from '../ui/components.js';
import { local } from '../ui/safe-storage.js';
import { formatDate } from '../i18n.js';
import { renderQuestionnaire, frenchSpacing } from '../ui/questionnaire.js';
import { decodeAndVerifyCampaignLink, LinkError } from '../crypto/link.js';
import { fingerprint, formatFingerprint } from '../crypto/keys.js';
import { randomId } from '../crypto/random.js';
import { validateRespondent, NAME_MAX, EMAIL_MAX } from '../engine/validate.js';
import { optionLabel } from '../engine/labels.js';
import { returnChannelText } from '../share/messages.js';
import {
  draftKey, emptyDraft, restoreDraft, hasContent, upsertItem, removeItem, setCurrent, setRespondent,
  findItem, codeState, checkItems,
} from './form/draft.js';
import { generateCodes, isClosed, localDay } from './form/codes.js';
import { sendPlan, distinctWarnings } from './form/send-plan.js';
import { renderSendStage } from './form/send.js';

const SAVE_DELAY_MS = 400;
const STEPS = ['intro', 'usages', 'send'];
const STAGE_STEP = { intro: 0, edit: 1, list: 1, codes: 2 };

function problem(root, { iconName = 'alert', danger = false, title, text, actions = [] }) {
  mount(root, h('div', { class: 'page page-narrow' },
    h('div', { class: 'empty-state' },
      h('span', { class: ['empty-state-icon', danger ? 'empty-state-danger' : null] }, icon(iconName)),
      h('h1', null, title),
      text ? h('p', { class: 'lead' }, text) : null,
      actions.length ? h('div', { class: 'cluster cluster-center' }, actions) : null)));
}

function linkProblem(root, ctx, err) {
  const { t } = ctx;
  const reload = button(t('common.actions.reload'), () => globalThis.location.reload(), { variant: 'primary', icon: 'refresh' });
  const home = h('a', { class: 'btn btn-secondary', href: '#/' }, t('common.actions.back_home'));
  if (err instanceof LinkError && err.code === 'version') {
    ctx.setTitle(t('form.errors.version_title'));
    problem(root, { title: t('form.errors.version_title'), text: t('form.errors.version_text'), actions: [reload, home] });
    return;
  }
  if (!(err instanceof LinkError)) console.error('[Recensia] Lien de collecte illisible.', err);
  ctx.setTitle(t('form.errors.broken_title'));
  problem(root, { danger: true, iconName: 'danger', title: t('form.errors.broken_title'), text: t('form.errors.broken_text'), actions: [home] });
}

export async function render(root, { params, ctx }) {
  const { t } = ctx;
  await Promise.all([loadCss('src/styles/questionnaire.css'), loadCss('src/styles/form.css')]);

  if (!globalThis.crypto?.subtle) {
    ctx.setTitle(t('form.errors.insecure_title'));
    problem(root, { title: t('form.errors.insecure_title'), text: t('form.errors.insecure_text') });
    return undefined;
  }

  let config;
  try {
    config = await decodeAndVerifyCampaignLink(params?.payload ?? '');
  } catch (err) {
    linkProblem(root, ctx, err);
    return undefined;
  }

  let questionnaire;
  let channelsData;
  let templates;
  let fpRaw;
  try {
    [questionnaire, channelsData, templates, fpRaw] = await Promise.all([
      ctx.data.get('questionnaire'),
      ctx.data.get('channels'),
      ctx.data.get('messages.fr'),
      fingerprint(config.pk),
      ctx.i18n.load('questionnaire'),
    ]);
  } catch (err) {
    console.error('[Recensia] Données du formulaire indisponibles.', err);
    ctx.setTitle(t('form.errors.data_title'));
    problem(root, {
      title: t('form.errors.data_title'),
      text: t('common.errors.data_unavailable'),
      actions: [button(t('common.actions.reload'), () => globalThis.location.reload(), { variant: 'primary', icon: 'refresh' })],
    });
    return undefined;
  }

  return startForm(root, { ctx, config, questionnaire, channelsData, templates, fpRaw });
}

function startForm(root, { ctx, config, questionnaire, channelsData, templates, fpRaw }) {
  const { t } = ctx;
  const campaignOpts = { mode: config.mode, departments: config.depts, department_required: config.dreq === true };
  const storageKey = draftKey(config.id);
  const persistent = local.available();
  const fp = formatFingerprint(fpRaw);
  const closed = isClosed(config.closes, localDay());
  const plan = sendPlan({ channels: config.channels, mode: config.mode, channelsData });
  const minutes = Number.isInteger(questionnaire.estimated_minutes) ? questionnaire.estimated_minutes : 3;
  const open = config.mode === 'open';

  let draft = restoreDraft(local.get(storageKey, null), config.id, questionnaire);
  let saveTimer = null;
  let disposed = false;
  let q = null;
  let stage = null;

  ctx.setTitle(t('form.meta.title', { title: config.title }));

  // --- Brouillon ------------------------------------------------------------------------

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (hasContent(draft)) local.set(storageKey, draft);
    else local.remove(storageKey);
    updateFooter();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function flush() {
    if (saveTimer !== null) saveNow();
  }

  // --- Structure de la page ------------------------------------------------------------

  const stepItems = STEPS.map((step) => h('li', { class: 'stepper-item' }, h('span', null, t(`form.steps.${step}`))));
  const stepper = h('ol', { class: 'stepper stepper-inline form-steps', 'aria-label': t('form.steps.label') }, stepItems);
  const stageRoot = h('div', { class: 'form-stage' });
  const clearButton = button(t('form.clear.button'), () => clearAll(), { variant: 'ghost', icon: 'trash', attrs: { class: 'form-clear' } });
  const footer = h('footer', { class: 'form-footer' },
    clearButton,
    h('p', { class: 'muted small' }, persistent ? t('form.footer.local') : t('form.footer.memory'), ' ',
      h('a', { href: '#/privacy' }, t('form.footer.privacy'))));

  mount(root, h('div', { class: 'page page-narrow form-page' },
    h('header', { class: 'page-header form-header' },
      h('div', null,
        h('p', { class: 'eyebrow' }, config.org || t('form.header.eyebrow')),
        h('h1', null, config.title),
        h('p', { class: 'cluster form-header-meta' },
          h('span', { class: 'badge badge-neutral' }, icon(open ? 'users' : 'shield'), t(`form.header.mode_${config.mode}`)),
          h('span', { class: 'muted' }, t('form.header.fingerprint'), ' ', h('span', { class: 'fingerprint' }, fp))))),
    closed ? callout('warn', h('p', null, h('strong', null, t('form.closed.title', { date: formatDate(config.closes) })), ' ', t('form.closed.text'))) : null,
    stepper,
    stageRoot,
    footer));

  function updateFooter() {
    clearButton.hidden = !hasContent(draft) || stage === 'codes';
  }

  function updateStepper() {
    const current = STAGE_STEP[stage] ?? 0;
    stepItems.forEach((item, index) => {
      item.classList.toggle('is-done', index < current);
      if (index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function focusStage() {
    const heading = stageRoot.querySelector('h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    globalThis.scrollTo(0, 0);
  }

  function go(next, arg = {}, { focus = true } = {}) {
    if (disposed) return;
    flush();
    if (q) {
      q.destroy();
      q = null;
    }
    stage = next;
    updateStepper();
    updateFooter();
    if (next === 'intro') renderIntro(arg);
    else if (next === 'edit') renderEdit(arg);
    else if (next === 'list') renderList(arg);
    else if (next === 'codes') {
      renderCodes().catch((err) => console.error('[Recensia] Étape d’envoi impossible.', err));
      return;
    }
    if (focus) focusStage();
  }

  function start() {
    if (draft.current) go('edit', { entryId: draft.current.entry_id, value: draft.current.value });
    else if (draft.items.length) go('list');
    else go('edit', {});
  }

  async function clearAll() {
    const ok = await confirmDialog({
      title: t('form.clear.title'),
      message: t('form.clear.text'),
      confirmLabel: t('form.clear.confirm'),
      danger: true,
    });
    if (!ok || disposed) return;
    draft = emptyDraft(config.id);
    local.remove(storageKey);
    clearTimeout(saveTimer);
    saveTimer = null;
    go('intro');
    toast(t('form.clear.done'), 'success');
  }

  // --- Étape 1 : notice (et identité en mode ouvert) ------------------------------------

  function identityCard({ onSubmit } = {}) {
    const values = draft.respondent ?? { first_name: '', last_name: '', email: '' };
    const onInput = () => {
      draft = setRespondent(draft, { first_name: first.value, last_name: last.value, email: email.value });
      scheduleSave();
    };
    // Entrée : champ suivant, puis « Commencer » depuis le dernier champ.
    const onEnter = (next) => (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      next();
    };
    const first = h('input', { type: 'text', name: 'first_name', autocomplete: 'given-name', enterkeyhint: 'next', maxlength: String(NAME_MAX), value: values.first_name ?? '', onInput, onKeydown: onEnter(() => last.focus()) });
    const last = h('input', { type: 'text', name: 'last_name', autocomplete: 'family-name', enterkeyhint: 'next', maxlength: String(NAME_MAX), value: values.last_name ?? '', onInput, onKeydown: onEnter(() => email.focus()) });
    const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', enterkeyhint: 'go', maxlength: String(EMAIL_MAX), spellcheck: 'false', value: values.email ?? '', onInput, onKeydown: onEnter(() => onSubmit?.()) });
    const fields = {
      first_name: field({ id: 'form-first-name', label: t('form.identity.first_name'), required: true, control: first }),
      last_name: field({ id: 'form-last-name', label: t('form.identity.last_name'), required: true, control: last }),
      email: field({ id: 'form-email', label: t('form.identity.email'), help: t('form.identity.email_help'), control: email }),
    };
    const controls = { first_name: first, last_name: last, email };
    const card = h('section', { class: 'card form-identity', 'aria-labelledby': 'form-identity-title' },
      h('h3', { id: 'form-identity-title' }, icon('users'), h('span', null, t('form.identity.title'))),
      h('p', { class: 'muted' }, t('form.identity.lead')),
      h('div', { class: 'form-identity-grid' }, fields.first_name, fields.last_name, fields.email));

    function check() {
      const result = validateRespondent({ first_name: first.value, last_name: last.value, email: email.value }, 'open');
      for (const key of Object.keys(fields)) setFieldError(fields[key], null);
      let firstInvalid = null;
      for (const error of result.errors) {
        const key = Object.hasOwn(fields, error.field) ? error.field : 'first_name';
        setFieldError(fields[key], identityError(t, key, error.code));
        if (!firstInvalid) firstInvalid = controls[key];
      }
      if (firstInvalid) firstInvalid.focus();
      return result;
    }
    return { card, check };
  }

  function renderIntro() {
    const returnText = frenchSpacing(returnChannelText(config.channels ?? [], templates, channelsData));
    const warnings = distinctWarnings(plan).map(frenchSpacing);
    const identity = open ? identityCard({ onSubmit: () => onStart() }) : null;
    const resumeCount = draft.items.length;
    const resume = resumeCount > 0 || Boolean(draft.current);

    function onStart() {
      if (identity) {
        const result = identity.check();
        if (!result.ok) {
          announce(t('form.identity.invalid'), { assertive: true });
          return;
        }
        draft = setRespondent(draft, { first_name: result.value.first_name, last_name: result.value.last_name, email: result.value.email ?? '' });
        saveNow();
      }
      start();
    }

    const modeCard = open
      ? h('section', { class: 'card form-mode', 'aria-labelledby': 'form-mode-title' },
        h('h3', { id: 'form-mode-title' }, icon('users'), h('span', null, t('form.mode.open_title'))),
        h('p', null, t('form.mode.open_text')),
        h('p', null, t('form.mode.open_encrypted')))
      : h('section', { class: 'card form-mode', 'aria-labelledby': 'form-mode-title' },
        h('h3', { id: 'form-mode-title' }, icon('shield'), h('span', null, t('form.mode.anonymous_title'))),
        h('ul', { class: 'check-list', role: 'list' },
          h('li', null, icon('check'), h('span', null, t('form.mode.anonymous_no_identity'))),
          h('li', null, icon('check'), h('span', null, t('form.mode.anonymous_day'))),
          h('li', null, icon('check'), h('span', null, t('form.mode.anonymous_unlinkable')))),
        h('h4', { class: 'form-mode-limits' }, t('form.mode.limits_title')),
        h('ul', { class: 'form-limits' },
          warnings.map((text) => h('li', null, text)),
          h('li', null, t('form.mode.anonymous_free_text'))));

    mount(stageRoot, h('section', { class: 'form-intro stack', 'aria-labelledby': 'form-stage-title' },
      h('div', null,
        h('h2', { id: 'form-stage-title', tabindex: '-1' }, t('form.intro.title')),
        h('p', { class: 'lead' }, config.org ? t('form.intro.lead_org', { org: config.org }) : t('form.intro.lead')),
        h('p', null, t('form.intro.no_control'))),
      h('ul', { class: 'check-list form-facts', role: 'list' },
        h('li', null, icon('info'), h('span', null, t('form.intro.duration', { count: minutes }))),
        h('li', null, icon('lock'), h('span', null, t('form.intro.one_code'))),
        h('li', null, icon('share'), h('span', null, returnText ? t('form.intro.return', { channel: returnText }) : t('form.intro.return_default'))),
        h('li', null, icon('offline'), h('span', null, t('form.intro.local'))),
        config.closes && !closed ? h('li', null, icon('alert'), h('span', null, t('form.intro.closes', { date: formatDate(config.closes) }))) : null),
      modeCard,
      h('section', { class: 'card form-fingerprint', 'aria-labelledby': 'form-fp-title' },
        h('h3', { id: 'form-fp-title' }, icon('key'), h('span', null, t('form.fingerprint.title'))),
        h('p', { class: 'form-fingerprint-value' }, h('span', { class: 'fingerprint' }, fp)),
        h('p', { class: 'muted' }, config.org ? t('form.fingerprint.help_org', { org: config.org }) : t('form.fingerprint.help'))),
      identity ? identity.card : null,
      persistent ? null : callout('warn', h('p', null, t('form.intro.no_storage'))),
      resume ? h('p', { class: 'form-resume' }, icon('info'), h('span', null, t('form.intro.resume', { count: resumeCount }))) : null,
      h('div', { class: 'form-actions' },
        button(resume ? t('form.intro.resume_button') : t('form.intro.start'), onStart, { variant: 'primary', icon: 'arrow-right' }))));
  }

  // --- Étape 2 : saisie d'un usage ------------------------------------------------------

  function renderEdit({ entryId = null, value = null } = {}) {
    const item = entryId ? findItem(draft, entryId) : null;
    const editing = Boolean(item);
    const first = draft.items.length === 0 && !editing;
    let dirty = Boolean(value);
    const titleText = editing
      ? t('form.edit.title_edit', { name: item.usage.usage_name ?? '' })
      : first ? t('form.edit.title_first') : t('form.edit.title_another', { n: draft.items.length + 1 });

    const qRoot = h('div', { class: 'form-questionnaire' });
    const form = h('form', {
      class: 'form-edit-form',
      novalidate: true,
      'aria-labelledby': 'form-stage-title',
      onSubmit: (event) => {
        event.preventDefault();
        submit();
      },
    }, qRoot,
    h('div', { class: 'form-actions' },
      button(editing ? t('form.edit.save_edit') : t('form.edit.save'), null, { variant: 'primary', type: 'submit', icon: 'check' }),
      button(first ? t('form.edit.back_intro') : t('common.actions.cancel'), () => cancel(), { icon: first ? 'arrow-left' : null })));

    mount(stageRoot, h('section', { class: 'form-edit', 'aria-labelledby': 'form-stage-title' },
      h('h2', { id: 'form-stage-title', tabindex: '-1' }, titleText),
      h('p', { class: 'muted' }, first ? t('form.edit.lead_first', { count: minutes }) : t('form.edit.lead')),
      editing && codeState(item, null) !== 'none' ? callout('info', h('p', null, t('form.edit.revision_note'))) : null,
      form));

    q = renderQuestionnaire(qRoot, {
      questionnaire,
      campaign: campaignOpts,
      initial: value ?? item?.usage ?? null,
      t,
      idPrefix: 'form-q',
      headingLevel: 3,
      onChange: (next) => {
        dirty = true;
        draft = setCurrent(draft, entryId, next);
        scheduleSave();
      },
    });

    function submit() {
      const result = q.validate();
      if (!result.ok) {
        q.focusFirstError();
        return;
      }
      draft = upsertItem(draft, { entryId: editing ? entryId : null, usage: result.value, newId: randomId(12) });
      saveNow();
      go('list', { saved: result.value.usage_name, edited: editing });
    }

    async function cancel() {
      if (dirty) {
        const ok = await confirmDialog({
          title: t('form.edit.cancel_title'),
          message: t('form.edit.cancel_text'),
          confirmLabel: t('form.edit.cancel_confirm'),
          danger: true,
        });
        if (!ok || disposed) return;
      }
      draft = setCurrent(draft, null, null);
      saveNow();
      go(draft.items.length ? 'list' : 'intro');
    }
  }

  // --- Étape 2 bis : liste des usages ---------------------------------------------------

  function respondentValue() {
    if (!open) return { ok: true, value: null };
    return validateRespondent(draft.respondent
      ? { first_name: draft.respondent.first_name, last_name: draft.respondent.last_name, email: draft.respondent.email }
      : null, 'open');
  }

  function renderList({ saved = null, edited = false, message = null } = {}) {
    const checks = new Map(checkItems(draft, questionnaire, campaignOpts).map((c) => [c.entry_id, c]));
    const who = respondentValue();
    const alert = h('div', { class: 'form-list-alert' });

    const usageCard = (item, index) => {
      const check = checks.get(item.entry_id);
      const state = codeState(item, who.ok ? who.value : null);
      const name = item.usage.usage_name || t('form.list.unnamed', { n: index + 1 });
      const meta = [
        item.usage.tool === 'other' && item.usage.tool_other ? item.usage.tool_other : frenchSpacing(optionLabel(questionnaire, 'tool', item.usage.tool)),
        frenchSpacing(optionLabel(questionnaire, 'status', item.usage.status)),
        item.usage.department,
      ].filter(Boolean).join(' · ');
      let badge = null;
      if (!check?.ok) badge = h('span', { class: 'badge badge-aia-to_qualify' }, t('form.list.incomplete'));
      else if (state === 'current') badge = h('span', { class: 'badge badge-neutral' }, icon('check'), t('form.list.coded', { rev: item.coded.rev }));
      else if (state === 'outdated') badge = h('span', { class: 'badge badge-data-1' }, t('form.list.outdated'));
      const titleId = `form-usage-${index}`;
      return h('li', { class: 'card card-compact form-usage', 'aria-labelledby': titleId },
        h('div', { class: 'form-usage-text' },
          h('h3', { class: 'form-usage-title', id: titleId }, name),
          meta ? h('p', { class: 'muted small' }, meta) : null,
          badge),
        h('div', { class: 'cluster form-usage-actions' },
          button(t('common.actions.edit'), () => go('edit', { entryId: item.entry_id }), { icon: 'edit', attrs: { 'aria-describedby': titleId } }),
          button(t('common.actions.delete'), () => remove(item, name), { variant: 'ghost', icon: 'trash', attrs: { 'aria-describedby': titleId } })));
    };

    const identityBox = open && who.ok
      ? h('div', { class: 'card card-compact form-identity-summary' },
        h('p', null, icon('users'), ' ', t('form.list.identity', { name: `${who.value.first_name} ${who.value.last_name}` }),
          who.value.email ? h('span', { class: 'muted' }, ` (${who.value.email})`) : null),
        button(t('form.list.identity_edit'), () => go('intro'), { variant: 'ghost', icon: 'edit' }))
      : null;

    const notice = saved
      ? callout('success', h('p', null, edited ? t('form.list.edited', { name: saved }) : t('form.list.saved', { name: saved })))
      : message ? callout('info', h('p', null, message)) : null;

    mount(stageRoot, h('section', { class: 'form-list stack', 'aria-labelledby': 'form-stage-title' },
      h('div', null,
        h('h2', { id: 'form-stage-title', tabindex: '-1' }, t('form.list.title', { count: draft.items.length })),
        h('p', { class: 'muted' }, t('form.list.lead'))),
      notice,
      identityBox,
      draft.items.length
        ? h('ul', { class: 'form-usages', role: 'list' }, draft.items.map(usageCard))
        : h('p', { class: 'form-empty' }, t('form.list.empty')),
      alert,
      h('div', { class: 'form-actions' },
        button(t('form.list.another'), () => go('edit', {}), { icon: 'plus' }),
        draft.items.length ? button(t('form.list.finish'), () => finish(), { variant: 'primary', icon: 'arrow-right' }) : null)));

    if (saved) announce(edited ? t('form.list.edited', { name: saved }) : t('form.list.saved', { name: saved }));

    function finish() {
      if (open && !who.ok) {
        go('intro');
        announce(t('form.identity.invalid'), { assertive: true });
        return;
      }
      const incomplete = draft.items.filter((item) => !checks.get(item.entry_id)?.ok);
      if (incomplete.length) {
        mount(alert, callout('danger', h('p', null, t('form.list.incomplete_alert', { count: incomplete.length }))));
        alert.setAttribute('tabindex', '-1');
        alert.focus();
        return;
      }
      go('codes');
    }

    async function remove(item, name) {
      const ok = await confirmDialog({
        title: t('form.list.delete_title'),
        message: item.coded ? t('form.list.delete_sent', { name }) : t('form.list.delete_text', { name }),
        confirmLabel: t('form.list.delete_confirm'),
        danger: true,
      });
      if (!ok || disposed) return;
      draft = removeItem(draft, item.entry_id);
      saveNow();
      go('list', { message: t('form.list.deleted', { name }) });
    }
  }

  // --- Étape 3 : codes et envoi ---------------------------------------------------------

  async function renderCodes() {
    mount(stageRoot, h('section', { class: 'form-generating', 'aria-labelledby': 'form-stage-title', 'aria-busy': 'true' },
      h('h2', { id: 'form-stage-title', tabindex: '-1' }, t('form.generating.title')),
      h('p', { role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('form.generating.text'))));
    focusStage();

    const checks = checkItems(draft, questionnaire, campaignOpts);
    const who = respondentValue();
    if (checks.some((c) => !c.ok) || !who.ok) {
      go('list');
      return;
    }
    const usages = new Map(checks.map((c) => [c.entry_id, c.value]));
    let result;
    try {
      result = await generateCodes({
        config,
        draft,
        usages,
        respondent: who.value,
        onCode: () => ctx.track.event('event/code_generated'),
      });
    } catch (err) {
      console.error('[Recensia] Chiffrement impossible.', err);
      if (disposed || stage !== 'codes') return;
      mount(stageRoot, h('section', { class: 'form-generating stack', 'aria-labelledby': 'form-stage-title' },
        h('h2', { id: 'form-stage-title', tabindex: '-1' }, t('form.generating.failed_title')),
        callout('danger', h('p', null, t('form.generating.failed_text'))),
        h('div', { class: 'form-actions' },
          button(t('common.actions.retry'), () => go('codes'), { variant: 'primary', icon: 'refresh' }),
          button(t('form.send.back'), () => go('list'), { icon: 'arrow-left' }))));
      focusStage();
      return;
    }
    if (disposed || stage !== 'codes') return;
    draft = result.draft;
    saveNow();
    const codes = result.codes.map((c) => ({ ...c, name: usages.get(c.entry_id)?.usage_name ?? '' }));
    renderSendStage(stageRoot, {
      config,
      fp,
      fpRaw,
      codes,
      plan,
      channelsData,
      templates,
      ctx,
      closed,
      onBack: () => go('list'),
      onClear: () => clearAll(),
    });
    focusStage();
  }

  // --- Démarrage ------------------------------------------------------------------------

  go('intro', {}, { focus: false });
  const onPageHide = () => flush();
  // Sur mobile, une application passée en arrière-plan peut être fermée sans « pagehide » :
  // la saisie en attente est enregistrée dès que la page est masquée.
  const onVisibility = () => {
    if (globalThis.document?.visibilityState === 'hidden') flush();
  };
  globalThis.addEventListener('pagehide', onPageHide);
  globalThis.document?.addEventListener('visibilitychange', onVisibility);

  return () => {
    flush();
    disposed = true;
    clearTimeout(saveTimer);
    globalThis.removeEventListener('pagehide', onPageHide);
    globalThis.document?.removeEventListener('visibilitychange', onVisibility);
    if (q) {
      q.destroy();
      q = null;
    }
  };
}

function identityError(t, key, code) {
  if (code === 'required') return key === 'last_name' ? t('form.identity.errors.last_name_required') : t('form.identity.errors.first_name_required');
  if (code === 'too_long') return key === 'email' ? t('form.identity.errors.email_too_long') : t('form.identity.errors.too_long', { max: NAME_MAX });
  if (code === 'invalid_email') return t('form.identity.errors.invalid_email');
  return t('form.identity.errors.invalid');
}
