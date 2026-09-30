// Mes campagnes (#/admin) : campagnes de ce navigateur, fichier de récupération, restauration d'une
// sauvegarde, codes en attente, état du stockage (CDC §4, §7.5, §7.6).
//
// Ce module exporte aussi les parcours partagés avec le lien d'import (#/i/…) et l'onglet Paramètres :
// choix de fichier, mot de passe, import du fichier de récupération, restauration, état du stockage.
// Ils utilisent l'espace de noms « admin » : appeler prepareAdmin(ctx) avant.

import { h, mount, loadCss, announce } from '../ui/dom.js';
import { icon, button, callout, modal, confirmDialog, field, setFieldError } from '../ui/components.js';
import { formatFingerprint } from '../crypto/keys.js';
import { BackupError, decryptWithPassword, isEncryptedEnvelope, isRecoveryFile } from '../crypto/backup.js';
import { formatDate, has } from '../i18n.js';
import { importJson, MAX_IMPORT_CHARS } from '../export/json.js';
import { BACKUP_FORMAT } from '../storage/backup-format.js';
import { daysSince } from '../services/model.js';
import {
  MAX_RECOVERY_CHARS, importRecovery, inspectRecoveryFile, listPendingCodes, removePendingCodes, clearPendingCodes,
} from '../services/recovery.js';
import {
  codesForCampaign, findCampaignForCodes, importCodes, resolvedCodes, stashReport,
} from '../services/import.js';

export const ADMIN_CSS = 'src/styles/admin.css';

let uid = 0;
const nextId = (prefix) => `${prefix}-${(uid += 1)}`;

/** Erreur d'interface (fichier illisible, stockage absent…) ; `code` renvoie à admin.errors.<code>. */
export class ViewError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ViewError';
    this.code = code;
  }
}

/** Feuille de style et textes « admin » (à appeler par toute vue qui réutilise ces parcours). */
export async function prepareAdmin(ctx) {
  await Promise.all([
    loadCss(ADMIN_CSS),
    ctx.i18n.load('admin').catch((err) => console.info('[Recensia] Textes « admin » indisponibles.', err)),
  ]);
}

/**
 * Journalise un échec : les erreurs attendues (fichier inadapté, mot de passe, conflit…) au niveau
 * « info », les autres au niveau « error ». Jamais de donnée ni de clé dans le message.
 */
export function logFailure(context, err) {
  const code = typeof err?.code === 'string' ? err.code : null;
  if (code && has(`admin.errors.${code}`)) console.info(`[Recensia] ${context} (${code}).`);
  else console.error(`[Recensia] ${context}`, err);
}

/** Message lisible pour une erreur des services (RecoveryError, StoreError, ImportError, ViewError). */
export function errorMessage(t, err) {
  const code = typeof err?.code === 'string' ? err.code : null;
  const key = code ? `admin.errors.${code}` : null;
  if (key && has(key)) return t(key);
  return t('admin.errors.generic');
}

/**
 * Ouvre le sélecteur de fichiers du système. L'élément <input type="file"> est ajouté à `host`
 * (retiré après usage). Annulation : liste vide (si le navigateur la signale).
 * @returns {Promise<File[]>}
 */
export function pickFiles(host, { accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    let settled = false;
    const done = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    host.appendChild(input);
    input.click();
  });
}

/** Lit un fichier choisi par l'utilisateur (localement, jamais envoyé), avec une taille plafonnée. */
export async function readFileText(file, maxChars) {
  if (!file || typeof file.text !== 'function') throw new ViewError('read');
  // Une unité UTF-16 occupe au plus 3 octets en UTF-8.
  if (Number(file.size) > maxChars * 3) throw new ViewError('too_large');
  let text;
  try {
    text = await file.text();
  } catch {
    throw new ViewError('read');
  }
  if (text.length > maxChars) throw new ViewError('too_large');
  return text;
}

