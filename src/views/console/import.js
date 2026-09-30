// Onglet « Importer des codes » (#/admin/<id>/import ; CDC §7.2, §7.5, §7.7).
// Texte collé (e-mails entiers, liens #/i/…, codes) et fichiers (.rcn, .txt, .eml) lus localement,
// importés par src/services/import.js ; rapport lisible (compteurs + détails repliables), annoncé.
// Le rapport survit au rafraîchissement de l'onglet (et au lien d'import) par la session.

import { h, mount, loadCss, announce } from '../../ui/dom.js';
import { icon, button, callout, field, setFieldError } from '../../ui/components.js';
import { formatDate, formatNumber, has } from '../../i18n.js';
import {
  MAX_CODES_PER_IMPORT, collectCodes, codesForCampaign, importCodes, otherCampaignCodes, reportCounts, resolvedCodes,
  stashReport, takeReport, textFromFile,
} from '../../services/import.js';
import { addPendingCodes, listPendingCodes, removePendingCodes } from '../../services/recovery.js';
import { pickFiles } from '../admin.js';

const CSS = 'src/styles/admin.css';
const MAX_FILES = 50;
const MAX_FILE_MB = 5;
const FILE_ACCEPT = '.rcn,.txt,.eml,text/plain,message/rfc822';
const SUMMARY_ORDER = ['accepted', 'revised', 'duplicates', 'invalid', 'other_campaign', 'unsupported_version'];
const KPI_ALWAYS = ['accepted', 'revised', 'duplicates', 'invalid'];
const KPI_OPTIONAL = ['other_campaign', 'after_close', 'unsupported_version'];
const KPI_CLASS = { accepted: 'kpi-success', revised: 'kpi-success', invalid: 'kpi-danger', other_campaign: 'kpi-warn', after_close: 'kpi-warn', unsupported_version: 'kpi-warn' };

/** Phrase de synthèse d'un rapport (annonce et en-tête du rapport). */
export function reportSummary(t, report) {
  const counts = reportCounts(report);
  if (counts.total === 0) return t('import.report.nothing');
  const parts = SUMMARY_ORDER.filter((k) => counts[k] > 0).map((k) => t(`import.report.parts.${k}`, { count: counts[k] }));
  return t('import.report.done', { parts: parts.join(', ') });
}

function fieldLabel(t, questionnaire, key) {
  const label = questionnaire?.fields?.[key]?.label;
  if (typeof label === 'string' && label) return label;
  const k = `import.respondent_fields.${key}`;
  return has(k) ? t(k) : key;
}

function preview(text) {
  return h('code', { class: 'code-preview' }, text);
}

function itemTitle(t, name) {
  return h('span', { class: 'report-item-title' }, name ? `«\u00a0${name}\u00a0»` : t('import.report.unnamed'));
}

function details(t, kind, count, body, { open = false } = {}) {
  return h('details', { class: 'report-details', open },
    h('summary', null, t(`import.report.details.${kind}`, { count })),
    h('div', { class: 'report-details-body' }, body));
}

