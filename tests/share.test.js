import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelInfo, anonymityWarning, listChannelTypes, validateChannels, normalizeTarget, senderFlag,
  isChannelAvailable, normalizePhone, isSafeUrl, isResponseCode, CHANNELS_MAX,
} from '../src/share/channels.js';
import {
  sanitizeText, isValidEmail, mailtoUrl, whatsappUrl, teamsShareUrl, gmailComposeUrl, outlookComposeUrl,
  importLink, planMailto, MAILTO_MAX, SERVICE_URLS, UrlError,
} from '../src/share/urls.js';
import { readFileSync, readdirSync } from 'node:fs';
import { loadJson, fakeCode, BASE_URL, FAKE_JWK, ROOT } from './helpers/share-fixtures.js';

const channelsData = loadJson('data/channels.json');
const templates = loadJson('data/messages.fr.json');
const CTX = { title: 'Recensement IA 2026', org: 'Menuiserie Alpine Concept', mode: 'anonymous', fingerprint: 'A1B2C3D4', channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] };

// --- data/channels.json ------------------------------------------------------

test('channels.json : types, drapeaux et cibles conformes au CDC §7.7', () => {
  const t = channelsData.types;
  assert.deepEqual(Object.keys(t), ['mailto', 'copy', 'file', 'share', 'teams', 'whatsapp']);
  const expect = {
    mailto: ['yes', 'email', true], copy: ['depends', 'instruction', false], file: ['depends', 'instruction', false],
    share: ['depends', null, false], teams: ['yes', null, false], whatsapp: ['yes', 'phone', false],
  };
  for (const [type, [flag, target, required]] of Object.entries(expect)) {
    assert.equal(t[type].identifies_sender, flag, `${type} : identifies_sender`);
    assert.equal(t[type].target, target, `${type} : target`);
    assert.equal(Boolean(t[type].target_required), required, `${type} : target_required`);
    assert.ok(t[type].label && t[type].help && t[type].via, `${type} : libellés`);
  }
  assert.equal(t.copy.target_max, 200);
  assert.equal(t.file.target_max, 200);
  assert.equal(t.share.runtime_detection, 'web_share');
  assert.equal(channelsData.max_channels, CHANNELS_MAX);
  assert.deepEqual(channelsData.guaranteed, ['copy', 'mailto', 'share']);
  assert.ok(channelsData.notes.some((n) => /Slack/.test(n) && /Copier/.test(n)));
});

test('channels.json : services tiers datés, à vérifier à chaque version, conformes à urls.js', () => {
  const s = channelsData.services;
  assert.deepEqual(Object.keys(s).sort(), ['gmail', 'outlook_web', 'teams', 'whatsapp']);
  for (const [name, service] of Object.entries(s)) {
    assert.equal(service.last_checked, '2026-09-29', name);
    assert.equal(service.to_verify_each_release, true, name);
    assert.ok(service.url_template.startsWith(SERVICE_URLS[name]), `${name} : même URL que urls.js`);
  }
  const fillT = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k]));
  const mail = { to: 'ia@exemple.fr', subject: 'Objet é', body: 'Corps & suite' };
  assert.equal(gmailComposeUrl(mail), fillT(s.gmail.url_template, mail));
  assert.equal(outlookComposeUrl(mail), fillT(s.outlook_web.url_template, mail));
  assert.equal(teamsShareUrl('https://exemple.fr/#/i/x', 'Texte'), fillT(s.teams.url_template, { href: 'https://exemple.fr/#/i/x', text: 'Texte' }));
  assert.equal(whatsappUrl('Texte'), fillT(s.whatsapp.url_template, { text: 'Texte' }));
  assert.equal(whatsappUrl('Texte', '+33 6 12 34 56 78'), fillT(s.whatsapp.url_template_with_phone, { text: 'Texte', phone: '33612345678' }));
});

// --- channels.js -------------------------------------------------------------

test('channelInfo et listChannelTypes', () => {
  const info = channelInfo('mailto', channelsData);
  assert.equal(info.identifies_sender, 'yes');
  assert.equal(info.identifies_sender_label, "Identifie l'expéditeur");
  assert.equal(info.target, 'email');
  assert.equal(info.target_required, true);
  assert.equal(channelInfo('copy', channelsData).identifies_sender_label, 'Anonymat selon le canal de dépôt');
  assert.equal(channelInfo('share', channelsData).target, null);
  for (const bad of ['slack', '__proto__', 'constructor', undefined, null, 3]) assert.equal(channelInfo(bad, channelsData), null);
  assert.equal(listChannelTypes(channelsData).length, 6);
  assert.equal(senderFlag('inconnu', channelsData), 'yes', 'type inconnu : hypothèse prudente');
});

