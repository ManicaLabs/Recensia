// Tests du lien de collecte (CDC §7.2, §7.7, §10.4 ; ARCHITECTURE §4.2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { generateCampaignKeys } from '../src/crypto/keys.js';
import {
  LINK_MAX_PAYLOAD, LINK_VERSION, LinkError, buildCollectUrl, campaignToLinkConfig, decodeAndVerifyCampaignLink,
  decodeCampaignLink, encodeCampaignLink, hasForbiddenChars, isStrictEmail, validateCampaignConfig, verifyCampaignKey,
} from '../src/crypto/link.js';

const BASE_URL = 'https://manicalabs.github.io/Recensia/';
const keys = await generateCampaignKeys();
const ch = (code) => String.fromCharCode(code);

function baseConfig(overrides = {}) {
  return {
    v: 1, id: 'k3J9xQ2mP0aZ', title: 'Recensement IA 2026', org: 'Menuiserie Alpine Concept', mode: 'anonymous',
    depts: ['Direction', 'Commercial et devis', 'Production'], pk: keys.publicKeyB64, ...overrides,
  };
}

/** Encode un objet arbitraire comme le ferait un lien forgé (sans validation). */
const forge = (obj) => deflateRawSync(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))).toString('base64url');

function expectLinkError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof LinkError, `LinkError attendue, reçu ${err?.name} : ${err?.message}`);
    assert.equal(err.code, code, `${err.message} ${JSON.stringify(err.errors)}`);
    return true;
  });
}

/** Le champ `field` doit être refusé (schema) avec le code d'erreur attendu. */
function expectSchema(overrides, field, errCode) {
  const payload = forge(baseConfig(overrides));
  assert.throws(() => decodeCampaignLink(payload), (err) => {
    assert.ok(err instanceof LinkError);
    assert.equal(err.code, 'schema', `${JSON.stringify(overrides)} : ${err.code}`);
    const hit = err.errors.find((e) => e.field === field);
    assert.ok(hit, `aucune erreur sur ${field} : ${JSON.stringify(err.errors)}`);
    if (errCode) assert.equal(hit.code, errCode, `${field} : ${hit.code}`);
    return true;
  });
}

const accepts = (overrides) => decodeCampaignLink(forge(baseConfig(overrides)));

const campaign = {
  id: 'k3J9xQ2mP0aZ',
  title: 'Recensement des usages de l’IA générative — automne 2026',
  org_name: 'Menuiserie Alpine Concept SAS',
  mode: 'anonymous',
  departments: [
    'Direction générale', 'Commercial et devis', 'Production et atelier', 'Ressources humaines', 'Comptabilité et finance',
    'Service client', 'Marketing et communication', 'Achats et logistique', 'Informatique', 'Bureau d’études',
  ],
  settings: {
    min_group_size: 5, department_required: true, comments_exportable: false, closes_on: '2026-10-31', group_by_department: false,
    channels: [
      { type: 'mailto', target: 'referent-ia@menuiserie-alpine-concept.fr', identifies_sender: 'yes', label: 'E-mail' },
      { type: 'copy', target: 'Collez votre code dans le canal Teams « Recensement IA » ou dans la boîte partagée de l’accueil.' },
      { type: 'file', target: null },
    ],
  },
  public_key: keys.publicKeyB64,
  private_key_jwk: keys.privateKeyJwk,
  fingerprint: keys.fingerprint,
  created_at: '2026-09-29T09:00:00.000Z', demo: false, last_backup_at: null, recovery_saved_at: null,
};

