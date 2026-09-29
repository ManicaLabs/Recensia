import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMessage, anonymityBlock, hasLockedBlock, listTemplates, renderTemplate, proseLength,
  publicContext, messageContextFromCampaign, returnChannelText, sheetContent, formatDay,
  formatDuration, formatCount, displayFingerprint, escapeHtml, clipText, MessageError, TOKENS, PUBLIC_CONTEXT_KEYS,
} from '../src/share/messages.js';
import { importLink } from '../src/share/urls.js';
import {
  loadJson, channelSets, fakeCode, fakeCollectLink, BASE_URL, FAKE_JWK, PRIVATE_MARKERS, TARGETS,
} from './helpers/share-fixtures.js';

const templates = loadJson('data/messages.fr.json');
const channelsData = loadJson('data/channels.json');
const limits = templates.limits;
const TEMPLATE_IDS = Object.keys(templates.templates);
const LINK = fakeCollectLink(1500);
const CODES = [fakeCode(650, 11), fakeCode(700, 12)];
const IMPORT_LINK = importLink(BASE_URL, CODES);

const VARIANTS = [
  { name: 'complet', closes_on: '2026-10-31', duration_min: 5, org: 'Menuiserie Alpine Concept', fingerprint: 'A1B2C3D4', title: 'Recensement IA 2026' },
  { name: 'minimal (sans date ni durée ni organisation ni empreinte)', closes_on: null, duration_min: null, org: '', fingerprint: null, title: 'Recensement IA' },
  { name: 'champs à la longueur maximale', closes_on: '2026-10-01', duration_min: 1, org: 'O'.repeat(limits.org_max), fingerprint: 'a1b2-c3d4', title: `Titre ${'é'.repeat(limits.title_max - 6)}` },
];

// Formulations qui promettraient plus que ce que garantit le mode anonyme (CDC §7.4, §15).
const OVERPROMISE_RE = /garanti|totalement anonyme|entièrement anonyme|complètement anonyme|parfaitement anonyme|strictement anonyme|100\s?% anonyme|intraçable|personne ne (?:peut|pourra) (?:savoir|vous identifier)|aucun moyen de (?:savoir|vous identifier)|impossible de (?:savoir|vous identifier)/i;