test('anonymityWarning : selon le mode et le drapeau du canal', () => {
  assert.equal(anonymityWarning('anonymous', 'mailto', channelsData),
    "Votre réponse est anonyme, mais l'envoi par e-mail ne l'est pas : le destinataire verra qui l'envoie.");
  assert.equal(anonymityWarning('anonymous', 'whatsapp', channelsData),
    "Votre réponse est anonyme, mais l'envoi par WhatsApp ne l'est pas : le destinataire verra qui l'envoie.");
  for (const type of ['copy', 'file', 'share']) {
    assert.match(anonymityWarning('anonymous', type, channelsData), /l'anonymat de l'envoi, lui, dépend du canal de dépôt/);
  }
  assert.match(anonymityWarning('anonymous', 'inconnu', channelsData), /ne l'est pas/);
  assert.match(anonymityWarning('open', 'mailto', channelsData), /^Réponse nominative/);
  assert.throws(() => anonymityWarning('public', 'mailto', channelsData), TypeError);
  const data = structuredClone(channelsData);
  data.types.anon = { label: 'Anonyme', identifies_sender: 'no', via: 'par formulaire' };
  assert.equal(anonymityWarning('anonymous', 'anon', data), null);
});

test('validateChannels : cibles, doublons, types inconnus, maximum de 3', () => {
  const ok = validateChannels([
    { type: 'mailto', target: ' ia@exemple.fr ' },
    { type: 'copy', target: 'Collez\u202E ici\u0007' },
    { type: 'whatsapp', target: '+33 6 12 34 56 78' },
  ], channelsData);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, [
    { type: 'mailto', target: 'ia@exemple.fr' },
    { type: 'copy', target: 'Collez ici' },
    { type: 'whatsapp', target: '33612345678' },
  ]);
  const codes = (list) => validateChannels(list, channelsData).errors.map((e) => e.code);
  assert.deepEqual(codes([{ type: 'mailto' }]), ['target_required']);
  assert.deepEqual(codes([{ type: 'mailto', target: 'a@b.fr?cc=x@y.fr' }]), ['invalid_email']);
  assert.deepEqual(codes([{ type: 'whatsapp', target: '06 12 34 56 78' }]), ['invalid_phone']);
  assert.deepEqual(codes([{ type: 'copy', target: 'x'.repeat(201) }]), ['target_too_long']);
  assert.deepEqual(codes([{ type: 'share', target: 'x' }]), ['unexpected_target']);
  assert.deepEqual(codes([{ type: 'copy' }, { type: 'copy' }]), ['duplicate_type']);
  assert.deepEqual(codes([{ type: 'slack' }]), ['unknown_type']);
  assert.deepEqual(codes([{ type: 'copy' }, { type: 'file' }, { type: 'share' }, { type: 'teams' }]), ['too_many']);
  assert.deepEqual(codes('mailto'), ['not_array']);
  assert.equal(normalizeTarget('mailto', 'IA@Exemple.fr', channelsData), 'IA@Exemple.fr');
  assert.equal(normalizeTarget('share', 'x', channelsData), '');
  assert.equal(normalizeTarget('whatsapp', '+33 6 12 34 56 78', channelsData), '33612345678');
});

test('isChannelAvailable : Web Share détecté à l\'exécution', () => {
  assert.equal(isChannelAvailable('share', channelsData, { navigator: {} }), false);
  assert.equal(isChannelAvailable('share', channelsData, { navigator: { share: async () => {} } }), true);
  assert.equal(isChannelAvailable('mailto', channelsData, {}), true);
  assert.equal(isChannelAvailable('slack', channelsData, {}), false);
});

// --- sanitizeText, isValidEmail -----------------------------------------------

