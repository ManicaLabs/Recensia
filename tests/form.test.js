// Formulaire répondant et saisie directe : brouillon, révisions, clair des codes selon le mode
// (aller-retour de chiffrement réel), plan d'envoi, entrée manuelle §3.3.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftKey, emptyDraft, restoreDraft, hasContent, upsertItem, removeItem, setCurrent, setRespondent,
  findItem, canonicalContent, codeState, revisionFor, markCoded, checkItems, sanitizeUsageShape,
} from '../src/views/form/draft.js';
import { buildPlain, generateCodes, isClosed, localDay } from '../src/views/form/codes.js';
import {
  effectiveChannels, sendPlan, sharedWarning, distinctWarnings, groupCodes, rcnFilename, rcnContent, DEFAULT_CHANNELS, mailPlan,
} from '../src/views/form/send-plan.js';
import { anonymousLimits, channelLimits, joinOr } from '../src/views/form/notice.js';
import { buildManualEntry, declarantFrom } from '../src/views/form/entry.js';
import { generateCampaignKeys } from '../src/crypto/keys.js';
import { decryptEntry, extractCodes, CODE_PREFIX } from '../src/crypto/codes.js';
import { validateUsage, validateRespondent, SCHEMA_VERSION } from '../src/engine/validate.js';
import { planMailto } from '../src/share/urls.js';
import { loadQuestionnaire, makeUsage, readJson } from './helpers/load-data.js';
import { fakeCode, BASE_URL } from './helpers/share-fixtures.js';
import { installFakeDocument } from './helpers/fake-dom.js';
import { t as i18nT, register as i18nRegister } from '../src/i18n.js';
import { savedNotice } from '../src/views/console/add.js';

const q = loadQuestionnaire();
const channelsData = readJson('data/channels.json');
const templates = readJson('data/messages.fr.json');
const catalogs = { form: readJson('src/i18n/fr/form.json'), questionnaire: readJson('src/i18n/fr/questionnaire.json') };

// t() de test : résout dans les catalogues form et questionnaire ; une clé absente est renvoyée telle quelle.
function t(key, vars = {}) {
  const [ns, ...path] = key.split('.');
  let v = catalogs[ns];
  for (const p of path) v = v && typeof v === 'object' ? v[p] : undefined;
  if (v && typeof v === 'object') v = Number(vars.count) === 1 ? v.one : v.other;
  if (typeof v !== 'string') return key;
  return v.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}
const CID = 'k3J9xQ2mP0aZ';
const ID_A = 'entryAAAAAAAAAAA';
const ID_B = 'entryBBBBBBBBBBB';
const WHO = { first_name: 'Camille', last_name: 'Durand', email: 'camille@exemple.fr' };
const NOW = new Date(2026, 8, 29, 14, 5, 7);

function draftWith(...usages) {
  let d = emptyDraft(CID);
  usages.forEach((usage, i) => { d = upsertItem(d, { usage, newId: [ID_A, ID_B][i] }); });
  return d;
}

