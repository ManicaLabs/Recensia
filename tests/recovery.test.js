// Fichier de récupération et codes en attente (src/services/recovery.js) : création de la campagne,
// ajout de clé, refus d'écrasement, mauvais mot de passe, fichier de sauvegarde, codes de session.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import { generateCampaignKeys } from '../src/crypto/keys.js';
import { encryptEntry } from '../src/crypto/codes.js';
import { randomId } from '../src/crypto/random.js';
import { openStore } from '../src/storage/store.js';
import {
  PENDING_MAX, RecoveryError, buildRecoveryFile, campaignFromRecovery, createPendingCodes, importRecovery,
  inspectRecoveryFile, markRecoverySaved, normalizeSettings, parseRecoveryFile, recoveryFilename,
} from '../src/services/recovery.js';
import { importCodes } from '../src/services/import.js';
import { loadQuestionnaire, makeUsage } from './helpers/load-data.js';

const questionnaire = loadQuestionnaire();
const PASS = 'correct horse battery';
const NOW = new Date('2026-09-29T10:00:00.000Z');

async function makeCampaign(overrides = {}) {
  const keys = await generateCampaignKeys();
  return {
    id: randomId(9),
    title: 'Recensement IA 2026',
    org_name: 'Menuiserie Alpine Concept',
    mode: 'anonymous',
    departments: ['Direction', 'RH'],
    settings: {
      min_group_size: 5, department_required: false, comments_exportable: false,
      closes_on: '2026-10-31', group_by_department: false, channels: [{ type: 'mailto', target: 'ia@exemple.fr' }],
    },
    public_key: keys.publicKeyB64,
    private_key_jwk: keys.privateKeyJwk,
    fingerprint: keys.fingerprint,
    created_at: '2026-09-01T08:00:00.000Z',
    demo: false,
    last_backup_at: null,
    recovery_saved_at: null,
    ...overrides,
  };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
  assert.ok(err instanceof RecoveryError, `RecoveryError attendue, reçu ${err?.name}`);
  assert.equal(err.code, code);
  return true;
});