test('sanitizeText : contrôles C0/C1, bidi, invisibles, normalisation, troncature', () => {
  assert.equal(sanitizeText('a\u0000b\u0007c\u001Fd\u007Fe\u0080f\u009Fg'), 'abcdefg');
  assert.equal(sanitizeText('a\u202Ab\u202Bc\u202Cd\u202De\u202Ef\u2066g\u2067h\u2068i\u2069j\u200Ek\u200Fl'), 'abcdefghijkl');
  assert.equal(sanitizeText('a\u200Bb\uFEFFc\u00ADd'), 'abcd');
  assert.equal(sanitizeText('  un \t deux\u2003trois  '), 'un deux trois');
  assert.equal(sanitizeText('ligne 1\r\nligne 2\rligne 3\u2028ligne 4'), 'ligne 1 ligne 2 ligne 3 ligne 4');
  assert.equal(sanitizeText('l1 \r\nl2\n\n\n\nl3\u0085l4', Infinity, { multiline: true }), 'l1\nl2\n\nl3\nl4');
  assert.equal(sanitizeText('é'), 'é', 'NFC');
  assert.equal(sanitizeText('abcdef', 3), 'abc');
  assert.equal(sanitizeText('ab\u{1F600}', 3), 'ab', 'pas de paire de substitution coupée');
  assert.equal(sanitizeText('a\uD800b'), 'ab', 'substitut isolé retiré');
  assert.equal(sanitizeText('a\uDC00b\uD83D'), 'ab', 'substituts bas et haut isolés retirés');
  assert.equal(sanitizeText('\u{1F600}\uDC00\u{1F4A1}'), '\u{1F600}\u{1F4A1}', 'paires valides conservées');
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(42), '42');
  assert.equal(sanitizeText('« titre » d\u00A0: x'), '« titre » d\u00A0: x', 'insécables conservées');
});

test('sanitizeText : tous les invisibles de mise en forme (Cf) et les remplisseurs hangûl retirés, liants conservés', () => {
  const cp = (...codes) => String.fromCodePoint(...codes);
  const tags = cp(0xe0001) + [...'secret'].map((l) => cp(0xe0000 + l.charCodeAt(0))).join('') + cp(0xe007f);
  assert.equal(sanitizeText(`Recensement${tags} IA`), 'Recensement IA', 'étiquettes Unicode (texte caché)');
  assert.equal(sanitizeText(`a${cp(0x180e, 0x2061, 0x2064, 0x206a, 0x206f, 0xfff9)}b${cp(0xfffb)}`), 'ab');
  assert.equal(sanitizeText(`a${cp(0x115f, 0x1160, 0x3164, 0xffa0)}b`), 'ab', 'remplisseurs hangûl');
  assert.equal(sanitizeText(`l1${tags}\nl2${cp(0x3164)}`, Infinity, { multiline: true }), 'l1\nl2');
  const emoji = cp(0x1f469, 0x200d, 0x1f4bb);
  assert.equal(sanitizeText(`${emoji} ${cp(0x2764, 0xfe0f)}`), `${emoji} ${cp(0x2764, 0xfe0f)}`, 'liant et sélecteur de variante conservés');
  assert.equal(sanitizeText(`a${cp(0x200c)}b`), `a${cp(0x200c)}b`, 'antiliant conservé');
  assert.equal(sanitizeText(`Cafe${cp(0x200b, 0x301)}`), 'Caf\u00e9', 'NFC après le retrait');
  const url = mailtoUrl({ to: 'ia@exemple.fr', subject: `Objet${tags}`, body: `Corps${tags}${cp(0x3164)}` });
  assert.ok(!/%F3%A0/i.test(url) && !/%E3%85%A4/i.test(url), 'aucune étiquette ni remplisseur dans le mailto');
});

test('isValidEmail : stricte', () => {
  for (const ok of ['ia@exemple.fr', 'prenom.nom+ia@sous.domaine.exemple.com', 'a_b-c@xn--exemple-9ua.fr', 'x1@a-b.io']) {
    assert.equal(isValidEmail(ok), true, ok);
  }
  const bad = [
    '', 'ia', 'ia@', '@exemple.fr', 'ia@exemple', 'ia@exemple.f', 'ia @exemple.fr', 'ia@exemple.fr ',
    'ia@exemple.fr?cc=x@y.fr', 'ia&x@exemple.fr', 'ia#x@exemple.fr', 'ia%40x@exemple.fr', 'a@b.fr,c@d.fr',
    'ia@exemple.fr\r\nBcc: x@y.fr', 'ia\u0000@exemple.fr', '.ia@exemple.fr', 'ia.@exemple.fr', 'i..a@exemple.fr',
    'ia@-exemple.fr', 'ia@exemple-.fr', 'ia@exemple..fr', 'ié@exemple.fr', 'ia@exémple.fr', '<ia@exemple.fr>',
    '"ia"@exemple.fr', 'ia@exemple.fr;x@y.fr', 'ia@[127.0.0.1]', `${'a'.repeat(65)}@exemple.fr`,
    `a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(60)}.fr`, null, undefined, 42,
  ];
  for (const s of bad) assert.equal(isValidEmail(s), false, String(s));
});

