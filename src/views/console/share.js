// Onglet « Diffuser » de la console (#/admin/<id>/diffuser) — CDC §7.7, côté responsable :
// lien de collecte (copier, partager, ouvrir), empreinte, QR code, messages générés modifiables
// (avec garde-fou de la phrase verrouillée), fiche imprimable.
// Seuls les champs publics de la campagne sont utilisés (publicCampaign) : jamais la clé privée.

import { h, mount, loadCss, announce } from '../../ui/dom.js';
import { button, callout, icon, modal, confirmDialog, copyButton, toast } from '../../ui/components.js';
import { copyText, copyRich } from '../../ui/clipboard.js';
import { downloadBlob, downloadText } from '../../ui/download.js';
import { formatFingerprint } from '../../crypto/keys.js';
import { buildCollectUrl } from '../../crypto/link.js';
import { renderMessage, messageContextFromCampaign, listTemplates, hasLockedBlock } from '../../share/messages.js';
import { gmailComposeUrl, outlookComposeUrl } from '../../share/urls.js';
import { qrSvgElement, qrSvgString, qrPngBlob } from '../../share/qr.js';
import { buildPrintableSheet, printSheet, SHEET_CSS } from '../../share/sheet.js';
import { slugify } from '../../export/registry.js';
import { formatDate, formatNumber } from '../../i18n.js';
import { publicCampaign, textToRichHtml, restoreLockedBlock, planMessageMailto } from '../new/share-helpers.js';
import { LINK_TARGET_LENGTH } from '../new/build-campaign.js';

const CSS = 'src/styles/share.css';
const TEMPLATE_ORDER = ['invitation_email', 'invitation_short', 'reminder_j3', 'reminder_j1', 'closing_thanks'];
const FEEDBACK_MS = 2000;

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Retour visuel « Copié » sur un bouton (libellé et pictogramme), annoncé aux lecteurs d'écran. */
function flash(btn, doneLabel, announceText) {
  const label = btn.querySelector('.btn-label');
  if (!label) return;
  const base = btn.dataset.label ?? label.textContent;
  btn.dataset.label = base;
  clearTimeout(Number(btn.dataset.timer));
  btn.classList.add('is-copied');
  label.textContent = doneLabel;
  announce(announceText ?? doneLabel);
  btn.dataset.timer = String(setTimeout(() => {
    btn.classList.remove('is-copied');
    label.textContent = base;
  }, FEEDBACK_MS));
}

function openInNewTab(url) {
  // Navigation déclenchée par l'utilisateur ; aucune requête émise par l'application.
  globalThis.open?.(url, '_blank', 'noopener,noreferrer');
}

