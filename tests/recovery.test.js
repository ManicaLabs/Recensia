// Fichier de récupération et codes en attente (src/services/recovery.js) : création de la campagne,
// ajout de clé, refus d'écrasement, mauvais mot de passe, fichier de sauvegarde, codes de session,
// mise en page et dialogue de suppression de l'onglet Paramètres, typographie des catalogues de
// l'administration.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { b64urlEncode } from '../src/crypto/b64url.js';
import { generateCampaignKeys } from '../src/crypto/keys.js';
import { encryptEntry } from '../src/crypto/codes.js';
import { randomId } from '../src/crypto/random.js';
import { openStore } from '../src/storage/store.js';
import {
  PENDING_MAX, PLAIN_BACKUP_MARK, RECOVERY_MIME, RecoveryError, UNPROTECTED_RECOVERY_MARK, backupDownloadFilename,
  buildRecoveryFile, campaignFromRecovery, createPendingCodes, importRecovery, inspectRecoveryFile, markRecoverySaved,
  normalizeSettings, parseRecoveryFile, recoveryFilename,
} from '../src/services/recovery.js';
import { backupFilename } from '../src/export/json.js';
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
    // Nom canonique (création comme paramètres) : slug du titre, empreinte, date ; un seul type MIME.
    // Le fichier non protégé porte un marqueur : il ne remplace jamais le fichier protégé du même jour.
    assert.equal(protectedFile.filename, `recensia-cle-recensement-ia-2026-${source.fingerprint}-2026-09-29.recensia-key`);
    assert.equal(openFile.filename, `recensia-cle-recensement-ia-2026-${source.fingerprint}-2026-09-29-NON-PROTEGEE.recensia-key`);
    assert.notEqual(openFile.filename, protectedFile.filename);
    const P = { protected: true };
    assert.equal(recoveryFilename({ title: 'Été 2026 !', fingerprint: 'a1b2c3d4' }, '2026-01-02', P), 'recensia-cle-ete-2026-A1B2C3D4-2026-01-02.recensia-key');
    assert.equal(recoveryFilename({ title: 'Recensement IA : été 2026 !', fingerprint: '8A7C048A' }, '2026-09-30', P),
      'recensia-cle-recensement-ia-ete-2026-8A7C048A-2026-09-30.recensia-key');
    assert.equal(recoveryFilename({ title: 'Été 2026 !', fingerprint: 'pas une empreinte' }, '2026-01-02', P), 'recensia-cle-ete-2026-2026-01-02.recensia-key');
    assert.equal(recoveryFilename({ id: 'k3J9xQ2mP0aZ', fingerprint: 'A1B2C3D4' }, '2026-01-02', P), 'recensia-cle-k3j9xq2mp0az-A1B2C3D4-2026-01-02.recensia-key');
    assert.equal(RECOVERY_MIME, 'application/json');
    assert.equal(protectedFile.mime, RECOVERY_MIME);
    assert.equal(openFile.mime, RECOVERY_MIME);
    assert.ok(protectedFile.text.endsWith('}\n'));
    assert.equal(protectedFile.protected, true);
    assert.equal(openFile.protected, false);
    const info = inspectRecoveryFile(protectedFile.text);
    assert.equal(info.protected, true);
    assert.equal(info.campaign.id, source.id);
    assert.equal(info.campaign.title, 'Recensement IA 2026');
    assert.equal(info.campaign.fingerprint, source.fingerprint);
    assert.ok(!protectedFile.text.includes(source.private_key_jwk.d), 'clé privée absente du fichier protégé en clair');
  });

  test('nom de fichier : seul un fichier explicitement protégé ou chiffré porte le nom sans marqueur', () => {
    const c = { title: 'Campagne X', fingerprint: '8cc20f70' };
    const day = '2026-09-30';
    // Récupération : marqueur NON-PROTEGEE par défaut, pour toute valeur autre que true.
    assert.equal(UNPROTECTED_RECOVERY_MARK, 'NON-PROTEGEE');
    for (const options of [undefined, {}, { protected: false }, { protected: 'oui' }, { protected: 1 }]) {
      assert.equal(recoveryFilename(c, day, options), 'recensia-cle-campagne-x-8CC20F70-2026-09-30-NON-PROTEGEE.recensia-key', JSON.stringify(options));
    }
    assert.equal(recoveryFilename(c, day, { protected: true }), 'recensia-cle-campagne-x-8CC20F70-2026-09-30.recensia-key');
    // Sauvegarde : nom de src/export/json.js pour la version chiffrée, marqueur EN-CLAIR sinon.
    assert.equal(PLAIN_BACKUP_MARK, 'EN-CLAIR');
    assert.equal(backupDownloadFilename(c, day, { encrypted: true }), backupFilename(c, day));
    assert.equal(backupDownloadFilename(c, day, { encrypted: true }), 'recensia-sauvegarde-campagne-x-2026-09-30.json');
    for (const options of [undefined, {}, { encrypted: false }, { encrypted: 'oui' }]) {
      assert.equal(backupDownloadFilename(c, day, options), 'recensia-sauvegarde-campagne-x-2026-09-30-EN-CLAIR.json', JSON.stringify(options));
    }
    // Les deux restent reconnus comme fichiers sensibles par tools/check.mjs (extension et préfixe inchangés).
    assert.match(backupDownloadFilename(c, day), /^recensia-sauvegarde-[^/]*\.json$/);
    assert.match(recoveryFilename(c, day), /\.recensia-key$/);
  });

  test('Paramètres : le nom et le message de fin rappellent le mode de protection', () => {
    const src = readFileSync(new URL('../src/views/console/settings.js', import.meta.url), 'utf8');
    assert.match(src, /backupDownloadFilename\(fresh, localDay\(\), \{ encrypted \}\)/, 'nom de sauvegarde marqué selon le chiffrement');
    assert.doesNotMatch(src, /\bbackupFilename\(/, 'nom de sauvegarde sans marqueur');
    const { recovery: cat, backup } = JSON.parse(readFileSync(new URL('../src/i18n/fr/settings.json', import.meta.url), 'utf8'));
    for (const text of [cat.done, cat.done_unprotected, backup.done, backup.done_plain]) assert.ok(text.includes('{filename}'), text);
    assert.match(cat.done, /protégé/);
    assert.match(cat.done_unprotected, /non protégé/);
    assert.match(backup.done, /chiffrée/);
    assert.match(backup.done_plain, /non chiffrée/);
    // Les catalogues annoncent le marqueur réellement produit (trait d'union insécable U+2011 : jamais coupé).
    const quoted = (mark) => `«\u00a0${mark.replaceAll('-', '\u2011')}\u00a0»`;
    assert.ok(cat.unprotected_text.includes(quoted(UNPROTECTED_RECOVERY_MARK)), cat.unprotected_text);
    assert.ok(backup.plain_help.includes(quoted(PLAIN_BACKUP_MARK)), backup.plain_help);
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
  // Codes de forme valide (octet de version 1, taille minimale atteinte), sans chiffrement réel.
  const c = (i) => {
    const bytes = new Uint8Array(120);
    bytes[0] = 1;
    new DataView(bytes.buffer).setUint32(1, i);
    return `RCN1.${b64urlEncode(bytes)}`;
  };

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
    assert.deepEqual(pending.list(), [c(1)], 'valeur non textuelle, texte quelconque et code mal formé ignorés');
    area.set('pending_codes', 'pas un tableau');
    assert.deepEqual(pending.list(), []);
    const many = Array.from({ length: PENDING_MAX + 10 }, (_, i) => c(i));
    assert.equal(pending.add(many), PENDING_MAX);
    assert.equal(pending.list().length, PENDING_MAX);
    assert.equal(pending.add([c(99999)]), 0);
  });

  test('un code mal formé (lien coupé) n\'est pas mis en attente ; une version future l\'est', () => {
    const area = memoryArea();
    const pending = createPendingCodes(area);
    const future = `RCN2.${'Q'.repeat(200)}`;
    const truncated = c(5).slice(0, 40);
    assert.equal(pending.add(['RCN1.abc', 'RCN1.abcdefghijklmnop', truncated]), 0);
    assert.deepEqual(pending.list(), []);
    assert.equal(area.raw.size, 0, 'rien n\'est écrit dans la session');
    assert.equal(pending.add(`https://manicalabs.github.io/Recensia/#/i/RCN1.abc~${c(6)}~${future}`), 2);
    assert.deepEqual(pending.list(), [c(6), future]);
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

describe('administration : mise en page et dialogue de suppression', () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  test('rapport d\'import : grille d\'indicateurs en auto-fit (aucune piste vide à 1280 px)', () => {
    const css = read('src/styles/admin.css');
    const rule = css.match(/(?:^|\n)\.import-report \.kpi-grid\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /grid-template-columns:\s*repeat\(auto-fit,/);
    assert.doesNotMatch(rule, /auto-fill/);
  });

  // Dialogue « Supprimer la campagne » : il contient un champ de saisie, donc seuls les paragraphes
  // d'avertissement sont reliés au dialogue (aria-describedby) ; alertdialog, car l'action est irréversible.
  test('suppression de campagne : modal({ describe: <avertissements>, alert: true })', () => {
    const src = read('src/views/console/settings.js');
    const at = src.indexOf("t('settings.danger.campaign_confirm_title')");
    assert.ok(at > 0, 'dialogue trouvé');
    const start = src.lastIndexOf('modal({', at);
    const end = src.indexOf('actions:', at);
    assert.ok(start > 0 && end > at, 'appel modal() complet');
    const call = src.slice(start, end);
    const described = call.match(/\bdescribe:\s*([A-Za-z_$][\w$]*)\s*,/)?.[1];
    assert.ok(described && described !== 'true', 'describe reçoit un nœud, pas true (le champ n\'est pas lu)');
    assert.match(call, /\balert:\s*true\b/, 'alert: true');
    const node = src.slice(src.lastIndexOf(`const ${described} = h(`, start), start);
    assert.match(node, /t\('settings\.danger\.campaign_text'\)/, 'avertissement : conséquence de la suppression');
    assert.match(node, /t\('settings\.danger\.campaign_confirm_text'/, 'avertissement : consigne de saisie');
    assert.doesNotMatch(node, /\binput\b|fieldNode/, 'le champ de saisie reste hors de la description');
  });

  // Les consignes de dépôt sont saisies (ou viennent de data/) avec des espaces ordinaires : comme le
  // formulaire répondant, l'onglet Paramètres les affiche avec la typographie française.
  test('informations : canaux de retour affichés avec frenchSpacing (libellé et consigne)', () => {
    const src = read('src/views/console/settings.js');
    assert.match(src, /import \{ frenchSpacing as fr \} from '\.\.\/\.\.\/ui\/questionnaire\.js';/);
    assert.match(src, /fr\(channelsData\?\.types\?\.\[c\.type\]\?\.label \?\? c\.type\)/);
    assert.match(src, /\$\{fr\(c\.target\)\}/);
  });
});

describe('catalogues de l\'administration (admin, import, import_link, settings) : typographie', () => {
  const readCatalog = (ns) => JSON.parse(readFileSync(new URL(`../src/i18n/fr/${ns}.json`, import.meta.url), 'utf8'));
  // Espace insécable U+00A0 avant « : ; ? ! » et à l'intérieur des guillemets. Exceptions : « :// » des
  // adresses et les heures (« 08:00 »).
  const issues = (text) => {
    const found = [];
    for (const m of text.matchAll(/(.)([:;?!])/gsu)) {
      if (m[1] === ' ') continue;
      if (m[2] === ':' && (text.startsWith('//', m.index + 2) || (/\d/.test(m[1]) && /\d/.test(text[m.index + 2] ?? '')))) continue;
      found.push(`${JSON.stringify(m[1])} avant « ${m[2]} »`);
    }
    for (const m of text.matchAll(/«(.)/gsu)) if (m[1] !== ' ') found.push('« sans espace insécable');
    for (const m of text.matchAll(/(.)»/gsu)) if (m[1] !== ' ') found.push('» sans espace insécable');
    if (/^[:;?!»]/u.test(text)) found.push('ponctuation en tête');
    return found;
  };

  test('le contrôle repère l\'espace ordinaire, l\'espace manquante et les guillemets', () => {
    assert.deepEqual(issues('Titre : « x » ; ok ? oui ! https://a.fr 08:00'), ['" " avant « ; »']);
    assert.equal(issues('Supprimer?').length, 1);
    assert.equal(issues('« x »').length, 2);
  });

  test('espaces insécables avant « : ; ? ! » et dans les guillemets', () => {
    const problems = [];
    const walk = (value, path) => {
      if (typeof value === 'string') {
        for (const issue of issues(value)) problems.push(`${path} : ${issue} — ${value.slice(0, 60)}`);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    for (const ns of ['admin', 'import', 'import_link', 'settings']) walk(readCatalog(ns), ns);
    assert.deepEqual(problems, []);
  });
});
