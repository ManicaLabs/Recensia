// Tests du chiffrement par mot de passe : fichier de récupération et sauvegarde complète (CDC §7.6, D8).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateCampaignKeys } from '../src/crypto/keys.js';
import { decryptEntry, encryptEntry } from '../src/crypto/codes.js';
import {
  BackupError, PBKDF2_MIN_ITERATIONS, decryptWithPassword, encryptWithPassword, exportEncrypted, importEncrypted,
  isEncryptedEnvelope, isRecoveryFile, unwrapPrivateKey, wrapPrivateKey,
} from '../src/crypto/backup.js';

const PASSWORD = 'cheval-agrafe-batterie-correct';
const ch = (code) => String.fromCharCode(code);

async function makeCampaign(overrides = {}) {
  const keys = await generateCampaignKeys();
  return {
    id: 'k3J9xQ2mP0aZ', title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept', mode: 'anonymous',
    departments: ['Direction', 'Commercial et devis', 'Production'],
    settings: { min_group_size: 5, department_required: false, comments_exportable: false, closes_on: '2026-10-31',
      group_by_department: false, channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] },
    public_key: keys.publicKeyB64, private_key_jwk: keys.privateKeyJwk, fingerprint: keys.fingerprint,
    created_at: '2026-09-29T09:00:00.000Z', demo: false, last_backup_at: null, recovery_saved_at: null,
    ...overrides,
  };
}

async function rejectsWith(promise, reason) {
  let caught;
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof BackupError, `BackupError attendue, reçu ${err?.name} : ${err?.message}`);
    assert.equal(err.reason, reason, err.message);
    caught = err;
    return true;
  });
  return caught;
}

const b64len = (s) => Buffer.from(s, 'base64url').length;