function renderReport(t, report, { campaign, questionnaire }) {
  const counts = reportCounts(report);
  const summary = reportSummary(t, report);
  const reason = (r) => (has(`import.reasons.${r}`) ? t(`import.reasons.${r}`) : t('import.reasons.schema'));
  const blocks = [];

  if (counts.accepted) {
    blocks.push(details(t, 'accepted', counts.accepted, h('ul', { class: 'report-list', role: 'list' }, report.accepted.map((a) => h('li', null,
      itemTitle(t, a.usage_name),
      h('span', { class: 'report-item-meta' },
        h('span', null, t('import.report.rev', { rev: a.rev })),
        a.after_close ? h('span', { class: 'badge badge-neutral' }, icon('alert'), t('import.report.after_close_badge')) : null,
        preview(a.preview)))))));
  }
  if (counts.revised) {
    blocks.push(details(t, 'revised', counts.revised, h('ul', { class: 'report-list', role: 'list' }, report.revised.map((a) => h('li', null,
      itemTitle(t, a.usage_name),
      h('span', { class: 'report-item-meta' },
        h('span', null, t('import.report.rev_change', { from: a.previous_rev, to: a.rev })),
        preview(a.preview)))))));
  }
  if (counts.duplicates) {
    blocks.push(details(t, 'duplicates', counts.duplicates, h('ul', { class: 'report-list', role: 'list' }, report.duplicates.map((d) => h('li', null,
      d.usage_name ? itemTitle(t, d.usage_name) : null,
      h('span', { class: 'report-item-meta' }, h('span', null, reason(d.reason)), preview(d.preview)))))));
  }
  if (counts.invalid) {
    blocks.push(details(t, 'invalid', counts.invalid, [
      h('ul', { class: 'report-list', role: 'list' }, report.invalid.map((x) => h('li', null,
        h('span', { class: 'report-item-meta' }, preview(x.preview)),
        h('span', null, reason(x.reason)),
        Array.isArray(x.fields) && x.fields.length
          ? h('span', { class: 'small muted' }, t('import.report.fields', { fields: x.fields.map((f) => fieldLabel(t, questionnaire, f)).join(', ') }))
          : null))),
      h('p', { class: 'small muted' }, t('import.report.invalid_text')),
    ], { open: true }));
  }
  if (counts.other_campaign) {
    const groups = new Map();
    for (const o of report.other_campaign) {
      if (!groups.has(o.campaign_id)) groups.set(o.campaign_id, { title: o.title, count: 0 });
      groups.get(o.campaign_id).count += 1;
    }
    blocks.push(details(t, 'other_campaign', counts.other_campaign, [
      h('ul', { class: 'report-list', role: 'list' }, [...groups].map(([id, g]) => h('li', null,
        h('span', { class: 'report-item-title' }, t('import.report.other_item', { count: g.count, title: g.title })),
        h('span', null, h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/${id}/import` }, t('import.report.other_open', { title: g.title }), icon('arrow-right')))))),
      h('p', { class: 'small muted' }, t('import.report.other_kept')),
    ], { open: true }));
  }
  if (counts.after_close) {
    const closes = campaign.settings?.closes_on;
    blocks.push(details(t, 'after_close', counts.after_close, [
      h('ul', { class: 'report-list', role: 'list' }, report.after_close.map((a) => h('li', null,
        itemTitle(t, a.usage_name),
        h('span', { class: 'report-item-meta' }, h('span', null, t('import.report.submitted', { date: formatDate(a.submitted_day) })), preview(a.preview))))),
      closes ? h('p', { class: 'small muted' }, t('import.report.after_close_text', { date: formatDate(closes) })) : null,
    ]));
  }
  if (counts.unsupported_version) {
    blocks.push(details(t, 'unsupported_version', counts.unsupported_version, [
      h('ul', { class: 'report-list', role: 'list' }, report.unsupported_version.map((u) => h('li', null, preview(u.preview)))),
      h('p', { class: 'small muted' }, t('import.report.unsupported_text')),
    ], { open: true }));
  }

  const kpis = [...KPI_ALWAYS, ...KPI_OPTIONAL.filter((k) => counts[k] > 0)];
  const titleId = 'import-report-title';
  const node = h('section', { class: 'card import-report', 'aria-labelledby': titleId },
    h('h3', { id: titleId, tabindex: '-1' }, t('import.report.title')),
    report.origin === 'link' ? h('p', { class: 'muted small' }, t('import.report.from_link')) : null,
    report.origin === 'session' ? h('p', { class: 'muted small' }, t('import.report.from_session')) : null,
    h('p', { class: 'report-summary' }, summary),
    counts.total > 0
      ? h('ul', { class: 'kpi-grid', role: 'list' }, kpis.map((k) => h('li', { class: ['kpi', counts[k] > 0 ? KPI_CLASS[k] : null] },
        h('span', { class: 'kpi-value' }, formatNumber(counts[k])),
        h('span', { class: 'kpi-label' }, t(`import.report.kpi.${k}`)))))
      : null,
    report.over_limit > 0
      ? callout('warn', h('p', null, t('import.report.over_limit', { count: formatNumber(report.over_limit), max: formatNumber(MAX_CODES_PER_IMPORT) })))
      : null,
    blocks,
    counts.accepted + counts.revised > 0
      ? h('div', { class: 'report-links' },
        h('a', { class: 'btn btn-primary btn-sm', href: `#/admin/${campaign.id}/registre` }, t('import.report.to_registry'), icon('arrow-right')),
        h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/${campaign.id}/tableau` }, t('import.report.to_dashboard')))
      : null);
  return { node, summary };
}

function helpCard(t, campaign, channelsData) {
  const channels = Array.isArray(campaign.settings?.channels) ? campaign.settings.channels : [];
  const types = [...new Set(channels.map((c) => c?.type).filter((type) => has(`import.help.channels.${type}`)))];
  const label = (type) => channelsData?.types?.[type]?.label ?? type;
  return h('section', { class: 'card import-help', 'aria-labelledby': 'import-help-title' },
    h('h3', { id: 'import-help-title', class: 'card-title' }, t('import.help.title')),
    h('p', null, t('import.help.intro')),
    h('ul', null, types.length
      ? types.map((type) => h('li', null, h('strong', null, label(type)), '\u00a0: ', t(`import.help.channels.${type}`)))
      : h('li', null, t('import.help.no_channels'))),
    h('p', null, t('import.help.link')),
    h('p', null, t('import.help.revision')),
    h('p', { class: 'muted small' }, campaign.mode === 'open' ? t('import.help.open') : t('import.help.anonymous')),
    h('p', { class: 'muted small' }, t('import.help.retention')));
}

export async function render(root, { campaign, model, ctx, refresh }) {
  await loadCss(CSS);
  const { t, store } = ctx;
  const hasKey = Boolean(campaign.private_key_jwk);
  let disposed = false;

  const stashed = takeReport(campaign.id);
  const reportZone = h('div', { class: 'import-report-zone' });
  let summary = null;
  if (stashed) {
    const rendered = renderReport(t, stashed, { campaign, questionnaire: model.questionnaire });
    mount(reportZone, rendered.node);
    summary = rendered.summary;
  }

  const header = [
    h('h2', { id: 'console-tab-title' }, t('import.title')),
    h('p', { class: 'lead muted' }, t('import.lead')),
  ];

  if (!hasKey) {
    mount(root, h('div', { class: 'stack import-tab' },
      header,
      reportZone,
      campaign.demo
        ? callout('info', h('p', null, t('import.demo')))
        : callout('danger',
          h('p', null, h('strong', null, t('import.no_key.title')), ' — ', t('import.no_key.text')),
          h('p', null, h('a', { class: 'btn btn-secondary btn-sm', href: '#/admin' }, icon('key'), h('span', null, t('import.no_key.action'))))),
      helpCard(t, campaign, model.channels)));
    if (summary) announce(summary);
    return () => { disposed = true; };
  }

  // --- Formulaire -----------------------------------------------------------------
  const files = []; // { id, name, content, count, problem }
  let fileSeq = 0;
  const filesHost = h('div', { class: 'visually-hidden' });
  const formFeedback = h('div', { class: 'import-form-feedback' });
  const textarea = h('textarea', {
    rows: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: 'RCN1.…',
  });
  const pasteField = field({ id: 'import-paste', label: t('import.form.paste_label'), help: t('import.form.paste_help'), control: textarea });
  const fileList = h('ul', { class: 'file-list', role: 'list' });
  const detected = h('p', { class: 'import-detected', 'aria-live': 'polite' });
  const working = h('p', { class: 'import-working', role: 'status' });
  const submitBtn = button(t('import.form.submit'), () => onSubmit(), { variant: 'primary', icon: 'upload' });
  const clearBtn = button(t('import.form.clear'), () => {
    textarea.value = '';
    files.length = 0;
    drawFiles();
    updateDetected();
    setFieldError(pasteField, null);
    textarea.focus();
  }, { variant: 'ghost' });

  const combinedText = () => [textarea.value, ...files.filter((f) => !f.problem).map((f) => f.content)].join('\n');

  function updateDetected() {
    let count = 0;
    try {
      count = collectCodes({ text: combinedText() }).codes.length;
    } catch {
      count = 0;
    }
    detected.textContent = t('import.form.detected', { count });
    if (count > 0) setFieldError(pasteField, null);
  }

  let debounce = null;
  textarea.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(updateDetected, 200);
  });

  function drawFiles() {
    mount(fileList, files.map((f) => h('li', null,
      h('span', { class: ['file-name', f.problem ? 'file-warn' : null] },
        icon(f.problem ? 'alert' : 'file'),
        h('span', null, f.problem ?? `${f.name} — ${t('import.form.file_codes', { count: f.count })}`)),
      h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm btn-icon',
        'aria-label': t('import.form.remove_file', { name: f.name }),
        title: t('import.form.remove_file', { name: f.name }),
        onClick: () => {
          const i = files.indexOf(f);
          if (i >= 0) files.splice(i, 1);
          drawFiles();
          updateDetected();
          dropzone.querySelector('button')?.focus();
        },
      }, icon('close')))));
  }

  async function addFiles(list) {
    const room = Math.max(0, MAX_FILES - files.length);
    const accepted = Array.from(list ?? []).slice(0, room);
    if ((list?.length ?? 0) > room) announce(t('import.form.too_many_files', { max: MAX_FILES }));
    for (const file of accepted) {
      const entry = { id: (fileSeq += 1), name: String(file.name ?? ''), content: '', count: 0, problem: null };
      if (Number(file.size) > MAX_FILE_MB * 1024 * 1024) {
        entry.problem = t('import.form.file_too_large', { name: entry.name, max: MAX_FILE_MB });
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          entry.content = textFromFile(entry.name, await file.text());
          entry.count = collectCodes({ text: entry.content }).codes.length;
        } catch {
          entry.problem = t('import.form.file_unreadable', { name: entry.name });
        }
      }
      files.push(entry);
    }
    if (disposed) return;
    drawFiles();
    updateDetected();
  }

  const dropzone = h('div', { class: 'dropzone import-dropzone' },
    icon('upload'),
    h('p', null, t('import.form.drop')),
    h('p', { class: 'muted small' }, t('import.form.or')),
    button(t('import.form.choose'), async () => {
      const chosen = await pickFiles(filesHost, { accept: FILE_ACCEPT, multiple: true });
      if (chosen.length) await addFiles(chosen);
    }, { icon: 'file', attrs: { 'aria-describedby': 'import-files-help' } }),
    h('p', { class: 'field-help', id: 'import-files-help' }, t('import.form.files_help')));

  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('is-over');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-over');
    const dropped = event.dataTransfer?.files;
    if (dropped?.length) {
      addFiles(dropped);
    } else {
      const text = event.dataTransfer?.getData('text/plain');
      if (text) {
        textarea.value = [textarea.value, text].filter(Boolean).join('\n');
        updateDetected();
      }
    }
  });

  function setBusy(busy) {
    submitBtn.disabled = busy;
    clearBtn.disabled = busy;
    textarea.readOnly = busy;
    mount(working, busy ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, t('import.form.working'))] : null);
  }

  async function runImport({ text, codes, fromPending = false }) {
    mount(formFeedback);
    setBusy(true);
    try {
      const report = await importCodes({ text, codes, campaign, store, questionnaire: model.questionnaire });
      removePendingCodes(resolvedCodes(report));
      const others = otherCampaignCodes(report);
      if (others.length) addPendingCodes(others);
      stashReport({ ...report, origin: fromPending ? 'session' : null });
      if (disposed) return;
      // Sans conserver le défilement : le rapport, en haut de l'onglet, doit être visible (mobile).
      await refresh({ keepScroll: false });
    } catch (err) {
      console.error('[Recensia] Import des codes impossible.', err);
      if (disposed) return;
      setBusy(false);
      const key = typeof err?.code === 'string' && has(`import.errors.${err.code}`) ? `import.errors.${err.code}` : 'import.errors.generic';
      mount(formFeedback, callout('danger', h('p', null, t(key))));
      announce(t(key), { assertive: true });
    }
  }

  function onSubmit() {
    let found;
    try {
      found = collectCodes({ text: combinedText() });
    } catch (err) {
      mount(formFeedback, callout('danger', h('p', null, t('import.errors.too_large'))));
      announce(t('import.errors.too_large'), { assertive: true });
      return;
    }
    if (found.codes.length === 0) {
      setFieldError(pasteField, t('import.form.none'));
      announce(t('import.form.none'), { assertive: true });
      textarea.focus();
      return;
    }
    setFieldError(pasteField, null);
    runImport({ text: combinedText() });
  }

  // --- Codes en attente de la session (reçus par lien) -----------------------------------
  const pendingZone = h('div', { class: 'import-pending' });
  const pending = listPendingCodes();
  if (pending.length) {
    codesForCampaign(pending, campaign).then((mine) => {
      if (disposed || mine.length === 0) return;
      mount(pendingZone, callout('info',
        h('p', null, t('import.pending.text', { count: mine.length })),
        h('p', null, button(t('import.pending.action', { count: mine.length }), () => runImport({ codes: mine, fromPending: true }), {
          variant: 'primary', size: 'sm', icon: 'upload',
        }))));
    }).catch((err) => console.warn('[Recensia] Codes en attente illisibles.', err));
  }

  const filesField = field({
    id: 'import-files', label: t('import.form.files_label'), group: true, control: h('div', null, dropzone, fileList),
  });

  mount(root, h('div', { class: 'stack import-tab' },
    header,
    reportZone,
    pendingZone,
    h('div', { class: 'split' },
      h('section', { class: 'card import-form', 'aria-labelledby': 'import-form-title' },
        h('h3', { id: 'import-form-title', class: 'card-title' }, t('import.form.title')),
        pasteField,
        filesField,
        detected,
        formFeedback,
        h('div', { class: 'import-actions' }, submitBtn, clearBtn, working)),
      helpCard(t, campaign, model.channels)),
    filesHost));

  updateDetected();
  if (summary) {
    announce(summary);
    root.querySelector('#import-report-title')?.focus({ preventScroll: true });
    if (typeof reportZone.scrollIntoView === 'function') reportZone.scrollIntoView({ block: 'start' });
  }
  return () => {
    disposed = true;
    clearTimeout(debounce);
  };
}