/**
 * Demande un mot de passe dans une boîte de dialogue et le soumet à `attempt(password)`.
 * Mot de passe incorrect (code 'wrong_password') : message dans le champ, la boîte reste ouverte.
 * @returns {Promise<any|null>} résultat de attempt, ou null si l'utilisateur annule
 * @throws toute autre erreur levée par attempt
 */
export function passwordDialog(t, { title, intro, submitLabel, attempt }) {
  const id = nextId('password');
  const input = h('input', {
    type: 'password', autocomplete: 'current-password', autofocus: true, spellcheck: 'false', autocapitalize: 'off',
  });
  const fieldNode = field({ id, label: t('admin.password.label'), required: true, control: input });
  const status = h('p', { class: 'muted small password-status', role: 'status' });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.closest('dialog')?.querySelector('.modal-actions .btn-primary')?.click();
  });

  const submit = async () => {
    const buttons = Array.from(input.closest('dialog')?.querySelectorAll('.modal-actions button') ?? []);
    const password = input.value;
    if (password === '') {
      setFieldError(fieldNode, t('admin.password.required'));
      input.focus();
      return undefined;
    }
    setFieldError(fieldNode, null);
    buttons.forEach((b) => { b.disabled = true; });
    input.readOnly = true;
    status.textContent = t('admin.password.checking');
    try {
      return { ok: true, result: await attempt(password) };
    } catch (err) {
      if (err?.code === 'wrong_password' || err?.code === 'password_required') {
        setFieldError(fieldNode, t('admin.password.wrong'));
        announce(t('admin.password.wrong'), { assertive: true });
        input.readOnly = false;
        input.select();
        input.focus();
        return undefined;
      }
      return { ok: false, error: err };
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      input.readOnly = false;
      status.textContent = '';
    }
  };

  return modal({
    title,
    content: h('div', { class: 'stack-sm' }, intro ? h('p', null, intro) : null, fieldNode, status),
    actions: [
      { label: t('common.actions.cancel'), value: null },
      { label: submitLabel ?? t('admin.password.unlock'), value: submit, variant: 'primary' },
    ],
  }).then((outcome) => {
    if (!outcome) return null;
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  });
}

/**
 * Import d'un fichier de récupération choisi par l'utilisateur (mot de passe demandé s'il est protégé).
 * @returns {Promise<{ status, campaign } | { redirect: 'backup', text } | null>} null : annulé
 * @throws {RecoveryError|ViewError}
 */
export async function recoveryImportFlow(ctx, file) {
  const { t, store } = ctx;
  if (!store) throw new ViewError('no_store');
  const text = typeof file === 'string' ? file : await readFileText(file, MAX_RECOVERY_CHARS);
  let info;
  try {
    info = inspectRecoveryFile(text);
  } catch (err) {
    if (err?.code === 'backup_file') return { redirect: 'backup', text };
    throw err;
  }
  if (!info.protected) return importRecovery({ store, file: text });
  // Trait d'union insécable : l'empreinte ne se coupe pas en fin de ligne.
  const fp = formatFingerprint(info.campaign.fingerprint).replace('-', '\u2011');
  return passwordDialog(t, {
    title: t('admin.recovery.dialog_title'),
    intro: info.campaign.title && fp
      ? t('admin.recovery.dialog_intro', { title: info.campaign.title, fp })
      : t('admin.recovery.dialog_intro_unknown'),
    attempt: (password) => importRecovery({ store, file: text, passphrase: password }),
  });
}

/**
 * Restauration d'une sauvegarde (.json, chiffrée ou non). Si la campagne existe déjà, le remplacement
 * est demandé explicitement (overwrite). Un fichier de récupération est renvoyé à l'appelant.
 * @returns {Promise<{ campaign_id, entries, assessments, actions, encrypted, campaign } | { redirect: 'recovery', text } | null>}
 * @throws {StoreError|ViewError}
 */