describe('lien : encodage et décodage', () => {
  test('aller-retour et payload base64url', () => {
    const cfg = baseConfig({ dreq: true, closes: '2026-10-31', channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'share' }] });
    const payload = encodeCampaignLink(cfg);
    assert.match(payload, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCampaignLink(payload), cfg);
    assert.equal(LINK_VERSION, 1);
  });

  test('normalisation : espaces de bord retirés, NFC, champs nuls omis, ordre canonique', () => {
    const decomposed = 'Re' + 'e' + ch(0x301) + 'dac';
    const out = accepts({ title: '  Recensement  ', org: ` ${decomposed} `, closes: null, channels: [], dreq: null });
    assert.equal(out.title, 'Recensement');
    assert.equal(out.org, 'Re' + ch(0xe9) + 'dac');
    assert.ok(!('closes' in out) && !('channels' in out) && !('dreq' in out));
    assert.deepEqual(Object.keys(out), ['v', 'id', 'title', 'org', 'mode', 'depts', 'pk']);
  });

  test('encodeCampaignLink refuse une configuration invalide', () => {
    expectLinkError(() => encodeCampaignLink(baseConfig({ title: '' })), 'schema');
    expectLinkError(() => encodeCampaignLink(baseConfig({ v: 2 })), 'version');
    expectLinkError(() => encodeCampaignLink(baseConfig({ private_key_jwk: keys.privateKeyJwk })), 'schema');
  });
});

describe('lien : décodage strict (format, taille, version)', () => {
  test('type, vide, alphabet', () => {
    expectLinkError(() => decodeCampaignLink(undefined), 'format');
    expectLinkError(() => decodeCampaignLink(''), 'format');
    const good = encodeCampaignLink(baseConfig());
    for (const bad of ['+', '/', '=', ' ', '%', '.', '~']) {
      expectLinkError(() => decodeCampaignLink(good.slice(0, 20) + bad + good.slice(21)), 'format');
    }
    expectLinkError(() => decodeCampaignLink(good + '='), 'format');
    const pad = (5 - (good.length % 4)) % 4 || 4; // longueur ≡ 1 (mod 4) : impossible en base64url
    expectLinkError(() => decodeCampaignLink(good + 'A'.repeat(pad)), 'format');
  });

  test('longueur maximale du payload vérifiée avant tout décodage', () => {
    expectLinkError(() => decodeCampaignLink('A'.repeat(LINK_MAX_PAYLOAD + 1)), 'size');
    expectLinkError(() => decodeCampaignLink('!'.repeat(LINK_MAX_PAYLOAD + 1)), 'size');
    assert.equal(LINK_MAX_PAYLOAD, 6000);
  });

  test('bombe de décompression dans un lien : size, sans développer la sortie', () => {
    const bomb = forge(`{"v":1,"title":"${'a'.repeat(4_000_000)}"}`);
    assert.ok(bomb.length <= LINK_MAX_PAYLOAD, `bombe de ${bomb.length} caractères`);
    assert.ok(inflateRawSync(Buffer.from(bomb, 'base64url')).length > 3_900_000);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    expectLinkError(() => decodeCampaignLink(bomb), 'size');
    assert.ok(performance.now() - t0 < 200);
    assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024);
  });

  test('JSON décompressé > 16 Ko : size', () => {
    const big = forge(baseConfig({ title: 'x'.repeat(17000) }));
    assert.ok(big.length <= LINK_MAX_PAYLOAD);
    expectLinkError(() => decodeCampaignLink(big), 'size');
  });

  test('octets après la fin du flux DEFLATE : format (encodage non malléable)', () => {
    const good = Buffer.from(encodeCampaignLink(baseConfig()), 'base64url');
    assert.ok(decodeCampaignLink(good.toString('base64url')));
    for (const extra of [[0], [0xff], Buffer.from('donnée cachée dans le lien')]) {
      expectLinkError(() => decodeCampaignLink(Buffer.concat([good, Buffer.from(extra)]).toString('base64url')), 'format');
    }
    // Flux produits par zlib (autre encodeur) : acceptés, sans faux positif.
    for (const level of [1, 6, 9]) {
      assert.ok(decodeCampaignLink(deflateRawSync(Buffer.from(JSON.stringify(baseConfig())), { level }).toString('base64url')));
    }
  });

  test('flux non DEFLATE, JSON invalide ou non objet : format', () => {
    expectLinkError(() => decodeCampaignLink(Buffer.from([0xff, 0xff, 0xff]).toString('base64url')), 'format');
    expectLinkError(() => decodeCampaignLink(forge('{"v":1,')), 'format');
    for (const notObject of ['[1,2]', '"texte"', '42', 'null', 'true']) expectLinkError(() => decodeCampaignLink(forge(notObject)), 'format');
  });

  test('version : absente ou non entière ⇒ schema, non prise en charge ⇒ version', () => {
    const { v, ...noV } = baseConfig();
    expectLinkError(() => decodeCampaignLink(forge(noV)), 'schema');
    expectLinkError(() => decodeCampaignLink(forge(baseConfig({ v: '1' }))), 'schema');
    expectLinkError(() => decodeCampaignLink(forge(baseConfig({ v: 2, nouveau: true }))), 'version');
    expectLinkError(() => decodeCampaignLink(forge(baseConfig({ v: 0 }))), 'version');
  });
});