describe('fichier de récupération', () => {
  let source;
  let protectedFile;
  let openFile;
  before(async () => {
    source = await makeCampaign();
    protectedFile = await buildRecoveryFile(source, PASS, { today: '2026-09-29' });
    openFile = await buildRecoveryFile(source, null, { today: '2026-09-29' });
  });

  test('nom de fichier et informations lisibles avant le mot de passe', () => {
    assert.equal(protectedFile.filename, 'recensia-cle-recensement-ia-2026-2026-09-29.recensia-key');
    assert.equal(recoveryFilename({ title: 'Été 2026 !' }, '2026-01-02'), 'recensia-cle-ete-2026-2026-01-02.recensia-key');
    assert.equal(protectedFile.protected, true);
    assert.equal(openFile.protected, false);
    const info = inspectRecoveryFile(protectedFile.text);
    assert.equal(info.protected, true);
    assert.equal(info.campaign.id, source.id);
    assert.equal(info.campaign.title, 'Recensement IA 2026');
    assert.equal(info.campaign.fingerprint, source.fingerprint);
    assert.ok(!protectedFile.text.includes(source.private_key_jwk.d), 'clé privée absente du fichier protégé en clair');
  });

  test('création de la campagne absente (fichier protégé) : clé, réglages, recovery_saved_at', async () => {
    const store = await openStore({ forceMemory: true });
    const res = await importRecovery({ store, file: protectedFile.text, passphrase: PASS, now: NOW });
    assert.equal(res.status, 'created');
    const stored = await store.getCampaign(source.id);
    assert.deepEqual(stored.private_key_jwk, source.private_key_jwk);
    assert.equal(stored.public_key, source.public_key);
    assert.equal(stored.fingerprint, source.fingerprint);
    assert.equal(stored.recovery_saved_at, NOW.toISOString());
    assert.equal(stored.created_at, source.created_at);
    assert.equal(stored.last_backup_at, null);
    assert.equal(stored.demo, false);
    assert.deepEqual(stored.settings, source.settings);
    // La clé restaurée déchiffre bien les codes de la campagne.
    const c = await encryptEntry({ entry_id: randomId(12), rev: 1, submitted_day: '2026-09-20', usage: makeUsage() }, source.public_key, source.id);
    const report = await importCodes({ codes: [c], campaign: stored, store, questionnaire });
    assert.equal(report.accepted.length, 1);
  });

  test('création depuis un fichier non protégé (mot de passe ignoré)', async () => {
    const store = await openStore({ forceMemory: true });
    const res = await importRecovery({ store, file: JSON.parse(openFile.text), now: NOW });
    assert.equal(res.status, 'created');
    assert.ok((await store.getCampaign(source.id)).private_key_jwk);
  });

  test('ajout de la clé à une campagne existante (même id, même clé publique) sans rien perdre', async () => {
    const store = await openStore({ forceMemory: true });
    const withoutKey = { ...source, private_key_jwk: null, last_backup_at: '2026-09-20T10:00:00.000Z', title: 'Titre local' };
    await store.putCampaign(withoutKey);
    await store.putEntry({
      campaign_id: source.id, entry_id: 'entryAAAAAAAAAAA', rev: 1, submitted_day: '2026-09-15', submitted_at: null,
      respondent: null, usage: makeUsage(), schema_version: 1, code_hash: null, source: 'manual',
      imported_at: '2026-09-15T10:00:00.000Z', after_close: false, excluded: false, group_override: null,
    });
    const res = await importRecovery({ store, file: protectedFile.text, passphrase: PASS, now: NOW });
    assert.equal(res.status, 'key_added');
    const stored = await store.getCampaign(source.id);
    assert.deepEqual(stored.private_key_jwk, source.private_key_jwk);
    assert.equal(stored.last_backup_at, '2026-09-20T10:00:00.000Z');
    assert.equal(stored.title, 'Titre local', 'les données locales ne sont pas écrasées par le fichier');
    assert.equal(stored.recovery_saved_at, NOW.toISOString());
    assert.equal((await store.listEntries(source.id)).length, 1);
    const again = await importRecovery({ store, file: protectedFile.text, passphrase: PASS });
    assert.equal(again.status, 'already_present');
  });

  test('refus d\'écrasement : même identifiant, autre clé publique ⇒ conflict, rien ne change', async () => {
    const store = await openStore({ forceMemory: true });
    const impostor = await makeCampaign({ id: source.id, title: 'Campagne locale' });
    await store.putCampaign(impostor);
    await rejectsWith(importRecovery({ store, file: protectedFile.text, passphrase: PASS }), 'conflict');
    const stored = await store.getCampaign(source.id);
    assert.equal(stored.public_key, impostor.public_key);
    assert.deepEqual(stored.private_key_jwk, impostor.private_key_jwk);
    assert.equal(stored.title, 'Campagne locale');
  });

  test('mot de passe absent ou incorrect', async () => {
    const store = await openStore({ forceMemory: true });
    await rejectsWith(importRecovery({ store, file: protectedFile.text }), 'password_required');
    await rejectsWith(importRecovery({ store, file: protectedFile.text, passphrase: 'mauvais mot de passe' }), 'wrong_password');
    assert.equal(await store.getCampaign(source.id), null);
  });

  test('fichiers refusés : sauvegarde, JSON quelconque, texte illisible, version future, copie en clair modifiée', async () => {
    const store = await openStore({ forceMemory: true });
    assert.throws(() => parseRecoveryFile(JSON.stringify({ format: 'recensia-backup', v: 1 })), (e) => e.code === 'backup_file');
    assert.throws(() => parseRecoveryFile('{"format":"recensia-encrypted","v":1}'), (e) => e.code === 'backup_file');
    assert.throws(() => parseRecoveryFile('{"hello":1}'), (e) => e.code === 'format');
    assert.throws(() => parseRecoveryFile('pas du JSON'), (e) => e.code === 'format');
    assert.throws(() => parseRecoveryFile({ ...JSON.parse(openFile.text), v: 2 }), (e) => e.code === 'version');
    const tampered = JSON.parse(protectedFile.text);
    tampered.campaign.fingerprint = '00000000';
    await rejectsWith(importRecovery({ store, file: tampered, passphrase: PASS }), 'mismatch');
  });

  test('markRecoverySaved relit la campagne et conserve les autres champs', async () => {
    const store = await openStore({ forceMemory: true });
    await store.putCampaign({ ...source, last_backup_at: '2026-09-21T08:00:00.000Z' });
    await markRecoverySaved(store, source.id, { now: NOW });
    const stored = await store.getCampaign(source.id);
    assert.equal(stored.recovery_saved_at, NOW.toISOString());
    assert.equal(stored.last_backup_at, '2026-09-21T08:00:00.000Z');
    assert.deepEqual(stored.private_key_jwk, source.private_key_jwk);
    await rejectsWith(buildRecoveryFile({ ...source, private_key_jwk: null }, PASS), 'no_key');
  });

  test('réglages normalisés et campagne reconstruite (pure)', () => {
    assert.deepEqual(normalizeSettings({ min_group_size: 0, closes_on: '31/10/2026', channels: 'x', extra: 1 }), {
      min_group_size: 5, department_required: false, comments_exportable: false, closes_on: null, group_by_department: false, channels: [],
    });
    const c = campaignFromRecovery({
      campaign: { id: 'abcdefghijkl', title: 'T\u0007itre', org_name: 'Org', mode: 'open', departments: ['RH', ''], settings: {}, public_key: 'pk', fingerprint: 'A1B2C3D4', created_at: null },
      private_key_jwk: { kty: 'EC' },
    }, { now: NOW });
    assert.equal(c.title, 'Titre');
    assert.deepEqual(c.departments, ['RH']);
    assert.equal(c.created_at, NOW.toISOString());
    assert.equal(c.recovery_saved_at, NOW.toISOString());
  });
});

