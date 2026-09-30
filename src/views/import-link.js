// Lien d'import (#/i/<code>[~<code>…], CDC §7.7) : le responsable clique sur le lien reçu.
//
// 1. Les codes de forme valide sont IMMÉDIATEMENT placés dans les codes en attente (session), toujours
//    chiffrés. Un code mal formé (lien coupé par la messagerie) n'est pas gardé : aucune clé ne le lirait.
// 2. Le fragment est retiré de l'adresse (history.replaceState vers #/admin, sans navigation) :
//    les codes ne restent ni dans l'historique ni dans une copie de l'adresse.
// 3. La campagne locale dont la clé déchiffre les codes est cherchée : s'il y en a une, import puis
//    onglet Import de la campagne, avec le rapport (transmis par la session).
// 4. Sinon, diagnostic (diagnoseUnmatched) :
//    - « Code illisible » si une campagne de ce navigateur a sa clé, ou si aucun code n'a une forme
//      valide : le lien a probablement été coupé, la consigne est d'abord de redemander le code complet ;
//    - « Clé absente » sinon : import du fichier de récupération sur place ; le code est conservé le temps
//      de la session et importé dès que la clé est là.

import { h, mount } from '../ui/dom.js';
import { icon, button, callout } from '../ui/components.js';
import {
  collectCodes, diagnoseUnmatched, findCampaignForCodes, importCodes, isKeepableCode, resolvedCodes, stashReport,
} from '../services/import.js';
import { addPendingCodes, removePendingCodes } from '../services/recovery.js';
import {
  prepareAdmin, pickFiles, recoveryImportFlow, backupRestoreFlow, importPendingFor, errorMessage, showFeedback, logFailure,
  restoreFocus,
} from './admin.js';

/** Retire les codes de l'adresse sans déclencher de navigation (aucun hashchange). */
function clearFragment() {
  try {
    const { history } = globalThis;
    history.replaceState(history.state ?? null, '', '#/admin');
  } catch (err) {
    console.info('[Recensia] Adresse non nettoyée.', err);
  }
}

// L'adresse vaut déjà #/admin : un lien « Mes campagnes » ne déclencherait aucun hashchange.
// On le fait naviguer explicitement tant que cette vue est affichée.
function keepAdminLinksAlive(ctx) {
  const d = globalThis.document;
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target?.closest?.('a[href="#/admin"]');
    if (!link || globalThis.location.hash !== '#/admin') return;
    event.preventDefault();
    ctx.navigate('/admin');
  };
  d.addEventListener('click', onClick);
  return () => d.removeEventListener('click', onClick);
}

function simpleState(t, { iconName, danger = false, title, text, extra = [], actions = [] }) {
  return h('div', { class: 'page page-narrow import-link' },
    h('div', { class: 'empty-state' },
      h('span', { class: ['empty-state-icon', danger ? 'empty-state-danger' : null] }, icon(iconName)),
      h('h1', null, title),
      h('p', { class: 'lead' }, text),
      extra,
      actions.length ? h('div', { class: 'cluster cluster-center' }, actions) : null));
}

