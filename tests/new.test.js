// Création de campagne (#/new) et onglet « Diffuser » : logique pure.
// src/views/new/build-campaign.js (validation, construction, longueur du lien, mot de passe)
// src/views/new/share-helpers.js (texte riche, phrase verrouillée, mailto, champs publics).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCampaignForm, buildCampaign, draftCampaign, collectUrlLength, linkLengthStatus, defaultForm,
  departmentIssue, departmentKey, mapLinkErrors, passwordStrength, recoveryFilename,
  PLACEHOLDER_ID, PLACEHOLDER_PUBLIC_KEY, LINK_TARGET_LENGTH, MIN_GROUP_SIZE, DEPARTMENTS_MAX,
  DEPARTMENT_SUGGESTION_KEYS,
} from '../src/views/new/build-campaign.js';
import { publicCampaign, textToRichHtml, restoreLockedBlock, mailtoPlan, planMessageMailto } from '../src/views/new/share-helpers.js';
import { validateCampaignConfig, campaignToLinkConfig, buildCollectUrl, decodeCampaignLink } from '../src/crypto/link.js';
import { decodePublicKey, generateCampaignKeys } from '../src/crypto/keys.js';
import { cleanLine, validateUsage } from '../src/engine/validate.js';
import { renderMessage, messageContextFromCampaign, hasLockedBlock, listTemplates } from '../src/share/messages.js';
import { MAILTO_MAX } from '../src/share/urls.js';
import { loadJson, BASE_URL, fakeCollectLink } from './helpers/share-fixtures.js';
import { makeUsage, loadQuestionnaire } from './helpers/load-data.js';

const channelsData = loadJson('data/channels.json');
const templates = loadJson('data/messages.fr.json');
const newCatalog = loadJson('src/i18n/fr/new.json');
const TODAY = '2026-09-29';

const TEN_DEPARTMENTS = ['Direction', 'Commercial et devis', 'Production', 'RH', 'Comptabilité', 'Service client',
  'Marketing', 'Informatique', 'Logistique', 'Qualité'];

function form(overrides = {}) {
  return {
    ...defaultForm(),
    title: 'Recensement des usages IA 2026',
    org_name: 'Menuiserie Alpine Concept',
    departments: [...TEN_DEPARTMENTS],
    channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy', target: 'Collez votre code dans la boîte partagée « IA »' }],
    closes_on: '2026-10-31',
    ...overrides,
  };
}

function check(f) {
  return validateCampaignForm(f, { channelsData, today: TODAY });
}

function fields(result) {
  return result.errors.map((e) => `${e.field}:${e.code}`);
}

let keysPromise;
function keys() {
  keysPromise ??= generateCampaignKeys();
  return keysPromise;
}

async function built(overrides = {}) {
  const r = check(form(overrides));
  assert.ok(r.ok, fields(r).join(', '));
  const k = await keys();
  return buildCampaign(r.value, {
    id: 'k3J9xQ2mP0aZ', publicKey: k.publicKeyB64, privateKeyJwk: k.privateKeyJwk, fingerprint: k.fingerprint,
    createdAt: '2026-09-29T10:00:00.000Z',
  });
}

