// Tests du module de chiffrement : base64url, aléa, compression, clés, codes de réponse (CDC §7.2, §10.4).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib';

import { b64urlDecode, b64urlEncode, isB64url } from '../src/crypto/b64url.js';
import { randomBytes, randomId } from '../src/crypto/random.js';
import { InflateError, MAX_INFLATED_BYTES, deflateJson, deflateRaw, inflateJson, inflateRaw } from '../src/crypto/compress.js';
import {
  decodePublicKey, fingerprint, formatFingerprint, generateCampaignKeys, importPrivateKey, importPublicKey,
  isFingerprint, normalizePrivateJwk, publicKeyFromPrivateJwk, verifyKeyPair,
} from '../src/crypto/keys.js';
import {
  CODE_MAX_LENGTH, CODE_MIN_BYTES, CODE_PREFIX, CodeError, PLAIN_MAX_BYTES, _encryptEntryWith, checkCodeFormat, codeHash, decryptEntry,
  encryptEntry, extractCodes, extractCodeCandidates, isCampaignId, isIsoTimestamp, isValidDay, validatePlain,
} from '../src/crypto/codes.js';

const VECTORS = JSON.parse(readFileSync(new URL('./vectors/codes-v1.json', import.meta.url), 'utf8'));
const CAMPAIGN = 'k3J9xQ2mP0aZ';
const enc = new TextEncoder();

const USAGE = Object.freeze({
  usage_name: 'Rédaction de devis', department: 'Commercial et devis', tool: 'microsoft_copilot', tool_other: null,
  model: 'GPT-4o', account_type: 'enterprise_provided', task_types: ['redaction', 'resume'], business_domain: 'commercial_devis',
  data_types: ['donnees_clients'], frequency: 'weekly', users_count: '6-15', output_audience: 'external_clients',
  output_review: 'systematic', affects_people: 'no', direct_interaction: 'no', biometric_emotion: 'no',
  built_or_customized: 'use_as_is', status: 'in_use', comment: 'Relu avant envoi ; aucune donnée nominative.',
});

function plainFor(overrides = {}) {
  return { v: 1, sv: 1, campaign_id: CAMPAIGN, entry_id: randomId(12), rev: 1, submitted_day: '2026-09-29', usage: { ...USAGE }, ...overrides };
}

async function rejects(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CodeError, `CodeError attendue, reçu ${err?.name} : ${err?.message}`);
    if (reason) assert.equal(err.reason, reason, err.message);
    return true;
  });
}

/**
 * Implémentation indépendante du format (Buffer, node:zlib, WebCrypto brut) : chiffre des octets
 * arbitraires. Sert à fabriquer des clairs invalides et à prouver la conformité au format documenté.
 */
async function sealRaw(payload, publicKeyB64, campaignId, { version = 1, aadCampaign = campaignId, infoCampaign = aadCampaign } = {}) {
  const subtle = globalThis.crypto.subtle;
  const alg = { name: 'ECDH', namedCurve: 'P-256' };
  const pk = await subtle.importKey('raw', Buffer.from(publicKeyB64, 'base64url'), alg, false, []);
  const eph = await subtle.generateKey(alg, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: pk }, eph.privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const keyBytes = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ephRaw, info: enc.encode(`recensia-v1|${infoCampaign}`) }, hkdf, 256);
  const aes = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aadCampaign) }, aes, payload));
  return CODE_PREFIX + Buffer.concat([Buffer.from([version]), ephRaw, iv, ct]).toString('base64url');
}

const sealJson = (obj, pk, cid, opts) => sealRaw(deflateRawSync(Buffer.from(JSON.stringify(obj)), { level: 9 }), pk, cid, opts);

/**
 * Déchiffreur indépendant du format documenté (Buffer, node:zlib, WebCrypto brut) : prouve que les
 * codes produits par le module (et les vecteurs figés) respectent la spécification, et pas seulement
 * l'implémentation qui les relit.
 */
async function openRaw(code, privateJwk, campaignId) {
  const subtle = globalThis.crypto.subtle;
  const alg = { name: 'ECDH', namedCurve: 'P-256' };
  assert.ok(code.startsWith('RCN1.'));
  const bytes = Buffer.from(code.slice(5), 'base64url');
  assert.equal(bytes[0], 1);
  const ephRaw = bytes.subarray(1, 66);
  const iv = bytes.subarray(66, 78);
  const sealed = bytes.subarray(78);
  const { kty, crv, x, y, d } = privateJwk;
  const priv = await subtle.importKey('jwk', { kty, crv, x, y, d }, alg, false, ['deriveBits']);
  const eph = await subtle.importKey('raw', ephRaw, alg, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: eph }, priv, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const keyBytes = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ephRaw, info: enc.encode(`recensia-v1|${campaignId}`) }, hkdf, 256);
  const aes = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const compressed = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(campaignId), tagLength: 128 }, aes, sealed);
  return JSON.parse(inflateRawSync(Buffer.from(compressed)).toString('utf8'));
}

function codeBytes(code) {
  return new Uint8Array(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url'));
}
function bytesToCode(bytes) {
  return CODE_PREFIX + Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------

describe('b64url', () => {
  test('aller-retour et conformité à Buffer base64url', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = n ? randomBytes(n) : new Uint8Array(0);
      const s = b64urlEncode(bytes);
      assert.equal(s, Buffer.from(bytes).toString('base64url'));
      assert.deepEqual(b64urlDecode(s), bytes);
      assert.ok(n === 0 || isB64url(s));
    }
  });

  test('alphabet strict : + / = espace et caractères non ASCII refusés', () => {
    for (const bad of ['ab+c', 'ab/c', 'abc=', 'AAAA==', 'ab c', 'abc\n', 'abé', 'ab%7E']) {
      assert.throws(() => b64urlDecode(bad), TypeError, bad);
      assert.equal(isB64url(bad), false, bad);
    }
    assert.equal(isB64url(''), false);
  });

  test('longueur impossible et bits de fin non nuls refusés', () => {
    assert.throws(() => b64urlDecode('A'), TypeError);
    assert.throws(() => b64urlDecode('AAAAA'), TypeError);
    assert.throws(() => b64urlDecode('AB'), TypeError); // 'AA' est la seule écriture de 0x00
    assert.throws(() => b64urlDecode('AAB'), TypeError);
    assert.deepEqual(b64urlDecode('AA'), new Uint8Array([0]));
    assert.throws(() => b64urlDecode(42), TypeError);
  });
});

