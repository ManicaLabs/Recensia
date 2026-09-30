// Chargement de la démo (src/services/demo.js) : enregistrements §3.2 à §3.5, consolidation en
// 10 lignes (annexe A), chargement et réinitialisation idempotents sur le store mémoire.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoRecords, loadDemo, DEMO_ID, demoReferenceTime, demoDayShift, shiftDay, shiftIso } from '../src/services/demo.js';
import { openStore, validateBackup } from '../src/storage/store.js';
import { consolidate } from '../src/engine/consolidate.js';
import { suggestActions } from '../src/engine/actions.js';
import { validateUsage } from '../src/engine/validate.js';
import { generateCampaignKeys } from '../src/crypto/keys.js';
import { buildCollectUrl, decodeAndVerifyCampaignLink } from '../src/crypto/link.js';
import { encryptEntry, decryptEntry } from '../src/crypto/codes.js';
import { registryPreview, registryPreviewRows } from '../src/views/demo.js';
import { register, t } from '../src/i18n.js';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './helpers/fake-dom.js';
import { loadAll } from './helpers/load-data.js';

const { demo, rules, calendar, questionnaire, actions: actionsData } = loadAll();
const NOW = new Date('2026-09-29T10:00:00.000Z');
const keys = await generateCampaignKeys();

// Annexe A : nom de la ligne → niveaux attendus (échelle numérique : 2 = élevé).
const EXPECTED = new Map([
  ['Reformulation de mails', ['minimal', 2]],
  ['Rédaction de devis', ['minimal', 2]],
  ['Chatbot du site web', ['limited', 2]],
  ['Tri automatique de CV', ['high', 2]],
  ['Aide à l\'évaluation annuelle', ['high', 3]],
  ['Visuels marketing', ['limited', 0]],
  ['Résumé de contrats fournisseurs', ['minimal', 2]],
  ['Transcription de réunions', ['minimal', 1]],
  ['Analyse d\'émotions en visio (test)', ['prohibited_suspected', 2]],
  ['Aide au code du site', ['minimal', 2]],
]);

function memoryData() {
  // Chargeur façon ctx.data : get(name) → promesse.
  return { get: async (name) => (name === 'demo-company' ? demo : Promise.reject(new Error(name))) };
}