describe('codes en attente (session)', () => {
  function memoryArea() {
    const map = new Map();
    return {
      get: (k, fallback = null) => (map.has(k) ? JSON.parse(map.get(k)) : fallback),
      set: (k, v) => { map.set(k, JSON.stringify(v)); return true; },
      remove: (k) => { map.delete(k); },
      raw: map,
    };
  }
  const c = (i) => `RCN1.${String(i).padStart(60, 'k')}`;

  test('add / list / remove / clear, dédoublonnage et liens d\'import', () => {
    const area = memoryArea();
    const pending = createPendingCodes(area);
    assert.deepEqual(pending.list(), []);
    assert.equal(pending.add([c(1), c(2)]), 2);
    assert.equal(pending.add(`https://manicalabs.github.io/Recensia/#/i/${c(2)}~${c(3)}`), 1);
    assert.deepEqual(pending.list(), [c(1), c(2), c(3)]);
    assert.equal(pending.remove([c(2)]), 2);
    assert.deepEqual(pending.list(), [c(1), c(3)]);
    pending.clear();
    assert.deepEqual(pending.list(), []);
    assert.equal(area.raw.size, 0);
  });

  test('valeurs altérées ignorées, plafond respecté', () => {
    const area = memoryArea();
    area.set('pending_codes', ['<script>', 42, c(1), 'RCN1.ok-code_123']);
    const pending = createPendingCodes(area);
    assert.deepEqual(pending.list(), [c(1), 'RCN1.ok-code_123']);
    area.set('pending_codes', 'pas un tableau');
    assert.deepEqual(pending.list(), []);
    const many = Array.from({ length: PENDING_MAX + 10 }, (_, i) => c(i));
    assert.equal(pending.add(many), PENDING_MAX);
    assert.equal(pending.list().length, PENDING_MAX);
    assert.equal(pending.add([c(99999)]), 0);
  });

  test('instance par défaut : fonctionne sans navigateur (repli mémoire de safe-storage)', async () => {
    const mod = await import('../src/services/recovery.js');
    mod.clearPendingCodes();
    assert.equal(mod.addPendingCodes([c(7)]), 1);
    assert.deepEqual(mod.listPendingCodes(), [c(7)]);
    assert.equal(mod.removePendingCodes([c(7)]), 0);
    mod.clearPendingCodes();
  });
});

describe('onglet Paramètres : fonctions pures', () => {
  let mod;
  before(async () => { mod = await import('../src/views/console/settings.js'); });

  test('parseDay : AAAA-MM-JJ, JJ/MM/AAAA (sans sélecteur de date), vide, invalide', () => {
    assert.equal(mod.parseDay('2026-10-31'), '2026-10-31');
    assert.equal(mod.parseDay('1/2/2027'), '2027-02-01');
    assert.equal(mod.parseDay('  '), null);
    assert.equal(mod.parseDay('2026-02-30'), undefined);
    assert.equal(mod.parseDay('31-10-2026'), undefined);
  });

  test('validateLocalSettings : seuil borné, booléens stricts, date facultative', () => {
    const ok = mod.validateLocalSettings({ min_group_size: ' 7 ', comments_exportable: true, group_by_department: 'oui', closes_on: '' });
    assert.deepEqual(ok, { ok: true, errors: {}, value: { min_group_size: 7, comments_exportable: true, group_by_department: false, closes_on: null } });
    for (const k of ['1', '51', '5.5', 'abc', '']) {
      assert.equal(mod.validateLocalSettings({ min_group_size: k }).errors.min_group_size, 'range', k);
    }
    assert.equal(mod.validateLocalSettings({ min_group_size: '5', closes_on: '2026-13-01' }).errors.closes_on, 'format');
  });

  test('mergeLocalSettings conserve les autres réglages et signale les changements', () => {
    const c = { id: 'x', settings: { min_group_size: 5, channels: [{ type: 'copy' }], department_required: true, closes_on: null } };
    const same = mod.mergeLocalSettings(c, { min_group_size: 5, closes_on: null });
    assert.equal(same.changed, false);
    const next = mod.mergeLocalSettings(c, { min_group_size: 6, closes_on: '2026-11-30' });
    assert.equal(next.changed, true);
    assert.deepEqual(next.campaign.settings.channels, [{ type: 'copy' }]);
    assert.equal(next.campaign.settings.department_required, true);
    assert.equal(c.settings.min_group_size, 5, 'objet d\'origine intact');
  });

  test('checkNewPassword : longueur minimale (caractères) et confirmation', () => {
    assert.equal(mod.checkNewPassword('court', 'court'), 'too_short');
    assert.equal(mod.checkNewPassword('mot de passe long', 'mot de passe lon'), 'mismatch');
    assert.equal(mod.checkNewPassword('mot de passe long', 'mot de passe long'), null);
    assert.equal(mod.checkNewPassword('ééééééééé', 'ééééééééé', 9), null);
  });
});