describe('random', () => {
  test('randomId : longueur, alphabet et unicité', () => {
    assert.match(randomId(), /^[A-Za-z0-9_-]{16}$/);
    assert.match(randomId(9), /^[A-Za-z0-9_-]{12}$/);
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    assert.equal(ids.size, 200);
    assert.throws(() => randomBytes(0), RangeError);
  });
});

describe('compress', () => {
  test('aller-retour JSON Unicode', () => {
    const obj = { a: 'Élodie — « test » 🙂 日本語', b: [1, 2, 3], c: null, d: { e: true } };
    assert.deepEqual(inflateJson(deflateJson(obj)), obj);
  });

  test('compatible DEFLATE brut standard (node:zlib)', () => {
    const obj = { x: 'données'.repeat(50) };
    assert.deepEqual(inflateJson(deflateRawSync(Buffer.from(JSON.stringify(obj)))), obj);
  });

  test('plafond exact : 16 384 octets acceptés, 16 385 refusés (size)', () => {
    assert.equal(MAX_INFLATED_BYTES, 16384);
    assert.equal(inflateRaw(deflateRaw(new Uint8Array(16384).fill(65))).length, 16384);
    assert.throws(() => inflateRaw(deflateRaw(new Uint8Array(16385).fill(65))), (e) => e instanceof InflateError && e.reason === 'size');
    assert.throws(() => inflateRaw(deflateRaw(new Uint8Array(200)), 100), (e) => e.reason === 'size');
  });

  test('bombe de décompression interrompue en flux, sans développer la sortie', () => {
    const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    assert.ok(bomb.length < 100000);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    assert.throws(() => inflateRaw(new Uint8Array(bomb)), (e) => e.reason === 'size');
    const elapsed = performance.now() - t0;
    const grown = process.memoryUsage().arrayBuffers - before;
    assert.ok(elapsed < 200, `interruption lente : ${elapsed} ms`);
    assert.ok(grown < 8 * 1024 * 1024, `mémoire allouée : ${grown} octets`);
  });

  test('bombe de 1 Gio (≈ 1 Mo compressé) interrompue en quelques millisecondes', () => {
    // 64 blocs non finals de 16 Mio de zéros (vidage synchrone), puis un bloc final vide.
    const segment = deflateRawSync(Buffer.alloc(16 * 1024 * 1024), { level: 9, finishFlush: zlibConstants.Z_SYNC_FLUSH });
    const FINAL_EMPTY_BLOCK = Buffer.from([0x03, 0x00]);
    assert.equal(inflateRawSync(Buffer.concat([segment, segment, FINAL_EMPTY_BLOCK])).length, 32 * 1024 * 1024); // flux valide
    const bomb = new Uint8Array(Buffer.concat([...Array(64).fill(segment), FINAL_EMPTY_BLOCK]));
    assert.ok(bomb.length < 1.1 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    assert.throws(() => inflateRaw(bomb), (e) => e instanceof InflateError && e.reason === 'size');
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 100, `interruption lente : ${elapsed} ms`);
    assert.ok(process.memoryUsage().arrayBuffers - before < 4 * 1024 * 1024);
  });

  test('flux vide, tronqué, corrompu, UTF-8 ou JSON invalides : format', () => {
    const good = deflateJson({ a: 'x'.repeat(500) });
    const isFormat = (e) => e instanceof InflateError && e.reason === 'format';
    assert.throws(() => inflateRaw(new Uint8Array(0)), isFormat);
    assert.throws(() => inflateRaw(good.subarray(0, good.length - 4)), isFormat);
    assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff])), isFormat);
    assert.throws(() => inflateJson(deflateRaw(new Uint8Array([0x22, 0xc3, 0x28, 0x22]))), isFormat);
    assert.throws(() => inflateJson(deflateRaw(enc.encode('{"a":'))), isFormat);
  });
});