describe('buildDemoRecords (pur)', () => {
  const snapshot = JSON.stringify(demo);
  const records = buildDemoRecords(demo, keys, NOW);

  test('campagne §3.2 : id « demo », demo: true, clés fournies, sans sauvegarde', () => {
    const c = records.campaign;
    assert.equal(c.id, DEMO_ID);
    assert.equal(c.id, 'demo');
    assert.equal(c.demo, true);
    assert.equal(c.org_name, 'Menuiserie Alpine Concept');
    assert.equal(c.mode, 'anonymous');
    assert.deepEqual(c.departments, demo.campaign.departments);
    assert.equal(c.public_key, keys.publicKeyB64);
    assert.deepEqual(c.private_key_jwk, keys.privateKeyJwk);
    assert.equal(c.fingerprint, keys.fingerprint);
    assert.equal(c.last_backup_at, null);
    assert.equal(c.recovery_saved_at, null);
    assert.ok(!Number.isNaN(Date.parse(c.created_at)));
    assert.equal(c.settings.min_group_size, 5);
  });

  test('entrées §3.3 : campaign_id « demo », source « demo », imported_at, anonymes', () => {
    assert.equal(records.entries.length, demo.entries.length);
    for (const e of records.entries) {
      assert.equal(e.campaign_id, 'demo');
      assert.equal(e.source, 'demo');
      assert.equal(e.respondent, null);
      assert.equal(e.code_hash, null);
      assert.equal(e.excluded, false);
      assert.ok(!Number.isNaN(Date.parse(e.imported_at)), e.entry_id);
      for (const key of ['entry_id', 'rev', 'submitted_day', 'submitted_at', 'usage', 'schema_version', 'after_close', 'group_override']) {
        assert.ok(key in e, `${e.entry_id} : ${key}`);
      }
      const check = validateUsage(e.usage, questionnaire, {
        departments: records.campaign.departments,
        department_required: records.campaign.settings.department_required,
        mode: records.campaign.mode,
      });
      assert.deepEqual(check.errors, [], e.entry_id);
    }
  });

  test('actions et évaluations rattachées à la campagne, sans responsable affecté automatiquement', () => {
    assert.equal(records.actions.length, demo.actions.length);
    for (const a of records.actions) {
      assert.equal(a.campaign_id, 'demo');
      assert.equal(typeof a.owner, 'string');
      assert.ok(['todo', 'in_progress', 'done', 'rejected'].includes(a.status));
      assert.ok(!Number.isNaN(Date.parse(a.created_at)) && !Number.isNaN(Date.parse(a.updated_at)));
    }
    // Les responsables éventuels viennent du fichier de démo (rôles génériques), jamais du modèle.
    assert.deepEqual(records.actions.map((a) => a.owner), demo.actions.map((a) => a.owner));
    assert.deepEqual(records.assessments, []);
  });

  test('sauvegarde réimportable : les enregistrements passent la validation du format de sauvegarde', () => {
    const check = validateBackup({
      format: 'recensia-backup', v: 1, exported_at: NOW.toISOString(), app_version: 'test',
      campaign: records.campaign, entries: records.entries, assessments: records.assessments, actions: records.actions,
    });
    assert.deepEqual(check.errors, []);
  });

  test('les données partagées (cache de ctx.data) ne sont jamais modifiées', () => {
    records.campaign.settings.min_group_size = 99;
    records.entries[0].usage.usage_name = 'modifié';
    assert.equal(JSON.stringify(demo), snapshot);
    const again = buildDemoRecords(demo, keys, NOW);
    assert.equal(again.campaign.settings.min_group_size, 5);
  });

  test('dates au jour de conception du jeu (29/09/2026) : aucun décalage, dates du fichier conservées', () => {
    const r = buildDemoRecords(demo, keys, NOW);
    assert.equal(r.shift_days, 0);
    assert.equal(r.campaign.created_at, demo.campaign.created_at);
    assert.equal(r.campaign.settings.closes_on, demo.campaign.settings.closes_on);
    assert.deepEqual(r.entries.map((e) => [e.submitted_day, e.imported_at]), demo.entries.map((e) => [e.submitted_day, e.imported_at]));
    assert.deepEqual(r.actions.map((a) => [a.due_date, a.created_at, a.updated_at]), demo.actions.map((a) => [a.due_date, a.created_at, a.updated_at]));
  });

  describe('dates relatives au chargement (le jeu ne « vieillit » pas)', () => {
    const DAY = 86400000;
    const ms = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v));
    const ref = demoReferenceTime(demo);
    // Toutes les dates d'un jeu d'enregistrements, dans un ordre fixe.
    const allDates = (r) => [
      r.campaign.created_at, r.campaign.settings.closes_on,
      ...r.entries.flatMap((e) => [e.submitted_day, e.imported_at]),
      ...r.actions.flatMap((a) => [a.created_at, a.updated_at, a.due_date]),
    ];
    const events = (r) => [r.campaign.created_at, ...r.entries.flatMap((e) => [e.submitted_day, e.imported_at]), ...r.actions.flatMap((a) => [a.created_at, a.updated_at])];
    const base = buildDemoRecords(demo, null, NOW);

    test('référence : la plus récente des dates d\'événements (pas les échéances à venir)', () => {
      assert.equal(new Date(ref).toISOString(), '2026-09-28T16:30:00.000Z');
      assert.equal(demoReferenceTime({ campaign: {} }), null);
      assert.equal(demoDayShift({ campaign: {} }, new Date('2030-01-01T00:00:00Z')), 0, 'jeu non daté : aucun décalage');
    });

    for (const at of ['2027-06-15T08:00:00.000Z', '2031-02-01T23:59:00.000Z', '2026-03-01T12:00:00.000Z']) {
      test(`chargé le ${at} : même décalage entier pour toutes les dates, dernier événement dans les 24 h`, () => {
        const now = new Date(at);
        const r = buildDemoRecords(demo, null, now);
        const shift = demoDayShift(demo, now);
        assert.equal(r.shift_days, shift);
        assert.ok(Number.isInteger(shift));
        // Tous les écarts conservés : chaque date est décalée de `shift` jours exactement.
        const before = allDates(base);
        const after = allDates(r);
        assert.equal(after.length, before.length);
        after.forEach((v, i) => {
          if (before[i] === null) assert.equal(v, null);
          else assert.equal(ms(v) - ms(before[i]), shift * DAY, `${before[i]} → ${v}`);
        });
        // Formats conservés (jour ou horodatage ISO complet).
        assert.ok(r.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.submitted_day)));
        assert.ok(r.actions.every((a) => a.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(a.due_date)));
        // Aucun événement dans le futur ; le plus récent a eu lieu dans les dernières 24 heures.
        const latest = Math.max(...events(r).map(ms));
        assert.ok(latest <= now.getTime() && now.getTime() - latest < DAY, new Date(latest).toISOString());
        // Les échéances d'actions et la clôture restent à venir comme au jour de conception.
        const today = at.slice(0, 10);
        assert.ok(r.campaign.settings.closes_on > today, r.campaign.settings.closes_on);
        const overdue = r.actions.filter((a) => a.due_date && a.due_date < today && (a.status === 'todo' || a.status === 'in_progress'));
        assert.deepEqual(overdue, [], 'aucune action de démo en retard au chargement');
        // Déterministe : même « now », mêmes enregistrements.
        assert.deepEqual(buildDemoRecords(demo, null, now), r);
      });
    }

    test('jeu d\'origine jamais modifié par le décalage ; campagne toujours réimportable', () => {
      const snapshot = JSON.stringify(demo);
      const now = new Date('2028-01-10T09:00:00Z');
      const r = buildDemoRecords(demo, keys, now);
      assert.equal(JSON.stringify(demo), snapshot);
      const check = validateBackup({
        format: 'recensia-backup', v: 1, exported_at: now.toISOString(), app_version: 'test',
        campaign: r.campaign, entries: r.entries, assessments: r.assessments, actions: r.actions,
      });
      assert.deepEqual(check.errors, []);
      // La consolidation (annexe A) ne dépend pas des dates.
      const groups = consolidate(r.entries, rules, calendar);
      assert.equal(groups.length, 10);
    });

    test('évaluations : updated_at et historique décalés de la même façon', () => {
      const data = {
        ...demo,
        assessments: [{ usage_key: 'x', override_ai_act_level: null, override_data_level: null, justification: '', owner: '',
          validation_status: 'validated', history: [{ at: '2026-09-27T10:00:00.000Z', field: 'validation_status', from: 'to_review', to: 'validated', justification: '' }],
          updated_at: '2026-09-27T10:00:00.000Z' }],
      };
      const r = buildDemoRecords(data, null, new Date('2026-10-09T18:00:00Z'));
      assert.equal(r.shift_days, 11);
      assert.equal(r.assessments[0].updated_at, '2026-10-08T10:00:00.000Z');
      assert.equal(r.assessments[0].history[0].at, '2026-10-08T10:00:00.000Z');
      assert.equal(data.assessments[0].history[0].at, '2026-09-27T10:00:00.000Z', 'données d\'origine intactes');
    });

    test('shiftDay / shiftIso : décalage exact, valeurs invalides inchangées', () => {
      assert.equal(shiftDay('2026-12-30', 3), '2027-01-02');
      assert.equal(shiftDay('2028-03-01', -1), '2028-02-29');
      assert.equal(shiftDay('2026-02-31', 5), '2026-02-31');
      assert.equal(shiftDay(null, 5), null);
      assert.equal(shiftIso('2026-09-28T16:30:00.000Z', 2), '2026-09-30T16:30:00.000Z');
      assert.equal(shiftIso('pas une date', 2), 'pas une date');
      assert.equal(shiftIso('2026-09-28T16:30:00.000Z', 0), '2026-09-28T16:30:00.000Z');
    });
  });

  test('sans clés : campagne sans clé publique ni privée', () => {
    const r = buildDemoRecords(demo, null, NOW);
    assert.equal(r.campaign.public_key, null);
    assert.equal(r.campaign.private_key_jwk, null);
    assert.equal(r.campaign.fingerprint, null);
  });

  test('données invalides : erreur explicite', () => {
    assert.throws(() => buildDemoRecords(null, keys, NOW), TypeError);
    assert.throws(() => buildDemoRecords({ entries: [] }, keys, NOW), TypeError);
  });

  test('consolidation : les 10 lignes de l\'annexe A avec les niveaux attendus', () => {
    const r = buildDemoRecords(demo, keys, NOW);
    const groups = consolidate(r.entries, rules, calendar, { byDepartment: r.campaign.settings.group_by_department, assessments: r.assessments });
    assert.equal(groups.length, 10);
    assert.deepEqual(groups.map((g) => g.name).sort(), [...EXPECTED.keys()].sort());
    for (const g of groups) {
      const [ai, data] = EXPECTED.get(g.name);
      assert.equal(g.effective.ai_act_level, ai, g.name);
      assert.equal(g.effective.data_level, data, g.name);
    }
    // Les actions de démo portent sur des lignes existantes et ne sont plus suggérées.
    const keysSet = new Set(groups.map((g) => g.usage_key));
    for (const a of r.actions) assert.ok(a.usage_key === null || keysSet.has(a.usage_key), a.id);
    const suggestions = suggestActions(groups, actionsData, r.actions);
    assert.ok(suggestions.length > 0);
    for (const a of r.actions) {
      assert.ok(!suggestions.some((s) => s.template_id === a.template_id && s.usage_key === a.usage_key), a.id);
    }
  });

  test('lien de collecte de la démo : valide, et un code produit avec la clé publique se déchiffre', async () => {
    const r = buildDemoRecords(demo, keys, NOW);
    const url = buildCollectUrl('https://manicalabs.github.io/Recensia/', r.campaign);
    assert.ok(url.startsWith('https://manicalabs.github.io/Recensia/#/c/'));
    const config = await decodeAndVerifyCampaignLink(url.split('#/c/')[1]);
    assert.equal(config.id, 'demo');
    assert.equal(config.pk, keys.publicKeyB64);
    assert.ok(!url.includes(keys.privateKeyJwk.d), 'jamais de clé privée dans le lien');
    const plain = { v: 1, sv: 1, campaign_id: 'demo', entry_id: 'demoTestEntry001', rev: 1, submitted_day: '2026-09-29', usage: r.entries[0].usage };
    const code = await encryptEntry(plain, config.pk, 'demo');
    const back = await decryptEntry(code, r.campaign.private_key_jwk, 'demo');
    assert.equal(back.usage.usage_name, r.entries[0].usage.usage_name);
  });
});