describe('brouillon', () => {
  test('clé par campagne, brouillon vide sans contenu', () => {
    assert.equal(draftKey(CID), `form-draft:${CID}`);
    const d = emptyDraft(CID);
    assert.deepEqual(d, { v: 1, campaign_id: CID, respondent: null, items: [], current: null });
    assert.equal(hasContent(d), false);
    assert.equal(hasContent(setCurrent(d, null, { usage_name: 'x' })), true);
  });

  test('upsertItem ajoute (rev 1) puis remplace sans changer entry_id ni rev ; saisie en cours effacée', () => {
    let d = setCurrent(emptyDraft(CID), null, { usage_name: 'brouillon' });
    d = upsertItem(d, { usage: makeUsage(), newId: ID_A });
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].entry_id, ID_A);
    assert.equal(d.items[0].rev, 1);
    assert.equal(d.current, null);
    const before = d;
    d = upsertItem(d, { entryId: ID_A, usage: makeUsage({ usage_name: 'Modifié' }), newId: ID_B });
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].usage.usage_name, 'Modifié');
    assert.equal(before.items[0].usage.usage_name, 'Reformulation de mails', 'immuable');
    assert.throws(() => upsertItem(d, { usage: makeUsage(), newId: 'court' }), TypeError);
  });

  test('removeItem et findItem', () => {
    let d = draftWith(makeUsage(), makeUsage({ usage_name: 'B' }));
    d = setCurrent(d, ID_B, { usage_name: 'en cours' });
    d = removeItem(d, ID_B);
    assert.equal(d.items.length, 1);
    assert.equal(findItem(d, ID_B), null);
    assert.equal(d.current, null, 'la modification en cours de l\'usage supprimé disparaît');
    assert.equal(findItem(d, ID_A).entry_id, ID_A);
  });

  test('restoreDraft : relit un brouillon valide, écarte le reste', () => {
    let d = draftWith(makeUsage());
    d = setRespondent(d, WHO);
    d = markCoded(d, ID_A, { rev: 2, content: canonicalContent(d.items[0].usage, null), code: fakeCode(700) });
    d = setCurrent(d, ID_A, { usage_name: 'suite', extra: 'x' });
    const stored = JSON.parse(JSON.stringify(d));
    const back = restoreDraft(stored, CID, q);
    assert.equal(back.items.length, 1);
    assert.equal(back.items[0].rev, 2);
    assert.equal(back.items[0].coded.code, stored.items[0].coded.code);
    assert.deepEqual(back.respondent, WHO);
    assert.equal(back.current.entry_id, ID_A);
    assert.equal(Object.hasOwn(back.current.value, 'extra'), false);
  });

  test('restoreDraft : autre campagne, autre version ou valeur illisible ⇒ brouillon vide', () => {
    const d = JSON.parse(JSON.stringify(draftWith(makeUsage())));
    assert.deepEqual(restoreDraft(d, 'autreCampagne1', q).items, []);
    assert.deepEqual(restoreDraft({ ...d, v: 2 }, CID, q).items, []);
    for (const raw of [null, 'x', 42, [], { v: 1 }]) assert.deepEqual(restoreDraft(raw, CID, q), emptyDraft(CID));
  });

  test('restoreDraft : entrées mal formées ignorées (identifiant, doublon, code, rev)', () => {
    const raw = {
      v: 1, campaign_id: CID, respondent: 'x', current: { entry_id: 'inconnu', value: 'x' },
      items: [
        { entry_id: 'bad id!', rev: 1, usage: {} },
        { entry_id: ID_A, rev: 5000, usage: makeUsage(), coded: { rev: 1, content: '{}', code: 'pas un code' } },
        { entry_id: ID_A, rev: 1, usage: makeUsage() },
        'x',
      ],
    };
    const back = restoreDraft(raw, CID, q);
    assert.equal(back.items.length, 1);
    assert.equal(back.items[0].rev, 1);
    assert.equal(back.items[0].coded, null);
    assert.equal(back.respondent, null);
    assert.deepEqual(back.current, { entry_id: null, value: {} });
  });

  test('sanitizeUsageShape : clés du questionnaire seulement, textes bornés', () => {
    const out = sanitizeUsageShape({ usage_name: 'a'.repeat(5000), task_types: ['resume', 3], x: 1, comment: { a: 1 } }, q);
    assert.equal(out.usage_name.length, 2000);
    assert.deepEqual(out.task_types, ['resume']);
    assert.equal(out.comment, null);
    assert.equal(Object.hasOwn(out, 'x'), false);
  });

  test('checkItems valide chaque usage avec les règles de la campagne', () => {
    const d = draftWith(makeUsage(), makeUsage({ department: null }));
    const res = checkItems(d, q, { mode: 'open', departments: ['Direction'] });
    assert.equal(res.length, 2);
    assert.ok(res.every((r) => !r.ok), 'service obligatoire en mode ouvert');
    assert.ok(checkItems(d, q, { mode: 'anonymous', departments: ['Direction'] }).every((r) => r.ok));
  });
});