test('normalizePhone, isSafeUrl, isResponseCode', () => {
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '33612345678');
  assert.equal(normalizePhone('0033 (6) 12.34.56.78'), '33612345678');
  assert.equal(normalizePhone('+33 (0)6 12 34 56 78'), '33612345678', 'préfixe national (0) retiré');
  assert.equal(normalizePhone('+33 ( 0 ) 6 12 34 56 78'), '33612345678');
  assert.equal(normalizePhone('+44 (0)20 7946 0958'), '442079460958');
  assert.equal(normalizePhone('06 12 34 56 78'), '');
  assert.equal(normalizePhone('33612345678'), '33612345678', 'format du lien (chiffres seuls)');
  assert.equal(normalizePhone('1234567'), '1234567');
  assert.equal(normalizePhone('123456'), '');
  assert.equal(normalizePhone('+33 6 12 34 56 78\n'), '33612345678');
  assert.equal(normalizePhone('+33 6 12 34 56 78 ; x'), '');
  assert.equal(normalizePhone('+0 12 34'), '');
  assert.equal(normalizePhone('+33 6 12 34 56 78 90 12 34'), '');
  assert.equal(isSafeUrl('https://manicalabs.github.io/Recensia/#/c/abc_-'), true);
  assert.equal(isSafeUrl('http://localhost:8765/Recensia/'), true);
  for (const bad of ['javascript:alert(1)', 'https://a b.fr', 'https://x.fr/"><script>', 'ftp://x.fr', 'https://', '//x.fr', 'data:text/html,x']) {
    assert.equal(isSafeUrl(bad), false, bad);
  }
  assert.equal(isResponseCode(fakeCode(100)), true);
  assert.equal(isResponseCode('RCN1.abc'), false);
  assert.equal(isResponseCode(`RCN2.${'a'.repeat(40)}`), false);
  assert.equal(isResponseCode(`RCN1.${'a'.repeat(40)}+`), false);
});

// --- URL -----------------------------------------------------------------------

test('mailtoUrl : encodage, sauts de ligne en %0D%0A, adresse validée', () => {
  const url = mailtoUrl({ to: 'ia@exemple.fr', subject: 'Réponse & suite = 100 % #1 +', body: 'Ligne 1\nLigne 2 ?\r\nFin' });
  assert.equal(url, 'mailto:ia@exemple.fr?subject=R%C3%A9ponse%20%26%20suite%20%3D%20100%20%25%20%231%20%2B&body=Ligne%201%0D%0ALigne%202%20%3F%0D%0AFin');
  assert.ok(!/%0A/.test(url.replace(/%0D%0A/g, '')), 'aucun %0A isolé');
  assert.equal(mailtoUrl({ subject: 'Objet' }), 'mailto:?subject=Objet');
  assert.equal(mailtoUrl({ to: 'ia@exemple.fr' }), 'mailto:ia@exemple.fr');
  assert.equal(mailtoUrl({ to: 'a+b@exemple.fr' }), 'mailto:a%2Bb@exemple.fr');
  assert.throws(() => mailtoUrl({ to: 'ia@exemple.fr?bcc=x@y.fr' }), (e) => e instanceof UrlError && e.code === 'invalid_email');
  assert.throws(() => mailtoUrl({ to: 'ia@exemple.fr\r\nBcc: x@y.fr' }), UrlError);
});

test('mailtoUrl : injection d\'en-têtes impossible', () => {
  const url = mailtoUrl({
    to: 'ia@exemple.fr',
    subject: 'Objet\r\nBcc: pirate@exemple.fr\n&cc=pirate@exemple.fr',
    body: 'Texte&bcc=pirate@exemple.fr&to=autre@exemple.fr#frag',
  });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'mailto:');
  assert.equal(parsed.pathname, 'ia@exemple.fr');
  assert.deepEqual([...parsed.searchParams.keys()], ['subject', 'body']);
  assert.equal(parsed.searchParams.get('subject'), 'Objet Bcc: pirate@exemple.fr &cc=pirate@exemple.fr');
  assert.equal(parsed.searchParams.get('body'), 'Texte&bcc=pirate@exemple.fr&to=autre@exemple.fr#frag');
  assert.equal(parsed.hash, '');
  assert.ok(!/[\r\n]/.test(url));
});