export async function render(root, { params, ctx }) {
  // Avant toute attente : les codes passent dans la session puis quittent l'adresse.
  let codes = [];
  try {
    codes = collectCodes({ codes: Array.isArray(params?.codes) ? params.codes : [] }).codes;
  } catch {
    codes = [];
  }
  const kept = codes.filter(isKeepableCode);
  if (kept.length > 0) addPendingCodes(kept);
  clearFragment();

  await prepareAdmin(ctx);
  const { t, store } = ctx;

  let disposed = false;
  const stopLinks = keepAdminLinksAlive(ctx);
  const cleanup = () => {
    disposed = true;
    stopLinks();
  };
  ctx.setTitle(t('import_link.meta.title'));
  const backButton = (variant = 'secondary') => button(t('import_link.back'), () => ctx.navigate('/admin'), { variant, icon: 'arrow-left' });

  if (codes.length === 0) {
    mount(root, simpleState(t, {
      iconName: 'alert',
      title: t('import_link.no_codes.title'),
      text: t('import_link.no_codes.text'),
      extra: [h('p', { class: 'muted' }, t('import_link.no_codes.hint'))],
      actions: [backButton('primary')],
    }));
    return cleanup;
  }
  if (!store) {
    mount(root, simpleState(t, { iconName: 'alert', danger: true, title: t('import_link.no_store.title'), text: t('import_link.no_store.text') }));
    return cleanup;
  }

  mount(root, h('div', { class: 'page page-narrow import-link' },
    h('h1', null, t('import_link.working.title')),
    h('p', { class: 'import-link-working', role: 'status' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', null, t('import_link.working.text')))));

  let campaigns = [];
  try {
    campaigns = await store.listCampaigns();
    const found = await findCampaignForCodes(codes, campaigns);
    if (disposed) return cleanup;
    if (found) {
      const questionnaire = await ctx.data.get('questionnaire');
      const report = await importCodes({ codes, campaign: found.campaign, campaigns, store, questionnaire });
      removePendingCodes(resolvedCodes(report));
      stashReport({ ...report, origin: 'link' });
      ctx.track.event('event/import_link');
      if (!disposed) ctx.navigate(`/admin/${found.campaign.id}/import`, { replace: true });
      return cleanup;
    }
  } catch (err) {
    console.error('[Recensia] Import par lien impossible.', err);
    if (!disposed) {
      mount(root, simpleState(t, {
        iconName: 'danger', danger: true, title: t('import_link.error.title'), text: t('import_link.error.text'), actions: [backButton('primary')],
      }));
    }
    return cleanup;
  }
  if (disposed) return cleanup;

  const diagnosis = diagnoseUnmatched(codes, campaigns);
  // Codes d'une version future du format : l'application doit d'abord être mise à jour.
  if (diagnosis === 'version') {
    mount(root, simpleState(t, {
      iconName: 'refresh',
      title: t('import_link.version.title'),
      text: t('import_link.version.text'),
      actions: [
        button(t('common.actions.reload'), () => globalThis.location.reload(), { variant: 'primary', icon: 'refresh' }),
        backButton(),
      ],
    }));
    return cleanup;
  }

  draw(diagnosis === 'unreadable');
  return cleanup;

  /**
   * unreadable : « Code illisible » (lien probablement coupé : redemander le code complet d'abord, puis
   * seulement la piste du fichier de récupération) ; sinon « Clé absente de ce navigateur ».
   */
  function draw(unreadable) {
    const feedbackZone = h('div', { class: 'admin-feedback' });
    const filesHost = h('div', { class: 'visually-hidden' });
    const count = codes.length;
    const keptCount = kept.length;
    const dropped = count - keptCount;
    let forgotten = false;

    const afterKey = async (campaign) => {
      let report = null;
      try {
        report = await importPendingFor(ctx, campaign, { fromLink: true });
      } catch (err) {
        console.warn('[Recensia] Codes en attente non importés.', err);
      }
      if (disposed) return;
      if (report) {
        ctx.navigate(`/admin/${campaign.id}/import`, { replace: true });
        return;
      }
      showFeedback(feedbackZone, forgotten ? 'info' : 'warn',
        forgotten ? t('import_link.no_key.key_ready', { title: campaign.title }) : t('import_link.no_key.wrong_campaign', { title: campaign.title }),
        h('p', null, h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/${campaign.id}` }, t('admin.recovery.open'), icon('arrow-right'))));
    };

    async function handleRecovery(fileOrText) {
      const res = await recoveryImportFlow(ctx, fileOrText);
      if (!res || disposed) return;
      if (res.redirect === 'backup') {
        await handleRestore(res.text);
        return;
      }
      await afterKey(res.campaign);
    }

    async function handleRestore(fileOrText) {
      const res = await backupRestoreFlow(ctx, fileOrText);
      if (!res || disposed) return;
      if (res.redirect === 'recovery') {
        await handleRecovery(res.text);
        return;
      }
      if (res.campaign) await afterKey(res.campaign);
    }

    const guarded = (fn, accept) => async (event) => {
      const btn = event?.currentTarget;
      const [file] = await pickFiles(filesHost, { accept });
      if (!file || disposed) return;
      if (btn) btn.disabled = true;
      try {
        await fn(file);
      } catch (err) {
        logFailure('Import de fichier impossible', err);
        if (!disposed) showFeedback(feedbackZone, 'danger', errorMessage(t, err));
      } finally {
        if (btn?.isConnected) btn.disabled = false;
        if (!disposed) restoreFocus(btn);
      }
    };

    const forget = () => {
      removePendingCodes(kept);
      forgotten = true;
      showFeedback(feedbackZone, 'info', t('import_link.no_key.forgotten', { count: keptCount }));
      forgetBtn.disabled = true;
      backBtn.focus(); // le bouton désactivé perdrait le focus clavier
    };
    const backBtn = backButton();
    const forgetBtn = keptCount > 0
      ? button(keptCount > 1 ? t('import_link.no_key.forget_many') : t('import_link.no_key.forget'), forget, { variant: 'ghost', icon: 'trash' })
      : null;
    const recoveryBtn = (variant) => button(t('admin.actions.import_recovery'), guarded(handleRecovery, '.recensia-key,.json,application/json'), { variant, icon: 'key' });
    const restoreBtn = () => button(t('admin.actions.restore_backup'), guarded(handleRestore, '.json,application/json'), { icon: 'upload' });
    const step = (text, ...actions) => ({ text, actions });

    const steps = unreadable
      ? [
        step(t('import_link.unreadable.step_ask')),
        // Codes de forme valide : ils peuvent venir d'une campagne créée dans un autre navigateur.
        keptCount > 0 ? step(t('import_link.unreadable.step_recovery'), recoveryBtn('secondary'), restoreBtn()) : null,
      ].filter(Boolean)
      : [
        step(t('import_link.no_key.step_recovery'), recoveryBtn('primary')),
        step(t('import_link.no_key.step_backup'), restoreBtn()),
        step(t('import_link.no_key.step_other')),
      ];
    const stepsTitle = unreadable ? t('import_link.unreadable.steps_title') : t('import_link.no_key.steps_title', { count: keptCount });
    const keptText = unreadable
      ? (keptCount > 0 ? t('import_link.unreadable.kept', { count: keptCount }) : t('import_link.unreadable.none_kept', { count }))
      : t('import_link.no_key.kept', { count: keptCount });

    mount(root, h('div', { class: 'page page-narrow import-link' },
      h('header', { class: 'page-header' },
        h('div', null,
          h('h1', null, unreadable ? t('import_link.unreadable.title', { count }) : t('import_link.no_key.title')),
          h('p', { class: 'lead' }, unreadable ? t('import_link.unreadable.lead', { count }) : t('import_link.no_key.lead', { count: keptCount })))),
      h('div', { class: 'stack' },
        unreadable ? null : callout('info', h('p', null, keptText)),
        !unreadable && dropped > 0 ? h('p', { class: 'muted' }, t('import_link.no_key.dropped', { count: dropped })) : null,
        // Répondant qui a scanné ou ouvert son propre lien : il n'a rien à importer.
        unreadable ? null : callout('warn', h('p', null, t('import_link.no_key.respondent'))),
        feedbackZone,
        h('section', { class: 'card', 'aria-labelledby': 'import-link-steps-title' },
          h('h2', { id: 'import-link-steps-title', class: 'card-title' }, stepsTitle),
          // Une seule consigne : un paragraphe plutôt qu'une liste numérotée d'un élément.
          steps.length === 1
            ? h('p', null, steps[0].text)
            : h('ol', { class: 'stepper import-link-steps' }, steps.map((st) => h('li', { class: 'stepper-item' },
              h('p', null, st.text),
              st.actions.length ? h('div', { class: 'cluster' }, st.actions) : null)))),
        unreadable ? h('p', { class: 'muted' }, keptText) : null,
        h('div', { class: 'import-link-actions' }, backBtn, forgetBtn)),
      filesHost));
  }
}
