// Onglet « Paramètres » (#/admin/<id>/parametres ; CDC §7.5, §7.6).
// Informations de la campagne (la clé privée n'est JAMAIS affichée), réglages locaux, fichier de
// récupération, sauvegarde et restauration, stockage persistant, zone de danger.
// Toute écriture relit la campagne depuis le store et enregistre l'objet complet.

import { h, mount, announce } from '../../ui/dom.js';
import { icon, button, callout, field, setFieldError, confirmDialog, modal, toast } from '../../ui/components.js';
import { downloadBlob, downloadText } from '../../ui/download.js';
import { formatFingerprint } from '../../crypto/keys.js';
import { formatDate, formatDateTime } from '../../i18n.js';
import { exportJson, backupFilename } from '../../export/json.js';
import { daysSince, localDay } from '../../services/model.js';
import { recomputeAfterClose } from '../../services/import.js';
import { buildRecoveryFile, markRecoverySaved } from '../../services/recovery.js';
import {
  prepareAdmin, pickFiles, backupRestoreFlow, recoveryImportFlow, storageCard, errorMessage, showFeedback, logFailure,
} from '../admin.js';

export const MIN_GROUP_SIZE = 2;
export const MAX_GROUP_SIZE = 50;
export const MIN_PASSWORD = 10;

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FR_DAY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function validDay(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Jour saisi (AAAA-MM-JJ, ou JJ/MM/AAAA si le navigateur n'a pas de sélecteur de date) → AAAA-MM-JJ | null | undefined (invalide). */
export function parseDay(input) {
  const s = String(input ?? '').trim();
  if (s === '') return null;
  let m = ISO_DAY_RE.exec(s);
  if (m && validDay(Number(m[1]), Number(m[2]), Number(m[3]))) return s;
  m = FR_DAY_RE.exec(s);
  if (m && validDay(Number(m[3]), Number(m[2]), Number(m[1]))) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return undefined;
}

/**
 * Valide les réglages locaux saisis (pur).
 * @returns {{ ok: boolean, errors: { min_group_size?: string, closes_on?: string },
 *   value: { min_group_size: number, comments_exportable: boolean, group_by_department: boolean, closes_on: string|null } | null }}
 */
export function validateLocalSettings(input = {}) {
  const errors = {};
  const raw = String(input.min_group_size ?? '').trim();
  const k = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(k) || k < MIN_GROUP_SIZE || k > MAX_GROUP_SIZE) errors.min_group_size = 'range';
  const closes = parseDay(input.closes_on);
  if (closes === undefined) errors.closes_on = 'format';
  if (Object.keys(errors).length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors,
    value: {
      min_group_size: k,
      comments_exportable: input.comments_exportable === true,
      group_by_department: input.group_by_department === true,
      closes_on: closes,
    },
  };
}

/** Applique des réglages locaux à une campagne relue (pur) → { campaign, changed }. */
export function mergeLocalSettings(campaign, value) {
  const current = campaign.settings ?? {};
  const next = { ...current, ...value };
  const changed = Object.keys(value).some((key) => (current[key] ?? null) !== (value[key] ?? null));
  return { campaign: { ...campaign, settings: next }, changed };
}

/** Contrôle d'un nouveau mot de passe (pur) → null | 'too_short' | 'mismatch'. */
export function checkNewPassword(password, confirmation, min = MIN_PASSWORD) {
  if (typeof password !== 'string' || [...password].length < min) return 'too_short';
  if (password !== confirmation) return 'mismatch';
  return null;
}

let uid = 0;
const nextId = (prefix) => `${prefix}-${(uid += 1)}`;

function checkbox(id, label, help, checked) {
  const input = h('input', { type: 'checkbox', id, checked, 'aria-describedby': help ? `${id}-help` : null });
  const node = h('label', { class: 'choice', for: id },
    input,
    h('span', { class: 'choice-text' },
      h('span', { class: 'choice-label' }, label),
      help ? h('span', { class: 'choice-help', id: `${id}-help` }, help) : null));
  return { input, node };
}

function passwordPair(t, prefix, { label, help, confirmLabel }) {
  const first = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', autocapitalize: 'off' });
  const second = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', autocapitalize: 'off' });
  const firstField = field({ id: `${prefix}-password`, label, help, control: first });
  const secondField = field({ id: `${prefix}-confirm`, label: confirmLabel, control: second });
  const node = h('div', { class: 'settings-passwords' }, firstField, secondField);
  const check = () => {
    const problem = checkNewPassword(first.value, second.value);
    setFieldError(firstField, problem === 'too_short' ? t('settings.password.too_short', { min: MIN_PASSWORD }) : null);
    setFieldError(secondField, problem === 'mismatch' ? t('settings.password.mismatch') : null);
    if (problem === 'too_short') first.focus();
    else if (problem === 'mismatch') second.focus();
    if (problem) announce(problem === 'too_short' ? t('settings.password.too_short', { min: MIN_PASSWORD }) : t('settings.password.mismatch'), { assertive: true });
    return problem === null ? first.value : null;
  };
  const reset = () => {
    first.value = '';
    second.value = '';
    setFieldError(firstField, null);
    setFieldError(secondField, null);
  };
  return { node, check, reset };
}

function infoSection(t, campaign, channelsData) {
  const s = campaign.settings ?? {};
  const channels = Array.isArray(s.channels) ? s.channels : [];
  const none = t('settings.info.none');
  return h('section', { class: 'card settings-section', 'aria-labelledby': 'settings-info-title' },
    h('h3', { id: 'settings-info-title' }, t('settings.info.title')),
    h('dl', { class: 'meta-list settings-info' },
      h('dt', null, t('settings.info.campaign_title')), h('dd', null, campaign.title),
      h('dt', null, t('settings.info.org')), h('dd', null, campaign.org_name || none),
      h('dt', null, t('settings.info.id')), h('dd', null, h('code', null, campaign.id)),
      h('dt', null, t('settings.info.mode')), h('dd', null, t(`common.mode.${campaign.mode === 'open' ? 'open' : 'anonymous'}`)),
      h('dt', null, t('settings.info.fingerprint')),
      h('dd', null,
        campaign.fingerprint ? h('span', { class: 'fingerprint' }, formatFingerprint(campaign.fingerprint)) : none,
        campaign.fingerprint ? h('p', { class: 'field-help settings-fp-help' }, t('settings.info.fingerprint_help')) : null),
      h('dt', null, t('settings.info.created')), h('dd', null, campaign.created_at ? formatDate(campaign.created_at) : none),
      h('dt', null, t('settings.info.departments')),
      h('dd', null, campaign.departments?.length
        ? h('ul', null, campaign.departments.map((d) => h('li', null, d)))
        : t('settings.info.departments_none')),
      h('dt', null, t('settings.info.channels')),
      h('dd', null, channels.length
        ? h('ul', null, channels.map((c) => h('li', null,
          channelsData?.types?.[c.type]?.label ?? c.type,
          c.target ? h('span', { class: 'muted' }, ` — ${c.target}`) : null)))
        : t('settings.info.channels_none')),
      h('dt', null, t('settings.info.key')),
      h('dd', null, campaign.private_key_jwk
        ? h('span', { class: 'settings-key' }, icon('lock'), h('span', null, t('settings.info.key_present')))
        : h('span', { class: 'settings-key' }, icon('alert'), h('span', null, t('settings.info.key_absent'))))),
    callout('info', h('p', null, t('settings.info.frozen'))));
}

export async function render(root, { campaign, model, ctx, refresh }) {
  await prepareAdmin(ctx);
  const { t, store } = ctx;
  const settings = campaign.settings ?? {};
  let disposed = false;
  const feedback = h('div', { class: 'admin-feedback' });
  const filesHost = h('div', { class: 'visually-hidden' });

  const fail = (err, zone = feedback) => {
    logFailure('Paramètres : opération impossible', err);
    if (!disposed) showFeedback(zone, 'danger', errorMessage(t, err));
  };
  const busy = (buttons, statusNode, text) => {
    buttons.forEach((b) => { b.disabled = Boolean(text); });
    mount(statusNode, text ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, text)] : null);
  };
  async function reread() {
    const fresh = await store.getCampaign(campaign.id);
    if (!fresh) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    return fresh;
  }

  // --- Réglages locaux ---------------------------------------------------------------------
  const kInput = h('input', {
    type: 'number', inputmode: 'numeric', min: String(MIN_GROUP_SIZE), max: String(MAX_GROUP_SIZE), step: '1',
    value: String(Number.isInteger(settings.min_group_size) ? settings.min_group_size : 5),
  });
  const kField = field({
    id: 'settings-k',
    label: t('settings.local.min_group_size'),
    help: campaign.mode === 'open' ? t('settings.local.min_group_size_help_open') : t('settings.local.min_group_size_help_anonymous'),
    control: kInput,
  });
  const comments = checkbox('settings-comments', t('settings.local.comments_exportable'), t('settings.local.comments_exportable_help'), settings.comments_exportable === true);
  const byDept = checkbox('settings-by-dept', t('settings.local.group_by_department'), t('settings.local.group_by_department_help'), settings.group_by_department === true);
  const closesInput = h('input', { type: 'date', value: typeof settings.closes_on === 'string' ? settings.closes_on : '' });
  const closesField = field({ id: 'settings-closes', label: t('settings.local.closes_on'), help: t('settings.local.closes_on_help'), control: closesInput });
  const saveBtn = button(t('settings.local.save'), null, { variant: 'primary', type: 'submit', icon: 'check' });
  const localStatus = h('p', { class: 'small muted', role: 'status' });
  const localZone = h('div');

  async function saveLocal() {
    const res = validateLocalSettings({
      min_group_size: kInput.value,
      comments_exportable: comments.input.checked,
      group_by_department: byDept.input.checked,
      closes_on: closesInput.value,
    });
    setFieldError(kField, res.errors.min_group_size ? t('settings.local.min_group_size_error', { min: MIN_GROUP_SIZE, max: MAX_GROUP_SIZE }) : null);
    setFieldError(closesField, res.errors.closes_on ? t('settings.local.closes_on_error') : null);
    if (!res.ok) {
      (res.errors.min_group_size ? kInput : closesInput).focus();
      announce(res.errors.min_group_size ? t('settings.local.min_group_size_error', { min: MIN_GROUP_SIZE, max: MAX_GROUP_SIZE }) : t('settings.local.closes_on_error'), { assertive: true });
      return;
    }
    saveBtn.disabled = true;
    try {
      const fresh = await reread();
      const { campaign: updated, changed } = mergeLocalSettings(fresh, res.value);
      if (!changed) {
        localStatus.textContent = t('settings.local.unchanged');
        return;
      }
      await store.putCampaign(updated);
      let reclassified = 0;
      if ((fresh.settings?.closes_on ?? null) !== (updated.settings.closes_on ?? null)) {
        const moved = recomputeAfterClose(await store.listEntries(campaign.id), updated.settings.closes_on);
        if (moved.length) await store.putEntries(moved);
        reclassified = moved.length;
      }
      const message = reclassified ? t('settings.local.saved_after_close', { count: reclassified }) : t('settings.local.saved');
      toast(message, 'success');
      announce(message);
      if (!disposed) await refresh();
    } catch (err) {
      fail(err, localZone);
    } finally {
      if (saveBtn.isConnected) saveBtn.disabled = false;
    }
  }

  const localSection = h('section', { class: 'card settings-section', 'aria-labelledby': 'settings-local-title' },
    h('h3', { id: 'settings-local-title' }, t('settings.local.title')),
    h('p', { class: 'muted' }, t('settings.local.lead')),
    h('form', {
      class: 'settings-form',
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        saveLocal();
      },
    },
    kField,
    h('div', { class: 'settings-choices' }, comments.node, byDept.node),
    closesField,
    localZone,
    h('div', { class: 'form-actions' }, saveBtn, localStatus)));

  // --- Fichier de récupération -------------------------------------------------------------
  let recoverySection;
  if (!campaign.private_key_jwk) {
    recoverySection = h('section', { class: 'card settings-section', 'aria-labelledby': 'settings-recovery-title' },
      h('h3', { id: 'settings-recovery-title' }, t('settings.recovery.title')),
      campaign.demo
        ? h('p', { class: 'muted' }, t('settings.recovery.demo'))
        : callout('warn', h('p', null, t('settings.recovery.no_key')),
          h('p', null, h('a', { class: 'btn btn-secondary btn-sm', href: '#/admin' }, icon('key'), h('span', null, t('settings.recovery.no_key_action'))))));
  } else {
    const pair = passwordPair(t, 'settings-recovery', {
      label: t('settings.recovery.password'),
      help: t('settings.recovery.password_help', { min: MIN_PASSWORD }),
      confirmLabel: t('settings.recovery.confirm'),
    });
    const status = h('p', { class: 'import-working', role: 'status' });
    const zone = h('div');
    const protectedBtn = button(t('settings.recovery.download'), () => downloadRecovery(true), { variant: 'primary', icon: 'download' });
    const openBtn = button(t('settings.recovery.download_unprotected'), () => downloadRecovery(false), { variant: 'ghost' });

    async function downloadRecovery(isProtected) {
      let password = null;
      if (isProtected) {
        password = pair.check();
        if (password === null) return;
      } else {
        const ok = await confirmDialog({
          title: t('settings.recovery.unprotected_title'),
          message: t('settings.recovery.unprotected_text'),
          confirmLabel: t('settings.recovery.unprotected_confirm'),
          danger: true,
        });
        if (!ok) return;
      }
      busy([protectedBtn, openBtn], status, t('settings.recovery.working'));
      try {
        const fresh = await reread();
        const file = await buildRecoveryFile(fresh, password, { today: localDay() });
        downloadText(file.text, file.filename, 'application/json');
        await markRecoverySaved(store, campaign.id);
        pair.reset();
        toast(t('settings.recovery.done'), 'success');
        announce(t('settings.recovery.done'));
        if (!disposed) await refresh();
      } catch (err) {
        fail(err, zone);
      } finally {
        if (!disposed) busy([protectedBtn, openBtn], status, null);
      }
    }

    recoverySection = h('section', { class: 'card settings-section', 'aria-labelledby': 'settings-recovery-title' },
      h('h3', { id: 'settings-recovery-title' }, t('settings.recovery.title')),
      h('p', { class: 'muted' }, t('settings.recovery.lead')),
      h('p', { class: ['storage-state', 'settings-status', campaign.recovery_saved_at ? 'is-ok' : 'is-warn'] },
        icon(campaign.recovery_saved_at ? 'check' : 'alert'),
        h('span', null, campaign.recovery_saved_at
          ? t('settings.recovery.saved', { date: formatDateTime(campaign.recovery_saved_at) })
          : t('settings.recovery.never'))),
      pair.node,
      zone,
      h('div', { class: 'import-actions' }, protectedBtn, openBtn, status));
  }

  // --- Sauvegarde et restauration ----------------------------------------------------------
  const backupDays = daysSince(campaign.last_backup_at);
  const encRadio = h('input', { type: 'radio', name: 'settings-backup-kind', id: 'settings-backup-enc', value: 'encrypted', checked: true, 'aria-describedby': 'settings-backup-enc-help' });
  const plainRadio = h('input', { type: 'radio', name: 'settings-backup-kind', id: 'settings-backup-plain', value: 'plain', 'aria-describedby': 'settings-backup-plain-help' });
  const radioChoice = (input, label, help, helpId) => h('li', null, h('label', { class: 'choice', for: input.id }, input,
    h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, label), h('span', { class: 'choice-help', id: helpId }, help))));
  const kindField = field({
    id: 'settings-backup-kind',
    label: t('settings.backup.kind'),
    group: true,
    control: h('ul', { class: 'choice-grid settings-kind', role: 'list' },
      radioChoice(encRadio, t('settings.backup.encrypted'), t('settings.backup.encrypted_help'), 'settings-backup-enc-help'),
      radioChoice(plainRadio, t('settings.backup.plain'), t('settings.backup.plain_help'), 'settings-backup-plain-help')),
  });
  const backupPair = passwordPair(t, 'settings-backup', {
    label: t('settings.backup.password'),
    help: t('settings.backup.password_help', { min: MIN_PASSWORD }),
    confirmLabel: t('settings.backup.confirm'),
  });
  const plainWarning = callout('warn', h('p', null, campaign.mode === 'open' ? t('settings.backup.plain_warning_open') : t('settings.backup.plain_warning_anonymous')));
  const syncKind = () => {
    const encrypted = encRadio.checked;
    backupPair.node.hidden = !encrypted;
    plainWarning.hidden = encrypted;
  };
  encRadio.addEventListener('change', syncKind);
  plainRadio.addEventListener('change', syncKind);
  syncKind();

  const backupStatus = h('p', { class: 'import-working', role: 'status' });
  const backupZone = h('div');
  const backupBtn = button(t('settings.backup.download'), () => downloadBackup(), { variant: 'primary', icon: 'download' });

  async function downloadBackup() {
    const encrypted = encRadio.checked;
    let password;
    if (encrypted) {
      password = backupPair.check();
      if (password === null) return;
    }
    busy([backupBtn], backupStatus, t('settings.backup.working'));
    try {
      const fresh = await reread();
      const blob = await exportJson(store, campaign.id, encrypted ? { password } : {});
      const filename = backupFilename(fresh, localDay());
      downloadBlob(blob, filename);
      backupPair.reset();
      toast(t('settings.backup.done', { filename }), 'success');
      announce(t('settings.backup.done', { filename }));
      if (!disposed) await refresh();
    } catch (err) {
      fail(err, backupZone);
    } finally {
      if (!disposed) busy([backupBtn], backupStatus, null);
    }
  }

  const restoreBtn = button(t('settings.backup.restore'), async () => {
    const [file] = await pickFiles(filesHost, { accept: '.json,application/json' });
    if (!file || disposed) return;
    restoreBtn.disabled = true;
    try {
      let res = await backupRestoreFlow(ctx, file);
      if (res?.redirect === 'recovery') res = await recoveryImportFlow(ctx, res.text);
      if (!res || disposed) return;
      const restoredId = res.campaign_id ?? res.campaign?.id;
      if (restoredId === campaign.id) {
        const message = res.status
          ? t(`admin.recovery.${res.status}`, { title: res.campaign.title })
          : t('admin.backup.restored', { count: res.entries, title: res.campaign?.title ?? campaign.title });
        toast(message, 'success');
        announce(message);
        await refresh();
        return;
      }
      const title = res.campaign?.title ?? restoredId;
      showFeedback(backupZone, 'success', t('settings.backup.restored_other', { title }),
        h('p', null, h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/${restoredId}` }, t('settings.backup.open_other', { title }), icon('arrow-right'))));
    } catch (err) {
      fail(err, backupZone);
    } finally {
      if (restoreBtn.isConnected) restoreBtn.disabled = false;
    }
  }, { icon: 'upload' });

  const backupSection = h('section', { class: 'card settings-section', 'aria-labelledby': 'settings-backup-title' },
    h('h3', { id: 'settings-backup-title' }, t('settings.backup.title')),
    h('p', { class: 'muted' }, t('settings.backup.lead')),
    h('p', { class: ['storage-state', 'settings-status', backupDays === null ? 'is-warn' : 'is-ok'] },
      icon(backupDays === null ? 'alert' : 'check'),
      h('span', null, backupDays === null
        ? t('settings.backup.never')
        : t('settings.backup.last', { count: backupDays, date: formatDate(campaign.last_backup_at) }))),
    kindField,
    backupPair.node,
    plainWarning,
    backupZone,
    h('div', { class: 'import-actions' }, backupBtn, backupStatus),
    h('div', { class: 'danger-item' },
      h('div', null,
        h('h4', null, t('settings.backup.restore_title')),
        h('p', { class: 'muted small' }, t('settings.backup.restore_text'))),
      restoreBtn));

  // --- Zone de danger ----------------------------------------------------------------------
  const entriesCount = model.entries.length;
  const deleteEntriesBtn = button(t('settings.danger.entries'), async () => {
    const ok = await confirmDialog({
      title: t('settings.danger.entries_confirm_title'),
      message: t('settings.danger.entries_confirm_text', { count: entriesCount, title: campaign.title }),
      confirmLabel: t('settings.danger.entries_confirm'),
      danger: true,
    });
    if (!ok || disposed) return;
    deleteEntriesBtn.disabled = true;
    try {
      const entries = await store.listEntries(campaign.id);
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        await store.deleteEntry(campaign.id, entry.entry_id);
      }
      const message = t('settings.danger.entries_done', { count: entries.length });
      toast(message, 'success');
      announce(message);
      if (!disposed) await refresh();
    } catch (err) {
      fail(err);
    } finally {
      if (deleteEntriesBtn.isConnected) deleteEntriesBtn.disabled = false;
    }
  }, { variant: 'danger', icon: 'trash', attrs: { disabled: entriesCount === 0 } });

  const deleteCampaignBtn = button(t('settings.danger.campaign'), async () => {
    const id = nextId('confirm-title');
    const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autofocus: true });
    const fieldNode = field({ id, label: t('settings.danger.campaign_confirm_label'), control: input });
    const expected = String(campaign.title ?? '').trim().normalize('NFC');
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      input.closest('dialog')?.querySelector('.modal-actions .btn-danger')?.click();
    });
    const ok = await modal({
      title: t('settings.danger.campaign_confirm_title'),
      content: h('div', { class: 'stack-sm' },
        h('p', null, t('settings.danger.campaign_text')),
        h('p', null, t('settings.danger.campaign_confirm_text', { title: campaign.title })),
        fieldNode),
      actions: [
        { label: t('common.actions.cancel'), value: false },
        {
          label: t('settings.danger.campaign_confirm'),
          variant: 'danger',
          value: () => {
            if (input.value.trim().normalize('NFC') !== expected) {
              setFieldError(fieldNode, t('settings.danger.campaign_confirm_error'));
              announce(t('settings.danger.campaign_confirm_error'), { assertive: true });
              input.focus();
              return undefined;
            }
            return true;
          },
        },
      ],
    });
    if (ok !== true || disposed) return;
    try {
      await store.deleteCampaign(campaign.id);
      toast(t('settings.danger.campaign_done', { title: campaign.title }), 'success');
      ctx.navigate('/admin');
    } catch (err) {
      fail(err);
    }
  }, { variant: 'danger', icon: 'trash' });

  const dangerSection = h('section', { class: 'card settings-section danger-zone', 'aria-labelledby': 'settings-danger-title' },
    h('h3', { id: 'settings-danger-title' }, t('settings.danger.title')),
    h('p', { class: 'muted' }, t('settings.danger.lead')),
    h('div', { class: 'danger-item' },
      h('div', null,
        h('h4', null, t('settings.danger.entries')),
        h('p', { class: 'muted small' }, t('settings.danger.entries_text', { count: entriesCount }))),
      deleteEntriesBtn),
    h('div', { class: 'danger-item' },
      h('div', null,
        h('h4', null, t('settings.danger.campaign')),
        h('p', { class: 'muted small' }, t('settings.danger.campaign_text'))),
      deleteCampaignBtn));

  mount(root, h('div', { class: 'settings-tab' },
    h('h2', { id: 'console-tab-title' }, t('settings.title')),
    feedback,
    infoSection(t, campaign, model.channels),
    localSection,
    recoverySection,
    backupSection,
    storageCard(ctx, { headingLevel: 3 }),
    dangerSection,
    filesHost));

  return () => { disposed = true; };
}