export async function backupRestoreFlow(ctx, file) {
  const { t, store } = ctx;
  if (!store) throw new ViewError('no_store');
  const text = typeof file === 'string' ? file : await readFileText(file, MAX_IMPORT_CHARS);
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ViewError('invalid_json');
  }
  if (isRecoveryFile(parsed)) return { redirect: 'recovery', text };

  let data = parsed;
  const encrypted = isEncryptedEnvelope(parsed);
  if (encrypted) {
    data = await passwordDialog(t, {
      title: t('admin.backup.dialog_title'),
      intro: t('admin.backup.dialog_intro'),
      attempt: async (password) => {
        try {
          return await decryptWithPassword(parsed, password);
        } catch (err) {
          if (err instanceof BackupError && err.reason === 'password') throw new ViewError('wrong_password');
          throw new ViewError('invalid_backup');
        }
      },
    });
    if (data === null) return null;
  }

  // JSON quelconque (ni sauvegarde ni enveloppe chiffrée) : message « pas une sauvegarde Recensia ».
  if (data?.format !== BACKUP_FORMAT) throw new ViewError(encrypted ? 'invalid_backup' : 'invalid_json');
  const id = data?.campaign?.id;
  let overwrite = false;
  if (typeof id === 'string' && id !== '') {
    const existing = await store.getCampaign(id).catch(() => null);
    // Même identifiant, autre clé : refus avant de demander une confirmation qui échouerait.
    if (existing?.public_key && data.campaign.public_key && existing.public_key !== data.campaign.public_key) {
      throw new ViewError('key_mismatch');
    }
    if (existing) {
      const ok = await confirmDialog({
        title: t('admin.backup.confirm_title'),
        message: t('admin.backup.confirm_text', { title: existing.title }),
        confirmLabel: t('admin.backup.confirm'),
        danger: true,
      });
      if (!ok) return null;
      overwrite = true;
    }
  }
  const result = await importJson(JSON.stringify(data), null, store, { overwrite });
  const campaign = await store.getCampaign(result.campaign_id);
  return { ...result, encrypted, campaign };
}

/**
 * Importe les codes en attente de la session que la clé de `campaign` déchiffre, puis transmet
 * le rapport à l'onglet Import par la session. fromLink : les codes viennent d'un lien d'import
 * ouvert à l'instant (événement d'audience « event/import_link »).
 * @returns {Promise<object|null>} rapport, ou null si aucun code en attente ne concerne la campagne
 */
export async function importPendingFor(ctx, campaign, { fromLink = false } = {}) {
  const pending = listPendingCodes();
  if (pending.length === 0 || !campaign?.private_key_jwk || !ctx.store) return null;
  const mine = await codesForCampaign(pending, campaign);
  if (mine.length === 0) return null;
  const questionnaire = await ctx.data.get('questionnaire');
  const report = await importCodes({ codes: mine, campaign, store: ctx.store, questionnaire });
  removePendingCodes(resolvedCodes(report));
  stashReport({ ...report, origin: fromLink ? 'link' : 'session' });
  if (fromLink) ctx.track.event('event/import_link');
  return report;
}

/**
 * Carte « Stockage de ce navigateur » : IndexedDB persistant ou non, repli mémoire, demande de
 * stockage persistant (navigator.storage.persist).
 */