describe('vue #/demo : aperçu du registre de l\'annexe A (CDC §14, phase 1)', () => {
  const r = buildDemoRecords(demo, keys, NOW);
  const groups = consolidate(r.entries, rules, calendar, { byDepartment: r.campaign.settings.group_by_department, assessments: r.assessments });
  for (const ns of ['common', 'demo']) {
    register(ns, JSON.parse(readFileSync(new URL(`../src/i18n/fr/${ns}.json`, import.meta.url), 'utf8')));
  }
  const elements = (node, tag, out = []) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 1 && (!tag || child.localName === tag)) out.push(child);
      if (child.nodeType === 1) elements(child, tag, out);
    }
    return out;
  };
  const levelsOf = (node) => elements(node).filter((el) => el.hasAttribute('data-level')).map((el) => el.getAttribute('data-level'));

  test('10 lignes, dans l\'ordre du registre, avec les niveaux attendus de l\'annexe A', () => {
    const rows = registryPreviewRows(groups);
    assert.equal(rows.length, 10);
    assert.deepEqual(rows.map((x) => x.id), groups.map((g) => g.id));
    for (const row of rows) assert.deepEqual([row.ai_act_level, row.data_level], EXPECTED.get(row.name), row.name);
    assert.equal(rows[0].name, 'Analyse d\'émotions en visio (test)', 'interdit suspecté en tête');
    assert.deepEqual(registryPreviewRows(undefined), []);
  });

  test('rendu : tableau (en-têtes nommant chaque axe) et cartes, 10 usages et leurs deux niveaux, lien vers le registre', () => {
    const dom = installFakeDocument();
    try {
      const node = registryPreview(t, groups, { href: '#/admin/demo/registre' });
      const table = elements(node, 'table')[0];
      const headers = elements(elements(table, 'thead')[0], 'th').map((th) => th.textContent);
      assert.deepEqual(headers, ['Cas d\'usage', 'Service(s)', 'Niveau AI Act', 'Exposition des données']);
      const trs = elements(elements(table, 'tbody')[0], 'tr');
      assert.equal(trs.length, 10);
      const byName = new Map(trs.map((tr) => [elements(tr, 'th')[0].textContent, levelsOf(tr)]));
      for (const [name, [ai, data]] of EXPECTED) assert.deepEqual(byName.get(name), [ai, String(data)], name);
      // Annexe A : n°4 et n°5 haut risque, n°9 interdit suspecté, n°5 exposition critique.
      assert.equal(byName.get('Tri automatique de CV')[0], 'high');
      assert.deepEqual(byName.get('Aide à l\'évaluation annuelle'), ['high', '3']);
      assert.equal(byName.get('Analyse d\'émotions en visio (test)')[0], 'prohibited_suspected');
      const text = node.textContent;
      assert.match(text, /Haut risque/);
      assert.match(text, /Interdit suspecté/);
      assert.match(text, /Critique/);
      assert.match(text, /indicative, à confirmer/);

      const cards = elements(elements(node, 'ul').find((ul) => ul.getAttribute('class') === 'demo-registry-cards'), 'li');
      assert.equal(cards.length, 10);
      assert.deepEqual(cards.map(levelsOf), trs.map(levelsOf), 'mêmes niveaux dans les cartes (petits écrans)');
      const link = elements(node, 'a').find((a) => a.getAttribute('href') === '#/admin/demo/registre');
      assert.ok(link, 'lien « Voir le registre complet »');
      assert.equal(link.textContent, 'Voir le registre complet');
    } finally {
      dom.restore();
    }
  });

  test('registre vide : message au lieu du tableau', () => {
    const dom = installFakeDocument();
    try {
      const node = registryPreview(t, [], { href: '#/admin/demo/registre' });
      assert.equal(elements(node, 'table').length, 0);
      assert.match(node.textContent, /réinitialisez la démo/);
    } finally {
      dom.restore();
    }
  });

  test('compteur d\'actions de la page : actions retenues au plan (libellé « au plan », pas « engagées »)', () => {
    const planned = r.actions.filter((a) => a.status !== 'rejected').length;
    assert.equal(planned, 5);
    assert.equal(t('demo.content.kpi.actions', { count: planned }), 'actions au plan');
    assert.equal(t('demo.content.kpi.actions', { count: 1 }), 'action au plan');
  });
});