describe('validateCampaignForm : champs et contraintes', () => {
  test('formulaire complet valide', () => {
    const r = check(form());
    assert.equal(r.ok, true, fields(r).join(', '));
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.mode, 'anonymous');
    assert.deepEqual(r.value.departments, TEN_DEPARTMENTS);
    assert.deepEqual(r.value.settings, {
      min_group_size: 5, department_required: false, comments_exportable: false, closes_on: '2026-10-31',
      group_by_department: false,
      channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy', target: 'Collez votre code dans la boîte partagée « IA »' }],
    });
  });

  test('titre requis, 80 caractères au plus, caractères de contrôle neutralisés', () => {
    assert.deepEqual(fields(check(form({ title: '   ' }))), ['title:required']);
    assert.deepEqual(fields(check(form({ title: 'x'.repeat(81) }))), ['title:too_long']);
    assert.equal(check(form({ title: 'é'.repeat(80) })).ok, true);
    const r = check(form({ title: '  Recensement\t IA\u0007 2026  ' }));
    assert.equal(r.value.title, 'Recensement IA 2026');
    assert.deepEqual(fields(check(form({ org_name: 'o'.repeat(81) }))), ['org_name:too_long']);
    assert.equal(check(form({ org_name: '' })).value.org_name, '');
  });

  test('mode inconnu refusé', () => {
    assert.deepEqual(fields(check(form({ mode: 'secret' }))), ['mode:required']);
  });

  test('services normalisés : espaces (y compris insécables), NFC ; stockés tels que le lien les normalise', () => {
    const r = check(form({ departments: ['  Service\u00A0\u00A0client ', 'Comptabilite\u0301', 'R\tH'] }));
    assert.equal(r.ok, true, fields(r).join(', '));
    assert.deepEqual(r.value.departments, ['Service client', 'Comptabilité', 'R H']);
    for (const d of r.value.departments) assert.equal(cleanLine(d), d);
  });

  test('services : vide, trop long, doublon (sans tenir compte de la casse), trop nombreux', () => {
    assert.deepEqual(fields(check(form({ departments: ['RH', ' '] }))), ['departments.1:empty']);
    assert.deepEqual(fields(check(form({ departments: ['x'.repeat(61)] }))), ['departments.0:too_long']);
    assert.equal(check(form({ departments: ['x'.repeat(60)] })).ok, true);
    assert.deepEqual(fields(check(form({ departments: ['RH', 'Direction', 'rh'] }))), ['departments.2:duplicate']);
    const many = Array.from({ length: DEPARTMENTS_MAX + 1 }, (_, i) => `Service ${i + 1}`);
    assert.deepEqual(fields(check(form({ departments: many }))), ['departments:too_many']);
    assert.equal(check(form({ departments: many.slice(0, DEPARTMENTS_MAX) })).ok, true);
  });

  test('mode ouvert : au moins un service, service toujours obligatoire', () => {
    assert.deepEqual(fields(check(form({ mode: 'open', departments: [] }))), ['departments:required_open']);
    const r = check(form({ mode: 'open', department_required: false }));
    assert.equal(r.ok, true);
    assert.equal(r.value.settings.department_required, true);
  });

  test('mode anonyme : service obligatoire seulement sur demande, et jamais sans liste', () => {
    assert.equal(check(form({ department_required: true })).value.settings.department_required, true);
    assert.equal(check(form({ department_required: false })).value.settings.department_required, false);
    const none = check(form({ departments: [], department_required: true }));
    assert.equal(none.ok, true);
    assert.equal(none.value.settings.department_required, false);
  });

  test('canaux : au moins un en mode anonyme, facultatifs en mode ouvert, 3 au plus', () => {
    assert.deepEqual(fields(check(form({ channels: [] }))), ['channels:required_anonymous']);
    assert.equal(check(form({ mode: 'open', channels: [] })).ok, true);
    const four = [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy' }, { type: 'file' }, { type: 'share' }];
    assert.deepEqual(fields(check(form({ channels: four }))), ['channels:too_many']);
  });

  test('cibles des canaux : e-mail requis et strict, consigne ≤ 200, téléphone normalisé', () => {
    assert.deepEqual(fields(check(form({ channels: [{ type: 'mailto', target: '' }] }))), ['channels.mailto:target_required']);
    for (const bad of ['ia@exemple', 'ia@@exemple.fr', 'ia exemple@exemple.fr', 'ia@exemple.fr?cc=x@y.fr', 'ia@exemple.fr\nBcc:x@y.fr']) {
      assert.deepEqual(fields(check(form({ channels: [{ type: 'mailto', target: bad }] }))), ['channels.mailto:invalid_email'], bad);
    }
    assert.deepEqual(fields(check(form({ channels: [{ type: 'copy', target: 'x'.repeat(201) }] }))), ['channels.copy:target_too_long']);
    assert.equal(check(form({ channels: [{ type: 'copy', target: 'x'.repeat(200) }] })).ok, true);
    assert.deepEqual(check(form({ channels: [{ type: 'copy', target: '   ' }] })).value.settings.channels, [{ type: 'copy' }]);
    const wa = check(form({ channels: [{ type: 'whatsapp', target: '+33 6 12 34 56 78' }] }));
    assert.deepEqual(wa.value.settings.channels, [{ type: 'whatsapp', target: '33612345678' }]);
    assert.deepEqual(fields(check(form({ channels: [{ type: 'whatsapp', target: '06 12 34 56 78' }] }))), ['channels.whatsapp:invalid_phone']);
    assert.deepEqual(fields(check(form({ channels: [{ type: 'teams' }, { type: 'teams' }] }))), ['channels.teams:duplicate_type']);
  });

  test('date de clôture : facultative, valide, pas dans le passé', () => {
    assert.equal(check(form({ closes_on: '' })).value.settings.closes_on, null);
    assert.equal(check(form({ closes_on: TODAY })).ok, true);
    assert.deepEqual(fields(check(form({ closes_on: '2026-09-28' }))), ['closes_on:past']);
    assert.deepEqual(fields(check(form({ closes_on: '2026-02-30' }))), ['closes_on:invalid_date']);
    assert.deepEqual(fields(check(form({ closes_on: '31/10/2026' }))), ['closes_on:invalid_date']);
  });

  test('seuil de masquage : borné en mode anonyme, remplacé par le défaut en mode ouvert', () => {
    assert.equal(check(form({ min_group_size: '7' })).value.settings.min_group_size, 7);
    for (const bad of ['2', '21', '4.5', 'abc', '']) {
      assert.deepEqual(fields(check(form({ min_group_size: bad }))), ['min_group_size:range'], bad);
    }
    assert.equal(check(form({ min_group_size: MIN_GROUP_SIZE.min })).ok, true);
    assert.equal(check(form({ min_group_size: MIN_GROUP_SIZE.max })).ok, true);
    const open = check(form({ mode: 'open', min_group_size: '99' }));
    assert.equal(open.ok, true);
    assert.equal(open.value.settings.min_group_size, MIN_GROUP_SIZE.default);
  });

  test('options d\'export et de registre : non par défaut', () => {
    const r = check(form());
    assert.equal(r.value.settings.comments_exportable, false);
    assert.equal(r.value.settings.group_by_department, false);
    const on = check(form({ comments_exportable: true, group_by_department: true }));
    assert.equal(on.value.settings.comments_exportable, true);
    assert.equal(on.value.settings.group_by_department, true);
  });

  test('chaque code d\'erreur possible a un message dans new.json', () => {
    const cases = [
      form({ title: '' }), form({ title: 'x'.repeat(81) }), form({ org_name: 'o'.repeat(81) }), form({ mode: 'x' }),
      form({ departments: ['', 'x'.repeat(61), 'A', 'a'] }), form({ mode: 'open', departments: [] }),
      form({ departments: Array.from({ length: 31 }, (_, i) => `S${i}`) }), form({ channels: [] }),
      form({ channels: [{ type: 'mailto' }, { type: 'copy', target: 'x'.repeat(201) }, { type: 'whatsapp', target: '0612' }] }),
      form({ channels: [{ type: 'mailto', target: 'x@y' }] }), form({ closes_on: '2020-01-01' }), form({ closes_on: 'x' }),
      form({ min_group_size: '1' }),
    ];
    for (const f of cases) {
      for (const e of check(f).errors) {
        const group = e.field.startsWith('departments.') ? 'department' : e.field.startsWith('channels.') ? 'channel' : e.field;
        assert.equal(typeof newCatalog.errors[group]?.[e.code], 'string', `new.errors.${group}.${e.code}`);
      }
    }
  });
});