function htmlToText(html) {
  return html
    .replace(/<\/p>\n<p>/g, '\n\n').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function scopeOf(templateId, channels) {
  const scope = templates.templates[templateId].anonymity_scope;
  return scope ? scope.map((type) => ({ type })) : channels;
}

function flagsOf(channels) {
  const known = channels.filter((c) => Object.hasOwn(channelsData.types, c.type));
  return {
    yes: known.filter((c) => channelsData.types[c.type].identifies_sender === 'yes'),
    depends: known.filter((c) => channelsData.types[c.type].identifies_sender === 'depends'),
  };
}

function checkAnonymityConsistency(locked, mode, scope) {
  const a = templates.anonymity_blocks.anonymous;
  if (mode === 'open') {
    assert.equal(locked, templates.anonymity_blocks.open);
    assert.ok(!/anonyme/i.test(locked), 'le mode ouvert ne parle pas d\'anonymat');
    return;
  }
  assert.ok(locked.startsWith(a.lead), 'annonce le mode anonyme');
  assert.notEqual(locked, `${a.lead}${a.end}`, 'jamais « Réponses anonymes. » sans réserve');
  const { yes, depends } = flagsOf(scope);
  if (yes.length) {
    assert.ok(locked.includes("n'est pas anonyme"), 'canal identifiant signalé');
    for (const c of yes) assert.ok(locked.includes(channelsData.types[c.type].via), `mention de ${c.type}`);
  } else {
    assert.ok(!locked.includes("n'est pas anonyme"), 'pas d\'alerte sans canal identifiant');
  }
  if (depends.length) {
    assert.ok(locked.includes("l'anonymat dépend du canal de dépôt"));
    for (const c of depends) assert.ok(locked.includes(channelsData.types[c.type].via), `mention de ${c.type}`);
  }
  if (!yes.length && !depends.length) assert.ok(locked.includes(a.unknown));
}

function checkMessage(templateId, ctx, msg) {
  const tpl = templates.templates[templateId];
  const all = [msg.subject, msg.body, msg.html, msg.locked_block];
  for (const text of all) {
    assert.ok(!/\{[a-z_]+\}/.test(text), 'aucun jeton résiduel');
    assert.ok(!text.includes('[[') && !text.includes(']]') && !text.includes('||'), 'aucune syntaxe de gabarit résiduelle');
    assert.ok(!/undefined|null|NaN|\[object/.test(text), 'aucune valeur technique');
    for (const marker of PRIVATE_MARKERS) assert.ok(!text.includes(marker), `aucune fuite de ${marker}`);
  }
  assert.ok(!msg.subject.includes('\n'));
  assert.ok(msg.subject.length <= limits.subject_max, `objet ≤ ${limits.subject_max}`);
  assert.equal(Boolean(msg.subject), Boolean(tpl.subject));
  if (tpl.subject && tpl.subject.includes('{title}')) {
    const title = publicContext(ctx, templates, channelsData).title;
    assert.ok(msg.subject.includes(title), 'objet non tronqué : le titre y figure en entier');
  }
  const max = tpl.kind === 'short' ? limits.short_max : limits.body_max;
  assert.ok(proseLength(msg.body) <= max, `corps ${proseLength(msg.body)} ≤ ${max}`);

  const lines = msg.body.split('\n');
  assert.ok(msg.locked_block.length > 0);
  assert.ok(lines.includes(msg.locked_block), 'bloc d\'anonymat seul sur sa ligne');
  assert.ok(hasLockedBlock(msg.body, msg.locked_block));
  checkAnonymityConsistency(msg.locked_block, ctx.mode, scopeOf(templateId, ctx.channels));

  for (const line of lines) {
    if (/https?:\/\//.test(line)) assert.ok(line === ctx.link || line === ctx.import_link, `lien seul sur sa ligne : ${line.slice(0, 60)}`);
    if (line.includes('RCN1.') && line !== ctx.import_link) assert.ok(ctx.codes.includes(line), 'code seul sur sa ligne');
    assert.ok(!/ {2,}/.test(line), 'pas d\'espaces doubles');
    assert.ok(!/ [,.](?:\s|$)/.test(line), 'pas d\'espace avant une virgule ou un point');
    assert.ok(!/\s(?:le|la|à|au|par|de|du|avant)[.,;:]?$/.test(line), `pas de phrase orpheline : ${line}`);
  }
  if (tpl.requires.includes('link')) {
    assert.equal(lines.filter((l) => l.includes(ctx.link)).length, 1, 'lien présent une fois');
    assert.ok(msg.html.includes(`<a href="${escapeHtml(ctx.link)}">`), 'lien cliquable en HTML');
  }
  if (tpl.requires.includes('import_link')) {
    assert.ok(lines.includes(ctx.import_link));
    assert.ok(msg.html.includes(`<a href="${escapeHtml(ctx.import_link)}">`));
  }
  assert.ok(!OVERPROMISE_RE.test(msg.subject + msg.body), 'aucune promesse d\'anonymat excessive');
  const pc = publicContext(ctx, templates, channelsData);
  if (tpl.body.includes('{org}') && pc.org) assert.ok(msg.body.includes(pc.org), 'organisation présente');
  const channelText = returnChannelText(ctx.channels, templates, channelsData);
  if (tpl.body.includes('{return_channel}') && channelText) assert.ok(msg.body.includes(channelText), 'canal de retour présent');
  if (tpl.body.includes('{fingerprint}') && pc.fingerprint) assert.ok(msg.body.includes(displayFingerprint(pc.fingerprint)), 'empreinte présente');
  if (tpl.body.includes('{closes_on}')) {
    const day = ctx.closes_on ? formatDay(ctx.closes_on, templates) : null;
    if (day) assert.ok(msg.body.includes(day), 'date de clôture présente');
    else assert.ok(!/au plus tard|se termine le/.test(msg.body), 'aucune phrase de date sans date');
  }
  assert.equal(htmlToText(msg.html), msg.body, 'le HTML porte le même contenu que le texte');
  assert.ok(!/<(?!\/?(?:p|br|a)\b)/.test(msg.html), 'seules les balises p, br et a');
}

test('toutes les combinaisons gabarit × mode × canaux × variantes sont valides', () => {
  const sets = channelSets(channelsData);
  assert.ok(sets.length > 100);
  let count = 0;
  for (const templateId of TEMPLATE_IDS) {
    for (const mode of ['anonymous', 'open']) {
      for (const { name, channels } of sets) {
        for (const variant of VARIANTS) {
          const ctx = {
            ...variant, mode, channels, link: LINK, codes: CODES, import_link: IMPORT_LINK,
            private_key_jwk: FAKE_JWK, d: FAKE_JWK.d, secret: 'SECRET-DO-NOT-LEAK', settings: { key: FAKE_JWK },
          };
          const msg = renderMessage(templateId, ctx, templates, channelsData);
          try {
            checkMessage(templateId, ctx, msg);
          } catch (err) {
            err.message = `[${templateId} / ${mode} / ${name} / ${variant.name}] ${err.message}`;
            throw err;
          }
          count += 1;
        }
      }
    }
  }
  assert.ok(count > 5000, `${count} rendus vérifiés`);
});

test('bloc d\'anonymat : formulations attendues', () => {
  const block = (mode, types) => anonymityBlock(mode, types.map((type) => ({ type })), templates, channelsData);
  assert.equal(block('anonymous', ['mailto']), "Réponses anonymes ; l'envoi par e-mail, lui, n'est pas anonyme.");
  assert.equal(block('anonymous', ['mailto', 'teams', 'whatsapp']), "Réponses anonymes ; l'envoi par e-mail, par Teams ou par WhatsApp, lui, n'est pas anonyme.");
  assert.equal(block('anonymous', ['copy', 'file']), "Réponses anonymes ; par copier-coller ou par fichier, l'anonymat dépend du canal de dépôt.");
  assert.equal(block('anonymous', ['mailto', 'copy']), "Réponses anonymes ; l'envoi par e-mail, lui, n'est pas anonyme ; par copier-coller, l'anonymat dépend du canal de dépôt.");
  assert.equal(block('anonymous', []), "Réponses anonymes ; l'anonymat dépend aussi du canal par lequel vous transmettez votre code.");
  assert.equal(block('open', ['mailto']), templates.anonymity_blocks.open);
  assert.throws(() => block('secret', []), (e) => e instanceof MessageError && e.code === 'invalid_mode');
});

test('un canal « n\'identifie pas » ne fait jamais disparaître la réserve', () => {
  const data = structuredClone(channelsData);
  data.types.anon_form = { label: 'Formulaire anonyme', identifies_sender: 'no', via: 'par le formulaire anonyme', target: null };
  const locked = anonymityBlock('anonymous', [{ type: 'anon_form' }], templates, data);
  assert.equal(locked, "Réponses anonymes ; l'anonymat dépend aussi du canal par lequel vous transmettez votre code.");
});

test('canaux inconnus ou piégés ignorés (y compris __proto__)', () => {
  const channels = [{ type: '__proto__' }, { type: 'constructor' }, { type: 'toString' }, null, 'mailto', { type: 'copy', target: 'ok' }];
  assert.equal(anonymityBlock('anonymous', channels, templates, channelsData), "Réponses anonymes ; par copier-coller, l'anonymat dépend du canal de dépôt.");
  assert.equal(returnChannelText(channels, templates, channelsData), 'par copier-coller (consigne : ok)');
});

test('sans données de canaux, refus explicite plutôt qu\'un bloc générique ou un canal de retour perdu', () => {
  const missing = (e) => e instanceof MessageError && e.code === 'missing_data';
  assert.throws(() => anonymityBlock('anonymous', [{ type: 'mailto' }], templates, undefined), missing);
  assert.throws(() => anonymityBlock('anonymous', [], templates, {}), missing);
  assert.equal(anonymityBlock('open', [{ type: 'mailto' }], templates, undefined), templates.anonymity_blocks.open);
  const ctx = { title: 'T', mode: 'anonymous', link: LINK, channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] };
  assert.throws(() => renderMessage('invitation_email', ctx, templates), missing, 'appel à trois arguments refusé');
  assert.throws(() => renderMessage('invitation_email', { ...ctx, mode: 'open' }, templates, null), missing);
  assert.throws(() => sheetContent({ campaign: { title: 'T', mode: 'open', settings: {} }, link: LINK, templates }), missing);
});

test('aucun texte destiné aux personnes ne promet plus que le mode (données brutes)', () => {
  const texts = [
    ...Object.values(templates.templates).flatMap((tpl) => [tpl.subject, tpl.body, tpl.body_compact]),
    templates.anonymity_blocks.open, ...Object.values(templates.anonymity_blocks.anonymous),
    ...Object.values(templates.sheet).flat(),
    ...Object.values(channelsData.types).flatMap((t) => [t.label, t.help, t.target_label]),
    ...Object.values(channelsData.sender_labels),
    ...Object.values(channelsData.warnings.anonymous), ...Object.values(channelsData.warnings.open),
  ].filter((x) => typeof x === 'string');
  assert.ok(texts.length > 30);
  for (const text of texts) assert.ok(!OVERPROMISE_RE.test(text), text);
  assert.ok(!/anonyme/i.test(templates.anonymity_blocks.open), 'le mode ouvert ne parle pas d\'anonymat');
  assert.match(templates.anonymity_blocks.open, /e-mail/, 'le mode ouvert signale aussi l\'e-mail facultatif');
});

test('le contexte ne retient que les champs publics : une campagne complète ne fait rien fuiter', () => {
  const campaign = {
    id: 'k3J9xQ2mP0aZ', title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept', mode: 'anonymous',
    departments: ['Direction'], public_key: 'PUBLIC', private_key_jwk: FAKE_JWK, fingerprint: 'A1B2C3D4',
    settings: { channels: [{ type: 'mailto', target: 'ia@exemple.fr' }], closes_on: '2026-10-31', secret: 'SECRET-DO-NOT-LEAK' },
  };
  const pc = publicContext({ ...campaign, link: LINK }, templates, channelsData);
  assert.deepEqual(Object.keys(pc).sort(), [...PUBLIC_CONTEXT_KEYS].sort());
  const direct = renderMessage('invitation_email', { ...campaign, link: LINK }, templates, channelsData);
  const mapped = renderMessage('invitation_email', messageContextFromCampaign(campaign, { link: LINK, duration_min: 4 }), templates, channelsData);
  for (const msg of [direct, mapped]) {
    for (const text of [msg.subject, msg.body, msg.html]) {
      for (const marker of [...PRIVATE_MARKERS, 'PUBLIC', 'k3J9xQ2mP0aZ']) assert.ok(!text.includes(marker), marker);
    }
  }
  assert.ok(direct.body.startsWith('Bonjour,\n\nNous lançons'), 'org_name n\'est pas un champ public du contexte');
  assert.ok(mapped.body.includes('Menuiserie Alpine Concept lance'));
  assert.ok(mapped.body.includes('par e-mail à ia@exemple.fr'));
  assert.ok(mapped.body.includes('31 octobre 2026'));
  assert.ok(mapped.body.includes('(environ 4 minutes)'));
  assert.equal(JSON.stringify(messageContextFromCampaign(campaign)).includes(FAKE_JWK.d), false);
});

test('champs issus du lien nettoyés : contrôles, bidi, sauts de ligne, longueur', () => {
  const title = `Titre\u202E piégé\u0007\r\nBcc: pirate@exemple.fr\u2066${'x'.repeat(300)}`;
  const msg = renderMessage('invitation_email', { title, org: 'Org\u0000\u009F\u200F', mode: 'open', link: LINK }, templates, channelsData);
  assert.ok(!/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F]/.test(msg.subject + msg.body));
  assert.ok(!msg.subject.includes('\n'));
  assert.ok(msg.subject.startsWith('Titre piégé Bcc: pirate@exemple.fr'));
  assert.ok(msg.subject.length <= limits.subject_max);
  const quoted = /« ([^»]*) »/.exec(msg.body)[1];
  assert.ok(quoted.length <= limits.title_max, 'titre tronqué');
  assert.ok(quoted.endsWith('\u2026'), 'troncature signalée');
  assert.ok(msg.body.includes('Org lance'));
});

test('un titre contenant de la syntaxe de gabarit ou du HTML reste littéral et échappé', () => {
  const title = '{link} [[a||b]] <script>alert(1)</script> & "x" \'y\'';
  const msg = renderMessage('invitation_email', { title, mode: 'anonymous', link: LINK, channels: [] }, templates, channelsData);
  assert.ok(msg.body.includes(`« ${title} »`));
  assert.equal(msg.body.split('\n').filter((l) => l.includes(LINK)).length, 1);
  assert.ok(!msg.html.includes('<script'));
  assert.ok(msg.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &#39;y&#39;'));
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('seuls les liens validés deviennent cliquables ; un lien non sûr est refusé', () => {
  const evil = 'javascript:alert(1)';
  assert.throws(() => renderMessage('invitation_email', { title: 'T', mode: 'open', link: evil }, templates, channelsData),
    (e) => e instanceof MessageError && e.code === 'missing_field' && e.detail === 'link');
  const msg = renderMessage('invitation_email', { title: 'Voir https://pirate.example/x', mode: 'open', link: LINK }, templates, channelsData);
  assert.equal((msg.html.match(/<a href="http/g) || []).length, 1, 'seul le lien de collecte est cliquable');
  const withMail = renderMessage('invitation_email', { title: 'T', mode: 'open', link: LINK, channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] }, templates, channelsData);
  assert.ok(withMail.html.includes('<a href="mailto:ia@exemple.fr">ia@exemple.fr</a>'));
});

test('erreurs : gabarit inconnu, champ requis manquant, mode invalide, code invalide', () => {
  const base = { title: 'T', mode: 'open', link: LINK };
  assert.throws(() => renderMessage('nope', base, templates, channelsData), (e) => e.code === 'unknown_template');
  assert.throws(() => renderMessage('__proto__', base, templates, channelsData), (e) => e.code === 'unknown_template');
  assert.throws(() => renderMessage('invitation_email', { ...base, title: '' }, templates, channelsData), (e) => e.code === 'missing_field');
  assert.throws(() => renderMessage('invitation_email', { ...base, mode: 'x' }, templates, channelsData), (e) => e.code === 'invalid_mode');
  assert.throws(() => renderMessage('code_email', { ...base, codes: [] , import_link: IMPORT_LINK }, templates, channelsData), (e) => e.code === 'missing_field');
  assert.throws(() => renderMessage('code_email', { ...base, codes: ['RCN1.abc def'], import_link: IMPORT_LINK }, templates, channelsData), (e) => e.code === 'invalid_code');
  assert.throws(() => renderMessage('code_share', { ...base, codes: CODES, import_link: LINK }, templates, channelsData), (e) => e.code === 'missing_field');
});

test('code_email : bloc d\'anonymat propre à l\'e-mail, compteur, corps compact', () => {
  const ctx = { title: 'T', mode: 'anonymous', channels: [{ type: 'copy' }], codes: [CODES[0]], import_link: importLink(BASE_URL, [CODES[0]]), fingerprint: 'A1B2C3D4' };
  const full = renderMessage('code_email', ctx, templates, channelsData);
  assert.equal(full.locked_block, "Réponses anonymes ; l'envoi par e-mail, lui, n'est pas anonyme.");
  assert.ok(full.body.includes('(1 usage décrit)'));
  const two = renderMessage('code_share', { ...ctx, codes: CODES, import_link: IMPORT_LINK }, templates, channelsData);
  assert.ok(two.body.includes('(2 usages décrits)'));
  assert.equal(formatCount(0, templates), '');
  assert.ok(full.body.split('\n').includes(CODES[0]), 'code brut en secours');
  const compact = renderMessage('code_email', ctx, templates, channelsData, { compact: true });
  assert.ok(!compact.body.split('\n').includes(CODES[0]), 'le corps compact ne répète pas le code');
  assert.ok(compact.body.split('\n').includes(ctx.import_link));
  assert.ok(compact.body.length < full.body.length);
  assert.ok(!compact.body.includes('« T »'), 'titre seulement dans l\'objet du corps compact');
  assert.equal(compact.subject, full.subject);
  const share = renderMessage('code_share', { ...ctx, channels: [{ type: 'copy' }] }, templates, channelsData);
  assert.equal(share.locked_block, "Réponses anonymes ; par copier-coller, l'anonymat dépend du canal de dépôt.");
});

test('hasLockedBlock : présent, tolérant à la mise en forme, absent après suppression', () => {
  const msg = renderMessage('invitation_email', { title: 'T', mode: 'anonymous', link: LINK, channels: [{ type: 'mailto', target: 'a@exemple.fr' }] }, templates, channelsData);
  assert.equal(hasLockedBlock(msg.body, msg.locked_block), true);
  const reflowed = msg.body.replace(msg.locked_block, msg.locked_block.replace(/ /g, '\n').replace(/'/g, '\u2019').replace(' ; ', '\u00A0; '));
  assert.equal(hasLockedBlock(reflowed, msg.locked_block), true);
  assert.equal(hasLockedBlock(msg.body.replace(msg.locked_block, ''), msg.locked_block), false);
  assert.equal(hasLockedBlock(msg.body.replace("n'est pas anonyme", 'est anonyme'), msg.locked_block), false);
  assert.equal(hasLockedBlock('', msg.locked_block), false);
  assert.equal(hasLockedBlock('texte', ''), true);
});

test('listTemplates : les sept gabarits, filtrables par destinataire', () => {
  const ids = listTemplates(templates).map((t) => t.id);
  assert.deepEqual(ids, ['invitation_email', 'invitation_short', 'reminder_j3', 'reminder_j1', 'closing_thanks', 'code_email', 'code_share']);
  assert.deepEqual(listTemplates(templates, { audience: 'manager' }).map((t) => t.id), ['code_email', 'code_share']);
  const invitation = listTemplates(templates)[0];
  assert.deepEqual(invitation, { id: 'invitation_email', label: 'Invitation (e-mail)', audience: 'respondents', kind: 'email', has_subject: true });
  assert.equal(listTemplates(templates).find((t) => t.id === 'invitation_short').has_subject, false);
});

test('gabarits : jetons connus, bloc d\'anonymat et liens seuls sur leur ligne dans la source', () => {
  const tokenSet = new Set(TOKENS);
  for (const [id, tpl] of Object.entries(templates.templates)) {
    for (const src of [tpl.subject, tpl.body, tpl.body_compact].filter(Boolean)) {
      for (const [, key] of src.matchAll(/\{([a-z_]+)\}/g)) assert.ok(tokenSet.has(key), `${id} : jeton ${key}`);
    }
    for (const src of [tpl.body, tpl.body_compact].filter(Boolean)) {
      const lines = src.split('\n');
      for (const token of ['{anonymity_block}', '{link}', '{import_link}', '{codes}']) {
        for (const line of lines.filter((l) => l.includes(token))) assert.equal(line, token, `${id} : ${token} seul sur sa ligne`);
      }
      assert.ok(lines.includes('{anonymity_block}'), `${id} : bloc d'anonymat`);
    }
    assert.ok(!tpl.subject || !/\{(?:link|import_link|codes|anonymity_block)\}/.test(tpl.subject), `${id} : objet sans lien`);
    assert.ok(Array.isArray(tpl.requires));
  }
  for (const id of ['invitation_email', 'invitation_short', 'reminder_j3', 'closing_thanks']) {
    assert.ok(templates.templates[id].body.includes('ni de contrôler ni de sanctionner'), `${id} : ton non punitif`);
  }
  // CDC §7.7 : chaque message prérempli porte titre, entreprise, lien, date de clôture, durée,
  // canal de retour, phrase sur l'anonymat et empreinte (la clôture n'a plus besoin de lien).
  for (const id of ['invitation_email', 'invitation_short', 'reminder_j3', 'reminder_j1']) {
    const src = templates.templates[id].body;
    for (const token of ['{title}', '{org}', '{link}', '{closes_on}', '{duration}', '{return_channel}', '{anonymity_block}', '{fingerprint}']) {
      assert.ok(src.includes(token), `${id} : ${token}`);
    }
  }
  assert.deepEqual(Object.keys(templates.limits).filter((k) => k.endsWith('_max')).sort(), ['body_max', 'org_max', 'short_max', 'subject_max', 'title_max']);
});

test('moteur de gabarits : lignes et groupes facultatifs, insertion en une passe', () => {
  const v = { a: 'A', b: '', c: '{a}' };
  assert.equal(renderTemplate('x {a}\ny {b}\nz', v), 'x A\nz');
  assert.equal(renderTemplate('début[[ {b}|| repli]] fin', v), 'début repli fin');
  assert.equal(renderTemplate('début[[ {a}|| repli]] fin', v), 'début A fin');
  assert.equal(renderTemplate('début[[ {b}]] fin', v), 'début fin');
  assert.equal(renderTemplate('{c}', v), '{a}', 'une valeur n\'est jamais réinterprétée');
  assert.equal(renderTemplate('p1\n\n{b}\n\np2', v), 'p1\n\np2');
});

test('clipText : coupe à un mot entier avec points de suspension', () => {
  assert.equal(clipText('Recensement IA 2026', 120), 'Recensement IA 2026');
  assert.equal(clipText('un deux trois quatre cinq', 16), 'un deux trois\u2026');
  assert.equal(clipText('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghi\u2026');
  assert.ok(clipText('mot '.repeat(80), 120).length <= 120);
  assert.equal(clipText(null, 10), '');
});

test('formats : dates, durées, empreinte', () => {
  assert.equal(formatDay('2026-10-01', templates), '1er octobre 2026');
  assert.equal(formatDay('2026-12-31', templates), '31 décembre 2026');
  assert.equal(formatDay('2026-02-30', templates), '');
  assert.equal(formatDay('31/10/2026', templates), '');
  assert.equal(formatDuration(1, templates), '1 minute');
  assert.equal(formatDuration(12, templates), '12 minutes');
  assert.equal(formatDuration(0, templates), '');
  assert.equal(formatDuration('3.5', templates), '');
  assert.equal(displayFingerprint('a1b2c3d4'), 'A1B2-C3D4');
  assert.equal(displayFingerprint('A1B2-C3D4'), 'A1B2-C3D4');
  assert.equal(displayFingerprint('A1B2C3D'), '');
  assert.equal(displayFingerprint('ZZZZZZZZ'), '');
});

test('canal de retour : avec et sans cible', () => {
  const text = (channels) => returnChannelText(channels, templates, channelsData);
  assert.equal(text([{ type: 'mailto', target: 'ia@exemple.fr' }]), 'par e-mail à ia@exemple.fr');
  assert.equal(text([{ type: 'mailto', target: 'pas une adresse' }]), 'par e-mail');
  assert.equal(text([{ type: 'whatsapp', target: TARGETS.whatsapp }]), 'par WhatsApp au +33612345678');
  assert.equal(text([{ type: 'whatsapp', target: '33612345678' }]), 'par WhatsApp au +33612345678');
  assert.equal(text([{ type: 'whatsapp', target: '06 12' }]), 'par WhatsApp');
  assert.equal(text([{ type: 'share' }, { type: 'teams' }, { type: 'file' }]), 'avec le bouton « Partager » de votre appareil, par Teams ou sous forme de fichier .rcn');
  assert.equal(text([{ type: 'copy', target: `a\u202Eb\nc` }]), 'par copier-coller (consigne : ab c)');
  assert.equal(text([]), '');
});

test('fiche imprimable : textes publics uniquement', () => {
  const campaign = {
    title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept', mode: 'anonymous', fingerprint: 'a1b2c3d4',
    private_key_jwk: FAKE_JWK, settings: { closes_on: '2026-11-01', channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy' }] },
  };
  const c = sheetContent({ campaign, link: LINK, templates, channelsData });
  assert.equal(JSON.stringify(c).includes(FAKE_JWK.d), false);
  assert.equal(c.fingerprint, 'A1B2-C3D4');
  assert.equal(c.steps.length, 3);
  assert.equal(c.steps_slide.length, 3);
  assert.ok(!c.steps_slide[0].includes('lien'), 'la diapositive n\'affiche pas le lien');
  assert.deepEqual(c.channels, ['Par e-mail à ia@exemple.fr', 'Par copier-coller']);
  assert.equal(c.closes, 'Réponses attendues au plus tard le 1er novembre 2026.');
  assert.equal(c.anonymity_block, "Réponses anonymes ; l'envoi par e-mail, lui, n'est pas anonyme ; par copier-coller, l'anonymat dépend du canal de dépôt.");
  assert.equal(c.link, LINK);
  const bare = sheetContent({ campaign: { title: 'T', mode: 'open', settings: {} }, link: LINK, fingerprint: 'FFFF0000', templates, channelsData });
  assert.deepEqual(bare.channels, [templates.sheet.channel_none]);
  assert.equal(bare.closes, '');
  assert.equal(bare.fingerprint, 'FFFF-0000');
  assert.throws(() => sheetContent({ campaign, link: 'ftp://x', templates, channelsData }), (e) => e.code === 'missing_field');
  for (const text of Object.values(c).flat()) assert.ok(!/\{[a-z_]+\}/.test(text));
});

test('fiche imprimable : densité selon la longueur des textes variables', () => {
  const sheet = (title, org, channels, mode = 'anonymous') => sheetContent({
    campaign: { title, org_name: org, mode, settings: { closes_on: '2026-10-31', channels } }, link: LINK, fingerprint: 'A1B2C3D4', templates, channelsData,
  });
  assert.equal(sheet('Recensement IA 2026', 'Menuiserie Alpine Concept', [{ type: 'mailto', target: TARGETS.mailto }, { type: 'copy', target: TARGETS.copy }]).density, 'normal');
  const long = [{ type: 'mailto', target: TARGETS.mailto }, { type: 'copy', target: 'x '.repeat(100).trim() }];
  assert.equal(sheet('Recensement IA 2026', 'Menuiserie Alpine Concept', long, 'open').density, 'dense');
  const worst = sheet('T'.repeat(80), 'O'.repeat(80), [{ type: 'mailto', target: TARGETS.mailto }, { type: 'copy', target: 'c'.repeat(200) }, { type: 'file', target: 'f'.repeat(200) }], 'open');
  assert.equal(worst.density, 'compact');
});