test('whatsappUrl, teamsShareUrl, gmailComposeUrl, outlookComposeUrl', () => {
  assert.equal(whatsappUrl('Bonjour !\nhttps://exemple.fr/#/c/x'), 'https://wa.me/?text=Bonjour%20!%0Ahttps%3A%2F%2Fexemple.fr%2F%23%2Fc%2Fx');
  assert.equal(whatsappUrl('Salut', '0033612345678'), 'https://wa.me/33612345678?text=Salut');
  assert.throws(() => whatsappUrl('x', '06 12'), (e) => e.code === 'invalid_phone');
  assert.equal(teamsShareUrl('https://exemple.fr/#/i/RCN1.x', 'Mon code'), 'https://teams.microsoft.com/share?href=https%3A%2F%2Fexemple.fr%2F%23%2Fi%2FRCN1.x&msgText=Mon%20code');
  assert.throws(() => teamsShareUrl('javascript:alert(1)', 'x'), (e) => e.code === 'invalid_url');
  assert.equal(gmailComposeUrl({ to: 'ia@exemple.fr', subject: 'S', body: 'a\nb' }), 'https://mail.google.com/mail/?view=cm&fs=1&to=ia%40exemple.fr&su=S&body=a%0Ab');
  assert.equal(gmailComposeUrl({ subject: 'S' }), 'https://mail.google.com/mail/?view=cm&fs=1&to=&su=S&body=');
  assert.equal(outlookComposeUrl({ to: 'ia@exemple.fr', subject: 'S', body: 'B' }), 'https://outlook.office.com/mail/deeplink/compose?to=ia%40exemple.fr&subject=S&body=B');
  assert.throws(() => outlookComposeUrl({ to: 'x@y' }), UrlError);
  assert.throws(() => gmailComposeUrl({ to: 'a@b.fr&su=x' }), UrlError);
});

test('importLink : codes joints par ~, fragment d\'origine retiré, codes validés', () => {
  const [a, b] = [fakeCode(80, 1), fakeCode(90, 2)];
  assert.equal(importLink(BASE_URL, [a, b]), `${BASE_URL}#/i/${a}~${b}`);
  assert.equal(importLink(`${BASE_URL}#/admin`, a), `${BASE_URL}#/i/${a}`);
  assert.match(importLink(BASE_URL, [a]), /^[A-Za-z0-9:/._~#-]+$/, 'alphabet sûr pour les messageries');
  assert.throws(() => importLink(BASE_URL, []), (e) => e.code === 'invalid_code');
  assert.throws(() => importLink(BASE_URL, ['RCN1.abc def']), (e) => e.code === 'invalid_code');
  assert.throws(() => importLink('javascript:x', [a]), (e) => e.code === 'invalid_url');
});

// --- planMailto ------------------------------------------------------------------

function checkPlanItem(item, to = 'ia@exemple.fr') {
  assert.ok(item.url.length <= MAILTO_MAX, `mailto ${item.url.length} ≤ ${MAILTO_MAX}`);
  assert.ok(item.url.startsWith(`mailto:${to}?subject=`));
  const parsed = new URL(item.url);
  assert.deepEqual([...parsed.searchParams.keys()], ['subject', 'body']);
  const body = parsed.searchParams.get('body').replace(/\r\n/g, '\n');
  assert.equal(body, item.body);
  const link = importLink(BASE_URL, item.codes);
  assert.ok(body.split('\n').includes(link), 'lien d\'import seul sur sa ligne');
  assert.ok(!body.includes(FAKE_JWK.d));
}

test('planMailto : un seul message quand tout tient', () => {
  const codes = [fakeCode(120, 1), fakeCode(130, 2)];
  const plan = planMailto({ to: 'ia@exemple.fr', codes, baseUrl: BASE_URL, templates, ctx: { ...CTX, private_key_jwk: FAKE_JWK }, channelsData });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].codes, codes);
  assert.equal(plan[0].compact, false);
  checkPlanItem(plan[0]);
  const body = plan[0].body.split('\n');
  for (const code of codes) assert.ok(body.includes(code), 'code brut en secours');
  assert.ok(plan[0].body.includes("Réponses anonymes\u00A0; l'envoi par e-mail, lui, n'est pas anonyme."));
});