function openMailto(url) {
  const link = h('a', { href: url, class: 'visually-hidden', tabindex: '-1' });
  globalThis.document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export async function render(root, { campaign, model, ctx }) {
  const { t } = ctx;
  loadCss(CSS);
  loadCss(SHEET_CSS);

  const pub = publicCampaign(campaign);
  const channelsData = model.channels;
  const heading = h('header', { class: 'share-header' },
    h('h2', { id: 'console-tab-title' }, t('share.title')),
    h('p', { class: 'lead' }, t('share.lead')));

  let link;
  try {
    link = buildCollectUrl(ctx.baseUrl, pub);
  } catch (err) {
    console.error('[Recensia] Lien de collecte impossible à construire.', err);
    mount(root, heading, callout('danger', h('p', null, t('share.link.error'))));
    return undefined;
  }

  let templates = null;
  try {
    templates = await ctx.data.get('messages.fr');
  } catch (err) {
    console.error('[Recensia] Gabarits de messages indisponibles.', err);
  }

  const cleanups = [];
  const title = pub.title ?? '';
  const slug = slugify(title || pub.org_name || pub.id);
  const fp = formatFingerprint(pub.fingerprint);
  const trackShare = () => ctx.track.event('event/share_link');

  mount(root, h('div', { class: 'share stack-lg' },
    heading,
    h('div', { class: 'share-top' }, linkCard(), qrCard()),
    templates ? messagesCard() : callout('danger', h('p', null, t('common.errors.data_unavailable'))),
    templates ? sheetCard() : null));

  return () => {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch (err) { console.error(err); }
    }
  };

  // --- Lien de collecte ---------------------------------------------------------------------------

  function linkCard() {
    const long = link.length > LINK_TARGET_LENGTH;
    const actions = [
      copyButton(() => {
        trackShare();
        return link;
      }, { label: t('share.link.copy'), variant: 'primary' }),
    ];
    if (typeof globalThis.navigator?.share === 'function') {
      actions.push(button(t('share.link.share'), async () => {
        try {
          await globalThis.navigator.share({ title, text: t('share.link.share_text', { title }), url: link });
          trackShare();
          announce(t('share.link.shared'));
        } catch (err) {
          if (err?.name !== 'AbortError') toast(t('share.link.share_failed'), 'warn');
        }
      }, { icon: 'share' }));
    }
    actions.push(h('a', {
      class: 'btn btn-secondary', href: link, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': t('share.link.open_label'),
    }, icon('external'), h('span', { class: 'btn-label' }, t('share.link.open'))));

    const closes = pub.settings?.closes_on;
    const closed = typeof closes === 'string' && closes < (model.today ?? localToday());
    return h('section', { class: 'card share-card share-link-card', 'aria-labelledby': 'share-link-title' },
      h('h3', { id: 'share-link-title', class: 'share-card-title' }, icon('share'), h('span', null, t('share.link.title'))),
      h('p', { class: 'muted' }, t('share.link.help')),
      h('p', { class: 'visually-hidden', id: 'share-link-label' }, t('share.link.label')),
      h('div', { class: 'code-block code-block-scroll share-link-code', role: 'textbox', 'aria-readonly': 'true', 'aria-labelledby': 'share-link-label', tabindex: '0' }, link),
      h('p', { class: 'share-link-meta muted' }, t('share.link.length', { length: formatNumber(link.length) })),
      long ? callout('warn', h('p', null, t('share.link.long', { length: formatNumber(link.length) }))) : null,
      h('div', { class: 'cluster share-actions' }, actions),
      h('div', { class: 'share-fp' },
        h('p', { class: 'share-fp-line' },
          icon('shield'),
          h('span', null, t('share.fingerprint.label')), ' ',
          h('strong', { class: 'fingerprint' }, fp || t('share.fingerprint.missing'))),
        h('p', { class: 'field-help' }, t('share.fingerprint.help'))),
      closed ? callout('info', h('p', null, t('share.closed', { date: formatDate(closes) }))) : null,
      pub.settings.channels.length === 0 ? callout('warn', h('p', null, t('share.no_channel'))) : null);
  }

  // --- QR code ------------------------------------------------------------------------------------

  function qrCard() {
    const label = t('share.qr.label', { title });
    let preview;
    try {
      preview = qrSvgElement(link, { title: label, className: 'share-qr-svg' });
    } catch (err) {
      console.error('[Recensia] QR code impossible.', err);
      return h('section', { class: 'card share-card', 'aria-labelledby': 'share-qr-title' },
        h('h3', { id: 'share-qr-title', class: 'share-card-title' }, icon('qr'), h('span', null, t('share.qr.title'))),
        callout('danger', h('p', null, t('share.qr.error'))));
    }
    const png = button(t('share.qr.png'), async () => {
      try {
        downloadBlob(await qrPngBlob(link, { size: 1024 }), `recensia-qr-${slug}.png`);
      } catch (err) {
        console.error('[Recensia] PNG du QR code impossible.', err);
        toast(t('share.qr.error'), 'danger');
      }
    }, { icon: 'download', size: 'sm', attrs: { 'aria-label': t('share.qr.png_label') } });
    const svgButton = button(t('share.qr.svg'), () => {
      downloadText(qrSvgString(link, { title: label }), `recensia-qr-${slug}.svg`, 'image/svg+xml');
    }, { icon: 'download', size: 'sm', attrs: { 'aria-label': t('share.qr.svg_label') } });
    return h('section', { class: 'card share-card share-qr-card', 'aria-labelledby': 'share-qr-title' },
      h('h3', { id: 'share-qr-title', class: 'share-card-title' }, icon('qr'), h('span', null, t('share.qr.title'))),
      h('p', { class: 'muted' }, t('share.qr.help')),
      h('figure', { class: 'share-qr' }, preview),
      h('div', { class: 'cluster share-qr-actions' }, h('span', { class: 'muted' }, t('share.qr.download')), png, svgButton));
  }

  // --- Messages générés ---------------------------------------------------------------------------

  function messagesCard() {
    const available = listTemplates(templates, { audience: 'respondents' });
    const ordered = [
      ...TEMPLATE_ORDER.map((id) => available.find((x) => x.id === id)).filter(Boolean),
      ...available.filter((x) => !TEMPLATE_ORDER.includes(x.id)),
    ];
    const context = messageContextFromCampaign(pub, { link, duration_min: model.questionnaire?.estimated_minutes });
    const drafts = new Map();
    let current = null;

    const select = h('select', { id: 'share-template', onChange: (event) => selectTemplate(event.target.value) },
      ordered.map((tpl) => h('option', { value: tpl.id }, tpl.label)));
    const subject = h('input', { type: 'text', id: 'share-subject', autocomplete: 'off', onInput: onEdit });
    const body = h('textarea', { id: 'share-body', class: 'share-body', rows: '16', spellcheck: 'true', onInput: onEdit });
    const subjectField = h('div', { class: 'field share-subject-field' },
      h('div', { class: 'share-field-head' },
        h('label', { class: 'field-label', for: 'share-subject' }, t('share.messages.subject')),
        copyButton(() => subject.value, { label: t('share.messages.copy_subject'), size: 'sm', variant: 'ghost' })),
      subject);
    const bodyField = h('div', { class: 'field share-body-field' },
      h('div', { class: 'share-field-head' },
        h('label', { class: 'field-label', for: 'share-body' }, t('share.messages.body')),
        h('span', { class: 'badge badge-neutral share-edited', hidden: true }, icon('edit'), t('share.messages.edited'))),
      body);
    const errorBox = h('div', { class: 'share-message-error', hidden: true }, callout('danger', h('p', null, t('share.messages.error'))));

    const lockedText = h('blockquote', { class: 'share-locked-text' });
    const lockedStatus = h('p', { class: 'share-locked-status', id: 'share-locked-status' });
    const restoreButton = button(t('share.messages.locked.restore'), () => {
      restorePhrase();
      body.focus();
    }, { size: 'sm', icon: 'refresh' });
    const lockedMissing = h('div', { class: 'share-locked-missing', hidden: true }, restoreButton);
    body.setAttribute('aria-describedby', 'share-locked-status');

    const copyPlain = button(t('share.messages.copy'), () => sendAction('copy', copyPlain), { variant: 'primary', icon: 'copy' });
    const copyRichButton = button(t('share.messages.copy_rich'), () => sendAction('rich', copyRichButton), { icon: 'copy', attrs: { 'aria-describedby': 'share-rich-help' } });
    const mailtoButton = button(t('share.messages.mailto'), () => sendAction('mailto', mailtoButton), { icon: 'mail', attrs: { 'aria-describedby': 'share-mailto-hint' } });
    const mailtoLabel = mailtoButton.querySelector('.btn-label');
    const mailtoHint = h('p', { class: 'field-help share-mailto-hint', id: 'share-mailto-hint', hidden: true });
    const gmailButton = button(t('share.messages.webmail.gmail'), () => sendAction('gmail', gmailButton), { size: 'sm', icon: 'external' });
    const outlookButton = button(t('share.messages.webmail.outlook'), () => sendAction('outlook', outlookButton), { size: 'sm', icon: 'external' });
    const resetButton = button(t('share.messages.reset'), onReset, { variant: 'ghost', size: 'sm', icon: 'refresh' });

    function generate(id) {
      return renderMessage(id, context, templates, channelsData);
    }

    function saveDraft() {
      if (current) drafts.set(current.id, { subject: subject.value, body: body.value });
    }

    function selectTemplate(id) {
      saveDraft();
      const info = ordered.find((x) => x.id === id) ?? ordered[0];
      let original;
      try {
        original = generate(info.id);
      } catch (err) {
        console.error('[Recensia] Message impossible à générer.', err);
        current = null;
        errorBox.hidden = false;
        subject.value = '';
        body.value = '';
        updateStatus();
        return;
      }
      errorBox.hidden = true;
      current = { id: info.id, info, original };
      const draft = drafts.get(info.id);
      subject.value = draft?.subject ?? original.subject;
      body.value = draft?.body ?? original.body;
      subjectField.hidden = !info.has_subject;
      lockedText.textContent = original.locked_block;
      updateStatus();
    }

    function isEdited() {
      if (!current) return false;
      return body.value !== current.original.body || (current.info.has_subject && subject.value !== current.original.subject);
    }

    function currentSubject() {
      return current?.info.has_subject ? subject.value : '';
    }

    // Message complet, sinon version courte générée (invitation e-mail), sinon « Copier ».
    function mailtoFor(text) {
      return planMessageMailto({ templateId: current.id, subject: currentSubject(), body: text, context, templates, channelsData });
    }

    let lastMailtoKind = 'full';
    function updateMailto() {
      const plan = current ? mailtoFor(body.value) : null;
      const kind = plan?.kind ?? 'full';
      const vars = plan ? { length: formatNumber(plan.full.length), max: formatNumber(plan.max) } : {};
      mailtoLabel.textContent = kind === 'short' ? t('share.messages.mailto_short') : t('share.messages.mailto');
      mailtoHint.hidden = kind === 'full';
      mailtoHint.classList.toggle('is-info', kind === 'short');
      if (kind !== lastMailtoKind) mailtoHint.classList.remove('is-emphasis');
      lastMailtoKind = kind;
      mailtoHint.textContent = kind === 'short' ? t('share.messages.mailto_short_help', vars)
        : kind === 'too_long' ? t('share.messages.mailto_too_long', vars) : '';
      if (kind === 'too_long') mailtoButton.setAttribute('aria-disabled', 'true');
      else mailtoButton.removeAttribute('aria-disabled');
    }

    function updateStatus() {
      const ok = !current || hasLockedBlock(body.value, current.original.locked_block);
      lockedStatus.replaceChildren(icon(ok ? 'check' : 'alert'), h('span', null, ok ? t('share.messages.locked.present') : t('share.messages.locked.missing')));
      lockedStatus.classList.toggle('is-missing', !ok);
      lockedMissing.hidden = ok;
      const edited = isEdited();
      bodyField.querySelector('.share-edited').hidden = !edited;
      resetButton.disabled = !edited;
      updateMailto();
      for (const btn of [copyPlain, copyRichButton, mailtoButton, gmailButton, outlookButton]) btn.disabled = !current;
    }

    function onEdit() {
      updateStatus();
    }

    function restorePhrase() {
      if (!current) return;
      const before = body.value;
      body.value = restoreLockedBlock(before, current.original.body, current.original.locked_block);
      const start = body.value.indexOf(current.original.locked_block);
      if (start >= 0) body.setSelectionRange?.(start, start + current.original.locked_block.length);
      updateStatus();
      announce(t('share.messages.locked.restored'));
    }

    // Garde-fou : la phrase « mode, anonymat, canal » ne disparaît pas sans avertissement.
    // → texte à utiliser, ou null si l'utilisateur renonce.
    async function guardedBody() {
      if (!current) return null;
      if (hasLockedBlock(body.value, current.original.locked_block)) return body.value;
      const choice = await modal({
        title: t('share.messages.locked.dialog.title'),
        content: [
          h('p', null, t('share.messages.locked.dialog.message')),
          h('blockquote', { class: 'share-locked-text' }, current.original.locked_block),
          h('p', null, t('share.messages.locked.dialog.risk')),
        ],
        actions: [
          { label: t('share.messages.locked.dialog.continue'), value: 'continue' },
          { label: t('share.messages.locked.dialog.restore'), value: 'restore', variant: 'primary', autofocus: true },
        ],
      });
      if (choice === 'restore') {
        restorePhrase();
        return body.value;
      }
      return choice === 'continue' ? body.value : null;
    }

    // « Ouvrir dans ma messagerie » : message affiché s'il tient dans la limite (après le garde-fou
    // de la phrase verrouillée), sinon version courte générée (qui contient toujours la phrase),
    // sinon renvoi vers « Copier le message ».
    async function sendMailto() {
      let plan = mailtoFor(body.value);
      if (plan.kind === 'full') {
        const text = await guardedBody();
        if (text === null) return;
        plan = mailtoFor(text); // la phrase rétablie peut faire dépasser la limite
      }
      updateStatus();
      if (plan.kind === 'too_long') {
        mailtoHint.classList.add('is-emphasis');
        announce(mailtoHint.textContent);
        copyPlain.focus();
        return;
      }
      trackShare();
      openMailto(plan.url);
      if (plan.kind === 'short') announce(t('share.messages.mailto_short_opened'));
    }

    async function sendAction(kind, btn) {
      if (!current) return;
      if (kind === 'mailto') {
        await sendMailto();
        return;
      }
      const text = await guardedBody();
      if (text === null) return;
      const subj = currentSubject();
      if (kind === 'copy' || kind === 'rich') {
        // Sans l'API Presse-papiers riche, copyRich se replie sur le texte brut : on le dit.
        const richApi = typeof globalThis.navigator?.clipboard?.write === 'function' && typeof globalThis.ClipboardItem === 'function';
        const ok = kind === 'rich' ? await copyRich(textToRichHtml(text), text) : await copyText(text);
        if (!ok) {
          toast(t('common.copy.failed'), 'warn');
          return;
        }
        trackShare();
        if (kind === 'rich' && !richApi) {
          // La notification (région aria-live) porte le message : pas de seconde annonce.
          flash(btn, t('share.messages.copied'), '');
          toast(t('share.messages.copied_plain_fallback'), 'info');
          return;
        }
        flash(btn, t('share.messages.copied'), kind === 'rich' ? t('share.messages.copied_rich') : t('common.copy.announce'));
        return;
      }
      const url = kind === 'gmail' ? gmailComposeUrl({ subject: subj, body: text }) : outlookComposeUrl({ subject: subj, body: text });
      trackShare();
      openInNewTab(url);
    }

    async function onReset() {
      if (!current || !isEdited()) return;
      const ok = await confirmDialog({
        title: t('share.messages.reset_confirm.title'),
        message: t('share.messages.reset_confirm.message'),
        confirmLabel: t('share.messages.reset_confirm.confirm'),
      });
      if (!ok) return;
      drafts.delete(current.id);
      subject.value = current.original.subject;
      body.value = current.original.body;
      updateStatus();
      announce(t('share.messages.reset_done'));
      body.focus();
    }

    const reminder = pub.mode === 'anonymous' ? t('share.messages.reminder_anonymous') : t('share.messages.reminder_open');
    const card = h('section', { class: 'card share-card share-messages', 'aria-labelledby': 'share-messages-title' },
      h('h3', { id: 'share-messages-title', class: 'share-card-title' }, icon('mail'), h('span', null, t('share.messages.title'))),
      h('p', { class: 'muted' }, t('share.messages.help')),
      h('div', { class: 'share-editor' },
        h('div', { class: 'share-editor-main' },
          h('div', { class: 'field share-template-field' },
            h('label', { class: 'field-label', for: 'share-template' }, t('share.messages.template')),
            select),
          errorBox,
          subjectField,
          bodyField,
          h('div', { class: 'cluster share-message-actions' }, copyPlain, copyRichButton, mailtoButton),
          mailtoHint,
          h('p', { class: 'field-help', id: 'share-rich-help' }, t('share.messages.copy_rich_help')),
          h('details', { class: 'share-webmail' },
            h('summary', null, t('share.messages.webmail.summary')),
            h('p', { class: 'field-help' }, t('share.messages.webmail.help')),
            h('div', { class: 'cluster' }, gmailButton, outlookButton)),
          h('div', { class: 'share-reset' }, resetButton)),
        h('aside', { class: 'share-editor-side', 'aria-labelledby': 'share-locked-title' },
          h('div', { class: 'share-locked' },
            h('h4', { id: 'share-locked-title', class: 'share-locked-title' }, icon('lock'), h('span', null, t('share.messages.locked.title'))),
            lockedText,
            h('p', { class: 'field-help' }, t('share.messages.locked.help')),
            lockedStatus,
            lockedMissing),
          callout(pub.mode === 'anonymous' ? 'warn' : 'info', h('p', null, reminder)))));

    select.value = ordered[0]?.id ?? '';
    selectTemplate(select.value);
    return card;
  }

  // --- Fiche imprimable ---------------------------------------------------------------------------

  function sheetCard() {
    let layout = 'page';
    let sheet = null;
    const preview = h('div', { class: 'share-sheet-preview', tabindex: '0', role: 'region', 'aria-label': t('share.sheet.preview') });
    const zoomNote = h('p', { class: 'field-help', hidden: true }, t('share.sheet.preview_zoomed'));
    const errorBox = h('div', { hidden: true }, callout('danger', h('p', null, t('share.sheet.error'))));

    const zoom = button(t('share.sheet.zoom'), () => {
      const on = !preview.classList.contains('is-zoomed');
      preview.classList.toggle('is-zoomed', on);
      zoom.setAttribute('aria-pressed', String(on));
      zoomNote.hidden = !on;
      if (on) preview.scrollLeft = 0;
    }, { size: 'sm', icon: 'plus', attrs: { 'aria-pressed': 'false' } });

    const printButton = button(t('share.sheet.print'), () => {
      if (!sheet) return;
      cleanups.push(printSheet(sheet));
      ctx.track.event('event/export_print');
    }, { variant: 'primary', icon: 'print' });

    const canFullscreen = Boolean(globalThis.document?.fullscreenEnabled);
    const fullscreen = canFullscreen
      ? button(t('share.sheet.fullscreen'), async () => {
        try {
          await preview.querySelector('.rc-sheet')?.requestFullscreen?.();
        } catch (err) {
          console.info('[Recensia] Plein écran refusé.', err);
        }
      }, { size: 'sm', icon: 'external' })
      : null;

    function draw() {
      try {
        sheet = buildPrintableSheet({ campaign: pub, link, fingerprint: pub.fingerprint, templates, channelsData, layout });
        mount(preview, sheet);
        errorBox.hidden = true;
        printButton.disabled = false;
      } catch (err) {
        console.error('[Recensia] Fiche imprimable impossible.', err);
        sheet = null;
        mount(preview);
        errorBox.hidden = false;
        printButton.disabled = true;
      }
      preview.dataset.layout = layout;
      if (fullscreen) fullscreen.hidden = layout !== 'slide';
    }

    const layoutGroup = h('fieldset', { class: 'share-layout' },
      h('legend', { class: 'field-label' }, t('share.sheet.layout')),
      h('div', { class: 'cluster' }, ['page', 'slide'].map((value) => h('label', { class: 'choice share-layout-choice', for: `share-layout-${value}` },
        h('input', {
          type: 'radio', name: 'share-layout', id: `share-layout-${value}`, value, checked: value === layout,
          onChange: () => { layout = value; draw(); },
        }),
        h('span', { class: 'choice-label' }, t(`share.sheet.${value}`))))));

    draw();
    return h('section', { class: 'card share-card share-sheet', 'aria-labelledby': 'share-sheet-title' },
      h('h3', { id: 'share-sheet-title', class: 'share-card-title' }, icon('print'), h('span', null, t('share.sheet.title'))),
      h('p', { class: 'muted' }, t('share.sheet.help')),
      h('div', { class: 'share-sheet-toolbar' },
        layoutGroup,
        h('div', { class: 'cluster share-sheet-actions' }, printButton, zoom, fullscreen)),
      errorBox,
      zoomNote,
      preview);
  }
}