describe('keys', () => {
  test('generateCampaignKeys : clé brute 65 octets, JWK normalisé, empreinte SHA-256', async () => {
    const k = await generateCampaignKeys();
    const raw = Buffer.from(k.publicKeyB64, 'base64url');
    assert.equal(raw.length, 65);
    assert.equal(raw[0], 0x04);
    assert.deepEqual(Object.keys(k.privateKeyJwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
    assert.equal(k.privateKeyJwk.kty, 'EC');
    assert.equal(k.privateKeyJwk.crv, 'P-256');
    const expected = createHash('sha256').update(raw).digest('hex').slice(0, 8).toUpperCase();
    assert.equal(k.fingerprint, expected);
    assert.equal(await fingerprint(k.publicKeyB64), expected);
    assert.ok(isFingerprint(k.fingerprint));
    assert.equal(await publicKeyFromPrivateJwk(k.privateKeyJwk), k.publicKeyB64);
    assert.equal(await verifyKeyPair(k.privateKeyJwk, k.publicKeyB64), true);
  });

  test('formatFingerprint', () => {
    assert.equal(formatFingerprint('A1B2C3D4'), 'A1B2-C3D4');
    assert.equal(formatFingerprint('a1b2c3d4'), 'A1B2-C3D4');
    assert.equal(formatFingerprint(null), '');
    assert.equal(formatFingerprint('xyz'), 'xyz');
  });

  test('clés publiques invalides refusées (longueur, préfixe, point hors courbe)', async () => {
    const k = await generateCampaignKeys();
    const raw = Buffer.from(k.publicKeyB64, 'base64url');
    assert.throws(() => decodePublicKey(raw.subarray(0, 64).toString('base64url')), TypeError);
    const compressed = Buffer.from(raw);
    compressed[0] = 0x02;
    assert.throws(() => decodePublicKey(compressed.toString('base64url')), TypeError);
    assert.throws(() => decodePublicKey('ab+c'), TypeError);
    const offCurve = Buffer.from(raw);
    offCurve[40] ^= 1;
    await assert.rejects(importPublicKey(offCurve.toString('base64url')), TypeError);
    assert.ok(await importPublicKey(k.publicKeyB64));
  });

  test('clés privées : JWK mal formé refusé, paire incohérente détectée', async () => {
    const a = await generateCampaignKeys();
    const b = await generateCampaignKeys();
    assert.throws(() => normalizePrivateJwk({ kty: 'EC', crv: 'P-384', x: a.privateKeyJwk.x, y: a.privateKeyJwk.y, d: a.privateKeyJwk.d }), TypeError);
    assert.throws(() => normalizePrivateJwk({ ...a.privateKeyJwk, d: undefined }), TypeError);
    assert.throws(() => normalizePrivateJwk({ ...a.privateKeyJwk, d: 'abc' }), TypeError);
    await assert.rejects(importPrivateKey(null), TypeError);
    assert.equal(await verifyKeyPair(a.privateKeyJwk, b.publicKeyB64), false);
    const mixed = { ...b.privateKeyJwk, d: a.privateKeyJwk.d };
    assert.equal(await verifyKeyPair(mixed, b.publicKeyB64), false);
    assert.equal(await verifyKeyPair(mixed, a.publicKeyB64), false);
  });
});

describe('codes : chiffrement et déchiffrement', async () => {
  const keys = await generateCampaignKeys();
  const other = await generateCampaignKeys();

  test('aller-retour anonyme (JWK) et ouvert (CryptoKey), clair normalisé', async () => {
    const anon = plainFor();
    const code = await encryptEntry(anon, keys.publicKeyB64, CAMPAIGN);
    assert.ok(code.startsWith(CODE_PREFIX));
    assert.match(code.slice(CODE_PREFIX.length), /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(await decryptEntry(code, keys.privateKeyJwk, CAMPAIGN), { ...anon, submitted_at: null, respondent: null });

    const open = plainFor({ rev: 2, submitted_at: '2026-09-29T14:03:12.345Z', respondent: { first_name: 'Élodie', last_name: 'Martin', email: null } });
    const key = await importPrivateKey(keys.privateKeyJwk);
    const code2 = await encryptEntry(open, keys.publicKeyB64, CAMPAIGN);
    assert.deepEqual(await decryptEntry(code2, key, CAMPAIGN), open);
  });

  test('v et campaign_id facultatifs, complétés ; nuls omis du clair chiffré', async () => {
    const { v, campaign_id, ...rest } = plainFor();
    const code = await encryptEntry({ ...rest, submitted_at: null, respondent: null }, keys.publicKeyB64, CAMPAIGN);
    const back = await decryptEntry(code, keys.privateKeyJwk, CAMPAIGN);
    assert.equal(back.v, 1);
    assert.equal(back.campaign_id, CAMPAIGN);
  });

  test('disposition binaire : 0x01 ‖ clé éphémère (65) ‖ IV (12) ‖ chiffré + tag (16)', async () => {
    const plain = plainFor();
    const code = await encryptEntry(plain, keys.publicKeyB64, CAMPAIGN);
    const bytes = codeBytes(code);
    assert.equal(bytes[0], 0x01);
    assert.equal(bytes[1], 0x04);
    const compressedLength = deflateJson({ ...plain }).length;
    assert.equal(bytes.length, 1 + 65 + 12 + compressedLength + 16);
  });

  test('deux chiffrements du même clair diffèrent (clé éphémère et IV neufs)', async () => {
    const plain = plainFor();
    const c1 = await encryptEntry(plain, keys.publicKeyB64, CAMPAIGN);
    const c2 = await encryptEntry(plain, keys.publicKeyB64, CAMPAIGN);
    assert.notEqual(c1, c2);
    const b1 = codeBytes(c1);
    const b2 = codeBytes(c2);
    assert.notDeepEqual(b1.subarray(1, 66), b2.subarray(1, 66));
    assert.notDeepEqual(b1.subarray(66, 78), b2.subarray(66, 78));
    assert.notDeepEqual(b1.subarray(78), b2.subarray(78));
    assert.deepEqual(await decryptEntry(c1, keys.privateKeyJwk, CAMPAIGN), await decryptEntry(c2, keys.privateKeyJwk, CAMPAIGN));
  });

  test('code altéré : un bit inversé dans chaque octet (version, clé éphémère, IV, chiffré, tag) est rejeté', async () => {
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    const bytes = codeBytes(code);
    const zones = { version: 0, ephemeral: 0, iv: 0, ciphertext: 0, tag: 0 };
    for (let i = 0; i < bytes.length; i++) {
      const altered = bytes.slice();
      altered[i] ^= 1 << (i % 8);
      const zone = i === 0 ? 'version' : i < 66 ? 'ephemeral' : i < 78 ? 'iv' : i < bytes.length - 16 ? 'ciphertext' : 'tag';
      zones[zone]++;
      await rejects(decryptEntry(bytesToCode(altered), keys.privateKeyJwk, CAMPAIGN), zone === 'version' ? 'version' : 'decrypt');
    }
    for (const [zone, n] of Object.entries(zones)) assert.ok(n > 0, `zone ${zone} non couverte`);
  });

  test('code tronqué ou caractère remplacé : rejeté', async () => {
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    for (const cut of [1, 2, 3, 10, 40]) await rejects(decryptEntry(code.slice(0, -cut), keys.privateKeyJwk, CAMPAIGN));
    const i = 200;
    const swapped = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1);
    await rejects(decryptEntry(swapped, keys.privateKeyJwk, CAMPAIGN), 'decrypt');
  });

  test('mauvaise clé privée : decrypt', async () => {
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    await rejects(decryptEntry(code, other.privateKeyJwk, CAMPAIGN), 'decrypt');
    await rejects(decryptEntry(code, await importPrivateKey(other.privateKeyJwk), CAMPAIGN), 'decrypt');
  });

  test('code d’une autre campagne (AAD et info HKDF) : rejeté', async () => {
    const code = await encryptEntry(plainFor({ campaign_id: 'AutreCampagne01' }), keys.publicKeyB64, 'AutreCampagne01');
    await rejects(decryptEntry(code, keys.privateKeyJwk, CAMPAIGN), 'decrypt');
    // Clair annonçant une autre campagne sous une AAD correcte (code forgé) : campaign.
    const forged = await sealJson(plainFor({ campaign_id: 'AutreCampagne01' }), keys.publicKeyB64, CAMPAIGN);
    await rejects(decryptEntry(forged, keys.privateKeyJwk, CAMPAIGN), 'campaign');
  });

  test('implémentation indépendante du format (node:zlib + WebCrypto brut) : lue', async () => {
    const plain = plainFor({ submitted_at: '2026-09-29T08:00:00+02:00' });
    const code = await sealJson(plain, keys.publicKeyB64, CAMPAIGN);
    assert.deepEqual(await decryptEntry(code, keys.privateKeyJwk, CAMPAIGN), { ...plain, respondent: null });
  });

  test('codes du module lus par un déchiffreur indépendant (sel HKDF, info, AAD, disposition)', async () => {
    const plain = plainFor({ respondent: { first_name: 'Élodie', last_name: 'Martin', email: null } });
    const code = await encryptEntry(plain, keys.publicKeyB64, CAMPAIGN);
    assert.deepEqual(await openRaw(code, keys.privateKeyJwk, CAMPAIGN), plain);
    await assert.rejects(openRaw(code, keys.privateKeyJwk, 'AutreCampagne01'));
  });

  test('AAD et info HKDF liés chacun à la campagne', async () => {
    const plain = plainFor();
    // Info HKDF correcte mais AAD d'une autre campagne, puis l'inverse : les deux sont refusés.
    const wrongAad = await sealJson(plain, keys.publicKeyB64, CAMPAIGN, { aadCampaign: 'AutreCampagne01', infoCampaign: CAMPAIGN });
    const wrongInfo = await sealJson(plain, keys.publicKeyB64, CAMPAIGN, { aadCampaign: CAMPAIGN, infoCampaign: 'AutreCampagne01' });
    await rejects(decryptEntry(wrongAad, keys.privateKeyJwk, CAMPAIGN), 'decrypt');
    await rejects(decryptEntry(wrongInfo, keys.privateKeyJwk, CAMPAIGN), 'decrypt');
  });

  test('plafonds : code trop long refusé avant tout décodage (size)', async () => {
    await rejects(decryptEntry(CODE_PREFIX + 'A'.repeat(CODE_MAX_LENGTH), keys.privateKeyJwk, CAMPAIGN), 'size');
    await rejects(decryptEntry(CODE_PREFIX + '!'.repeat(CODE_MAX_LENGTH), keys.privateKeyJwk, CAMPAIGN), 'size');
    await rejects(decryptEntry('x'.repeat(CODE_MAX_LENGTH + 1), keys.privateKeyJwk, CAMPAIGN), 'size');
  });

  test('plafonds : clair décompressé > 16 Ko refusé (size), bombe dans un code comprise', async () => {
    const big = plainFor({ usage: { ...USAGE, comment: 'x'.repeat(PLAIN_MAX_BYTES) } });
    await rejects(decryptEntry(await sealJson(big, keys.publicKeyB64, CAMPAIGN), keys.privateKeyJwk, CAMPAIGN), 'size');
    const bomb = deflateRawSync(Buffer.alloc(8 * 1024 * 1024), { level: 9 });
    const bombCode = await sealRaw(bomb, keys.publicKeyB64, CAMPAIGN);
    assert.ok(bombCode.length <= CODE_MAX_LENGTH, `bombe de ${bombCode.length} caractères`);
    await rejects(decryptEntry(bombCode, keys.privateKeyJwk, CAMPAIGN), 'size');
  });

  test('plafonds : encryptEntry refuse un clair > 16 Ko', async () => {
    const big = plainFor({ usage: { ...USAGE, comment: 'é'.repeat(9000) } });
    await rejects(encryptEntry(big, keys.publicKeyB64, CAMPAIGN), 'size');
  });

  test('alphabet strict : + / = et espaces refusés (format)', async () => {
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    const at = 100;
    for (const ch of ['+', '/', '=', ' ', '\n', '.', '~', '%']) {
      await rejects(decryptEntry(code.slice(0, at) + ch + code.slice(at + 1), keys.privateKeyJwk, CAMPAIGN), 'format');
    }
    await rejects(decryptEntry(code + '=', keys.privateKeyJwk, CAMPAIGN), 'format');
    await rejects(decryptEntry(` ${code}`, keys.privateKeyJwk, CAMPAIGN), 'format');
  });

  test('préfixe, type, taille minimale et octet de version', async () => {
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    await rejects(decryptEntry(code.slice(5), keys.privateKeyJwk, CAMPAIGN), 'format');
    await rejects(decryptEntry(`rcn1.${code.slice(5)}`, keys.privateKeyJwk, CAMPAIGN), 'format');
    await rejects(decryptEntry(`RCN2.${code.slice(5)}`, keys.privateKeyJwk, CAMPAIGN), 'version');
    await rejects(decryptEntry(null, keys.privateKeyJwk, CAMPAIGN), 'format');
    await rejects(decryptEntry(CODE_PREFIX, keys.privateKeyJwk, CAMPAIGN), 'format');
    const short = new Uint8Array(CODE_MIN_BYTES - 1);
    short[0] = 1;
    await rejects(decryptEntry(bytesToCode(short), keys.privateKeyJwk, CAMPAIGN), 'format');
    const v2 = codeBytes(code);
    v2[0] = 2;
    await rejects(decryptEntry(bytesToCode(v2), keys.privateKeyJwk, CAMPAIGN), 'version');
  });

  test('checkCodeFormat : contrôles préalables, même raison que decryptEntry', async () => {
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    assert.equal(checkCodeFormat(code), null, 'code bien formé');
    const short = new Uint8Array(CODE_MIN_BYTES - 1);
    short[0] = 1;
    const v2 = codeBytes(code);
    v2[0] = 2;
    const cases = [
      [null, 'format'], [42, 'format'], [undefined, 'format'], ['', 'format'],
      [code.slice(5), 'format'], [`rcn1.${code.slice(5)}`, 'format'], [CODE_PREFIX, 'format'],
      [`${code.slice(0, 100)}+${code.slice(101)}`, 'format'], [`${code}=`, 'format'], [` ${code}`, 'format'],
      [`${code.slice(0, 100)}\n${code.slice(101)}`, 'format'], [CODE_PREFIX + 'A', 'format'],
      [bytesToCode(short), 'format'],
      [`RCN2.${code.slice(5)}`, 'version'], ['RCN12.abc', 'version'], [bytesToCode(v2), 'version'],
      [CODE_PREFIX + 'A'.repeat(CODE_MAX_LENGTH), 'size'], ['x'.repeat(CODE_MAX_LENGTH + 1), 'size'],
    ];
    for (const [input, reason] of cases) {
      const label = typeof input === 'string' ? `${input.slice(0, 12)}… (${input.length})` : String(input);
      assert.equal(checkCodeFormat(input), reason, label);
      await rejects(decryptEntry(input, keys.privateKeyJwk, CAMPAIGN), reason);
    }
    // Bien formé mais illisible avec cette clé, altéré ou d'une autre campagne : le déchiffrement tranche.
    const flipped = codeBytes(code);
    flipped[flipped.length - 1] ^= 1;
    for (const input of [bytesToCode(flipped), await encryptEntry(plainFor(), other.publicKeyB64, CAMPAIGN)]) {
      assert.equal(checkCodeFormat(input), null);
      await rejects(decryptEntry(input, keys.privateKeyJwk, CAMPAIGN), 'decrypt');
    }
  });

  test('structure du clair vérifiée après déchiffrement', async () => {
    const pk = keys.publicKeyB64;
    const cases = [
      [[1, 2], 'schema'],
      [{ ...plainFor(), extra: 1 }, 'schema'],
      [{ ...plainFor(), v: 2 }, 'version'],
      [{ ...plainFor(), v: '1' }, 'schema'],
      [{ ...plainFor(), sv: 99 }, 'version'],
      [{ ...plainFor(), sv: undefined }, 'schema'],
      [{ ...plainFor(), entry_id: 'court' }, 'schema'],
      [{ ...plainFor(), entry_id: 'a'.repeat(33) }, 'schema'],
      [{ ...plainFor(), entry_id: 'abc+defghij' }, 'schema'],
      [{ ...plainFor(), rev: 0 }, 'schema'],
      [{ ...plainFor(), rev: 1001 }, 'schema'],
      [{ ...plainFor(), rev: 1.5 }, 'schema'],
      [{ ...plainFor(), rev: '1' }, 'schema'],
      [{ ...plainFor(), submitted_day: '2026-02-30' }, 'schema'],
      [{ ...plainFor(), submitted_day: '29/09/2026' }, 'schema'],
      [{ ...plainFor(), submitted_at: '2026-09-29 10:00' }, 'schema'],
      [{ ...plainFor(), submitted_at: '2026-09-29T25:00:00Z' }, 'schema'],
      [{ ...plainFor(), respondent: 'Élodie Martin' }, 'schema'],
      [{ ...plainFor(), respondent: ['Élodie'] }, 'schema'],
      [{ ...plainFor(), usage: undefined }, 'schema'],
      [{ ...plainFor(), usage: [] }, 'schema'],
      [{ ...plainFor(), campaign_id: 42 }, 'schema'],
    ];
    for (const [obj, reason] of cases) {
      await rejects(decryptEntry(await sealJson(obj, pk, CAMPAIGN), keys.privateKeyJwk, CAMPAIGN), reason);
    }
    // Contenu authentique mais illisible : DEFLATE invalide, JSON invalide, UTF-8 invalide.
    await rejects(decryptEntry(await sealRaw(new Uint8Array([0xff, 0xfe, 0xfd]), pk, CAMPAIGN), keys.privateKeyJwk, CAMPAIGN), 'format');
    await rejects(decryptEntry(await sealRaw(deflateRawSync(Buffer.from('{"v":1,')), pk, CAMPAIGN), keys.privateKeyJwk, CAMPAIGN), 'format');
    await rejects(decryptEntry(await sealRaw(deflateRawSync(Buffer.from([0x22, 0xc3, 0x28, 0x22])), pk, CAMPAIGN), keys.privateKeyJwk, CAMPAIGN), 'format');
  });

  test('encryptEntry valide son entrée', async () => {
    await rejects(encryptEntry(plainFor({ campaign_id: 'AutreCampagne01' }), keys.publicKeyB64, CAMPAIGN), 'campaign');
    await rejects(encryptEntry({ ...plainFor(), extra: true }, keys.publicKeyB64, CAMPAIGN), 'schema');
    await rejects(encryptEntry(plainFor({ v: 2 }), keys.publicKeyB64, CAMPAIGN), 'version');
    await rejects(encryptEntry(plainFor({ rev: 0 }), keys.publicKeyB64, CAMPAIGN), 'schema');
    await rejects(encryptEntry(plainFor(), 'pas-une-cle', CAMPAIGN), 'format');
    await assert.rejects(encryptEntry(plainFor(), keys.publicKeyB64, 'x'), TypeError);
    const code = await encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN);
    await assert.rejects(decryptEntry(code, { kty: 'EC' }, CAMPAIGN), TypeError);
    await assert.rejects(decryptEntry(code, keys.privateKeyJwk, 'x'), TypeError);
  });

  test('100 codes déchiffrés en moins de 2 s', async () => {
    const codes = [];
    for (let i = 0; i < 100; i++) {
      codes.push(await encryptEntry(plainFor({ usage: { ...USAGE, usage_name: `Usage n° ${i}` } }), keys.publicKeyB64, CAMPAIGN));
    }
    // Meilleur de 3 essais : un seul pic de charge de la machine ne fait pas échouer le test.
    let elapsed = Infinity;
    for (let attempt = 0; attempt < 3 && elapsed >= 2000; attempt++) {
      const t0 = performance.now();
      for (const code of codes) await decryptEntry(code, keys.privateKeyJwk, CAMPAIGN);
      elapsed = Math.min(elapsed, performance.now() - t0);
    }
    assert.ok(elapsed < 2000, `${elapsed.toFixed(0)} ms`);
  });

  test('aucune journalisation et aucun paramètre d dans les erreurs', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    const saved = methods.map((m) => console[m]);
    let calls = 0;
    for (const m of methods) console[m] = () => { calls++; };
    const messages = [];
    try {
      const k = await generateCampaignKeys();
      const code = await encryptEntry(plainFor(), k.publicKeyB64, CAMPAIGN);
      await decryptEntry(code, k.privateKeyJwk, CAMPAIGN);
      for (const attempt of [
        () => decryptEntry(code, other.privateKeyJwk, CAMPAIGN),
        () => decryptEntry(code, { ...k.privateKeyJwk, x: other.privateKeyJwk.x }, CAMPAIGN),
        () => decryptEntry(code, { ...k.privateKeyJwk, crv: 'P-384' }, CAMPAIGN),
        () => decryptEntry(code.slice(0, -3), k.privateKeyJwk, CAMPAIGN),
        () => importPrivateKey({ ...k.privateKeyJwk, y: other.privateKeyJwk.y }),
        () => publicKeyFromPrivateJwk({ ...k.privateKeyJwk, x: other.privateKeyJwk.x }),
      ]) {
        try { await attempt(); } catch (e) { messages.push(`${e.message} ${JSON.stringify(e)} ${e.stack}`); }
      }
      assert.ok(messages.length >= 5);
      for (const m of messages) {
        assert.ok(!m.includes(k.privateKeyJwk.d), 'd dans un message d’erreur');
        assert.ok(!m.includes(other.privateKeyJwk.d), 'd dans un message d’erreur');
      }
    } finally {
      methods.forEach((m, i) => { console[m] = saved[i]; });
    }
    assert.equal(calls, 0);
  });
});