describe('buildCampaign : campagne complète (§3.2)', () => {
  test('forme exacte, clé privée présente, aucune sauvegarde ni fichier de récupération', async () => {
    const { ok, campaign } = await built();
    assert.equal(ok, true);
    assert.deepEqual(Object.keys(campaign).sort(), [
      'created_at', 'demo', 'departments', 'fingerprint', 'id', 'last_backup_at', 'mode', 'org_name',
      'private_key_jwk', 'public_key', 'recovery_saved_at', 'settings', 'title',
    ]);
    assert.equal(campaign.demo, false);
    assert.equal(campaign.last_backup_at, null);
    assert.equal(campaign.recovery_saved_at, null);
    assert.equal(campaign.created_at, '2026-09-29T10:00:00.000Z');
    assert.match(campaign.fingerprint, /^[0-9A-F]{8}$/);
    assert.equal(typeof campaign.private_key_jwk.d, 'string');
    assert.deepEqual(Object.keys(campaign.settings).sort(), [
      'channels', 'closes_on', 'comments_exportable', 'department_required', 'group_by_department', 'min_group_size',
    ]);
  });

  test('services, titre et canaux stockés = valeur normalisée du lien', async () => {
    const { campaign } = await built({ title: ' Recensement  IA ', departments: ['  Service\u00A0client', 'Comptabilite\u0301'] });
    const link = validateCampaignConfig(campaignToLinkConfig(campaign));
    assert.equal(link.ok, true);
    assert.deepEqual(campaign.departments, link.value.depts);
    assert.equal(campaign.title, link.value.title);
    assert.equal(campaign.org_name, link.value.org);
    assert.deepEqual(campaign.settings.channels, link.value.channels);
    // Le formulaire répondant compare le service au caractère près : une réponse valide passe.
    const usage = makeUsage({ department: 'Service client' });
    const v = validateUsage(usage, loadQuestionnaire(), { departments: campaign.departments, department_required: true, mode: 'anonymous' });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });

  test('lien de collecte : aller-retour, sans clé privée', async () => {
    const { campaign } = await built();
    const url = buildCollectUrl(BASE_URL, campaign);
    assert.ok(url.startsWith(`${BASE_URL}#/c/`));
    assert.ok(!url.includes(campaign.private_key_jwk.d));
    const config = decodeCampaignLink(url.split('#/c/')[1]);
    assert.equal(config.id, campaign.id);
    assert.deepEqual(config.depts, campaign.departments);
    assert.equal(config.pk, campaign.public_key);
    assert.equal(config.closes, '2026-10-31');
    assert.equal(config.dreq, undefined);
    assert.ok(!JSON.stringify(config).includes(campaign.private_key_jwk.d));
  });

  test('mode ouvert : dreq dans le lien', async () => {
    const { campaign } = await built({ mode: 'open' });
    assert.equal(campaign.settings.department_required, true);
    assert.equal(decodeCampaignLink(buildCollectUrl(BASE_URL, campaign).split('#/c/')[1]).dreq, true);
  });

  test('erreurs du lien ramenées aux champs', () => {
    assert.deepEqual(mapLinkErrors([
      { field: 'title', code: 'chars' }, { field: 'org', code: 'too_long' }, { field: 'depts[2]', code: 'duplicate' },
      { field: 'depts', code: 'too_many' }, { field: 'closes', code: 'invalid_date' }, { field: 'channels[1].target', code: 'invalid_email' },
      { field: 'channels', code: 'too_many' }, { field: 'pk', code: 'invalid_key' },
    ], [{ type: 'copy' }, { type: 'mailto' }]), [
      { field: 'title', code: 'chars' }, { field: 'org_name', code: 'too_long' }, { field: 'departments.2', code: 'duplicate', index: 2 },
      { field: 'departments', code: 'too_many' }, { field: 'closes_on', code: 'invalid_date' },
      { field: 'channels.mailto', code: 'invalid_email', type: 'mailto' }, { field: 'channels', code: 'too_many' },
      { field: 'form', code: 'invalid_key' },
    ]);
  });
});

