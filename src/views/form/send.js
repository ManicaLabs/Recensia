// Étape « Envoyer mes codes » du formulaire répondant (CDC §7.7, côté répondant) : destinataire,
// empreinte et avertissement d'anonymat visibles avant tout envoi ; un bouton par canal activé ;
// codes bruts en secours ; QR du lien d'import pour passer d'un appareil à l'autre.
// Toutes les URL sont ouvertes par une navigation déclenchée par l'utilisateur : aucune requête.

import { h, mount, announce } from '../../ui/dom.js';
import { button, callout, icon, toast } from '../../ui/components.js';
import { copyText } from '../../ui/clipboard.js';
import { downloadText } from '../../ui/download.js';
import { importLink, teamsShareUrl, whatsappUrl } from '../../share/urls.js';
import { renderMessage } from '../../share/messages.js';
import { qrSvgElement } from '../../share/qr.js';
import { groupCodes, mailPlan, rcnContent, rcnFilename, sharedWarning } from './send-plan.js';
import { frenchSpacing } from '../../ui/questionnaire.js';

function safeImportLink(baseUrl, codes) {
  try {
    return importLink(baseUrl, codes);
  } catch (err) {
    console.warn('[Recensia] Lien d\'import impossible à construire.', err);
    return null;
  }
}

/**
 * Bouton « Copier » dont le rappel onCopied n'est appelé qu'après une copie réussie
 * (copyButton de components.js ne signale pas l'échec à l'appelant : le remerciement
 * et l'événement d'envoi ne doivent pas suivre une copie ratée).
 */
function copyAction(t, getText, { label, variant = 'secondary', onCopied } = {}) {
  let timer = null;
  let busy = false;
  const btn = button(label, async () => {
    if (busy) return;
    busy = true;
    let ok = false;
    try {
      ok = await copyText(String(getText() ?? ''));
    } catch (err) {
      console.warn('[Recensia] Copie impossible.', err);
      ok = false;
    } finally {
      busy = false;
    }
    if (!ok) {
      toast(t('common.copy.failed'), 'warn');
      return;
    }
    btn.classList.add('is-copied');
    labelNode.textContent = t('common.copy.done');
    announce(t('common.copy.announce'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('is-copied');
      labelNode.textContent = label;
    }, 2000);
    if (typeof onCopied === 'function') onCopied();
  }, { variant, icon: 'copy' });
  const labelNode = btn.querySelector('.btn-label');
  return btn;
}

/**
 * Affiche l'étape d'envoi.
 * @param {HTMLElement} container
 * @param {{ config: object, fp: string, fpRaw: string, codes: { entry_id, rev, code, name }[],
 *   plan: object[], channelsData: object, templates: object, ctx: object, closed: boolean,
 *   onBack: () => void, onClear: () => void }} options
 */