export function storageCard(ctx, { headingLevel = 2 } = {}) {
  const { t, store } = ctx;
  const titleId = nextId('storage-title');
  const body = h('div', { class: 'stack-sm' });
  const storage = globalThis.navigator?.storage;
  const canPersist = typeof storage?.persist === 'function';

  const state = (ok, text) => h('p', { class: ['storage-state', ok ? 'is-ok' : 'is-warn'] },
    icon(ok ? 'check' : 'alert'), h('span', null, text));

  const draw = (persisted, message = null) => {
    if (!store) {
      mount(body, state(false, t('admin.errors.no_store')));
      return;
    }
    if (store.kind === 'memory') {
      mount(body, state(false, t('admin.storage.memory')));
      return;
    }
    mount(body,
      state(persisted, persisted ? t('admin.storage.persisted') : t('admin.storage.not_persisted')),
      !persisted && canPersist ? h('div', null, button(t('admin.storage.request'), onRequest, { icon: 'shield', size: 'sm' })) : null,
      !persisted && !canPersist ? h('p', { class: 'muted small' }, t('admin.storage.unsupported')) : null,
      message ? h('p', { class: 'small', role: 'status' }, message) : null,
      h('p', { class: 'muted small' }, t('admin.storage.idb')));
  };

  async function onRequest() {
    let ok = false;
    try {
      ok = (await storage.persist()) === true;
    } catch {
      ok = false;
    }
    if (store) store.persisted = ok;
    const message = ok ? t('admin.storage.granted') : t('admin.storage.denied');
    draw(ok, message);
    announce(message);
  }

  draw(store?.persisted === true);
  if (store?.kind === 'indexeddb' && typeof storage?.persisted === 'function') {
    Promise.resolve().then(() => storage.persisted()).then((value) => {
      const actual = value === true;
      if (actual !== store.persisted) {
        store.persisted = actual;
        draw(actual);
      }
    }).catch(() => {});
  }
  return h('section', { class: 'card storage-card', 'aria-labelledby': titleId },
    h(`h${headingLevel}`, { id: titleId, class: 'card-title' }, t('admin.storage.title')),
    body);
}

/** Encart de retour (succès, erreur…) affiché dans une zone de la page et annoncé. */
export function showFeedback(zone, kind, message, ...extra) {
  mount(zone, callout(kind, h('p', null, message), ...extra));
  announce(message, { assertive: kind === 'danger' });
  if (typeof zone.scrollIntoView === 'function') zone.scrollIntoView({ block: 'nearest' });
}

// --- Vue #/admin ------------------------------------------------------------------

function sortCampaigns(list) {
  return [...list].sort((a, b) => {
    if (Boolean(a.demo) !== Boolean(b.demo)) return a.demo ? 1 : -1;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  });
}

function backupText(t, campaign) {
  const days = daysSince(campaign.last_backup_at);
  if (days === null) return t('admin.card.backup_never');
  return `${formatDate(campaign.last_backup_at)} (${t('admin.card.backup_days', { count: days })})`;
}

function campaignCard(t, campaign, entriesCount) {
  const titleId = nextId('campaign-title');
  const missingKey = !campaign.private_key_jwk && !campaign.demo;
  const fp = campaign.fingerprint ? formatFingerprint(campaign.fingerprint) : null;
  return h('li', { class: ['card', 'campaign-card', missingKey ? 'is-missing-key' : null] },
    h('div', { class: 'campaign-card-head' },
      campaign.org_name ? h('p', { class: 'eyebrow' }, campaign.org_name) : null,
      h('h3', { class: 'campaign-card-title', id: titleId }, campaign.title),
      h('p', { class: 'cluster campaign-badges' },
        h('span', { class: 'badge badge-neutral' }, icon(campaign.mode === 'open' ? 'users' : 'shield'), t(`common.mode.${campaign.mode === 'open' ? 'open' : 'anonymous'}`)),
        campaign.demo ? h('span', { class: 'badge badge-neutral badge-demo' }, t('admin.card.demo')) : null,
        missingKey ? h('span', { class: 'badge badge-neutral badge-missing-key' }, icon('key'), t('admin.card.no_key')) : null)),
    h('dl', { class: 'meta-list campaign-meta' },
      h('dt', null, t('admin.card.fingerprint')), h('dd', null, fp ? h('span', { class: 'fingerprint' }, fp) : t('admin.card.none')),
      h('dt', null, t('admin.card.entries')), h('dd', null, String(entriesCount)),
      h('dt', null, t('admin.card.created')), h('dd', null, campaign.created_at ? formatDate(campaign.created_at) : t('admin.card.none')),
      h('dt', null, t('admin.card.backup')), h('dd', null, backupText(t, campaign))),
    missingKey ? h('p', { class: 'campaign-alert small' }, icon('alert'), h('span', null, t('admin.card.no_key_text'))) : null,
    h('div', { class: 'campaign-card-actions' },
      h('a', {
        class: 'btn btn-primary btn-sm',
        href: `#/admin/${campaign.id}`,
        'aria-label': t('admin.actions.open_label', { title: campaign.title }),
      }, t('admin.actions.open'), icon('arrow-right'))));
}