describe('longueur du lien de collecte', () => {
  test('clé publique et identifiant provisoires bien formés', () => {
    assert.equal(decodePublicKey(PLACEHOLDER_PUBLIC_KEY).length, 65);
    assert.match(PLACEHOLDER_ID, /^[A-Za-z0-9_-]{12}$/);
  });

  test('collectUrlLength = longueur exacte de buildCollectUrl', async () => {
    const { campaign } = await built();
    assert.equal(collectUrlLength(BASE_URL, campaign), buildCollectUrl(BASE_URL, campaign).length);
    assert.equal(collectUrlLength(`${BASE_URL}#/new`, campaign), buildCollectUrl(BASE_URL, campaign).length);
  });

  test('10 services et 2 canaux : moins de 1 500 caractères ; l\'aperçu est fidèle à quelques caractères près', async () => {
    const { campaign } = await built();
    const real = buildCollectUrl(BASE_URL, campaign).length;
    assert.ok(real < LINK_TARGET_LENGTH, `${real}`);
    const preview = collectUrlLength(BASE_URL, draftCampaign(form(), channelsData));
    assert.ok(Math.abs(preview - real) <= 8, `aperçu ${preview}, réel ${real}`);
    assert.equal(linkLengthStatus(real).over, false);
  });

  // Texte varié (la compression réduirait presque à rien des caractères répétés).
  function prose(length, seed) {
    const letters = 'abcdefghijklmnopqrstuvwxyzéèàçôABCDEFGHIJ0123456789';
    let s = seed;
    let out = '';
    while (out.length < length) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      out += (s >>> 16) % 7 === 0 ? ' ' : letters[(s >>> 16) % letters.length];
    }
    return `x${out.slice(1, length - 1)}x`;
  }

  test('titres, services et consignes au maximum : dépassement signalé', () => {
    const f = form({
      title: prose(80, 1), org_name: prose(80, 2),
      departments: Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')} ${prose(57, i + 10)}`),
      channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy', target: prose(200, 3) }, { type: 'file', target: prose(200, 4) }],
    });
    assert.equal(check(f).ok, true);
    const length = collectUrlLength(BASE_URL, draftCampaign(f, channelsData));
    assert.ok(length > LINK_TARGET_LENGTH, `${length}`);
    assert.deepEqual(linkLengthStatus(length), { length, target: 1500, over: true });
    assert.equal(linkLengthStatus(1500).over, false);
    assert.equal(linkLengthStatus(1501).over, true);
  });

  test('aperçu tolérant : champs invalides ignorés, jamais d\'exception', () => {
    const draft = draftCampaign({ title: '', departments: ['A', 'a', ' ', 'B'], channels: [{ type: 'mailto', target: 'x' }, { type: 'nope' }], closes_on: 'x' }, channelsData);
    assert.deepEqual(draft.departments, ['A', 'B']);
    assert.deepEqual(draft.settings.channels, []);
    assert.equal(draft.settings.closes_on, null);
    assert.ok(collectUrlLength(BASE_URL, draft) > BASE_URL.length);
    assert.doesNotThrow(() => collectUrlLength(BASE_URL, draftCampaign(null, null)));
  });
});