describe('lien : validation de chaque champ', () => {
  test('clés inconnues refusées (y compris __proto__ et clé privée)', () => {
    expectSchema({ extra: 1 }, 'extra', 'unknown');
    expectSchema({ d: keys.privateKeyJwk.d }, 'd', 'unknown');
    const payload = forge(`{"v":1,"id":"k3J9xQ2mP0aZ","title":"T","org":"","mode":"open","depts":[],"pk":"${keys.publicKeyB64}","__proto__":{"x":1}}`);
    assert.throws(() => decodeCampaignLink(payload), (e) => e.code === 'schema' && e.errors.some((x) => x.field === '__proto__'));
  });

  test('id : base64url 8..32 ou « demo »', () => {
    assert.equal(accepts({ id: 'demo' }).id, 'demo');
    assert.equal(accepts({ id: 'a'.repeat(8) }).id, 'a'.repeat(8));
    assert.equal(accepts({ id: 'A-_'.repeat(10) + 'zz' }).id.length, 32);
    expectSchema({ id: 'a'.repeat(7) }, 'id');
    expectSchema({ id: 'a'.repeat(33) }, 'id');
    expectSchema({ id: 'abc+defgh' }, 'id');
    expectSchema({ id: 'Démo-2026' }, 'id');
    expectSchema({ id: 12345678 }, 'id');
    expectSchema({ id: undefined }, 'id', 'required');
  });

  test('title : 1..80 caractères', () => {
    assert.equal(accepts({ title: 'é'.repeat(80) }).title.length, 80);
    assert.equal(accepts({ title: '🙂'.repeat(80) }).title, '🙂'.repeat(80));
    expectSchema({ title: '' }, 'title', 'required');
    expectSchema({ title: '   ' }, 'title', 'required');
    expectSchema({ title: 'x'.repeat(81) }, 'title', 'too_long');
    expectSchema({ title: 42 }, 'title', 'type');
    expectSchema({ title: undefined }, 'title', 'required');
  });

  test('caractères de contrôle et bidi refusés dans les textes', () => {
    const forbidden = [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x85, 0x9f, 0x061c, 0x200e, 0x200f, 0x2028, 0x2029,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const c of forbidden) {
      const s = `Titre ${ch(c)} piégé`;
      assert.ok(hasForbiddenChars(s), c.toString(16));
      expectSchema({ title: s }, 'title', 'chars');
      expectSchema({ org: s }, 'org', 'chars');
      expectSchema({ depts: ['Direction', s] }, 'depts[1]', 'chars');
      expectSchema({ channels: [{ type: 'copy', target: s }] }, 'channels[0].target', 'chars');
    }
    // Surrogates isolés (casseraient encodeURIComponent dans un mailto).
    expectSchema({ title: `a${ch(0xd800)}b` }, 'title', 'chars');
    expectSchema({ title: `a${ch(0xdc00)}` }, 'title', 'chars');
    assert.ok(!hasForbiddenChars('Accents, « guillemets », espace insécable' + ch(0xa0) + 'et 🙂'));
  });

  test('org : 0..80 caractères, présente', () => {
    assert.equal(accepts({ org: '' }).org, '');
    assert.equal(accepts({ org: 'o'.repeat(80) }).org.length, 80);
    expectSchema({ org: 'o'.repeat(81) }, 'org', 'too_long');
    expectSchema({ org: undefined }, 'org', 'required');
    expectSchema({ org: null }, 'org', 'type');
  });

  test('mode : anonymous | open', () => {
    assert.equal(accepts({ mode: 'open' }).mode, 'open');
    expectSchema({ mode: 'anonyme' }, 'mode', 'enum');
    expectSchema({ mode: undefined }, 'mode', 'required');
  });

  test('depts : ≤ 30 chaînes de 1..60 caractères, uniques', () => {
    const thirty = Array.from({ length: 30 }, (_, i) => `Service ${i + 1}`);
    assert.equal(accepts({ depts: thirty }).depts.length, 30);
    assert.deepEqual(accepts({ depts: [] }).depts, []);
    assert.equal(accepts({ depts: ['d'.repeat(60)] }).depts[0].length, 60);
    expectSchema({ depts: [...thirty, 'Service 31'] }, 'depts', 'too_many');
    expectSchema({ depts: 'Direction' }, 'depts', 'type');
    expectSchema({ depts: undefined }, 'depts', 'required');
    expectSchema({ depts: ['Direction', ''] }, 'depts[1]', 'required');
    expectSchema({ depts: ['d'.repeat(61)] }, 'depts[0]', 'too_long');
    expectSchema({ depts: ['Direction', 3] }, 'depts[1]', 'type');
    expectSchema({ depts: ['Direction', 'RH', 'Direction'] }, 'depts[2]', 'duplicate');
    expectSchema({ depts: ['Direction ', ' Direction'] }, 'depts[1]', 'duplicate');
    expectSchema({ depts: [ch(0xe9) + 'tudes', 'e' + ch(0x301) + 'tudes'] }, 'depts[1]', 'duplicate');
  });

  test('dreq : booléen facultatif', () => {
    assert.equal(accepts({ dreq: true }).dreq, true);
    assert.equal(accepts({ dreq: false }).dreq, false);
    expectSchema({ dreq: 'oui' }, 'dreq', 'type');
    expectSchema({ dreq: 1 }, 'dreq', 'type');
  });

  test('pk : base64url de 65 octets commençant par 0x04, point P-256 vérifié à part', async () => {
    const raw = Buffer.from(keys.publicKeyB64, 'base64url');
    expectSchema({ pk: undefined }, 'pk', 'required');
    expectSchema({ pk: 42 }, 'pk', 'type');
    expectSchema({ pk: raw.subarray(0, 64).toString('base64url') }, 'pk', 'invalid_key');
    expectSchema({ pk: Buffer.concat([raw, Buffer.from([0])]).toString('base64url') }, 'pk', 'invalid_key');
    const compressed = Buffer.from(raw);
    compressed[0] = 0x02;
    expectSchema({ pk: compressed.toString('base64url') }, 'pk', 'invalid_key');
    expectSchema({ pk: raw.toString('base64') }, 'pk', 'invalid_key');

    // Forme correcte mais point hors courbe : accepté par le décodage synchrone, refusé par verifyCampaignKey.
    const offCurve = Buffer.from(raw);
    offCurve[33] ^= 0x10;
    const payload = forge(baseConfig({ pk: offCurve.toString('base64url') }));
    assert.equal(decodeCampaignLink(payload).pk, offCurve.toString('base64url'));
    await assert.rejects(verifyCampaignKey(offCurve.toString('base64url')), (e) => e instanceof LinkError && e.code === 'schema' && e.errors[0].field === 'pk');
    await assert.rejects(decodeAndVerifyCampaignLink(payload), (e) => e instanceof LinkError && e.code === 'schema');
    assert.equal(await verifyCampaignKey(keys.publicKeyB64), true);
    assert.deepEqual(await decodeAndVerifyCampaignLink(encodeCampaignLink(baseConfig())), baseConfig());
  });

  test('closes : date AAAA-MM-JJ valide, facultative', () => {
    assert.equal(accepts({ closes: '2026-10-31' }).closes, '2026-10-31');
    assert.equal(accepts({ closes: '2028-02-29' }).closes, '2028-02-29');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '31/10/2026', '2026-10-31T00:00:00Z', 20261031, '']) {
      expectSchema({ closes: bad }, 'closes', 'invalid_date');
    }
  });

  test('channels : ≤ 3, types connus, clés connues, sans doublon', () => {
    const out = accepts({ channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy' }, { type: 'teams' }] });
    assert.equal(out.channels.length, 3);
    expectSchema({ channels: [{ type: 'copy' }, { type: 'file' }, { type: 'share' }, { type: 'teams' }] }, 'channels', 'too_many');
    expectSchema({ channels: { type: 'copy' } }, 'channels', 'type');
    expectSchema({ channels: ['copy'] }, 'channels[0]', 'type');
    expectSchema({ channels: [{ type: 'slack' }] }, 'channels[0].type', 'enum');
    expectSchema({ channels: [{ target: 'x' }] }, 'channels[0].type', 'required');
    expectSchema({ channels: [{ type: 'copy', label: 'x' }] }, 'channels[0].label', 'unknown');
    expectSchema({ channels: [{ type: 'copy' }, { type: 'copy', target: 'Autre consigne' }] }, 'channels[1].type', 'duplicate');
    expectSchema({ channels: [{ type: 'copy', target: 42 }] }, 'channels[0].target', 'type');
  });

  test('channels mailto : adresse stricte ≤ 254 requise', () => {
    for (const ok of ['ia@exemple.fr', 'referent.ia+recensia@sous.domaine.exemple.co.uk', 'x_y-z@xn--exmple-cua.fr', `${'a'.repeat(64)}@exemple.fr`]) {
      assert.ok(isStrictEmail(ok), ok);
      assert.equal(accepts({ channels: [{ type: 'mailto', target: ok }] }).channels[0].target, ok);
    }
    const bad = [
      'ia', 'ia@', '@exemple.fr', 'ia@exemple', 'ia@exemple.f', 'ia@@exemple.fr', 'i@a@exemple.fr', 'ia @exemple.fr',
      'ia@exemple.fr?subject=Piège', 'ia@exemple.fr&cc=x@y.fr', 'ia@exemple.fr,x@y.fr', 'ia;x@exemple.fr', 'ia@exemple.fr#x',
      'ia%0A@exemple.fr', '<ia@exemple.fr>', '.ia@exemple.fr', 'ia.@exemple.fr', 'i..a@exemple.fr', 'ia@-exemple.fr',
      'ia@exemple-.fr', 'ia@exemple..fr', 'élodie@exemple.fr', 'ia@exémple.fr', `ia@exemple.fr${ch(0x0a)}`, `${'a'.repeat(65)}@exemple.fr`,
      `ia@${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(60)}.fr`,
    ];
    for (const b of bad) {
      assert.ok(!isStrictEmail(b), b);
      expectSchema({ channels: [{ type: 'mailto', target: b }] }, 'channels[0].target');
    }
    expectSchema({ channels: [{ type: 'mailto' }] }, 'channels[0].target', 'required');
    expectSchema({ channels: [{ type: 'mailto', target: '' }] }, 'channels[0].target', 'required');
  });

  test('channels copy / file : consigne facultative ≤ 200', () => {
    assert.equal(accepts({ channels: [{ type: 'copy', target: 'c'.repeat(200) }] }).channels[0].target.length, 200);
    assert.deepEqual(accepts({ channels: [{ type: 'file' }] }).channels, [{ type: 'file' }]);
    assert.deepEqual(accepts({ channels: [{ type: 'file', target: '' }] }).channels, [{ type: 'file' }]);
    expectSchema({ channels: [{ type: 'copy', target: 'c'.repeat(201) }] }, 'channels[0].target', 'too_long');
    expectSchema({ channels: [{ type: 'file', target: 'f'.repeat(201) }] }, 'channels[0].target', 'too_long');
  });

  test('channels whatsapp : numéro international en chiffres facultatif', () => {
    assert.equal(accepts({ channels: [{ type: 'whatsapp', target: '33612345678' }] }).channels[0].target, '33612345678');
    assert.deepEqual(accepts({ channels: [{ type: 'whatsapp' }] }).channels, [{ type: 'whatsapp' }]);
    for (const bad of ['+33612345678', '0612345678', '33 6 12 34 56 78', '336123', '3361234567890123', 'abc']) {
      expectSchema({ channels: [{ type: 'whatsapp', target: bad }] }, 'channels[0].target', 'pattern');
    }
  });

  test('channels share / teams : aucune cible', () => {
    assert.deepEqual(accepts({ channels: [{ type: 'share' }, { type: 'teams' }] }).channels, [{ type: 'share' }, { type: 'teams' }]);
    expectSchema({ channels: [{ type: 'share', target: 'x' }] }, 'channels[0].target', 'forbidden');
    expectSchema({ channels: [{ type: 'teams', target: 'https://teams.example' }] }, 'channels[0].target', 'forbidden');
  });

  test('validateCampaignConfig renvoie toutes les erreurs', () => {
    const res = validateCampaignConfig({ v: 1, id: 'x', title: '', mode: 'autre', depts: 'a', pk: 'b', extra: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.value, null);
    const fields = res.errors.map((e) => e.field).sort();
    assert.deepEqual(fields, ['depts', 'extra', 'id', 'mode', 'org', 'pk', 'title']);
    assert.equal(validateCampaignConfig(null).ok, false);
    assert.equal(validateCampaignConfig([]).ok, false);
  });
});

describe('lien : campagne → lien de collecte', () => {
  test('campaignToLinkConfig ne recopie que les champs publics', () => {
    const cfg = campaignToLinkConfig(campaign);
    assert.deepEqual(Object.keys(cfg), ['v', 'id', 'title', 'org', 'mode', 'depts', 'dreq', 'pk', 'closes', 'channels']);
    assert.equal(cfg.org, campaign.org_name);
    assert.equal(cfg.dreq, true);
    assert.equal(cfg.closes, '2026-10-31');
    assert.deepEqual(cfg.channels, [
      { type: 'mailto', target: 'referent-ia@menuiserie-alpine-concept.fr' },
      { type: 'copy', target: campaign.settings.channels[1].target },
      { type: 'file' },
    ]);
    assert.ok(!JSON.stringify(cfg).includes(keys.privateKeyJwk.d));
    const minimal = campaignToLinkConfig({ ...campaign, org_name: null, settings: { department_required: false, closes_on: null, channels: [] } });
    assert.deepEqual(Object.keys(minimal), ['v', 'id', 'title', 'org', 'mode', 'depts', 'pk']);
    assert.equal(minimal.org, '');
  });

  test('buildCollectUrl : URL complète, fragment de base retiré', () => {
    const url = buildCollectUrl(BASE_URL, campaign);
    assert.ok(url.startsWith(`${BASE_URL}#/c/`));
    assert.equal(buildCollectUrl(`${BASE_URL}#/admin/x`, campaign), url);
    const decoded = decodeCampaignLink(url.slice(`${BASE_URL}#/c/`.length));
    assert.equal(decoded.title, campaign.title);
    assert.deepEqual(decoded.depts, campaign.departments);
  });

  test('lien de collecte < 1 500 caractères avec 10 services, titre, organisation et 3 canaux', () => {
    const url = buildCollectUrl(BASE_URL, campaign);
    assert.equal(campaign.departments.length, 10);
    assert.ok(url.length < 1500, `lien de ${url.length} caractères`);
    assert.match(url.slice(BASE_URL.length), /^#\/c\/[A-Za-z0-9_-]+$/);
  });

  test('aucun matériel de clé privée dans le lien', () => {
    const url = buildCollectUrl(BASE_URL, campaign);
    const payload = url.slice(`${BASE_URL}#/c/`.length);
    const inflated = inflateRawSync(Buffer.from(payload, 'base64url'));
    const json = inflated.toString('utf8');
    const d = keys.privateKeyJwk.d;
    const dBytes = Buffer.from(d, 'base64url');
    for (const haystack of [url, json]) {
      assert.ok(!haystack.includes(d), 'd (base64url) présent');
      assert.ok(!haystack.includes(dBytes.toString('hex')), 'd (hex) présent');
      assert.ok(!haystack.includes(dBytes.toString('base64')), 'd (base64) présent');
      assert.ok(!/private|jwk|"d"/i.test(haystack), 'mention de clé privée');
    }
    assert.equal(inflated.indexOf(dBytes), -1, 'd (octets bruts) présent');
    assert.deepEqual(Object.keys(JSON.parse(json)).filter((k) => !['v', 'id', 'title', 'org', 'mode', 'depts', 'dreq', 'pk', 'closes', 'channels'].includes(k)), []);
  });
});