describe('codes : vecteurs figés (compatibilité ascendante)', () => {
  const { test_key: key } = VECTORS;

  test('clé de test marquée et cohérente', async () => {
    assert.match(key.notice, /TEST KEY — NOT A SECRET/);
    assert.equal(await fingerprint(key.public_key), key.fingerprint);
    assert.equal(formatFingerprint(key.fingerprint), key.fingerprint_formatted);
    assert.equal(await publicKeyFromPrivateJwk(key.private_key_jwk), key.public_key);
  });

  test('les codes figés restent lisibles', async () => {
    assert.ok(VECTORS.decrypt_vectors.length >= 2);
    for (const v of VECTORS.decrypt_vectors) {
      assert.deepEqual(await decryptEntry(v.code, key.private_key_jwk, key.campaign_id), v.expected, v.name);
      assert.equal(await codeHash(v.code), v.code_hash, v.name);
    }
  });

  test('les vecteurs figés respectent le format documenté (déchiffreur indépendant)', async () => {
    const compact = (p) => Object.fromEntries(Object.entries(p).filter(([, value]) => value !== null));
    for (const v of [...VECTORS.decrypt_vectors, ...VECTORS.deterministic_vectors]) {
      assert.deepEqual(await openRaw(v.code, key.private_key_jwk, key.campaign_id), compact(v.expected), v.name);
    }
  });

  test('vecteur déterministe : clé éphémère et IV imposés ⇒ code identique', async () => {
    for (const v of VECTORS.deterministic_vectors) {
      assert.match(v.notice, /TEST KEY — NOT A SECRET/);
      const iv = new Uint8Array(Buffer.from(v.iv, 'base64url'));
      const code = await _encryptEntryWith(v.plain, key.public_key, key.campaign_id, { ephemeralPrivateJwk: v.ephemeral_private_key_jwk, iv });
      assert.equal(code, v.code, v.name);
      assert.equal(Buffer.from(code.slice(5), 'base64url').subarray(1, 66).toString('base64url'), v.ephemeral_public_key);
      assert.deepEqual(await decryptEntry(v.code, key.private_key_jwk, key.campaign_id), v.expected);
    }
  });

  test('codes figés à rejeter', async () => {
    for (const v of VECTORS.reject_vectors) {
      await rejects(decryptEntry(v.code, key.private_key_jwk, v.campaign_id), v.reason);
      const early = ['format', 'size', 'version'].includes(v.reason) ? v.reason : null;
      assert.equal(checkCodeFormat(v.code), early, `checkCodeFormat : ${v.name}`);
    }
    for (const v of [...VECTORS.decrypt_vectors, ...VECTORS.deterministic_vectors]) assert.equal(checkCodeFormat(v.code), null, v.name);
  });
});