describe('services : ajout', () => {
  test('departmentIssue', () => {
    assert.equal(departmentIssue(['RH'], 'Direction'), null);
    assert.equal(departmentIssue(['RH'], '  '), 'empty');
    assert.equal(departmentIssue(['RH'], ' rh '), 'duplicate');
    assert.equal(departmentIssue([], 'x'.repeat(61)), 'too_long');
    assert.equal(departmentIssue(Array.from({ length: 30 }, (_, i) => `S${i}`), 'Autre'), 'too_many');
    assert.equal(departmentKey('Service  CLIENT'), departmentKey('service client'));
  });

  test('suggestions : 8 libellés dans new.json, valides comme services', () => {
    assert.equal(DEPARTMENT_SUGGESTION_KEYS.length, 8);
    const names = DEPARTMENT_SUGGESTION_KEYS.map((k) => newCatalog.departments.suggestions[k]);
    assert.deepEqual(names, ['Direction', 'Commercial', 'Production', 'RH', 'Comptabilité', 'Service client', 'Marketing', 'Informatique']);
    assert.equal(check(form({ departments: names })).ok, true);
  });
});

describe('fichier de récupération', () => {
  test('force indicative du mot de passe', () => {
    assert.deepEqual(passwordStrength(''), { level: 'empty', ok: false, length: 0 });
    assert.equal(passwordStrength('court').level, 'too_short');
    assert.equal(passwordStrength('aaaaaaaaaaaa').level, 'weak');
    assert.equal(passwordStrength('1234567890').level, 'weak');
    assert.equal(passwordStrength('azertyuiop').level, 'weak');
    assert.equal(passwordStrength('motdepasse1').level, 'fair');
    assert.equal(passwordStrength('Motdepasse12!').level, 'good');
    assert.equal(passwordStrength('cheval batterie agrafe').level, 'strong');
    assert.equal(passwordStrength('cheval batterie agrafe').ok, true);
    assert.equal(passwordStrength(null).level, 'empty');
  });

  test('nom du fichier : recensia-cle-<slug>-<EMPREINTE>.recensia-key', () => {
    assert.equal(recoveryFilename({ title: 'Recensement IA : été 2026 !', fingerprint: 'a1b2c3d4' }),
      'recensia-cle-recensement-ia-ete-2026-A1B2C3D4.recensia-key');
    assert.equal(recoveryFilename({ id: 'k3J9xQ2mP0aZ' }), 'recensia-cle-k3j9xq2mp0az-CLE.recensia-key');
  });
});

// ---------------------------------------------------------------------------------------------
// Diffusion
// ---------------------------------------------------------------------------------------------

describe('publicCampaign', () => {
  test('jamais la clé privée ni les champs inconnus', async () => {
    const { campaign } = await built();
    const pub = publicCampaign({ ...campaign, secret: 'x', settings: { ...campaign.settings, extra: 'y' } });
    const json = JSON.stringify(pub);
    assert.ok(!('private_key_jwk' in pub));
    assert.ok(!json.includes(campaign.private_key_jwk.d));
    assert.ok(!json.includes('secret') && !json.includes('extra'));
    assert.equal(buildCollectUrl(BASE_URL, pub), buildCollectUrl(BASE_URL, campaign));
    assert.deepEqual(pub.settings.channels, campaign.settings.channels);
  });
});