export async function render(root, { ctx }) {
  await prepareAdmin(ctx);
  const { t, store } = ctx;
  ctx.setTitle(t('admin.meta.title'));

  if (!store) {
    mount(root, h('div', { class: 'page page-narrow' },
      h('div', { class: 'empty-state' },
        h('span', { class: 'empty-state-icon empty-state-danger' }, icon('alert')),
        h('h1', null, t('admin.no_store.title')),
        h('p', { class: 'lead' }, t('admin.no_store.text')))));
    return undefined;
  }

  let disposed = false;
  const feedbackZone = h('div', { class: 'admin-feedback' });
  const pendingZone = h('div', { class: 'admin-pending' });
  const listZone = h('div', { class: 'admin-list-body' });
  const countNode = h('span', { class: 'muted admin-count' });
  const filesHost = h('div', { class: 'visually-hidden' });

  async function drawList() {
    const campaigns = sortCampaigns(await store.listCampaigns());
    const counts = await Promise.all(campaigns.map((c) => store.listEntries(c.id).then((e) => e.length, () => 0)));
    if (disposed) return;
    countNode.textContent = campaigns.length ? t('admin.list.count', { count: campaigns.length }) : '';
    if (campaigns.length === 0) {
      mount(listZone, h('div', { class: 'empty-state admin-empty card card-flat' },
        h('span', { class: 'empty-state-icon' }, icon('list')),
        h('h3', null, t('admin.empty.title')),
        h('p', { class: 'muted' }, t('admin.empty.text')),
        h('div', { class: 'cluster cluster-center' },
          h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', null, t('admin.actions.new'))),
          h('a', { class: 'btn btn-secondary', href: '#/demo' }, t('admin.actions.load_demo')))));
      return;
    }
    mount(listZone, h('ul', { class: 'grid grid-2 campaign-grid', role: 'list' },
      campaigns.map((c, i) => campaignCard(t, c, counts[i]))));
  }

  function drawPending() {
    const pending = listPendingCodes();
    if (pending.length === 0) {
      mount(pendingZone);
      return;
    }
    const importBtn = button(t('admin.pending.import'), onImportPending, { variant: 'primary', size: 'sm', icon: 'upload' });
    mount(pendingZone, callout('info',
      h('p', null, t('admin.pending.text', { count: pending.length })),
      h('div', { class: 'cluster' },
        importBtn,
        button(t('admin.pending.forget'), () => {
          clearPendingCodes();
          drawPending();
          showFeedback(feedbackZone, 'info', t('admin.pending.forgotten'));
          // Le bouton a disparu : le focus clavier passe au message.
          feedbackZone.setAttribute('tabindex', '-1');
          feedbackZone.focus({ preventScroll: true });
        }, { variant: 'ghost', size: 'sm' }))));
  }

  async function onImportPending(event) {
    const btn = event?.currentTarget;
    if (btn) btn.disabled = true;
    announce(t('admin.pending.working'));
    try {
      const pending = listPendingCodes();
      const found = await findCampaignForCodes(pending, await store.listCampaigns());
      if (disposed) return;
      if (!found) {
        showFeedback(feedbackZone, 'warn', t('admin.pending.no_match'));
        return;
      }
      const report = await importPendingFor(ctx, found.campaign);
      if (disposed) return;
      if (report) ctx.navigate(`/admin/${found.campaign.id}/import`);
    } catch (err) {
      logFailure('Import des codes en attente impossible', err);
      showFeedback(feedbackZone, 'danger', errorMessage(t, err));
    } finally {
      if (btn?.isConnected) btn.disabled = false;
    }
  }

  const openLink = (campaign) => h('p', null,
    h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/${campaign.id}` }, t('admin.recovery.open'), icon('arrow-right')));

  async function handleRecovery(fileOrText) {
    const res = await recoveryImportFlow(ctx, fileOrText);
    if (!res || disposed) return;
    if (res.redirect === 'backup') {
      showFeedback(feedbackZone, 'info', t('admin.recovery.is_backup'));
      await handleRestore(res.text);
      return;
    }
    let report = null;
    try {
      report = await importPendingFor(ctx, res.campaign);
    } catch (err) {
      console.warn('[Recensia] Codes en attente non importés.', err);
    }
    if (disposed) return;
    if (report) {
      ctx.navigate(`/admin/${res.campaign.id}/import`);
      return;
    }
    showFeedback(feedbackZone, res.status === 'already_present' ? 'info' : 'success',
      t(`admin.recovery.${res.status}`, { title: res.campaign.title }), openLink(res.campaign));
    await drawList();
    drawPending();
  }

  async function handleRestore(fileOrText) {
    const res = await backupRestoreFlow(ctx, fileOrText);
    if (!res || disposed) return;
    if (res.redirect === 'recovery') {
      showFeedback(feedbackZone, 'info', t('admin.backup.is_recovery'));
      await handleRecovery(res.text);
      return;
    }
    const campaign = res.campaign ?? { id: res.campaign_id, title: res.campaign_id };
    let report = null;
    try {
      report = await importPendingFor(ctx, campaign);
    } catch (err) {
      console.warn('[Recensia] Codes en attente non importés.', err);
    }
    if (disposed) return;
    if (report) {
      ctx.navigate(`/admin/${campaign.id}/import`);
      return;
    }
    const extra = [openLink(campaign)];
    if (!campaign.private_key_jwk && !campaign.demo) extra.unshift(h('p', null, t('admin.backup.restored_no_key')));
    showFeedback(feedbackZone, 'success', t('admin.backup.restored', { count: res.entries, title: campaign.title }), ...extra);
    await drawList();
    drawPending();
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
    }
  };

  const recoveryHelpId = nextId('recovery-help');
  const backupHelpId = nextId('backup-help');

  mount(root, h('div', { class: 'page admin' },
    h('header', { class: 'page-header' },
      h('div', null,
        h('h1', null, t('admin.title')),
        h('p', { class: 'lead' }, t('admin.lead'))),
      h('div', { class: 'page-header-actions' },
        h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', null, t('admin.actions.new'))))),
    h('div', { class: 'stack admin-top' }, feedbackZone, pendingZone),
    h('section', { class: 'section admin-list', 'aria-labelledby': 'admin-list-title' },
      h('div', { class: 'cluster cluster-between admin-list-header' },
        h('h2', { id: 'admin-list-title' }, t('admin.list.title')),
        countNode),
      listZone),
    h('div', { class: 'grid grid-2 admin-cards' },
      h('section', { class: 'card admin-files', 'aria-labelledby': 'admin-files-title' },
        h('h2', { id: 'admin-files-title', class: 'card-title' }, t('admin.files.title')),
        h('p', { class: 'muted' }, t('admin.files.text')),
        h('ul', { class: 'admin-file-actions', role: 'list' },
          h('li', null,
            button(t('admin.actions.import_recovery'), guarded(handleRecovery, '.recensia-key,.json,application/json'), {
              icon: 'key', attrs: { 'aria-describedby': recoveryHelpId },
            }),
            h('p', { class: 'field-help', id: recoveryHelpId }, t('admin.files.recovery_help'))),
          h('li', null,
            button(t('admin.actions.restore_backup'), guarded(handleRestore, '.json,application/json'), {
              icon: 'upload', attrs: { 'aria-describedby': backupHelpId },
            }),
            h('p', { class: 'field-help', id: backupHelpId }, t('admin.files.backup_help'))),
          h('li', null,
            h('a', { class: 'btn btn-ghost', href: '#/demo' }, t('admin.actions.load_demo'), icon('arrow-right'))))),
      storageCard(ctx)),
    h('div', { class: 'admin-reminder' }, callout('info', h('p', null, t('admin.reminder')))),
    filesHost));

  await drawList();
  drawPending();
  return () => { disposed = true; };
}