describe('révisions', () => {
  const usage = makeUsage();

  test('premier code : rev 1 ; même contenu : code réutilisé ; contenu modifié : rev + 1 une seule fois', () => {
    let d = draftWith(usage);
    assert.equal(codeState(d.items[0]), 'none');
    assert.deepEqual(revisionFor(d.items[0]), { rev: 1, reuse: false });
    d = markCoded(d, ID_A, { rev: 1, content: canonicalContent(usage), code: fakeCode(700) });
    assert.equal(codeState(d.items[0]), 'current');
    assert.deepEqual(revisionFor(d.items[0]), { rev: 1, reuse: true });
    d = upsertItem(d, { entryId: ID_A, usage: makeUsage({ frequency: 'daily' }) });
    assert.equal(codeState(d.items[0]), 'outdated');
    assert.deepEqual(revisionFor(d.items[0]), { rev: 2, reuse: false });
    d = upsertItem(d, { entryId: ID_A, usage: makeUsage({ frequency: 'monthly' }) });
    assert.deepEqual(revisionFor(d.items[0]), { rev: 2, reuse: false }, 'plusieurs modifications avant un nouveau code : une seule révision');
  });

  test('changer l\'identité (mode ouvert) rend le code périmé', () => {
    let d = draftWith(usage);
    d = markCoded(d, ID_A, { rev: 1, content: canonicalContent(usage, WHO), code: fakeCode(700) });
    assert.equal(codeState(d.items[0], WHO), 'current');
    assert.equal(codeState(d.items[0], { ...WHO, email: null }), 'outdated');
  });

  test('canonicalContent ne dépend pas de l\'ordre des clés', () => {
    const a = canonicalContent({ b: 1, a: [1, { y: 1, x: 2 }] }, { last_name: 'D', first_name: 'C' });
    const b = canonicalContent({ a: [1, { x: 2, y: 1 }], b: 1 }, { first_name: 'C', last_name: 'D' });
    assert.equal(a, b);
  });
});

describe('clair des codes selon le mode', () => {
  test('anonyme : ni identité ni horodatage, date au jour local', () => {
    const plain = buildPlain({ config: { id: CID, mode: 'anonymous' }, entryId: ID_A, rev: 1, usage: makeUsage(), respondent: WHO, now: NOW });
    assert.deepEqual(Object.keys(plain), ['v', 'sv', 'campaign_id', 'entry_id', 'rev', 'submitted_day', 'usage']);
    assert.equal(plain.submitted_day, '2026-09-29');
    assert.equal(plain.sv, SCHEMA_VERSION);
    assert.ok(!JSON.stringify(plain).includes('Camille'));
  });

  test('ouvert : prénom, nom, e-mail facultatif et horodatage complet', () => {
    const plain = buildPlain({ config: { id: CID, mode: 'open' }, entryId: ID_A, rev: 3, usage: makeUsage(), respondent: { ...WHO, email: '' }, now: NOW });
    assert.equal(plain.rev, 3);
    assert.equal(plain.submitted_at, NOW.toISOString());
    assert.deepEqual(plain.respondent, { first_name: 'Camille', last_name: 'Durand', email: null });
    assert.ok(validateRespondent(plain.respondent, 'open').ok);
    assert.throws(() => buildPlain({ config: { id: CID, mode: 'open' }, entryId: ID_A, rev: 1, usage: makeUsage(), now: NOW }), TypeError);
    assert.throws(() => buildPlain({ config: { id: CID, mode: 'x' }, entryId: ID_A, rev: 1, usage: makeUsage() }), TypeError);
  });

  test('localDay et isClosed', () => {
    assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.equal(isClosed('2026-10-31', '2026-10-31'), false, 'le jour même reste ouvert');
    assert.equal(isClosed('2026-10-31', '2026-11-01'), true);
    assert.equal(isClosed(undefined, '2026-11-01'), false);
    assert.equal(isClosed('31/10/2026', '2026-11-01'), false);
  });
});