describe('enveloppe chiffrée par mot de passe', () => {
  test('format, paramètres et aller-retour', async () => {
    const data = { a: 'Élodie 🙂', n: [1, 2, 3] };
    const env = await encryptWithPassword(data, PASSWORD);
    assert.deepEqual(Object.keys(env), ['format', 'v', 'kdf', 'cipher', 'ciphertext']);
    assert.equal(env.format, 'recensia-encrypted');
    assert.equal(env.v, 1);
    assert.deepEqual(Object.keys(env.kdf), ['name', 'hash', 'iterations', 'salt']);
    assert.equal(env.kdf.name, 'PBKDF2');
    assert.equal(env.kdf.hash, 'SHA-256');
    assert.ok(env.kdf.iterations >= 600000);
    assert.equal(b64len(env.kdf.salt), 16);
    assert.deepEqual(env.cipher, { name: 'AES-GCM', iv: env.cipher.iv });
    assert.equal(b64len(env.cipher.iv), 12);
    for (const s of [env.kdf.salt, env.cipher.iv, env.ciphertext]) assert.match(s, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(await decryptWithPassword(env, PASSWORD), data);
    assert.deepEqual(await decryptWithPassword(JSON.stringify(env), PASSWORD), data);
    assert.ok(isEncryptedEnvelope(env));
    assert.ok(!isEncryptedEnvelope({ format: 'recensia-backup' }));
  });

  test('sel et IV neufs à chaque chiffrement', async () => {
    const a = await encryptWithPassword({ x: 1 }, PASSWORD);
    const b = await encryptWithPassword({ x: 1 }, PASSWORD);
    assert.notEqual(a.kdf.salt, b.kdf.salt);
    assert.notEqual(a.cipher.iv, b.cipher.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test('moins de 600 000 itérations refusé à la création comme à la lecture', async () => {
    assert.equal(PBKDF2_MIN_ITERATIONS, 600000);
    await assert.rejects(encryptWithPassword({ x: 1 }, PASSWORD, { iterations: 599999 }), RangeError);
    await assert.rejects(encryptWithPassword({ x: 1 }, PASSWORD, { iterations: 1000 }), RangeError);
    const env = await encryptWithPassword({ x: 1 }, PASSWORD);
    await rejectsWith(decryptWithPassword({ ...env, kdf: { ...env.kdf, iterations: 1000 } }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, kdf: { ...env.kdf, iterations: 2 ** 31 } }, PASSWORD), 'format');
  });

  test('mauvais mot de passe, mot de passe vide, contenu altéré : erreur explicite', async () => {
    const env = await encryptWithPassword({ secret_de_test: 1 }, PASSWORD);
    const err = await rejectsWith(decryptWithPassword(env, 'mauvais mot de passe'), 'password');
    assert.match(err.message, /Mot de passe incorrect/);
    await rejectsWith(decryptWithPassword(env, ''), 'password');
    await rejectsWith(decryptWithPassword(env, null), 'password');
    const bytes = Buffer.from(env.ciphertext, 'base64url');
    bytes[3] ^= 1;
    await rejectsWith(decryptWithPassword({ ...env, ciphertext: bytes.toString('base64url') }, PASSWORD), 'password');
    await assert.rejects(encryptWithPassword({ x: 1 }, ''), TypeError);
  });

  test('enveloppe mal formée : format ou version', async () => {
    const env = await encryptWithPassword({ x: 1 }, PASSWORD);
    await rejectsWith(decryptWithPassword('pas du JSON', PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, format: 'autre' }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, v: 2 }, PASSWORD), 'version');
    await rejectsWith(decryptWithPassword({ ...env, kdf: { ...env.kdf, hash: 'SHA-1' } }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, kdf: { ...env.kdf, extra: 1 } }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, cipher: { name: 'AES-CBC', iv: env.cipher.iv } }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, kdf: { ...env.kdf, salt: 'AAAA' } }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, cipher: { ...env.cipher, iv: `${env.cipher.iv}+` } }, PASSWORD), 'format');
    await rejectsWith(decryptWithPassword({ ...env, ciphertext: 'AAAA' }, PASSWORD), 'format');
  });

  test('mot de passe normalisé en NFC', async () => {
    const composed = `mot de passe d${ch(0xe9)}j${ch(0xe0)} vu`;
    const decomposed = `mot de passe de${ch(0x301)}ja${ch(0x300)} vu`;
    const env = await encryptWithPassword({ ok: true }, composed);
    assert.deepEqual(await decryptWithPassword(env, decomposed), { ok: true });
  });

  test('exportEncrypted / importEncrypted : sauvegarde complète', async () => {
    const campaign = await makeCampaign();
    const backup = {
      format: 'recensia-backup', v: 1, exported_at: '2026-09-29T10:00:00.000Z', app_version: '0.1.0', campaign,
      entries: [{ campaign_id: campaign.id, entry_id: 'aZ09_-bY18xW27vU', rev: 1, submitted_day: '2026-09-29', usage: { usage_name: 'Test' } }],
      assessments: [], actions: [],
    };
    const file = await exportEncrypted(backup, PASSWORD);
    assert.equal(file.format, 'recensia-encrypted');
    assert.ok(!JSON.stringify(file).includes(campaign.private_key_jwk.d));
    assert.deepEqual(await importEncrypted(JSON.stringify(file), PASSWORD), backup);
    await rejectsWith(importEncrypted(file, 'mauvais'), 'password');
  });
});