describe('codes : extraction et empreinte', async () => {
  const keys = await generateCampaignKeys();
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => encryptEntry(plainFor(), keys.publicKeyB64, CAMPAIGN)));

  test('e-mail collé : codes bruts et lien d’import, dédoublonnés, ordre conservé', () => {
    const mail = [
      'Bonjour,', '', 'Voici mes réponses :', `https://manicalabs.github.io/Recensia/#/i/${a}~${b}`, '',
      'En secours, les codes bruts :', a, `${b}.`, `(${c})`, '> Cordialement',
    ].join('\r\n');
    assert.deepEqual(extractCodes(mail), [a, b, c]);
  });

  test('« ~ » encodé en %7E ou %7e', () => {
    assert.deepEqual(extractCodes(`https://x.test/Recensia/#/i/${a}%7E${b}%7e${c}`), [a, b, c]);
  });

  test('fichier .rcn (un code par ligne) et texte sans code', () => {
    assert.deepEqual(extractCodes(`${c}\n${a}\n${c}\n`), [c, a]);
    assert.deepEqual(extractCodes('Aucun code ici. RCN1. RCN.abc rcn1.abc RCN0.abc'), []);
    assert.deepEqual(extractCodes(''), []);
    assert.deepEqual(extractCodes(null), []);
  });

  test('code d’une version future : extrait, puis refusé par decryptEntry (version)', async () => {
    const future = `RCN2.${a.slice(CODE_PREFIX.length)}`;
    assert.deepEqual(extractCodes(`Code : ${future} et ${a}`), [future, a]);
    await rejects(decryptEntry(future, keys.privateKeyJwk, CAMPAIGN), 'version');
  });

  test('lien d’import réécrit par un filtre de sécurité (Outlook Safe Links)', () => {
    const target = encodeURIComponent(`https://manicalabs.github.io/Recensia/#/i/${a}~${b}`);
    const rewritten = `https://eur01.safelinks.protection.outlook.com/?url=${target}&data=05%7C02%7Cia%40exemple.fr%7C&reserved=0`;
    assert.deepEqual(extractCodes(rewritten), [a, b]);
    // Double encodage du séparateur (%257E).
    assert.deepEqual(extractCodes(`#/i/${a}%257E${c}`), [a, c]);
  });

  // Texte brut recoupé par une messagerie : chaque ligne coupée à `width` colonnes, préfixe compris.
  const wrap = (text, width, prefix = '') => text.split('\n').flatMap((line) => {
    const size = width - prefix.length;
    if (line.length <= size) return [`${prefix}${line}`];
    const out = [];
    for (let i = 0; i < line.length; i += size) out.push(`${prefix}${line.slice(i, i + size)}`);
    return out;
  }).join('\n');
  const importUrl = (...codes) => `https://manicalabs.github.io/Recensia/#/i/${codes.join('~')}`;

  test('code recoupé à 76 colonnes (texte brut, CRLF) : recollé et déchiffrable', async () => {
    const mail = [
      'Bonjour,', '', 'Voici ma réponse chiffrée. Ouvrez ce lien :', importUrl(a), '',
      'En secours, copiez le texte ci-dessous :', a, '', 'Empreinte : A1B2-C3D4',
    ].join('\n');
    const wrapped = wrap(mail, 76);
    assert.ok(wrapped.split('\n').every((l) => l.length <= 76) && wrapped.split('\n').length > 20, 'prérequis : texte recoupé');
    assert.deepEqual(extractCodes(wrapped), [a]);
    assert.deepEqual(extractCodes(wrapped.replace(/\n/g, '\r\n')), [a], 'CRLF');
    assert.deepEqual((await decryptEntry(extractCodes(wrapped)[0], keys.privateKeyJwk, CAMPAIGN)).usage.usage_name, USAGE.usage_name);
  });

  test('code recoupé dans une citation « > » (72 colonnes) et « >> »', () => {
    for (const prefix of ['> ', '>> ', '> > ', '>']) {
      const quoted = wrap(['Le 30/09/2026, un collègue a écrit :', importUrl(a, b), '', c].join('\n'), 72, prefix);
      assert.deepEqual(extractCodes(`Transféré :\n${quoted}\n`), [a, b, c], JSON.stringify(prefix));
    }
  });

  test('code suivi d’un mot collé sur la ligne suivante : jamais recollé à tort', async () => {
    // Code sur une seule ligne (non recoupé), puis un mot : le code seul est retenu.
    assert.deepEqual(extractCodes(`${a}\nMerci`), [a]);
    const [entry] = extractCodeCandidates(`${a}\nMerci`);
    assert.deepEqual(entry.candidates, [a, `${a}Merci`], 'recollage gardé en variante');
    await assert.rejects(decryptEntry(`${a}Merci`, keys.privateKeyJwk, CAMPAIGN),
      (err) => err instanceof CodeError && ['decrypt', 'format'].includes(err.reason), 'recollage erroné refusé (tag ou longueur)');
    // Code recoupé : la dernière ligne (courte) termine le code ; le mot suivant n'y est pas ajouté.
    for (const next of ['Merci', 'Réponses anonymes ; l’envoi par e-mail, lui, n’est pas anonyme.', 'Cordialement,', 'A1B2']) {
      const text = `${wrap(a, 76)}\n${next}`;
      if (text.split('\n').at(-2).length >= 74) continue; // dernière ligne pleine : cas ambigu couvert par les variantes
      assert.deepEqual(extractCodes(text), [a], next);
    }
    assert.deepEqual(extractCodes(`${wrap(a, 76)}\n\nMerci`), [a], 'ligne vide après le code');
    assert.deepEqual(extractCodes(`${wrap(importUrl(a), 76)}\nhttps://manicalabs.github.io/Recensia/`), [a], 'adresse sur la ligne suivante');
  });

  // Code recoupé dont la dernière ligne est pleine (cas ambigu) : k caractères de texte avant le code
  // sur la première ligne, pour que le reste tombe juste sur des lignes de 76 colonnes.
  const fullTail = (code) => {
    const k0 = (76 - ((code.length + 1) % 76)) % 76;
    const k = k0 < 10 ? k0 + 76 : k0;
    const text = `${'z'.repeat(k)} ${code}`;
    const lines = [];
    for (let i = 0; i < text.length; i += 76) lines.push(text.slice(i, i + 76));
    assert.equal(lines.at(-1).length, 76, 'prérequis : dernière ligne pleine');
    return lines.join('\n');
  };

  test('dernière ligne pleine : un mot accentué ou suivi d’une lettre n’est pas une fin de code', () => {
    assert.deepEqual(extractCodes(`${fullTail(a)}\nRéponses anonymes\u00A0; l'envoi par e-mail, lui, n'est pas anonyme.`), [a]);
    assert.deepEqual(extractCodes(`${fullTail(a)}\nÉquipe RH`), [a]);
    assert.deepEqual(extractCodes(`${fullTail(a)}\n2026年`), [a], 'chiffre suivi d’un caractère non latin');
  });

  test('même code deux fois (lien d’import et code brut) : le recollage confirmé l’emporte, une seule entrée', () => {
    // Seul, « Merci » après une dernière ligne pleine est indécidable : le recollage erroné est préféré,
    // le bon code reste candidat. Confirmé par une autre occurrence, il est retenu une seule fois.
    const [alone] = extractCodeCandidates(`${fullTail(a)}\nMerci`);
    assert.equal(alone.code, `${a}Merci`);
    assert.ok(alone.candidates.includes(a));
    for (const text of [
      `${fullTail(a)}\nMerci\n\nLien :\n${wrap(importUrl(a), 76)}\n`,
      `Lien :\n${wrap(importUrl(a), 76)}\n\n${fullTail(a)}\nMerci`,
    ]) {
      const found = extractCodeCandidates(text);
      assert.deepEqual(found.map((f) => f.code), [a]);
      assert.equal(found[0].candidates[0], a);
    }
  });

  test('variantes : le bon recollage figure parmi les candidats, même mal préféré', async () => {
    // Recoupage « en peigne » (72 puis 8 colonnes) : reconnu, recollage complet préféré ; les autres
    // recollages restent proposés, un seul se déchiffre.
    const lines = [];
    for (let i = 0, odd = false; i < a.length; odd = !odd) {
      const size = odd ? 6 : 70;
      lines.push(`> ${a.slice(i, i + size)}`);
      i += size;
    }
    const [entry] = extractCodeCandidates(lines.join('\n'));
    assert.equal(entry.code, a, 'peigne reconnu : recollage complet préféré');
    assert.ok(entry.candidates.includes(a), 'recollage complet proposé');
    assert.equal(new Set(entry.candidates).size, entry.candidates.length, 'sans doublon');
    assert.ok(entry.candidates.length <= 5);
    let opened = 0;
    for (const candidate of entry.candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await decryptEntry(candidate, keys.privateKeyJwk, CAMPAIGN);
        opened += 1;
      } catch (err) {
        assert.ok(err instanceof CodeError);
      }
    }
    assert.equal(opened, 1, 'un seul candidat se déchiffre');
    // Un code isolé non recoupé n'a qu'un candidat.
    assert.deepEqual(extractCodeCandidates(`Code : ${a}.`), [{ code: a, candidates: [a] }]);
  });

  test('citation recoupée à nouveau (« peigne » à une ou deux dents) : codes recollés', () => {
    const mail = ['Voici ma réponse chiffrée. Ouvrez ce lien :', importUrl(a, b), '', 'Empreinte : A1B2-C3D4', '', c, '', 'Merci'].join('\n');
    for (const [width, times] of [[72, 2], [76, 2], [80, 3]]) {
      let text = mail;
      for (let k = 0; k < times; k += 1) text = wrap(text, width, '> ');
      const lengths = text.split('\n').map((l) => l.length);
      assert.ok(lengths.includes(width) && lengths.some((n) => n <= 8), 'prérequis : lignes longues et « dents »');
      assert.deepEqual(extractCodes(text), [a, b, c], `${width} colonnes, ${times} citations`);
      // Mot collé juste après le code : si la dernière dent tombe juste, le recollage est indécidable,
      // mais le bon code reste parmi les candidats.
      let glued = [c, 'Merci'].join('\n');
      for (let k = 0; k < times; k += 1) glued = wrap(glued, width, '> ');
      assert.ok(extractCodeCandidates(glued)[0].candidates.includes(c), `${width} colonnes, ${times} citations, mot collé`);
    }
  });

  test('extraction linéaire sur un grand texte recoupé', () => {
    const block = `${wrap(importUrl(a), 76)}\n`;
    const noise = `${'x'.repeat(76)}\n`.repeat(20000);
    const big = `${block}\n${noise}${block}\nRCN1.${'y'.repeat(75)}\n${noise}`;
    const start = performance.now();
    const found = extractCodes(big);
    assert.ok(performance.now() - start < 2000, 'moins de 2 s');
    assert.equal(found[0], a);
    assert.equal(found.length, 2, 'code et bruit : 2 candidats distincts');
    assert.ok(found[1].length <= 12000 + 76, 'taille plafonnée');
  });

  test('codeHash : SHA-256 hexadécimal de la chaîne', async () => {
    assert.equal(await codeHash(a), createHash('sha256').update(a, 'utf8').digest('hex'));
    assert.notEqual(await codeHash(a), await codeHash(b));
  });
});