describe('génération des codes (chiffrement réel)', () => {
  test('anonyme : aller-retour sans identité, deux codes différents pour le même contenu', async () => {
    const keys = await generateCampaignKeys();
    const config = { id: CID, mode: 'anonymous', pk: keys.publicKeyB64 };
    const usage = validateUsage(makeUsage(), q, { mode: 'anonymous', departments: [] }).value;
    const draft = draftWith(usage, usage);
    const usages = new Map(draft.items.map((i) => [i.entry_id, i.usage]));
    const seen = [];
    const { draft: next, codes, generated } = await generateCodes({ config, draft, usages, respondent: WHO, now: NOW, onCode: (x) => seen.push(x) });
    assert.equal(generated, 2);
    assert.equal(seen.length, 2);
    assert.ok(codes.every((c) => c.code.startsWith(CODE_PREFIX) && c.fresh));
    assert.notEqual(codes[0].code, codes[1].code);
    for (const c of codes) {
      const plain = await decryptEntry(c.code, keys.privateKeyJwk, CID);
      assert.equal(plain.respondent, null);
      assert.equal(plain.submitted_at, null);
      assert.equal(plain.submitted_day, '2026-09-29');
      assert.equal(plain.entry_id, c.entry_id);
      assert.ok(validateUsage(plain.usage, q, { mode: 'anonymous', departments: [] }).ok);
    }
    assert.ok(next.items.every((i) => codeState(i, null) === 'current'));
    // Le fichier .rcn produit est relu tel quel par l'import (extractCodes).
    const all = codes.map((c) => c.code);
    assert.deepEqual(extractCodes(rcnContent(all)), all);
  });

  test('ouvert : identité incluse ; régénération sans changement ⇒ code réutilisé ; modification ⇒ rev 2', async () => {
    const keys = await generateCampaignKeys();
    const config = { id: CID, mode: 'open', pk: keys.publicKeyB64 };
    const opts = { mode: 'open', departments: ['Direction'] };
    const usage = validateUsage(makeUsage({ department: 'Direction' }), q, opts).value;
    let draft = draftWith(usage);
    const who = validateRespondent(WHO, 'open').value;
    const first = await generateCodes({ config, draft, usages: new Map([[ID_A, usage]]), respondent: who, now: NOW });
    const plain = await decryptEntry(first.codes[0].code, keys.privateKeyJwk, CID);
    assert.deepEqual(plain.respondent, WHO);
    assert.equal(plain.submitted_at, NOW.toISOString());
    assert.equal(plain.rev, 1);

    const again = await generateCodes({ config, draft: first.draft, usages: new Map([[ID_A, usage]]), respondent: who, now: NOW });
    assert.equal(again.generated, 0);
    assert.equal(again.codes[0].code, first.codes[0].code);
    assert.equal(again.codes[0].fresh, false);

    const changed = { ...usage, frequency: 'daily' };
    draft = upsertItem(first.draft, { entryId: ID_A, usage: changed });
    const third = await generateCodes({ config, draft, usages: new Map([[ID_A, changed]]), respondent: who, now: NOW });
    assert.equal(third.generated, 1);
    const plain3 = await decryptEntry(third.codes[0].code, keys.privateKeyJwk, CID);
    assert.equal(plain3.rev, 2);
    assert.equal(plain3.entry_id, ID_A);
    assert.equal(plain3.usage.frequency, 'daily');
    assert.equal(third.draft.items[0].rev, 2);
  });

  test('chiffrement injectable : le clair transmis est celui de buildPlain', async () => {
    const calls = [];
    const encrypt = async (plain, pk, id) => { calls.push({ plain, pk, id }); return fakeCode(700, calls.length); };
    const draft = draftWith(makeUsage());
    const res = await generateCodes({ config: { id: CID, mode: 'anonymous', pk: 'PK' }, draft, usages: new Map(), now: NOW, encrypt });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pk, 'PK');
    assert.equal(calls[0].id, CID);
    assert.equal(calls[0].plain.entry_id, ID_A);
    assert.equal(res.codes[0].code, fakeCode(700, 1));
  });
});