describe('loadDemo (store mémoire)', () => {
  test('premier chargement : campagne, 23 entrées et actions écrites ; second appel sans effet', async () => {
    const store = await openStore({ forceMemory: true });
    const first = await loadDemo(store, memoryData(), { now: NOW });
    assert.equal(first.loaded, true);
    assert.deepEqual(first.counts, { entries: demo.entries.length, actions: demo.actions.length, assessments: 0 });
    const campaign = await store.getCampaign('demo');
    assert.equal(campaign.demo, true);
    assert.ok(campaign.public_key && campaign.private_key_jwk && campaign.fingerprint);
    assert.equal((await store.listEntries('demo')).length, demo.entries.length);
    assert.equal((await store.listActions('demo')).length, demo.actions.length);

    const second = await loadDemo(store, memoryData(), { now: NOW });
    assert.equal(second.loaded, false);
    assert.equal(second.campaign.public_key, campaign.public_key, 'la démo existante est conservée');
    assert.equal((await store.listEntries('demo')).length, demo.entries.length);
  });

  test('accepte aussi le contenu JSON directement', async () => {
    const store = await openStore({ forceMemory: true });
    const r = await loadDemo(store, demo, { now: NOW, keys });
    assert.equal(r.loaded, true);
    assert.equal((await store.getCampaign('demo')).public_key, keys.publicKeyB64);
  });

  test('réinitialisation : modifications effacées, jeu d\'origine rechargé, idempotente', async () => {
    const store = await openStore({ forceMemory: true });
    await loadDemo(store, memoryData(), { now: NOW });
    // L'utilisateur modifie la démo : action ajoutée, action modifiée, entrée supprimée, évaluation.
    await store.putAction({ id: 'M-extra', campaign_id: 'demo', usage_key: null, template_id: null, title: 'Ajout', description: '',
      owner: '', due_date: null, priority: 'low', status: 'todo', suggested: false, suggested_role: null,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
    const [firstAction] = await store.listActions('demo');
    await store.putAction({ ...firstAction, status: 'rejected' });
    await store.deleteEntry('demo', demo.entries[0].entry_id);
    await store.putAssessment({ campaign_id: 'demo', usage_key: 'x', override_ai_act_level: 'high', override_data_level: null,
      justification: 'test', owner: '', validation_status: 'validated', history: [], updated_at: NOW.toISOString() });
    // Une autre campagne ne doit pas être touchée.
    await store.putCampaign({ ...(await store.getCampaign('demo')), id: 'autre', demo: false });

    const snapshot = async () => ({
      entries: (await store.listEntries('demo')).map((e) => e.entry_id).sort(),
      actions: (await store.listActions('demo')).map((a) => `${a.id}:${a.status}`).sort(),
      assessments: (await store.listAssessments('demo')).length,
    });

    const r1 = await loadDemo(store, memoryData(), { reset: true, now: NOW });
    assert.equal(r1.loaded, true);
    const s1 = await snapshot();
    const r2 = await loadDemo(store, memoryData(), { reset: true, now: NOW });
    assert.equal(r2.loaded, true);
    const s2 = await snapshot();

    assert.deepEqual(s1, s2, 'deux réinitialisations donnent le même état');
    assert.deepEqual(s1.entries, demo.entries.map((e) => e.entry_id).sort());
    assert.deepEqual(s1.actions, demo.actions.map((a) => `${a.id}:${a.status}`).sort());
    assert.equal(s1.assessments, 0);
    assert.ok(await store.getCampaign('autre'), 'autre campagne conservée');
    const groups = consolidate(await store.listEntries('demo'), rules, calendar);
    assert.equal(groups.length, 10);
  });

  test('échec d\'écriture : aucune démo partielle laissée', async () => {
    const store = await openStore({ forceMemory: true });
    const failing = { ...store, putActions: async () => { throw new Error('quota'); } };
    await assert.rejects(() => loadDemo(failing, memoryData(), { now: NOW }), /quota/);
    assert.equal(await store.getCampaign('demo'), null);
    assert.equal((await store.listEntries('demo')).length, 0);
  });

  test('réinitialisation sans données disponibles (hors ligne sans cache) : la démo existante est conservée', async () => {
    const store = await openStore({ forceMemory: true });
    await loadDemo(store, memoryData(), { now: NOW });
    const before = await store.getCampaign('demo');
    const offline = { get: async () => { throw new Error('offline'); } };
    await assert.rejects(() => loadDemo(store, offline, { reset: true, now: NOW }), /offline/);
    const after = await store.getCampaign('demo');
    assert.ok(after, 'campagne de démo toujours présente');
    assert.equal(after.public_key, before.public_key);
    assert.equal((await store.listEntries('demo')).length, demo.entries.length);
    assert.equal((await store.listActions('demo')).length, demo.actions.length);
  });

  test('chargement à une date ultérieure : dates décalées dans le store', async () => {
    const store = await openStore({ forceMemory: true });
    const later = new Date('2027-09-01T10:00:00Z');
    await loadDemo(store, memoryData(), { now: later, keys });
    const campaign = await store.getCampaign('demo');
    assert.ok(campaign.settings.closes_on > '2027-09-01', campaign.settings.closes_on);
    const actions = await store.listActions('demo');
    assert.ok(actions.every((a) => a.updated_at <= later.toISOString()));
  });

  test('sans store : erreur explicite', async () => {
    await assert.rejects(() => loadDemo(null, memoryData()), TypeError);
  });
});