export function renderSendStage(container, options) {
  const { config, fp, fpRaw, codes, plan, channelsData, templates, ctx, closed, onBack, onClear } = options;
  const { t } = ctx;
  const allCodes = codes.map((c) => c.code);
  const count = allCodes.length;
  const recipient = config.org ? t('form.send.recipient_org', { org: config.org, title: config.title }) : t('form.send.recipient_title', { title: config.title });
  const messageCtx = {
    title: config.title,
    org: config.org,
    mode: config.mode,
    channels: config.channels ?? [],
    fingerprint: fpRaw,
    closes_on: config.closes ?? null,
  };
  const common = frenchSpacing(sharedWarning(plan));
  // Libellés issus de data/channels.json : typographie française à l'affichage.
  const channels = plan.map((item) => ({ ...item, label: frenchSpacing(item.label), button_label: frenchSpacing(item.button_label) }));
  const status = h('p', { class: 'visually-hidden', role: 'status' });

  const track = () => ctx.track.event('event/share_code');
  const thank = (message) => {
    status.textContent = message;
    thanks.hidden = false;
  };

  const shareBody = (group) => {
    const link = safeImportLink(ctx.baseUrl, group);
    if (!link) return group.join('\n');
    return renderMessage('code_share', { ...messageCtx, codes: group, import_link: link }, templates, channelsData).body;
  };

  const download = (group, { note } = {}) => {
    downloadText(rcnContent(group), rcnFilename(config.title), 'text/plain;charset=utf-8');
    track();
    toast(note ?? t('form.send.file_done', { name: rcnFilename(config.title) }), 'success');
    thank(t('form.send.file_done', { name: rcnFilename(config.title) }));
  };

  // --- Actions par canal ---------------------------------------------------------------

  const copied = () => {
    track();
    thank(t('form.send.copied'));
  };

  function mailActions(item) {
    let plan;
    try {
      plan = mailPlan({
        to: item.target,
        codes: allCodes,
        baseUrl: ctx.baseUrl,
        templates,
        ctx: messageCtx,
        channelsData,
        fallback: { subject: t('form.send.mail_fallback_subject', { title: config.title }), body: t('form.send.mail_fallback_body', { title: config.title }) },
      });
    } catch (err) {
      console.warn('[Recensia] Message prérempli impossible.', err);
      return [callout('warn', h('p', null, t('form.send.mail_unavailable'))),
        button(t('form.send.file_button'), () => download(allCodes), { variant: 'primary', icon: 'download' })];
    }
    const total = plan.items.length;
    const namesOf = (list) => list.map((code) => codes.find((c) => c.code === code)?.name).filter(Boolean).join(', ');
    const nodes = plan.items.map((message, index) => {
      const names = namesOf(message.codes);
      if (message.kind === 'fallback') {
        // Code trop long pour un e-mail prérempli (CDC §17) : fichier ou code copié, puis un
        // e-mail court déjà adressé, pour rester en deux clics (CDC §7.7).
        return h('div', { class: 'form-send-fallback stack-sm' },
          h('p', null, t('form.send.mail_too_long', { name: names })),
          h('div', { class: 'form-send-actions' },
            button(t('form.send.file_button_one'), () => download(message.codes, { note: t('form.send.file_attach', { target: item.target }) }), { variant: index === 0 ? 'primary' : 'secondary', icon: 'download' }),
            h('a', {
              class: ['btn', 'btn-secondary'],
              href: message.url,
              onClick: () => {
                track();
                thank(t('form.send.mail_opened'));
              },
            }, icon('mail'), h('span', { class: 'btn-label' }, t('form.send.mail_fallback_open'))),
            copyAction(t, () => message.codes.join('\n'), { label: t('form.codes.copy'), onCopied: copied })));
      }
      const label = total === 1 ? item.button_label : t('form.send.mail_part', { n: index + 1, total });
      return h('a', {
        class: ['btn', index === 0 ? 'btn-primary' : 'btn-secondary', 'form-send-link'],
        href: message.url,
        onClick: () => {
          track();
          thank(t('form.send.mail_opened'));
        },
      }, icon('mail'), h('span', { class: 'btn-label' }, label, total > 1 && names ? h('span', { class: 'form-send-detail' }, names) : null));
    });
    return [
      h('div', { class: ['form-send-actions', total > 1 ? 'is-list' : null] }, nodes),
      total > 1 ? h('p', { class: 'muted small' }, t('form.send.mail_split', { count: total })) : null,
      h('p', { class: 'muted small' }, plan.help === 'mail_help' ? t('form.send.mail_help') : t('form.send.mail_fallback_help')),
    ];
  }

  function copyActions(item) {
    const main = copyAction(t, () => allCodes.join('\n'), {
      label: count === 1 ? t('form.send.copy_one') : t('form.send.copy_all', { count }),
      variant: 'primary',
      onCopied: copied,
    });
    const withMessage = copyAction(t, () => shareBody(allCodes), { label: t('form.send.copy_message'), onCopied: copied });
    return [h('div', { class: 'form-send-actions' }, main, withMessage),
      h('p', { class: 'muted small' }, item.target ? t('form.send.copy_help') : t('form.send.copy_help_no_target'))];
  }

  function fileActions(item) {
    const name = rcnFilename(config.title);
    return [h('div', { class: 'form-send-actions' },
      button(t('form.send.file_button'), () => download(allCodes), { variant: 'primary', icon: 'download' })),
    h('p', { class: 'muted small' }, item.target ? t('form.send.file_help', { name }) : t('form.send.file_help_no_target', { name }))];
  }

  function shareActions(item) {
    if (!item.available) return [h('p', { class: 'muted' }, t('form.send.share_unavailable'))];
    const onShare = async () => {
      const nav = globalThis.navigator;
      const data = { title: t('form.send.share_title', { title: config.title }), text: shareBody(allCodes) };
      try {
        const file = typeof File === 'function' ? new File([rcnContent(allCodes)], rcnFilename(config.title), { type: 'text/plain' }) : null;
        if (file && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) data.files = [file];
      } catch {
        // partage de fichier non pris en charge : texte seul
      }
      try {
        await nav.share(data);
        track();
        thank(t('form.send.shared'));
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn('[Recensia] Partage impossible.', err);
        toast(t('form.send.share_failed'), 'warn');
      }
    };
    return [h('div', { class: 'form-send-actions' }, button(item.button_label, onShare, { variant: 'primary', icon: 'share' }))];
  }

  function serviceActions(item) {
    const buildUrl = (group) => {
      const text = shareBody(group);
      if (item.type === 'teams') {
        const link = safeImportLink(ctx.baseUrl, group);
        return link ? teamsShareUrl(link, text) : '';
      }
      return whatsappUrl(text, item.target ?? undefined);
    };
    let groups;
    try {
      groups = groupCodes(allCodes, buildUrl);
      if (groups.some((group) => !buildUrl(group))) throw new Error('lien d\'import indisponible');
    } catch (err) {
      console.warn(`[Recensia] Lien ${item.type} impossible.`, err);
      return [callout('warn', h('p', null, t('form.send.service_unavailable')))];
    }
    const total = groups.length;
    const nodes = groups.map((group, index) => {
      const names = group.map((code) => codes.find((c) => c.code === code)?.name).filter(Boolean).join(', ');
      const label = total === 1 ? item.button_label : t('form.send.service_part', { label: item.button_label, n: index + 1, total });
      return h('a', {
        class: ['btn', index === 0 ? 'btn-primary' : 'btn-secondary', 'form-send-link'],
        href: buildUrl(group),
        target: '_blank',
        rel: 'noopener noreferrer',
        onClick: () => {
          track();
          thank(t('form.send.service_opened', { label: item.label }));
        },
      }, icon('external'), h('span', { class: 'btn-label' }, label,
        total > 1 && names ? h('span', { class: 'form-send-detail' }, names) : null,
        h('span', { class: 'visually-hidden' }, ` ${t('form.send.new_window')}`)));
    });
    return [h('div', { class: ['form-send-actions', total > 1 ? 'is-list' : null] }, nodes),
      h('p', { class: 'muted small' }, t('form.send.service_help', { label: item.label }))];
  }

  function targetLine(item) {
    if (!item.target) return null;
    if (item.type === 'mailto') return h('p', { class: 'form-channel-target' }, h('strong', null, t('form.send.to')), ' ', item.target);
    if (item.type === 'whatsapp') return h('p', { class: 'form-channel-target' }, h('strong', null, t('form.send.number')), ' ', `+${item.target}`);
    return h('p', { class: 'form-channel-target' }, h('strong', null, t('form.send.instruction')), ' ', frenchSpacing(item.target));
  }

  function channelCard(item, index) {
    const titleId = `form-channel-${index}`;
    let actions;
    switch (item.type) {
      case 'mailto': actions = mailActions(item); break;
      case 'copy': actions = copyActions(item); break;
      case 'file': actions = fileActions(item); break;
      case 'share': actions = shareActions(item); break;
      default: actions = serviceActions(item);
    }
    const warning = !common && item.warning
      ? callout(item.identifies_sender === 'yes' ? 'warn' : 'info', h('p', null, frenchSpacing(item.warning)))
      : null;
    return h('li', { class: ['card', 'card-compact', 'form-channel', item.available ? null : 'is-unavailable'], 'aria-labelledby': titleId },
      h('h4', { class: 'form-channel-title', id: titleId }, item.fallback ? t('form.send.fallback_title') : item.label),
      targetLine(item),
      warning,
      actions);
  }

  // --- Codes ------------------------------------------------------------------------

  function codeItem(entry, index) {
    const qrId = `form-code-qr-${index}`;
    const qrBox = h('div', { class: 'form-code-qr', id: qrId, hidden: true });
    let qrBuilt = false;
    const toggle = button(t('form.codes.qr_show'), () => {
      if (!qrBuilt) {
        const link = safeImportLink(ctx.baseUrl, [entry.code]);
        let figure;
        try {
          if (!link) throw new Error('lien d\'import indisponible');
          figure = h('figure', { class: 'form-qr-figure' },
            qrSvgElement(link, { title: t('form.codes.qr_label', { name: entry.name }), className: 'qr form-qr' }),
            h('figcaption', { class: 'muted small' }, t('form.codes.qr_help')));
        } catch (err) {
          console.warn('[Recensia] QR code impossible.', err);
          figure = h('p', { class: 'muted' }, t('form.codes.qr_failed'));
        }
        mount(qrBox, figure);
        qrBuilt = true;
      }
      qrBox.hidden = !qrBox.hidden;
      toggle.setAttribute('aria-expanded', String(!qrBox.hidden));
      toggle.querySelector('.btn-label').textContent = qrBox.hidden ? t('form.codes.qr_show') : t('form.codes.qr_hide');
    }, { icon: 'qr', attrs: { 'aria-expanded': 'false', 'aria-controls': qrId } });

    // Code brut toujours copiable, quel que soit le canal (CDC §7.7 et §15 : repli si un lien
    // est tronqué ou si rien ne s'ouvre), sans avoir à le sélectionner à la main sur mobile.
    const copy = copyAction(t, () => entry.code, { label: t('form.codes.copy'), onCopied: copied });

    return h('li', { class: 'form-code' },
      h('h4', { class: 'form-code-title' }, entry.name,
        entry.rev > 1 ? h('span', { class: 'badge badge-neutral form-code-rev' }, t('form.codes.revision', { rev: entry.rev })) : null),
      h('details', { class: 'form-code-details' },
        h('summary', null, t('form.codes.show')),
        // Sans hauteur maximale : le <details> replie déjà le code, et une zone défilante
        // devrait être atteignable au clavier (WCAG 2.1.1, Safari).
        h('p', { class: 'code-block form-code-value' }, entry.code)),
      h('div', { class: 'cluster' }, copy, toggle),
      qrBox);
  }

  const thanks = callout('success',
    h('p', null, h('strong', null, t('form.thanks.title')), ' ', t('form.thanks.text')));
  thanks.hidden = true;

  mount(container, h('section', { class: 'form-send stack', 'aria-labelledby': 'form-stage-title' },
    h('div', null,
      h('h2', { id: 'form-stage-title', tabindex: '-1' }, t('form.send.title', { count })),
      h('p', { class: 'lead' }, t('form.send.lead', { count }))),
    closed ? callout('warn', h('p', null, t('form.send.closed'))) : null,

    h('section', { class: 'card form-before-send', 'aria-labelledby': 'form-before-title' },
      h('h3', { id: 'form-before-title' }, icon('shield'), h('span', null, t('form.send.before_title'))),
      h('dl', { class: 'meta-list form-meta-list' },
        h('dt', null, t('form.send.recipient')),
        h('dd', null, recipient),
        h('dt', null, t('form.send.fingerprint')),
        h('dd', null, h('span', { class: 'fingerprint' }, fp))),
      h('p', { class: 'muted small' }, config.org ? t('form.send.fingerprint_help_org', { org: config.org }) : t('form.send.fingerprint_help')),
      common ? callout(config.mode === 'open' ? 'info' : 'warn', h('p', null, common)) : null),

    h('section', { class: 'form-channels-section', 'aria-labelledby': 'form-channels-title' },
      h('h3', { id: 'form-channels-title' }, count === 1 ? t('form.send.channels_title_one') : t('form.send.channels_title')),
      h('ul', { class: 'form-channels', role: 'list' }, channels.map(channelCard))),

    thanks,
    status,

    h('section', { class: 'form-codes-section', 'aria-labelledby': 'form-codes-title' },
      h('h3', { id: 'form-codes-title' }, t('form.codes.title', { count })),
      h('p', { class: 'muted' }, t('form.codes.lead')),
      h('ol', { class: 'form-code-list', role: 'list' }, codes.map(codeItem)),
      h('p', { class: 'muted small' }, t('form.codes.correction'))),

    h('div', { class: 'form-actions' },
      button(t('form.send.back'), onBack, { icon: 'arrow-left' }),
      button(t('form.clear.button'), onClear, { variant: 'ghost', icon: 'trash', attrs: { class: 'form-clear' } }))));

  announce(t('form.send.ready', { count }));
}