describe('plan d\'envoi', () => {
  const noShare = { navigator: {} };
  const withShare = { navigator: { share: () => {} } };

  test('sans canal dans le lien : Copier et Fichier', () => {
    assert.deepEqual(effectiveChannels(undefined, channelsData), DEFAULT_CHANNELS.map((c) => ({ type: c.type, target: null })));
    assert.deepEqual(effectiveChannels([{ type: 'inconnu' }], channelsData).map((c) => c.type), ['copy', 'file']);
  });

  test('canaux du lien conservés dans l\'ordre, sans doublon', () => {
    const list = effectiveChannels([{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'mailto', target: 'b@exemple.fr' }, { type: 'whatsapp', target: '33612345678' }], channelsData);
    assert.deepEqual(list, [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'whatsapp', target: '33612345678' }]);
  });

  test('avertissement d\'anonymat propre à chaque canal (anonyme)', () => {
    const plan = sendPlan({ channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy' }], mode: 'anonymous', channelsData, env: noShare });
    assert.match(plan[0].warning, /par e-mail ne l'est pas/);
    assert.match(plan[1].warning, /dépend du canal de dépôt/);
    assert.equal(sharedWarning(plan), null);
    assert.equal(distinctWarnings(plan).length, 2);
  });

  test('mode ouvert : un seul avertissement commun', () => {
    const plan = sendPlan({ channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'file' }], mode: 'open', channelsData, env: noShare });
    assert.match(sharedWarning(plan), /Réponse nominative/);
    assert.equal(distinctWarnings(plan).length, 1);
  });

  test('partage natif absent : canal indisponible et repli « Copier » si plus rien n\'est utilisable', () => {
    const plan = sendPlan({ channels: [{ type: 'share' }], mode: 'anonymous', channelsData, env: noShare });
    assert.equal(plan.length, 2);
    assert.equal(plan[0].available, false);
    assert.equal(plan[0].warning, null, 'aucun avertissement pour un canal inutilisable');
    assert.deepEqual([plan[1].type, plan[1].available, plan[1].fallback], ['copy', true, true]);
    assert.match(sharedWarning(plan), /dépend du canal de dépôt/, 'seul le repli utilisable porte l\'avertissement');
    const ok = sendPlan({ channels: [{ type: 'share' }], mode: 'anonymous', channelsData, env: withShare });
    assert.deepEqual(ok.map((p) => [p.type, p.available]), [['share', true]]);
  });

  test('libellés de bouton issus de data/channels.json', () => {
    const plan = sendPlan({ channels: [{ type: 'teams' }], mode: 'anonymous', channelsData, env: noShare });
    assert.equal(plan[0].button_label, channelsData.types.teams.button_label);
    assert.equal(plan[0].identifies_sender, 'yes');
  });

  test('groupCodes : groupes consécutifs sous la limite, code trop long seul', () => {
    const build = (group) => 'x'.repeat(group.join('').length);
    assert.deepEqual(groupCodes(['aaaa', 'bbbb', 'cccc'], build, 8), [['aaaa', 'bbbb'], ['cccc']]);
    assert.deepEqual(groupCodes(['a'.repeat(20), 'bb'], build, 8), [['a'.repeat(20)], ['bb']]);
    assert.deepEqual(groupCodes([], build, 8), []);
  });

  test('e-mail : codes réels ⇒ un message par code, chacun sous la limite mailto', () => {
    const codes = [fakeCode(700, 1), fakeCode(720, 2)];
    const messages = planMailto({ to: 'ia@exemple.fr', codes, baseUrl: BASE_URL, templates, ctx: { title: 'T', mode: 'anonymous', channels: [{ type: 'mailto', target: 'ia@exemple.fr' }] }, channelsData });
    assert.equal(messages.length, 2);
    assert.ok(messages.every((m) => !m.tooLong && m.url.length <= 1800));
  });

  test('e-mail : code trop long pour un e-mail prérempli ⇒ e-mail court sans code et aide propre au repli', () => {
    const code = fakeCode(1500, 3);
    const to = 'ia@exemple.fr';
    const ctx = { title: 'T', mode: 'open', channels: [{ type: 'mailto', target: to }] };
    const fallback = { subject: t('form.send.mail_fallback_subject', { title: 'T' }), body: t('form.send.mail_fallback_body', { title: 'T' }) };
    assert.ok(code.length > 1000);
    assert.equal(planMailto({ to, codes: [code], baseUrl: BASE_URL, templates, ctx, channelsData })[0].tooLong, true, 'prérequis : au-delà de la limite mailto');
    const plan = mailPlan({ to, codes: [code], baseUrl: BASE_URL, templates, ctx, channelsData, fallback });
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].kind, 'fallback');
    assert.deepEqual(plan.items[0].codes, [code]);
    assert.match(plan.items[0].url, /^mailto:ia@exemple\.fr\?subject=/, 'lien mailto adressé au responsable');
    assert.ok(plan.items[0].url.length <= 1800);
    assert.ok(!plan.items[0].url.includes(code.slice(5, 40)), 'le corps court ne contient pas le code');
    assert.equal(plan.openable, 0);
    assert.equal(plan.help, 'mail_fallback_help', 'pas d\'aide « le message s\'ouvre, prêt à partir »');
    assert.notEqual(t(`form.send.${plan.help}`), t('form.send.mail_help'));
    assert.ok(!t(`form.send.${plan.help}`).startsWith('form.'), 'texte présent dans le catalogue');
  });

  test('e-mail : un code court prérempli et un code trop long ⇒ l\'aide habituelle reste affichée', () => {
    const to = 'ia@exemple.fr';
    const codes = [fakeCode(700, 1), fakeCode(1500, 2)];
    const plan = mailPlan({ to, codes, baseUrl: BASE_URL, templates, ctx: { title: 'T', mode: 'open', channels: [{ type: 'mailto', target: to }] }, channelsData, fallback: { subject: 'S', body: 'B' } });
    assert.deepEqual(plan.items.map((i) => i.kind), ['prefilled', 'fallback']);
    assert.equal(plan.openable, 1);
    assert.equal(plan.help, 'mail_help');
    assert.throws(() => mailPlan({ to: 'pas une adresse', codes, baseUrl: BASE_URL, templates, ctx: {}, channelsData, fallback: {} }));
  });

  test('fichier .rcn : nom dérivé du titre, un code par ligne', () => {
    assert.equal(rcnFilename('Recensement IA 2026 — Siège'), 'recensia-recensement-ia-2026-siege-codes.rcn');
    assert.equal(rcnFilename(''), 'recensia-campagne-codes.rcn');
    assert.equal(rcnContent(['RCN1.a', 'RCN1.b']), 'RCN1.a\nRCN1.b\n');
  });
});