describe('codes : validateurs', () => {
  test('isValidDay', () => {
    for (const ok of ['2026-09-29', '2028-02-29', '2026-12-31']) assert.ok(isValidDay(ok), ok);
    for (const ko of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-9-29', '2026-09-29T00:00:00Z', '', null, 20260929]) assert.ok(!isValidDay(ko), String(ko));
  });

  test('isIsoTimestamp', () => {
    for (const ok of ['2026-09-29T14:03:12.345Z', '2026-09-29T14:03Z', '2026-09-29T14:03:12+02:00']) assert.ok(isIsoTimestamp(ok), ok);
    for (const ko of ['2026-09-29', '2026-09-29T24:00:00Z', '2026-09-29T14:03:12', '2026-02-30T10:00:00Z', 'hier']) assert.ok(!isIsoTimestamp(ko), ko);
  });

  test('isCampaignId et validatePlain', () => {
    assert.ok(isCampaignId('demo'));
    assert.ok(isCampaignId(CAMPAIGN));
    assert.ok(!isCampaignId('court'));
    assert.ok(!isCampaignId('a'.repeat(33)));
    const res = validatePlain(plainFor(), CAMPAIGN);
    assert.equal(res.ok, true);
    assert.equal(validatePlain(plainFor(), 'AutreCampagne01').reason, 'campaign');
  });
});