describe('textToRichHtml : HTML échappé reconstruit depuis le texte modifié', () => {
  test('tout est échappé ; paragraphes et sauts de ligne', () => {
    const html = textToRichHtml('Bonjour <b>tous</b> & "vous" \'ici\',\n<script>alert(1)</script>\n\nMerci');
    assert.equal(html, '<p>Bonjour &lt;b&gt;tous&lt;/b&gt; &amp; &quot;vous&quot; &#39;ici&#39;,<br>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n<p>Merci</p>');
    assert.equal(textToRichHtml('  \n '), '');
    assert.equal(textToRichHtml('a\r\n\r\nb'), '<p>a</p>\n<p>b</p>');
  });

  test('liens http(s) valides cliquables, ponctuation finale exclue ; javascript: jamais', () => {
    const link = fakeCollectLink(1500);
    const html = textToRichHtml(`Ouvrez ce lien :\n${link}\nou https://exemple.fr/page?a=1&b=2. Fin\njavascript:alert(1) et https://exemple.fr/"x`);
    assert.ok(html.includes(`<a href="${link}">${link}</a>`));
    assert.ok(html.includes('<a href="https://exemple.fr/page?a=1&amp;b=2">https://exemple.fr/page?a=1&amp;b=2</a>. Fin'));
    assert.ok(!/href="javascript/i.test(html));
    assert.ok(html.includes('javascript:alert(1)'));
    assert.ok(html.includes('<a href="https://exemple.fr/">https://exemple.fr/</a>&quot;x'));
  });

  test('adresses e-mail valides en mailto:', () => {
    const html = textToRichHtml('Écrivez à ia@exemple.fr, ou à pas@valide.');
    assert.ok(html.includes('<a href="mailto:ia@exemple.fr">ia@exemple.fr</a>,'));
    assert.ok(!html.includes('mailto:pas@valide'));
  });

  test('message généré puis modifié : liens conservés, ajouts échappés', () => {
    const link = fakeCollectLink(1200);
    const campaign = { title: 'Recensement IA', org_name: 'ACME', mode: 'anonymous', fingerprint: 'A1B2C3D4',
      settings: { closes_on: '2026-10-31', channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] } };
    const msg = renderMessage('invitation_email', messageContextFromCampaign(campaign, { link, duration_min: 3 }), templates, channelsData);
    const edited = msg.body.replace('Bonjour,', 'Bonjour <équipe>,');
    const html = textToRichHtml(edited);
    assert.ok(html.includes('Bonjour &lt;équipe&gt;,'));
    assert.ok(html.includes(`<a href="${link}">`));
    assert.ok(!html.includes('<équipe>'));
  });
});