describe('fichier de récupération de la clé', () => {
  test('avec mot de passe : format, aucune clé en clair, aller-retour fonctionnel', async () => {
    const campaign = await makeCampaign();
    const file = await wrapPrivateKey(campaign, PASSWORD);
    assert.deepEqual(Object.keys(file), ['format', 'v', 'created_at', 'campaign', 'protected', 'key']);
    assert.equal(file.format, 'recensia-key');
    assert.equal(file.v, 1);
    assert.ok(!Number.isNaN(Date.parse(file.created_at)));
    assert.deepEqual(Object.keys(file.campaign), ['id', 'title', 'org_name', 'mode', 'departments', 'settings', 'public_key', 'fingerprint', 'created_at']);
    assert.equal(file.protected, true);
    assert.equal(file.key.format, 'recensia-encrypted');
    assert.ok(isRecoveryFile(file));
    const text = JSON.stringify(file);
    assert.ok(!text.includes(campaign.private_key_jwk.d), 'd en clair dans un fichier protégé');
    assert.ok(!text.includes('private_key_jwk'));

    const out = await unwrapPrivateKey(text, PASSWORD);
    assert.deepEqual(out.private_key_jwk, campaign.private_key_jwk);
    assert.equal(out.campaign.id, campaign.id);
    assert.equal(out.campaign.public_key, campaign.public_key);
    assert.equal(out.campaign.fingerprint, campaign.fingerprint);
    assert.deepEqual(out.campaign.settings, campaign.settings);
    assert.deepEqual(out.campaign.departments, campaign.departments);

    // La clé restaurée déchiffre bien les codes de la campagne.
    const code = await encryptEntry({ entry_id: 'aZ09_-bY18xW27vU', rev: 1, submitted_day: '2026-09-29', usage: { usage_name: 'Test' } }, campaign.public_key, campaign.id);
    assert.equal((await decryptEntry(code, out.private_key_jwk, campaign.id)).entry_id, 'aZ09_-bY18xW27vU');
  });

  test('sans mot de passe : JWK en clair, protected = false', async () => {
    const campaign = await makeCampaign();
    const file = await wrapPrivateKey(campaign, null);
    assert.equal(file.protected, false);
    assert.deepEqual(file.key, campaign.private_key_jwk);
    const out = await unwrapPrivateKey(JSON.parse(JSON.stringify(file)), null);
    assert.deepEqual(out.private_key_jwk, campaign.private_key_jwk);
    assert.deepEqual((await unwrapPrivateKey(file, 'ignoré')).private_key_jwk, campaign.private_key_jwk);
  });

  test('mauvais mot de passe ou mot de passe absent : refusé explicitement', async () => {
    const campaign = await makeCampaign();
    const file = await wrapPrivateKey(campaign, PASSWORD);
    const err = await rejectsWith(unwrapPrivateKey(file, 'pas le bon'), 'password');
    assert.match(err.message, /Mot de passe incorrect/);
    const missing = await rejectsWith(unwrapPrivateKey(file, null), 'password');
    assert.match(missing.message, /mot de passe requis/);
    await rejectsWith(unwrapPrivateKey(file, ''), 'password');
  });

  test('clé ne correspondant pas à la clé publique : refusée', async () => {
    const a = await makeCampaign();
    const b = await makeCampaign();
    const messages = [];

    // Fichier non protégé dont la clé a été remplacée par celle d'une autre campagne.
    const plainFile = await wrapPrivateKey(a, null);
    messages.push((await rejectsWith(unwrapPrivateKey({ ...plainFile, key: b.private_key_jwk }, null), 'mismatch')).message);

    // Fichier protégé dont la clé publique et l'empreinte ont été remplacées.
    const protectedFile = await wrapPrivateKey(a, PASSWORD);
    const swapped = { ...protectedFile, campaign: { ...protectedFile.campaign, public_key: b.public_key, fingerprint: b.fingerprint } };
    messages.push((await rejectsWith(unwrapPrivateKey(swapped, PASSWORD), 'mismatch')).message);

    // JWK incohérent : d d'une campagne, x et y de l'autre.
    const mixed = { ...a.private_key_jwk, d: b.private_key_jwk.d };
    messages.push((await rejectsWith(unwrapPrivateKey({ ...plainFile, key: mixed }, null), 'mismatch')).message);

    // Empreinte falsifiée.
    const badFp = { ...plainFile, campaign: { ...plainFile.campaign, fingerprint: plainFile.campaign.fingerprint === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA' } };
    messages.push((await rejectsWith(unwrapPrivateKey(badFp, null), 'mismatch')).message);

    for (const m of messages) {
      assert.ok(!m.includes(a.private_key_jwk.d) && !m.includes(b.private_key_jwk.d), 'd dans un message d’erreur');
    }
  });

  test('fichier protégé : la copie en clair de la campagne n’est jamais utilisée', async () => {
    const campaign = await makeCampaign();
    const file = await wrapPrivateKey(campaign, PASSWORD);
    // Modification sans le mot de passe : mode, seuil de masquage, canal de retour et titre.
    const tampered = {
      ...file,
      campaign: {
        ...file.campaign, mode: 'open', title: 'Campagne piégée',
        settings: { ...file.campaign.settings, min_group_size: 1, channels: [{ type: 'mailto', target: 'pirate@exemple.fr' }] },
      },
    };
    const out = await unwrapPrivateKey(tampered, PASSWORD);
    assert.equal(out.campaign.mode, campaign.mode);
    assert.equal(out.campaign.title, campaign.title);
    assert.deepEqual(out.campaign.settings, campaign.settings);
    // Identifiant en clair remplacé : refusé.
    const otherId = { ...file, campaign: { ...file.campaign, id: 'AutreCampagne01' } };
    await rejectsWith(unwrapPrivateKey(otherId, PASSWORD), 'mismatch');
  });

  test('wrapPrivateKey vérifie la paire avant d’écrire', async () => {
    const a = await makeCampaign();
    const b = await makeCampaign();
    await rejectsWith(wrapPrivateKey({ ...a, private_key_jwk: b.private_key_jwk }, PASSWORD), 'mismatch');
    await rejectsWith(wrapPrivateKey({ ...a, fingerprint: b.fingerprint }, null), 'mismatch');
    await assert.rejects(wrapPrivateKey({ ...a, private_key_jwk: null }, PASSWORD), TypeError);
    await assert.rejects(wrapPrivateKey(a, ''), TypeError);
    await assert.rejects(wrapPrivateKey(a, PASSWORD, { iterations: 100000 }), RangeError);
    await assert.rejects(wrapPrivateKey({ ...a, id: 'x' }, PASSWORD), TypeError);
  });

  test('fichier non reconnu, version ou champs invalides', async () => {
    const campaign = await makeCampaign();
    const file = await wrapPrivateKey(campaign, null);
    await rejectsWith(unwrapPrivateKey('{', null), 'format');
    await rejectsWith(unwrapPrivateKey({ ...file, format: 'recensia-backup' }, null), 'format');
    await rejectsWith(unwrapPrivateKey({ ...file, v: 2 }, null), 'version');
    await rejectsWith(unwrapPrivateKey({ ...file, protected: 'non' }, null), 'format');
    await rejectsWith(unwrapPrivateKey({ ...file, campaign: { ...file.campaign, id: 'x' } }, null), 'format');
    await rejectsWith(unwrapPrivateKey({ ...file, campaign: { ...file.campaign, mode: 'autre' } }, null), 'format');
    await rejectsWith(unwrapPrivateKey({ ...file, campaign: { ...file.campaign, public_key: 'abc' } }, null), 'format');
    await rejectsWith(unwrapPrivateKey({ ...file, key: { kty: 'EC' } }, null), 'format');
    assert.ok(!isRecoveryFile({ format: 'recensia-encrypted', v: 1 }));
  });

  test('aucune journalisation', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    const saved = methods.map((m) => console[m]);
    let calls = 0;
    for (const m of methods) console[m] = () => { calls++; };
    try {
      const campaign = await makeCampaign();
      const file = await wrapPrivateKey(campaign, PASSWORD);
      await unwrapPrivateKey(file, PASSWORD);
      await unwrapPrivateKey(file, 'faux').catch(() => {});
    } finally {
      methods.forEach((m, i) => { console[m] = saved[i]; });
    }
    assert.equal(calls, 0);
  });
});