describe('notice : limites de la réponse anonyme', () => {
  const noShare = { navigator: {} };
  const mailCopy = [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy' }];
  const limitsFor = (mode, { depts = ['Direction', 'Marketing'], dreq, channels = mailCopy } = {}) => anonymousLimits({
    mode, depts, dreq, plan: sendPlan({ channels, mode, channelsData, env: noShare }), channelsData, t,
  });

  test('anonyme : le service reste visible, limite toujours présente (service obligatoire)', () => {
    const limits = limitsFor('anonymous', { dreq: true });
    const dept = limits.find((l) => l.id === 'department');
    assert.ok(dept, 'limite « service » présente');
    assert.equal(dept.text, catalogs.form.mode.anonymous_department);
    assert.match(dept.text, /service reste visible/);
    assert.ok(!dept.text.includes(catalogs.questionnaire.department_unspecified), 'pas de choix « ne pas préciser » si le service est obligatoire');
  });

  test('anonyme, service facultatif : la limite propose « Je préfère ne pas le préciser »', () => {
    for (const dreq of [false, undefined]) {
      const dept = limitsFor('anonymous', { dreq }).find((l) => l.id === 'department');
      assert.match(dept.text, /service reste visible/);
      assert.ok(dept.text.includes(`« ${catalogs.questionnaire.department_unspecified} »`), dept.text);
    }
  });

  test('anonyme sans service proposé : pas de limite « service » ; mode ouvert : aucune limite', () => {
    assert.equal(limitsFor('anonymous', { depts: [] }).some((l) => l.id === 'department'), false);
    assert.deepEqual(limitsFor('open', { dreq: true }), []);
    assert.deepEqual(limitsFor('open'), []);
  });

  test('avertissements des canaux fusionnés en une liste courte, puis service et champs libres', () => {
    const limits = limitsFor('anonymous', { dreq: true });
    assert.deepEqual(limits.map((l) => l.id), ['channel_0', 'channel_1', 'department', 'free_text']);
    assert.match(limits[0].text, /^Par e-mail, l'envoi n'est pas anonyme/);
    assert.match(limits[1].text, /^Par copier-coller, tout dépend/);
    const three = channelLimits(sendPlan({ channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'whatsapp' }, { type: 'file' }], mode: 'anonymous', channelsData, env: noShare }), channelsData, t);
    assert.equal(three.length, 2, 'un avertissement par nature de canal, pas un par canal');
    assert.match(three[0], /^Par e-mail ou par WhatsApp, l'envoi n'est pas anonyme/);
    assert.match(three[1], /^Par fichier, tout dépend/);
    assert.equal(joinOr(['a', 'b', 'c'], t), 'a, b ou c');
    assert.equal(joinOr([], t), '');
  });

  test('canal indisponible (partage natif absent) : pas d\'avertissement pour lui', () => {
    const limits = channelLimits(sendPlan({ channels: [{ type: 'share' }], mode: 'anonymous', channelsData, env: noShare }), channelsData, t);
    assert.deepEqual(limits, [t('form.mode.channel_depends', { via: 'Par copier-coller' })], 'seul le repli « Copier » est signalé');
  });
});

describe('textes du répondant', () => {
  test('un seul terme pour la personne qui lance la campagne : jamais « organisateur »', () => {
    const text = JSON.stringify(catalogs.form);
    assert.equal(/organisat(eur|rice)/i.test(text), false);
  });

  test('états des étapes annoncés en texte', () => {
    for (const state of ['done', 'current', 'todo']) assert.equal(typeof catalogs.form.steps[state], 'string', state);
  });
});