describe('phrase verrouillée : garde-fou et rétablissement', () => {
  const link = fakeCollectLink(1000);
  const channelSets = [
    [{ type: 'mailto', target: 'ia@exemple.fr' }],
    [{ type: 'copy', target: 'Boîte partagée' }, { type: 'file' }],
    [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'teams' }, { type: 'whatsapp', target: '33612345678' }],
  ];
  const ids = listTemplates(templates, { audience: 'respondents' }).map((x) => x.id);

  function message(id, mode, channels) {
    const campaign = { title: 'Recensement IA', org_name: 'ACME', mode, fingerprint: 'A1B2C3D4', settings: { closes_on: '2026-10-31', channels } };
    return renderMessage(id, messageContextFromCampaign(campaign, { link, duration_min: 3 }), templates, channelsData);
  }

  test('5 gabarits de diffusion (invitations, relances, clôture)', () => {
    assert.deepEqual([...ids].sort(), ['closing_thanks', 'invitation_email', 'invitation_short', 'reminder_j1', 'reminder_j3']);
  });

  for (const mode of ['anonymous', 'open']) {
    test(`${mode} : supprimée ⇒ détectée, rétablie à sa place, pour chaque gabarit et jeu de canaux`, () => {
      for (const id of ids) {
        for (const channels of channelSets) {
          const msg = message(id, mode, channels);
          const block = msg.locked_block;
          assert.equal(hasLockedBlock(msg.body, block), true);
          assert.equal(restoreLockedBlock(msg.body, msg.body, block), msg.body, 'texte intact inchangé');
          const removed = msg.body.replace(block, '');
          assert.equal(hasLockedBlock(removed, block), false, `${id} sans la phrase`);
          const restored = restoreLockedBlock(removed, msg.body, block);
          assert.equal(hasLockedBlock(restored, block), true, `${id} rétabli`);
          assert.equal(restored.split(block).length - 1, 1, `${id} : une seule occurrence`);
          // À sa place d'origine : même position relative que dans le message généré.
          const before = msg.body.slice(0, msg.body.indexOf(block)).trim().split('\n').pop();
          const at = restored.indexOf(block);
          assert.ok(restored.slice(0, at).trim().endsWith(before), `${id} : réinsérée après « ${before} »`);
        }
      }
    });
  }

  test('phrase retouchée (promesse d\'anonymat) : remplacée, pas dupliquée', () => {
    const msg = message('invitation_email', 'anonymous', channelSets[0]);
    const block = msg.locked_block;
    assert.match(block, /n'est pas anonyme/);
    const altered = msg.body.replace("n'est pas anonyme", 'est anonyme');
    assert.equal(hasLockedBlock(altered, block), false);
    const restored = restoreLockedBlock(altered, msg.body, block);
    assert.equal(restored, msg.body);
    assert.ok(!restored.includes("l'envoi par e-mail, lui, est anonyme"));
  });

  test('texte entièrement réécrit : phrase ajoutée à la fin ; texte vide : phrase seule', () => {
    const msg = message('reminder_j3', 'anonymous', channelSets[1]);
    const restored = restoreLockedBlock('Salut,\nrépondez vite !', msg.body, msg.locked_block);
    assert.equal(restored, `Salut,\nrépondez vite !\n\n${msg.locked_block}`);
    assert.equal(restoreLockedBlock('', msg.body, msg.locked_block), msg.locked_block);
  });

  test('message court (une phrase par ligne) : rétablie sur sa ligne', () => {
    const msg = message('invitation_short', 'anonymous', channelSets[0]);
    const lines = msg.body.split('\n');
    const index = lines.findIndex((l) => l.includes(msg.locked_block));
    const removed = lines.filter((_, i) => i !== index).join('\n');
    assert.equal(restoreLockedBlock(removed, msg.body, msg.locked_block), msg.body);
  });

  test('mise en forme retouchée (retours à la ligne, apostrophes typographiques) : toujours présente', () => {
    const msg = message('invitation_email', 'anonymous', channelSets[0]);
    const reflowed = msg.body.replace(msg.locked_block, msg.locked_block.replace(' ; ', ' ;\n').replace(/'/g, '\u2019'));
    assert.equal(hasLockedBlock(reflowed, msg.locked_block), true);
    assert.equal(restoreLockedBlock(reflowed, msg.body, msg.locked_block), reflowed);
  });
});

describe('mailtoPlan : « Ouvrir dans ma messagerie »', () => {
  test('sans destinataire, objet et corps encodés ; dépassement de MAILTO_MAX signalé', () => {
    const small = mailtoPlan({ subject: 'Rappel : « IA » & co', body: 'Bonjour\nLien' });
    assert.equal(small.url, 'mailto:?subject=Rappel%20%3A%20%C2%AB%20IA%20%C2%BB%20%26%20co&body=Bonjour%0D%0ALien');
    assert.equal(small.tooLong, false);
    assert.equal(small.max, MAILTO_MAX);
    const campaign = { title: 'Recensement IA', org_name: 'ACME', mode: 'anonymous', fingerprint: 'A1B2C3D4',
      settings: { closes_on: '2026-10-31', channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] } };
    const msg = renderMessage('invitation_email', messageContextFromCampaign(campaign, { link: fakeCollectLink(1400), duration_min: 3 }), templates, channelsData);
    const big = mailtoPlan({ subject: msg.subject, body: msg.body });
    assert.equal(big.tooLong, true);
    assert.equal(big.length, big.url.length);
    assert.equal(mailtoPlan({ body: 'x'.repeat(100) }, 50).tooLong, true);
  });
});

describe('planMessageMailto : invitation trop longue ⇒ version courte', () => {
  const channels = [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy', target: 'Collez votre code dans la boîte partagée « IA »' }];
  function setup(mode, linkLength) {
    const link = fakeCollectLink(linkLength);
    const campaign = { title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept', mode, fingerprint: 'A1B2C3D4',
      settings: { closes_on: '2026-10-31', channels } };
    const context = messageContextFromCampaign(campaign, { link, duration_min: 3 });
    const plan = (id, edit = (m) => m) => {
      const msg = edit(renderMessage(id, context, templates, channelsData));
      return { msg, plan: planMessageMailto({ templateId: id, subject: msg.subject, body: msg.body, context, templates, channelsData }) };
    };
    return { link, plan };
  }

  for (const mode of ['anonymous', 'open']) {
    test(`${mode} : invitation e-mail (lien de 560 caractères) ⇒ version courte complète, sous la limite`, () => {
      const { link, plan } = setup(mode, 560);
      const { msg, plan: p } = plan('invitation_email');
      assert.equal(p.full.tooLong, true, `${p.full.length}`);
      assert.equal(p.kind, 'short');
      assert.ok(p.url.length <= MAILTO_MAX, `${p.url.length}`);
      assert.equal(p.url, p.short.url);
      const short = renderMessage('invitation_short', setupContext(link, mode), templates, channelsData);
      assert.equal(p.short.body, short.body);
      assert.equal(p.short.subject, msg.subject, 'même objet que l\'invitation e-mail');
      // Lien seul sur sa ligne, phrase verrouillée et empreinte présentes, aucun jeton résiduel.
      assert.ok(p.short.body.split('\n').includes(link));
      assert.ok(p.url.includes(`%0D%0A${encodeURIComponent(link)}%0D%0A`));
      assert.equal(hasLockedBlock(p.short.body, msg.locked_block), true);
      assert.ok(p.short.body.includes('A1B2-C3D4'));
      assert.ok(!/\{[a-z_]+\}/.test(p.short.body));
      assert.ok(p.url.startsWith('mailto:?subject='));
    });
  }

  function setupContext(link, mode) {
    return messageContextFromCampaign({ title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept', mode, fingerprint: 'A1B2C3D4',
      settings: { closes_on: '2026-10-31', channels } }, { link, duration_min: 3 });
  }

  test('objet modifié repris ; corps modifié non repris (version regénérée, phrase toujours présente)', () => {
    const { plan } = setup('anonymous', 560);
    const { msg, plan: p } = plan('invitation_email', (m) => ({ ...m, subject: 'Objet revu', body: m.body.replace(m.locked_block, '') }));
    assert.equal(p.kind, 'short');
    assert.equal(p.short.subject, 'Objet revu');
    assert.ok(decodeURIComponent(p.url).includes('subject=Objet revu'));
    assert.equal(hasLockedBlock(p.short.body, msg.locked_block), true);
  });

  test('message qui tient : envoyé tel quel (y compris modifié)', () => {
    const { plan } = setup('anonymous', 300);
    const { msg, plan: p } = plan('closing_thanks', (m) => ({ ...m, body: `${m.body}\nAjout` }));
    assert.equal(p.kind, 'full');
    assert.equal(p.url, mailtoPlan({ subject: msg.subject, body: msg.body }).url);
    assert.equal(p.short, null);
  });

  test('lien très long : même la version courte dépasse ⇒ « Copier »', () => {
    const { plan } = setup('anonymous', 1500);
    const { plan: p } = plan('invitation_email');
    assert.equal(p.kind, 'too_long');
    assert.equal(p.url, null);
    assert.ok(p.short.length > MAILTO_MAX);
  });

  test('relance trop longue : body_compact des gabarits ⇒ version compacte ; sans lui : « Copier »', () => {
    const { link, plan } = setup('anonymous', 560);
    for (const id of ['reminder_j3', 'reminder_j1']) {
      const { msg, plan: p } = plan(id);
      assert.equal(p.full.tooLong, true, `${id} : ${p.full.length}`);
      assert.equal(p.kind, 'short', id);
      assert.ok(p.url.length <= MAILTO_MAX, `${id} : ${p.url.length}`);
      assert.ok(p.short.body.split('\n').includes(link), `${id} : lien seul sur sa ligne`);
      assert.equal(hasLockedBlock(p.short.body, msg.locked_block), true, id);
      assert.ok(p.short.body.includes('A1B2-C3D4'), id);
    }
    const bare = structuredClone(templates);
    delete bare.templates.reminder_j3.body_compact;
    const bareMsg = renderMessage('reminder_j3', setupContext(link, 'anonymous'), bare, channelsData);
    const none = planMessageMailto({ templateId: 'reminder_j3', subject: bareMsg.subject, body: bareMsg.body, context: setupContext(link, 'anonymous'), templates: bare, channelsData });
    assert.equal(none.kind, 'too_long');
    assert.equal(none.short, null);
    const custom = structuredClone(templates);
    custom.templates.reminder_j3.body_compact = 'Rappel : « {title} ».\n{link}\n{anonymity_block}\nEmpreinte : {fingerprint}';
    const context = setupContext(link, 'anonymous');
    const msg = renderMessage('reminder_j3', context, custom, channelsData);
    const q = planMessageMailto({ templateId: 'reminder_j3', subject: msg.subject, body: msg.body, context, templates: custom, channelsData });
    assert.equal(q.kind, 'short');
    assert.ok(q.short.body.startsWith('Rappel : « Recensement IA 2026 ».'));
    assert.equal(hasLockedBlock(q.short.body, msg.locked_block), true);
  });

  test('aucune version courte sans la phrase verrouillée ; gabarit inconnu sans erreur', () => {
    const { link } = setup('anonymous', 560);
    const context = setupContext(link, 'anonymous');
    const custom = structuredClone(templates);
    custom.templates.invitation_short.body = 'Bonjour !\n{link}';
    const msg = renderMessage('invitation_email', context, custom, channelsData);
    const p = planMessageMailto({ templateId: 'invitation_email', subject: msg.subject, body: msg.body, context, templates: custom, channelsData });
    assert.equal(p.kind, 'too_long');
    assert.equal(p.short, null);
    const u = planMessageMailto({ templateId: 'inconnu', subject: 'x', body: 'y'.repeat(3000), context, templates, channelsData });
    assert.equal(u.kind, 'too_long');
  });
});
