// Pipeline d'import des codes (src/services/import.js) : toutes les catégories du rapport, anonymat
// forcé, révisions, doublons, autre campagne, clôture, performance (CDC §7.2, §7.5, §14 phase 2).
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import { generateCampaignKeys } from '../src/crypto/keys.js';
import { b64urlDecode, b64urlEncode } from '../src/crypto/b64url.js';
import { CODE_MAX_LENGTH, CodeError, decryptEntry, encryptEntry, codeHash } from '../src/crypto/codes.js';
import { randomId } from '../src/crypto/random.js';
import { openStore } from '../src/storage/store.js';
import {
  ImportError, MAX_CODES_PER_IMPORT, checkPlain, codeFormatIssue, codesForCampaign, collectCodes, diagnoseUnmatched,
  findCampaignForCodes, importCodes, isAfterClose, isKeepableCode, otherCampaignCodes, planImport, previewCode, publicReport,
  recomputeAfterClose, reportCounts, resolvedCodes, sortCodesByCampaign, stashReport, takeReport, textFromFile,
} from '../src/services/import.js';
import { loadQuestionnaire, makeUsage } from './helpers/load-data.js';

const questionnaire = loadQuestionnaire();
const NOW = new Date('2026-09-29T10:00:00.000Z');

async function makeCampaign(overrides = {}) {
  const keys = await generateCampaignKeys();
  return {
    id: randomId(9),
    title: 'Recensement IA 2026',
    org_name: 'Menuiserie Alpine Concept',
    mode: 'anonymous',
    departments: ['Direction', 'Commercial et devis', 'RH'],
    settings: {
      min_group_size: 5, department_required: false, comments_exportable: false,
      closes_on: '2026-10-31', group_by_department: false, channels: [{ type: 'copy' }],
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

function plainFor(overrides = {}, usageOverrides = {}) {
  return {
    entry_id: randomId(12),
    rev: 1,
    submitted_day: '2026-09-20',
    usage: makeUsage(usageOverrides),
    ...overrides,
  };
}

const code = (campaign, plain) => encryptEntry(plain, campaign.public_key, campaign.id);

async function setup() {
  const store = await openStore({ forceMemory: true });
  const anon = await makeCampaign();
  const open = await makeCampaign({ mode: 'open', title: 'Campagne nominative' });
  const other = await makeCampaign({ title: 'Autre campagne' });
  for (const c of [anon, open, other]) await store.putCampaign(c);
  return { store, anon, open, other, campaigns: [anon, open, other] };
}

async function run(env, campaign, input) {
  return importCodes({ ...input, campaign, campaigns: env.campaigns, store: env.store, questionnaire, now: NOW });
}

describe('utilitaires purs', () => {
  test('previewCode tronque au milieu, garde les codes courts', () => {
    assert.equal(previewCode('RCN1.abc'), 'RCN1.abc');
    const long = `RCN1.${'A'.repeat(60)}xyz789`;
    const p = previewCode(long);
    assert.ok(p.startsWith('RCN1.AAAAAAAAA'));
    assert.ok(p.endsWith('xyz789'));
    assert.ok(p.includes('…'));
    assert.ok(p.length < 25);
  });

  test('collectCodes : e-mail entier, liens d\'import, lignes ; dédoublonné et plafonné', () => {
    const a = `RCN1.${'a'.repeat(120)}`;
    const b = `RCN1.${'b'.repeat(120)}`;
    const text = `Bonjour,\nVoici mon usage : https://manicalabs.github.io/Recensia/#/i/${a}~${b}\n\nCode brut :\n${a}\n`;
    assert.deepEqual(collectCodes({ text }).codes, [a, b]);
    assert.deepEqual(collectCodes({ codes: [b, a, b] }).codes, [b, a]);
    const many = Array.from({ length: MAX_CODES_PER_IMPORT + 3 }, (_, i) => `RCN1.${String(i).padStart(40, 'x')}`);
    const res = collectCodes({ text: many.join('\n') });
    assert.equal(res.codes.length, MAX_CODES_PER_IMPORT);
    assert.equal(res.over_limit, 3);
  });

  test('textFromFile : e-mail enregistré (quoted-printable, base64), fichiers bruts inchangés', () => {
    const codeA = `RCN1.${'a1B2-c3_D4'.repeat(12)}`;
    const codeB = `RCN1.${'Zz9_yY8-'.repeat(15)}`;
    // Quoted-printable : lignes coupées à 76 caractères par « = ».
    const qp = [];
    const body = `Lien : https://manicalabs.github.io/Recensia/#/i/${codeA}~${codeB}`;
    for (let i = 0; i < body.length; i += 70) qp.push(body.slice(i, i + 70));
    const eml = `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp.join('=\r\n')}\r\n`;
    assert.deepEqual(collectCodes({ text: textFromFile('message.eml', eml) }).codes, [codeA, codeB]);
    assert.notDeepEqual(collectCodes({ text: eml }).codes, [codeA, codeB], 'sans décodage, les codes seraient coupés');
    // Partie base64.
    const b64 = Buffer.from(`Voici mon code :\n${codeB}\n`, 'utf8').toString('base64').replace(/(.{60})/g, '$1\r\n');
    const eml2 = `Subject: code\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--x--\r\n`;
    assert.deepEqual(collectCodes({ text: textFromFile('code.eml', eml2) }).codes, [codeB]);
    // Fichier .rcn : lu tel quel.
    assert.equal(textFromFile('usage.rcn', `${codeA}\n`), `${codeA}\n`);
  });

  test('textFromFile : temps linéaire sur un e-mail atypique (pas de retours arrière exponentiels)', () => {
    const codeB = `RCN1.${'Zz9_yY8-'.repeat(15)}`;
    // En-tête base64 sans ligne vide ni contenu base64 ensuite : cas qui bloquait l'onglet.
    const odd = `Content-Transfer-Encoding: base64\r\n${Array.from({ length: 2000 }, () => 'Lorem ipsum dolor sit amet').join('\r\n')}\r\n`;
    const long = `Content-Transfer-Encoding: base64\n${'a b'.repeat(200000)}`;
    const started = performance.now();
    textFromFile('odd.eml', odd);
    textFromFile('long.eml', long);
    assert.ok(performance.now() - started < 500, `analyse en ${Math.round(performance.now() - started)} ms`);
    // Plusieurs parties base64 (majuscules, CRLF), dont une qui n'est pas du texte.
    const b64 = Buffer.from(`Code : ${codeB}\r\n`, 'utf8').toString('base64');
    const eml = `Subject: x\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: BASE64\r\n\r\niVBORw0KGgo=\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--b--\r\n`;
    assert.deepEqual(collectCodes({ text: textFromFile('m.eml', eml) }).codes, [codeB]);
  });

  test('isAfterClose et recomputeAfterClose (codes seulement)', () => {
    assert.equal(isAfterClose('2026-11-01', '2026-10-31'), true);
    assert.equal(isAfterClose('2026-10-31', '2026-10-31'), false);
    assert.equal(isAfterClose('2026-11-01', null), false);
    const entries = [
      { entry_id: 'a', source: 'code', submitted_day: '2026-11-02', after_close: false },
      { entry_id: 'b', source: 'code', submitted_day: '2026-10-01', after_close: true },
      { entry_id: 'c', source: 'manual', submitted_day: '2026-11-02', after_close: false },
      { entry_id: 'd', source: 'code', submitted_day: '2026-10-01', after_close: false },
    ];
    const changed = recomputeAfterClose(entries, '2026-10-31');
    assert.deepEqual(changed.map((e) => [e.entry_id, e.after_close]), [['a', true], ['b', false]]);
    assert.equal(entries[0].after_close, false, 'entrées d\'origine non modifiées');
    assert.deepEqual(recomputeAfterClose(entries, null).map((e) => e.entry_id), ['b']);
  });

  test('planImport : le rev le plus élevé l\'emporte, excluded et group_override conservés', () => {
    const campaign = { id: 'campaignAAA', settings: { closes_on: '2026-10-31' } };
    const cand = (entry_id, rev, day = '2026-09-20') => ({
      code: `RCN1.${entry_id}${rev}`, hash: `h${entry_id}${rev}`,
      plain: { entry_id, rev, sv: 1, submitted_day: day }, usage: { usage_name: `U ${entry_id}` },
      respondent: null, submitted_at: null,
    });
    const existing = [{ entry_id: 'e2', rev: 1, excluded: true, group_override: 'G-1' }, { entry_id: 'e3', rev: 3 }];
    const plan = planImport(
      [cand('e1', 1), cand('e1', 2), cand('e2', 2, '2026-11-05'), cand('e3', 2), cand('e3', 3)],
      existing, campaign, { importedAt: NOW.toISOString() },
    );
    assert.deepEqual(plan.accepted.map((a) => [a.entry_id, a.rev]), [['e1', 2]]);
    assert.deepEqual(plan.revised.map((a) => [a.entry_id, a.rev, a.previous_rev]), [['e2', 2, 1]]);
    assert.deepEqual(plan.duplicates.map((d) => [d.entry_id, d.rev, d.reason]).sort(),
      [['e1', 1, 'obsolete'], ['e3', 2, 'older_rev'], ['e3', 3, 'same_rev']]);
    const e2 = plan.writes.find((w) => w.entry_id === 'e2');
    assert.equal(e2.excluded, true);
    assert.equal(e2.group_override, 'G-1');
    assert.equal(e2.after_close, true);
    assert.deepEqual(plan.after_close.map((a) => a.entry_id), ['e2']);
    assert.equal(plan.writes.length, 2);
  });

  test('planImport : le rev le plus élevé l\'emporte même si les versions ne se suivent pas', () => {
    const campaign = { id: 'campaignAAA', settings: {} };
    const cand = (entry_id, rev, n = '') => ({
      code: `RCN1.${entry_id}${rev}${n}`, hash: `h${entry_id}${rev}${n}`,
      plain: { entry_id, rev, sv: 1, submitted_day: '2026-09-20' }, usage: { usage_name: `U ${entry_id}` },
      respondent: null, submitted_at: null,
    });
    // Ordres variés : révision avant, après, séparée par d'autres codes, rev maximal en tête ou en queue.
    const orders = [
      [cand('e1', 1), cand('e2', 1), cand('e1', 2)],
      [cand('e1', 2), cand('e2', 1), cand('e1', 1)],
      [cand('e1', 1), cand('e2', 1), cand('e3', 1), cand('e1', 3), cand('e4', 1), cand('e1', 2)],
      [cand('e3', 1), cand('e1', 1), cand('e2', 1), cand('e2', 2), cand('e1', 2), cand('e3', 4), cand('e1', 5)],
    ];
    for (const list of orders) {
      const expected = new Map();
      for (const c of list) expected.set(c.plain.entry_id, Math.max(expected.get(c.plain.entry_id) ?? 0, c.plain.rev));
      const plan = planImport(list, [], campaign, { importedAt: NOW.toISOString() });
      assert.deepEqual(new Map(plan.writes.map((w) => [w.entry_id, w.rev])), expected);
      assert.equal(plan.writes.length + plan.duplicates.length, list.length);
      assert.ok(plan.duplicates.every((d) => d.reason === 'obsolete'));
    }
    // Même version reçue deux fois (deux chiffrements différents) : une seule est gardée.
    const twice = planImport([cand('e1', 1, 'a'), cand('e2', 1), cand('e1', 1, 'b')], [], campaign);
    assert.deepEqual(twice.writes.map((w) => [w.entry_id, w.code_hash]), [['e1', 'he11a'], ['e2', 'he21']]);
    assert.deepEqual(twice.duplicates.map((d) => [d.entry_id, d.reason]), [['e1', 'repeated']]);
  });

  test('checkPlain : identité refusée en anonyme, exigée en ouvert, service obligatoire en ouvert', () => {
    const anon = { id: 'x', mode: 'anonymous', departments: ['RH'], settings: {} };
    const open = { id: 'y', mode: 'open', departments: ['RH'], settings: {} };
    const base = { usage: makeUsage({ department: 'RH' }), respondent: null, submitted_at: null };
    assert.equal(checkPlain(base, anon, questionnaire).ok, true);
    assert.equal(checkPlain({ ...base, respondent: { first_name: 'A', last_name: 'B' } }, anon, questionnaire).reason, 'identity_in_anonymous');
    assert.equal(checkPlain({ ...base, submitted_at: '2026-09-20T10:00:00Z' }, anon, questionnaire).reason, 'identity_in_anonymous');
    assert.equal(checkPlain(base, open, questionnaire).reason, 'respondent_invalid');
    const who = { first_name: '  Camille ', last_name: 'Martin', email: null };
    const ok = checkPlain({ ...base, respondent: who }, open, questionnaire);
    assert.equal(ok.ok, true);
    assert.equal(ok.respondent.first_name, 'Camille');
    const noDept = checkPlain({ usage: makeUsage({ department: null }), respondent: who }, open, questionnaire);
    assert.equal(noDept.reason, 'usage_invalid');
    assert.deepEqual(noDept.fields, ['department']);
  });
});

describe('importCodes', () => {
  let env;
  before(async () => { env = await setup(); });

  test('codes acceptés : entrées §3.3 écrites (source code, empreinte, horodatage)', async () => {
    const plains = [plainFor(), plainFor({}, { usage_name: 'Résumé de contrats', tool: 'claude' }), plainFor()];
    const codes = await Promise.all(plains.map((p) => code(env.anon, p)));
    const report = await run(env, env.anon, { text: codes.join('\n') });
    assert.equal(report.total, 3);
    assert.equal(report.accepted.length, 3);
    assert.equal(report.written, 3);
    const stored = await env.store.getEntry(env.anon.id, plains[1].entry_id);
    assert.equal(stored.source, 'code');
    assert.equal(stored.code_hash, await codeHash(codes[1]));
    assert.equal(stored.imported_at, NOW.toISOString());
    assert.equal(stored.respondent, null);
    assert.equal(stored.submitted_at, null);
    assert.equal(stored.excluded, false);
    assert.equal(stored.group_override, null);
    assert.equal(stored.after_close, false);
    assert.equal(stored.schema_version, 1);
    assert.equal(stored.usage.usage_name, 'Résumé de contrats');
    assert.ok(report.accepted.every((a) => a.preview.length < 25 && a.preview.includes('…')));
    assert.deepEqual(resolvedCodes(report).sort(), [...codes].sort());
  });

  test('doublons : même code réimporté, même entry_id et même rev', async () => {
    const plain = plainFor();
    const first = await code(env.anon, plain);
    await run(env, env.anon, { codes: [first] });
    const again = await run(env, env.anon, { codes: [first] });
    assert.deepEqual(again.duplicates.map((d) => d.reason), ['already_imported']);
    assert.equal(again.written, 0);
    const replay = await code(env.anon, plain); // nouveau chiffrement, même contenu
    const res = await run(env, env.anon, { codes: [replay] });
    assert.deepEqual(res.duplicates.map((d) => d.reason), ['same_rev']);
    assert.equal((await env.store.listEntries(env.anon.id)).filter((e) => e.entry_id === plain.entry_id).length, 1);
  });

  test('révision : rev + 1 remplace l\'entrée en gardant excluded et group_override ; rev inférieur obsolète', async () => {
    const plain = plainFor();
    await run(env, env.anon, { codes: [await code(env.anon, plain)] });
    const stored = await env.store.getEntry(env.anon.id, plain.entry_id);
    await env.store.putEntry({ ...stored, excluded: true, group_override: 'U-manuel' });
    const v2 = await code(env.anon, { ...plain, rev: 2, usage: makeUsage({ usage_name: 'Reformulation corrigée' }) });
    const res = await run(env, env.anon, { codes: [v2] });
    assert.equal(res.revised.length, 1);
    assert.equal(res.revised[0].previous_rev, 1);
    const after = await env.store.getEntry(env.anon.id, plain.entry_id);
    assert.equal(after.rev, 2);
    assert.equal(after.usage.usage_name, 'Reformulation corrigée');
    assert.equal(after.excluded, true);
    assert.equal(after.group_override, 'U-manuel');
    const old = await code(env.anon, { ...plain, rev: 1 });
    const res2 = await run(env, env.anon, { codes: [old] });
    assert.deepEqual(res2.duplicates.map((d) => d.reason), ['older_rev']);
    assert.equal((await env.store.getEntry(env.anon.id, plain.entry_id)).rev, 2);
  });

  test('révision reçue dans le même collage que l\'original, séparée par d\'autres codes : la plus récente gagne', async () => {
    const plain = plainFor();
    const v1 = await code(env.anon, plain);
    const other = await code(env.anon, plainFor());
    const v2 = await code(env.anon, { ...plain, rev: 2, usage: makeUsage({ usage_name: 'Version corrigée' }) });
    const res = await run(env, env.anon, { text: `Premier envoi :\n${v1}\n\nAutre collègue :\n${other}\n\nCorrection :\n${v2}\n` });
    assert.equal(res.accepted.length, 2);
    assert.deepEqual(res.duplicates.map((d) => [d.rev, d.reason]), [[1, 'obsolete']]);
    const stored = await env.store.getEntry(env.anon.id, plain.entry_id);
    assert.equal(stored.rev, 2);
    assert.equal(stored.usage.usage_name, 'Version corrigée');
    assert.equal(stored.code_hash, await codeHash(v2));
  });

  test('autre campagne locale : signalée, rien n\'est écrit, code gardé en attente', async () => {
    const before = (await env.store.listEntries(env.anon.id)).length;
    const foreign = await code(env.other, plainFor());
    const res = await run(env, env.anon, { codes: [foreign] });
    assert.equal(res.other_campaign.length, 1);
    assert.equal(res.other_campaign[0].campaign_id, env.other.id);
    assert.equal(res.other_campaign[0].title, 'Autre campagne');
    assert.equal((await env.store.listEntries(env.anon.id)).length, before);
    assert.deepEqual(otherCampaignCodes(res), [foreign]);
    assert.deepEqual(resolvedCodes(res), []);
  });

  test('invalides : altéré, tronqué, clé inconnue, contenu hors questionnaire', async () => {
    const good = await code(env.anon, plainFor());
    const i = 60;
    const altered = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    const truncated = good.slice(0, 40);
    const stranger = await makeCampaign();
    const unknownKey = await encryptEntry(plainFor(), stranger.public_key, stranger.id);
    const badUsage = await code(env.anon, plainFor({}, { tool: 'outil_inconnu' }));
    const res = await run(env, env.anon, { codes: [altered, truncated, unknownKey, badUsage] });
    const reasons = res.invalid.map((x) => x.reason);
    assert.deepEqual(reasons, ['decrypt', 'format', 'decrypt', 'usage_invalid']);
    assert.deepEqual(res.invalid[3].fields, ['tool']);
    assert.equal(res.written, 0);
    // Les codes indéchiffrables restent « en attente » (une autre clé peut les lire).
    assert.deepEqual(resolvedCodes(res).sort(), [truncated, badUsage].sort());
  });

  test('version non prise en charge : signalée à part (mettez l\'application à jour)', async () => {
    const res = await run(env, env.anon, { text: `RCN2.${'Q'.repeat(200)}` });
    assert.equal(res.unsupported_version.length, 1);
    assert.equal(res.invalid.length, 0);
  });

  test('anonymat forcé : un code portant une identité ou un horodatage est refusé en mode anonyme', async () => {
    const withIdentity = await code(env.anon, plainFor({ respondent: { first_name: 'Camille', last_name: 'Martin' } }));
    const withTimestamp = await code(env.anon, plainFor({ submitted_at: '2026-09-20T09:15:00.000Z' }));
    const res = await run(env, env.anon, { codes: [withIdentity, withTimestamp] });
    assert.deepEqual(res.invalid.map((x) => x.reason), ['identity_in_anonymous', 'identity_in_anonymous']);
    assert.equal(res.written, 0);
    for (const e of await env.store.listEntries(env.anon.id)) {
      assert.equal(e.respondent, null);
      assert.equal(e.submitted_at, null);
    }
  });

  test('mode ouvert : répondant obligatoire, horodatage conservé, service obligatoire', async () => {
    const who = { first_name: 'Camille', last_name: 'Martin', email: 'camille.martin@exemple.fr' };
    const ok = plainFor({ respondent: who, submitted_at: '2026-09-20T09:15:00.000Z' }, { department: 'RH' });
    const noWho = plainFor({}, { department: 'RH' });
    const noDept = plainFor({ respondent: who }, { department: null });
    const res = await run(env, env.open, { codes: await Promise.all([ok, noWho, noDept].map((p) => code(env.open, p))) });
    assert.equal(res.accepted.length, 1);
    assert.deepEqual(res.invalid.map((x) => x.reason), ['respondent_invalid', 'usage_invalid']);
    const stored = await env.store.getEntry(env.open.id, ok.entry_id);
    assert.deepEqual(stored.respondent, who);
    assert.equal(stored.submitted_at, '2026-09-20T09:15:00.000Z');
  });

  test('après la clôture : accepté, listé à part et marqué after_close', async () => {
    const late = plainFor({ submitted_day: '2026-11-03' });
    const res = await run(env, env.anon, { codes: [await code(env.anon, late)] });
    assert.equal(res.accepted.length, 1);
    assert.equal(res.after_close.length, 1);
    assert.equal(res.accepted[0].after_close, true);
    assert.equal((await env.store.getEntry(env.anon.id, late.entry_id)).after_close, true);
  });

  test('rapport : compteurs, version publique sans codes, texte sans code', async () => {
    const empty = await run(env, env.anon, { text: 'Bonjour, aucun code ici.' });
    assert.equal(empty.total, 0);
    assert.deepEqual(reportCounts(empty), {
      total: 0, accepted: 0, revised: 0, duplicates: 0, invalid: 0, other_campaign: 0, after_close: 0, unsupported_version: 0,
    });
    const c = await code(env.anon, plainFor());
    const res = await run(env, env.anon, { codes: [c] });
    const pub = publicReport(res);
    assert.equal(pub.outcomes, undefined);
    assert.ok(!JSON.stringify(pub).includes(c), 'le code complet ne figure pas dans le rapport public');
  });

  test('campagne sans clé privée : ImportError no_key', async () => {
    await assert.rejects(
      importCodes({ codes: [], campaign: { ...env.anon, private_key_jwk: null }, store: env.store, questionnaire }),
      (err) => err instanceof ImportError && err.code === 'no_key',
    );
  });

  test('répartition par campagne et recherche de la campagne d\'un lien', async () => {
    const a1 = await code(env.anon, plainFor());
    const a2 = await code(env.anon, plainFor());
    const o1 = await code(env.other, plainFor());
    const junk = 'RCN1.pasuncode';
    const { byCampaign, unmatched } = await sortCodesByCampaign([a1, o1, a2, junk], env.campaigns);
    assert.deepEqual(byCampaign.get(env.anon.id), [a1, a2]);
    assert.deepEqual(byCampaign.get(env.other.id), [o1]);
    assert.deepEqual(unmatched, [junk]);
    const found = await findCampaignForCodes([o1, a1, a2], env.campaigns);
    assert.equal(found.campaign.id, env.anon.id);
    assert.deepEqual(await codesForCampaign([a1, o1], env.other), [o1]);
    assert.equal(await findCampaignForCodes([junk], env.campaigns), null);
    assert.deepEqual(await codesForCampaign([a1], { ...env.anon, private_key_jwk: null }), []);
  });

  test('performance : 100 codes importés en moins de 2 s', async () => {
    // Meilleur de 3 essais (campagne neuve à chaque fois) : robuste à une machine chargée.
    let elapsed = Infinity;
    for (let attempt = 0; attempt < 3 && elapsed >= 2000; attempt++) {
      const perf = await makeCampaign();
      await env.store.putCampaign(perf);
      const codes = await Promise.all(Array.from({ length: 100 }, () => code(perf, plainFor())));
      const started = performance.now();
      const res = await importCodes({ text: codes.join('\n'), campaign: perf, campaigns: [...env.campaigns, perf], store: env.store, questionnaire, now: NOW });
      elapsed = Math.min(elapsed, performance.now() - started);
      assert.equal(res.accepted.length, 100);
      assert.equal((await env.store.listEntries(perf.id)).length, 100);
    }
    assert.ok(elapsed < 2000, `import de 100 codes en ${Math.round(elapsed)} ms`);
  });
});

describe('contrôle de forme sans clé et diagnostic des codes illisibles (lien coupé)', () => {
  let campaign;
  let good;
  before(async () => {
    campaign = await makeCampaign();
    good = await code(campaign, plainFor());
  });

  test('codeFormatIssue : préfixe, alphabet, taille minimale, longueur maximale, version', () => {
    assert.equal(codeFormatIssue(good), null);
    assert.equal(codeFormatIssue('RCN1.abc'), 'format');
    assert.equal(codeFormatIssue('RCN1.abcdefghijklmnop'), 'format', 'trop court pour un code');
    assert.equal(codeFormatIssue(good.slice(0, 40)), 'format');
    assert.equal(codeFormatIssue(`${good.slice(0, 20)}+${good.slice(21)}`), 'format', 'alphabet base64url strict');
    assert.equal(codeFormatIssue(good.replace('RCN1.', 'XYZ1.')), 'format');
    assert.equal(codeFormatIssue(`RCN2.${'Q'.repeat(200)}`), 'version');
    assert.equal(codeFormatIssue(`RCN1.${'A'.repeat(CODE_MAX_LENGTH)}`), 'size');
    assert.equal(codeFormatIssue(null), 'format');
    // Préfixe RCN1. mais octet de version différent : même réponse que decryptEntry.
    const bytes = b64urlDecode(good.slice(5));
    bytes[0] = 2;
    assert.equal(codeFormatIssue(`RCN1.${b64urlEncode(bytes)}`), 'version');
  });

  test('codeFormatIssue concorde avec decryptEntry pour toutes les troncatures d\'un code', async () => {
    for (let n = 6; n < good.length; n += 1) {
      const cut = good.slice(0, n);
      const issue = codeFormatIssue(cut);
      // eslint-disable-next-line no-await-in-loop
      const reason = await decryptEntry(cut, campaign.private_key_jwk, campaign.id).then(() => 'ok', (err) => (err instanceof CodeError ? err.reason : 'other'));
      if (issue === 'format') assert.equal(reason, 'format', `troncature à ${n} caractères`);
      else assert.equal(reason, 'decrypt', `troncature à ${n} caractères : forme valide, déchiffrement refusé`);
    }
  });

  test('isKeepableCode : forme valide ou version future gardées, codes mal formés écartés', () => {
    assert.equal(isKeepableCode(good), true);
    assert.equal(isKeepableCode(`RCN2.${'Q'.repeat(200)}`), true);
    assert.equal(isKeepableCode('RCN1.abc'), false);
    assert.equal(isKeepableCode(`RCN1.${'A'.repeat(CODE_MAX_LENGTH)}`), false);
  });

  test('diagnoseUnmatched : clé locale ou forme invalide ⇒ « illisible », sinon « clé absente »', () => {
    const withKey = [campaign];
    const withoutKey = [{ ...campaign, private_key_jwk: null }, { id: 'demo', demo: true, private_key_jwk: null }];
    // Lien coupé à 600 caractères, de forme encore valide : la clé est là, c'est le lien qui est abîmé.
    let cut = good.slice(0, 600);
    for (let n = 600; codeFormatIssue(cut) !== null; n -= 1) cut = good.slice(0, n);
    assert.equal(diagnoseUnmatched([cut], withKey), 'unreadable');
    assert.equal(diagnoseUnmatched([cut], withoutKey), 'no_key');
    assert.equal(diagnoseUnmatched([cut], []), 'no_key');
    // Aucun code de forme valide : illisible même sans aucune clé locale.
    assert.equal(diagnoseUnmatched(['RCN1.abc'], []), 'unreadable');
    assert.equal(diagnoseUnmatched(['RCN1.abc', cut], withoutKey), 'no_key');
    // Version plus récente du format : mise à jour, quelle que soit la clé.
    assert.equal(diagnoseUnmatched([`RCN2.${'Q'.repeat(200)}`], withKey), 'version');
    assert.equal(diagnoseUnmatched([`RCN2.${'Q'.repeat(200)}`, 'RCN1.abc'], []), 'unreadable');
  });
});

describe('rapport transmis par la session', () => {
  function memoryArea() {
    const map = new Map();
    return {
      get: (k, fallback = null) => (map.has(k) ? JSON.parse(map.get(k)) : fallback),
      set: (k, v) => { map.set(k, JSON.stringify(v)); return true; },
      remove: (k) => { map.delete(k); },
    };
  }

  test('stashReport / takeReport : une seule lecture, campagne vérifiée, péremption', () => {
    const area = memoryArea();
    const report = { campaign_id: 'campA', total: 1, accepted: [{ preview: 'RCN1.x…y' }], outcomes: [{ code: 'RCN1.secret', status: 'accepted' }] };
    assert.equal(stashReport(report, { area, now: 1000 }), true);
    assert.equal(takeReport('campB', { area, now: 1000 }), null, 'autre campagne : rien');
    const got = takeReport('campA', { area, now: 2000 });
    assert.equal(got.total, 1);
    assert.equal(got.outcomes, undefined);
    assert.equal(takeReport('campA', { area, now: 2000 }), null, 'lecture unique');
    stashReport(report, { area, now: 0 });
    assert.equal(takeReport('campA', { area, now: 31 * 60 * 1000 }), null, 'rapport périmé');
  });
});