describe('saisie directe par le responsable (entrée §3.3)', () => {
  const usage = makeUsage();

  test('anonyme : aucun déclarant, pas d\'horodatage de réponse', () => {
    const entry = buildManualEntry({ campaign: { id: CID, mode: 'anonymous' }, usage, respondent: WHO, now: NOW, entryId: ID_A });
    assert.deepEqual(entry, {
      campaign_id: CID, entry_id: ID_A, rev: 1, submitted_day: '2026-09-29', submitted_at: null, respondent: null,
      usage, schema_version: SCHEMA_VERSION, code_hash: null, source: 'manual', imported_at: NOW.toISOString(),
      after_close: false, excluded: false, group_override: null,
    });
  });

  test('ouvert : déclarant facultatif et horodatage complet', () => {
    const withWho = buildManualEntry({ campaign: { id: CID, mode: 'open' }, usage, respondent: { first_name: 'Jean', last_name: 'Martin', email: null }, now: NOW, entryId: ID_A });
    assert.equal(withWho.submitted_at, NOW.toISOString());
    assert.deepEqual(withWho.respondent, { first_name: 'Jean', last_name: 'Martin', email: null });
    const without = buildManualEntry({ campaign: { id: CID, mode: 'open' }, usage, respondent: null, now: NOW, entryId: ID_A });
    assert.equal(without.respondent, null);
  });

  test('declarantFrom : vide ⇒ null ; prénom et nom ensemble ; ignoré en anonyme', () => {
    assert.deepEqual(declarantFrom({ first_name: ' ', last_name: '' }, 'open'), { ok: true, value: null, errors: [] });
    assert.deepEqual(declarantFrom({ first_name: ' Jean ', last_name: 'Martin' }, 'open').value, { first_name: 'Jean', last_name: 'Martin', email: null });
    const partial = declarantFrom({ first_name: 'Jean' }, 'open');
    assert.equal(partial.ok, false);
    assert.deepEqual(partial.errors.map((e) => e.field), ['last_name']);
    assert.deepEqual(declarantFrom({ first_name: 'Jean', last_name: 'Martin' }, 'anonymous'), { ok: true, value: null, errors: [] });
    assert.equal(declarantFrom({ first_name: 'J'.repeat(61), last_name: 'M' }, 'open').errors[0].code, 'too_long');
  });
});

describe('saisie directe : confirmation d\'enregistrement', () => {
  const NB = '\u00A0';
  const byClass = (node, cls, out = []) => {
    for (const child of node.childNodes ?? []) {
      if ((child.getAttribute?.('class') ?? '').split(' ').includes(cls)) out.push(child);
      byClass(child, cls, out);
    }
    return out;
  };
  let fake;
  before(() => {
    fake = installFakeDocument();
    i18nRegister('common', readJson('src/i18n/fr/common.json'));
    i18nRegister('add', readJson('src/i18n/fr/add.json'));
  });
  after(() => fake.restore());

  test('classement indicatif : l\'axe de chaque badge est écrit à l\'écran (CDC D5)', () => {
    const node = savedNotice({ id: CID }, { name: 'Tri de CV', classification: { ai_act_level: 'high', data_level: 2 } }, i18nT);
    const badges = byClass(node, 'badge');
    assert.equal(badges.length, 2);
    assert.deepEqual(byClass(node, 'badge-axis').map((n) => n.textContent), [`AI Act${NB}: `, `Exposition des données${NB}: `]);
    assert.equal(byClass(node, 'visually-hidden').length, 0, 'axe visible, pas seulement lu');
    assert.equal(badges[0].textContent, `AI Act${NB}: Haut risque`);
    assert.equal(badges[1].getAttribute('data-level'), '2');
    assert.equal(byClass(node, 'disclaimer').length, 1, 'classement présenté comme indicatif');
    assert.ok(node.textContent.includes(`Usage «${NB}Tri de CV${NB}» ajouté au registre.`));
  });

  test('sans classification : ni badge ni avertissement, lien vers le registre conservé', () => {
    const node = savedNotice({ id: CID }, { name: 'Usage', classification: null }, i18nT);
    assert.equal(byClass(node, 'badge').length, 0);
    assert.equal(byClass(node, 'disclaimer').length, 0);
    assert.ok(node.textContent.includes('Voir dans le registre'));
  });
});