test('planMailto : au-delà de 1 800 caractères, un message par code', () => {
  const codes = [fakeCode(300, 1), fakeCode(320, 2), fakeCode(340, 3), fakeCode(360, 4)];
  const plan = planMailto({ to: 'ia@exemple.fr', codes, baseUrl: BASE_URL, templates, ctx: CTX, channelsData });
  assert.equal(plan.length, codes.length);
  plan.forEach((item, i) => {
    assert.deepEqual(item.codes, [codes[i]]);
    assert.equal(item.tooLong, undefined);
    checkPlanItem(item);
  });
});

test('planMailto : corps compact pour un code long, repli fichier au-delà', () => {
  const codes = [fakeCode(700, 1), fakeCode(1700, 2), fakeCode(300, 3)];
  const plan = planMailto({ to: 'ia@exemple.fr', codes, baseUrl: BASE_URL, templates, ctx: CTX, channelsData });
  assert.equal(plan.length, 3);
  assert.equal(plan[0].compact, true, 'code réel (~700 car.) : corps compact');
  checkPlanItem(plan[0]);
  assert.deepEqual(plan[1], { tooLong: true, fallback: 'file', codes: [codes[1]] });
  assert.equal(plan[2].compact, false);
  checkPlanItem(plan[2]);
});

test('planMailto : objet imposé, adresse et codes validés, seuil paramétrable', () => {
  const code = fakeCode(200, 5);
  const [item] = planMailto({ to: 'ia@exemple.fr', subject: 'Mon objet\r\nBcc: x@y.fr', codes: [code], baseUrl: BASE_URL, templates, ctx: CTX, channelsData });
  assert.equal(new URL(item.url).searchParams.get('subject'), 'Mon objet Bcc: x@y.fr');
  assert.throws(() => planMailto({ to: 'pas-une-adresse', codes: [code], baseUrl: BASE_URL, templates, ctx: CTX, channelsData }), (e) => e.code === 'invalid_email');
  assert.throws(() => planMailto({ codes: [code], baseUrl: BASE_URL, templates, ctx: CTX, channelsData }), (e) => e.code === 'invalid_email');
  assert.throws(() => planMailto({ to: 'ia@exemple.fr', codes: ['x'], baseUrl: BASE_URL, templates, ctx: CTX, channelsData }), (e) => e.code === 'invalid_code');
  const tight = planMailto({ to: 'ia@exemple.fr', codes: [code], baseUrl: BASE_URL, templates, ctx: CTX, channelsData, max: 300 });
  assert.equal(tight[0].tooLong, true);
});

test('planMailto : mode ouvert ; données de canaux obligatoires', () => {
  const code = fakeCode(200, 6);
  const [open] = planMailto({ to: 'ia@exemple.fr', codes: [code], baseUrl: BASE_URL, templates, ctx: { ...CTX, mode: 'open' }, channelsData });
  assert.ok(open.body.includes(templates.anonymity_blocks.open));
  assert.throws(() => planMailto({ to: 'ia@exemple.fr', codes: [code], baseUrl: BASE_URL, templates, ctx: CTX }), (e) => e.code === 'missing_data');
});

test('planMailto : codes de taille réelle et titre long accentué tiennent dans un mailto compact', () => {
  const title = 'Recensement général des usages de l\u2019IA générative au sein des équipes – été 2026';
  for (const mode of ['anonymous', 'open']) {
    // Codes réels : 650 à 900 caractères (CDC §17), y compris avec les espaces insécables des gabarits.
    for (const length of [650, 800, 900]) {
      const [item] = planMailto({ to: 'recensement.ia@menuiserie-alpine-concept.fr', codes: [fakeCode(length, 7)], baseUrl: BASE_URL, templates, ctx: { ...CTX, title, mode }, channelsData });
      assert.equal(item.tooLong, undefined, `${mode} / ${length}`);
      assert.equal(item.compact, true);
      assert.ok(item.subject.includes(title), 'le titre reste dans l\'objet');
      checkPlanItem(item, 'recensement.ia@menuiserie-alpine-concept.fr');
    }
  }
});

test('modules de partage : aucune assertion arrière dans les expressions régulières (Safari < 16.4)', () => {
  const dir = `${ROOT}src/share/`;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(dir + name, 'utf8');
    assert.ok(!/\(\?<[=!]/.test(src), `${name} : assertion arrière`);
  }
});
