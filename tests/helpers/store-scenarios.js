// Scénarios du store, communs au backend mémoire (node --test) et au backend IndexedDB
// (vérification dans Chrome). Assertions minimales sans dépendance à node:assert.
// ctx = { open: async () => store vide testé, scratch: async () => store mémoire annexe
//         (source de sauvegardes), kind: 'memory' | 'indexeddb' }

import {
  makeKeys, makeCampaign, makeEntry, makeAssessment, makeAction, seedCampaign,
} from './storage-fixtures.js';

class AssertionError extends Error {}

function fmt(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

export const check = {
  ok(v, msg = 'valeur vraie attendue') {
    if (!v) throw new AssertionError(msg);
  },
  equal(a, b, msg) {
    if (!Object.is(a, b)) throw new AssertionError(`${msg ?? 'égalité'} : ${fmt(a)} ≠ ${fmt(b)}`);
  },
  deepEqual(a, b, msg) {
    if (!deepEqual(a, b)) throw new AssertionError(`${msg ?? 'égalité profonde'} : ${fmt(a)} ≠ ${fmt(b)}`);
  },
  async rejects(promiseOrFn, expected, msg) {
    let error = null;
    try {
      await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (e) {
      error = e;
    }
    if (!error) throw new AssertionError(`${msg ?? 'rejet attendu'} : aucune erreur`);
    if (expected && typeof expected === 'object') {
      for (const [k, v] of Object.entries(expected)) {
        if (error[k] !== v) throw new AssertionError(`${msg ?? 'rejet'} : ${k} = ${fmt(error[k])}, attendu ${fmt(v)}`);
      }
    }
    return error;
  },
};

const UK = 'chatgpt|redaction|commercial_devis';

async function backupOf(store, cid, opts) {
  return store.exportCampaignData(cid, opts);
}

export const scenarios = [
  {
    name: 'type du store',
    async run({ open, kind }) {
      const s = await open();
      check.equal(s.kind, kind, 'kind');
      check.equal(typeof s.persisted, 'boolean', 'persisted booléen');
    },
  },
  {
    name: 'campagnes : écriture, lecture, liste triée, clones',
    async run({ open, scratch }) {
      const s = await open();
      const keys = await makeKeys();
      const b = makeCampaign('campB', keys);
      const a = makeCampaign('campA', null);
      await s.putCampaign(b);
      await s.putCampaign(a);
      b.title = 'modifié après écriture';
      const got = await s.getCampaign('campB');
      check.equal(got.title, 'Recensement IA 2026', "l'objet écrit est copié");
      got.title = 'modifié après lecture';
      got.settings.min_group_size = 99;
      const again = await s.getCampaign('campB');
      check.equal(again.title, 'Recensement IA 2026', "l'objet lu est une copie");
      check.equal(again.settings.min_group_size, 5, 'copie profonde');
      check.deepEqual(again.private_key_jwk, keys.private_key_jwk, 'clé privée conservée');
      check.equal(await s.getCampaign('absente'), null, 'campagne absente ⇒ null');
      const list = await s.listCampaigns();
      check.deepEqual(list.map((c) => c.id), ['campA', 'campB'], 'liste triée par id');
      list[0].title = 'x';
      check.equal((await s.getCampaign('campA')).title, 'Recensement IA 2026', 'liste = copies');
      await s.putCampaign({ ...a, title: 'Nouveau titre' });
      check.equal((await s.getCampaign('campA')).title, 'Nouveau titre', 'remplacement');
    },
  },
  {
    name: 'entrées : écriture, lecture, isolement par campagne, suppression',
    async run({ open, scratch }) {
      const s = await open();
      await s.putCampaign(makeCampaign('campA', null));
      await s.putCampaign(makeCampaign('campB', null));
      const n = await s.putEntries([makeEntry('campA', 'e2'), makeEntry('campA', 'e1'), makeEntry('campB', 'e1')]);
      check.equal(n, 3, 'nombre écrit');
      await s.putEntry(makeEntry('campA', 'e0', { rev: 2 }));
      const listA = await s.listEntries('campA');
      check.deepEqual(listA.map((e) => e.entry_id), ['e0', 'e1', 'e2'], 'tri par entry_id, campagne A seule');
      check.equal((await s.listEntries('campB')).length, 1, 'campagne B');
      check.equal((await s.listEntries('inconnue')).length, 0, 'campagne inconnue');
      const e0 = await s.getEntry('campA', 'e0');
      check.equal(e0.rev, 2, 'getEntry');
      e0.usage.task_types.push('code');
      check.deepEqual((await s.getEntry('campA', 'e0')).usage.task_types, ['redaction'], 'copie profonde');
      check.equal(await s.getEntry('campA', 'absente'), null, 'absente ⇒ null');
      await s.putEntry(makeEntry('campA', 'e0', { rev: 3 }));
      check.equal((await s.getEntry('campA', 'e0')).rev, 3, 'mise à jour');
      await s.deleteEntry('campA', 'e0');
      check.equal(await s.getEntry('campA', 'e0'), null, 'supprimée');
      await s.deleteEntry('campA', 'e0'); // suppression d'une entrée absente : sans erreur
      check.equal((await s.listEntries('campA')).length, 2, 'reste deux entrées');
    },
  },
  {
    name: 'putEntries : tout ou rien (clé invalide)',
    async run({ open, scratch }) {
      const s = await open();
      await s.putCampaign(makeCampaign('campA', null));
      await check.rejects(
        s.putEntries([makeEntry('campA', 'e1'), makeEntry('campA', '')]),
        { name: 'StoreError', code: 'invalid_key' }, 'clé vide',
      );
      check.equal((await s.listEntries('campA')).length, 0, 'aucune écriture partielle');
      await check.rejects(s.putEntries('pas une liste'), { code: 'invalid_record' });
    },
  },
  {
    name: 'putEntries : tout ou rien (valeur non clonable)',
    async run({ open, scratch }) {
      const s = await open();
      await s.putCampaign(makeCampaign('campA', null));
      const bad = makeEntry('campA', 'e2');
      bad.usage.fn = () => 1;
      await check.rejects(s.putEntries([makeEntry('campA', 'e1'), bad]), { name: 'DataCloneError' });
      check.equal((await s.listEntries('campA')).length, 0, 'aucune écriture partielle');
    },
  },
  {
    name: 'évaluations : écriture, liste, suppression',
    async run({ open, scratch }) {
      const s = await open();
      await s.putCampaign(makeCampaign('campA', null));
      await s.putAssessment(makeAssessment('campA', 'k2'));
      await s.putAssessment(makeAssessment('campA', 'k1', { owner: 'Mme Martin' }));
      await s.putAssessment(makeAssessment('campB', 'k1'));
      const list = await s.listAssessments('campA');
      check.deepEqual(list.map((a) => a.usage_key), ['k1', 'k2'], 'tri et isolement');
      check.equal(list[0].owner, 'Mme Martin');
      await s.putAssessment(makeAssessment('campA', 'k1', { validation_status: 'validated' }));
      check.equal((await s.listAssessments('campA'))[0].validation_status, 'validated', 'remplacement');
      await s.deleteAssessment('campA', 'k1');
      check.deepEqual((await s.listAssessments('campA')).map((a) => a.usage_key), ['k2']);
      check.equal((await s.listAssessments('campB')).length, 1, 'autre campagne intacte');
    },
  },
  {
    name: 'actions : écriture unitaire et groupée, liste, suppression',
    async run({ open, scratch }) {
      const s = await open();
      await s.putActions([makeAction('campA', 'a2'), makeAction('campA', 'a1'), makeAction('campB', 'b1')]);
      await s.putAction(makeAction('campA', 'a3', { status: 'done' }));
      const list = await s.listActions('campA');
      check.deepEqual(list.map((a) => a.id), ['a1', 'a2', 'a3']);
      check.equal(list[2].status, 'done');
      await s.deleteAction('a1');
      check.deepEqual((await s.listActions('campA')).map((a) => a.id), ['a2', 'a3']);
      await check.rejects(s.putAction({ id: 'x' }), { code: 'invalid_key' }, 'campaign_id obligatoire');
      await check.rejects(s.putActions([makeAction('campA', 'ok'), null]), { code: 'invalid_record' });
      check.equal((await s.listActions('campA')).length, 2, 'rien écrit');
    },
  },
  {
    name: 'métadonnées',
    async run({ open, scratch }) {
      const s = await open();
      check.equal(await s.getMeta('last_reminder'), null, 'absente ⇒ null');
      await s.setMeta('last_reminder', { at: '2026-09-29', n: 2 });
      const v = await s.getMeta('last_reminder');
      check.deepEqual(v, { at: '2026-09-29', n: 2 });
      v.n = 3;
      check.equal((await s.getMeta('last_reminder')).n, 2, 'copie');
      await s.setMeta('last_reminder', 'texte');
      check.equal(await s.getMeta('last_reminder'), 'texte');
      await check.rejects(s.setMeta('', 1), { code: 'invalid_key' });
    },
  },
  {
    name: 'suppression de campagne en cascade',
    async run({ open, scratch }) {
      const s = await open();
      const keys = await makeKeys();
      await seedCampaign(s, 'campA', keys, { entries: 4, actions: 3 });
      await seedCampaign(s, 'campB', null, { entries: 2, actions: 1 });
      const res = await s.deleteCampaign('campA');
      check.deepEqual(res, { entries: 4, assessments: 1, actions: 3 }, 'compte rendu');
      check.equal(await s.getCampaign('campA'), null);
      check.equal((await s.listEntries('campA')).length, 0, 'entrées supprimées');
      check.equal((await s.listAssessments('campA')).length, 0, 'évaluations supprimées');
      check.equal((await s.listActions('campA')).length, 0, 'actions supprimées');
      check.equal((await s.listEntries('campB')).length, 2, 'autre campagne intacte');
      check.equal((await s.listActions('campB')).length, 1);
      check.equal((await s.listAssessments('campB')).length, 1);
      check.deepEqual(await s.deleteCampaign('campA'), { entries: 0, assessments: 0, actions: 0 }, 'idempotent');
    },
  },
  {
    name: 'identifiants invalides refusés',
    async run({ open, scratch }) {
      const s = await open();
      await check.rejects(s.getCampaign(undefined), { code: 'invalid_key' });
      await check.rejects(s.listEntries(''), { code: 'invalid_key' });
      await check.rejects(s.getEntry('campA', 3), { code: 'invalid_key' });
      await check.rejects(s.putCampaign(null), { code: 'invalid_record' });
      await check.rejects(s.putCampaign(['x']), { code: 'invalid_record' });
      await check.rejects(s.putEntry({ campaign_id: 'campA' }), { code: 'invalid_key' });
      await check.rejects(s.deleteAssessment('campA', null), { code: 'invalid_key' });
    },
  },
  {
    name: 'export : clé privée retirée par défaut, incluse sur demande',
    async run({ open, scratch }) {
      const s = await open();
      const keys = await makeKeys();
      await seedCampaign(s, 'campA', keys);
      const plain = await backupOf(s, 'campA');
      check.equal(plain.format, 'recensia-backup');
      check.equal(plain.v, 1);
      check.ok(!Number.isNaN(Date.parse(plain.exported_at)), 'exported_at ISO');
      check.ok(!('private_key_jwk' in plain.campaign), 'clé privée retirée');
      check.ok(!JSON.stringify(plain).includes('"d"'), 'aucun champ "d"');
      check.equal(plain.entries.length, 3);
      check.equal(plain.assessments.length, 1);
      check.equal(plain.actions.length, 2);
      check.equal(plain.campaign.public_key, keys.public_key, 'clé publique conservée');
      const full = await backupOf(s, 'campA', { includePrivateKey: true, appVersion: '1.2.3' });
      check.deepEqual(full.campaign.private_key_jwk, keys.private_key_jwk, 'clé privée incluse');
      check.equal(full.app_version, '1.2.3');
      check.deepEqual((await s.getCampaign('campA')).private_key_jwk, keys.private_key_jwk, 'store intact');
      await check.rejects(backupOf(s, 'absente'), { code: 'not_found' });
    },
  },
  {
    name: 'import : aller-retour complet',
    async run({ open, scratch }) {
      const s = await open();
      const keys = await makeKeys();
      await seedCampaign(s, 'campA', keys);
      const backup = await backupOf(s, 'campA', { includePrivateKey: true });
      const before = {
        campaign: await s.getCampaign('campA'),
        entries: await s.listEntries('campA'),
        assessments: await s.listAssessments('campA'),
        actions: await s.listActions('campA'),
      };
      await s.deleteCampaign('campA');
      const copy = JSON.parse(JSON.stringify(backup));
      const res = await s.importCampaignData(backup);
      check.deepEqual(res, { campaign_id: 'campA', entries: 3, assessments: 1, actions: 2 });
      check.deepEqual(backup, copy, "l'objet importé n'est pas modifié");
      check.deepEqual(await s.getCampaign('campA'), before.campaign, 'campagne identique');
      check.deepEqual(await s.listEntries('campA'), before.entries, 'entrées identiques');
      check.deepEqual(await s.listAssessments('campA'), before.assessments, 'évaluations identiques');
      check.deepEqual(await s.listActions('campA'), before.actions, 'actions identiques');
    },
  },
  {
    name: 'import : sauvegarde sans clé privée dans un store vide',
    async run({ open, scratch }) {
      const s = await open();
      const src = await scratch();
      const keys = await makeKeys();
      await seedCampaign(src, 'campA', keys);
      const backup = await backupOf(src, 'campA');
      await s.importCampaignData(backup);
      const c = await s.getCampaign('campA');
      check.equal(c.private_key_jwk, null, 'clé privée absente ⇒ null');
      check.equal(c.public_key, keys.public_key);
    },
  },
  {
    name: 'import : conflit sans écrasement',
    async run({ open, scratch }) {
      const s = await open();
      await seedCampaign(s, 'campA', null);
      const backup = await backupOf(s, 'campA');
      backup.entries = [];
      const err = await check.rejects(s.importCampaignData(backup), { name: 'StoreError', code: 'conflict' });
      check.ok(err.message.includes('campA'), 'message explicite');
      check.equal((await s.listEntries('campA')).length, 3, 'rien modifié');
    },
  },
  {
    name: 'import : écrasement remplace les données et garde la clé privée existante',
    async run({ open, scratch }) {
      const s = await open();
      const keys = await makeKeys();
      await seedCampaign(s, 'campA', keys, { entries: 3, actions: 2 });
      const backup = await backupOf(s, 'campA'); // sans clé privée
      backup.campaign.title = 'Titre restauré';
      backup.entries = backup.entries.slice(0, 1);
      backup.actions = [];
      backup.assessments = [];
      const res = await s.importCampaignData(backup, { overwrite: true });
      check.deepEqual(res, { campaign_id: 'campA', entries: 1, assessments: 0, actions: 0 });
      const c = await s.getCampaign('campA');
      check.equal(c.title, 'Titre restauré');
      check.deepEqual(c.private_key_jwk, keys.private_key_jwk, 'clé privée existante conservée');
      check.equal((await s.listEntries('campA')).length, 1, 'anciennes entrées remplacées');
      check.equal((await s.listActions('campA')).length, 0);
      check.equal((await s.listAssessments('campA')).length, 0);
      const withNull = await backupOf(s, 'campA');
      withNull.campaign.private_key_jwk = null;
      await s.importCampaignData(withNull, { overwrite: true });
      check.deepEqual((await s.getCampaign('campA')).private_key_jwk, keys.private_key_jwk, 'null n’écrase pas la clé');
    },
  },
  {
    name: 'import : clé publique différente refusée',
    async run({ open, scratch }) {
      const s = await open();
      const k1 = await makeKeys();
      const k2 = await makeKeys();
      await seedCampaign(s, 'campA', k1);
      const other = await scratch();
      await seedCampaign(other, 'campA', k2);
      const backup = await backupOf(other, 'campA', { includePrivateKey: true });
      await check.rejects(s.importCampaignData(backup, { overwrite: true }), { code: 'key_mismatch' });
      check.equal((await s.getCampaign('campA')).public_key, k1.public_key, 'campagne intacte');
    },
  },
  {
    name: 'import : tout ou rien si une action appartient à une autre campagne',
    async run({ open, scratch }) {
      const s = await open();
      await seedCampaign(s, 'campB', null, { actions: 1 });
      const src = await scratch();
      await seedCampaign(src, 'campA', null, { actions: 0 });
      const backup = await backupOf(src, 'campA');
      backup.actions = [makeAction('campA', 'campB-act-0')];
      await check.rejects(s.importCampaignData(backup), { code: 'conflict' });
      check.equal(await s.getCampaign('campA'), null, 'campagne non créée');
      check.equal((await s.listEntries('campA')).length, 0, 'entrées non créées');
      check.equal((await s.listActions('campB'))[0].campaign_id, 'campB', 'action intacte');
    },
  },
  {
    name: 'import : validation structurelle stricte',
    async run({ open, scratch }) {
      const s = await open();
      const keys = await makeKeys();
      const other = await makeKeys();
      const src = await scratch();
      await seedCampaign(src, 'campA', keys);
      const good = await backupOf(src, 'campA', { includePrivateKey: true });
      const variant = (mutate) => {
        const b = JSON.parse(JSON.stringify(good));
        mutate(b);
        return b;
      };
      // [libellé, sauvegarde, chemin attendu, code attendu] : chaque cas doit échouer pour
      // la raison visée, et pour elle seule.
      const cases = [
        ['non-objet', 'texte', '', 'type'],
        ['format', variant((b) => { b.format = 'autre'; }), 'format', 'format'],
        ['version', variant((b) => { b.v = 2; }), 'v', 'version'],
        ['clé inconnue', variant((b) => { b.extra = 1; }), 'extra', 'unknown'],
        ['campagne absente', variant((b) => { delete b.campaign; }), 'campaign', 'type'],
        ['mode', variant((b) => { b.campaign.mode = 'public'; }), 'campaign.mode', 'enum'],
        ['id campagne', variant((b) => { b.campaign.id = 'a b'; }), 'campaign.id', 'format'],
        ['départements', variant((b) => { b.campaign.departments = 'RH'; }), 'campaign.departments', 'type'],
        ['réglages', variant((b) => { b.campaign.settings.min_group_size = '5'; }), 'campaign.settings.min_group_size', 'type'],
        ['canaux', variant((b) => { b.campaign.settings.channels = [1, 2, 3, 4]; }), 'campaign.settings.channels', 'type'],
        ['clé publique', variant((b) => { b.campaign.public_key = 'abc'; }), 'campaign.public_key', 'format'],
        ['JWK incomplet', variant((b) => { b.campaign.private_key_jwk.d = 'AAAA'; }), 'campaign.private_key_jwk', 'format'],
        ['JWK d’une autre clé', variant((b) => { b.campaign.private_key_jwk = other.private_key_jwk; }), 'campaign.private_key_jwk', 'mismatch'],
        ['created_at', variant((b) => { b.campaign.created_at = 'hier'; }), 'campaign.created_at', 'format'],
        ['entrées non tableau', variant((b) => { b.entries = {}; }), 'entries', 'type'],
        ['entrée hors campagne', variant((b) => { b.entries[0].campaign_id = 'campZ'; }), 'entries[0].campaign_id', 'mismatch'],
        ['rev', variant((b) => { b.entries[0].rev = 0; }), 'entries[0].rev', 'type'],
        ['jour', variant((b) => { b.entries[0].submitted_day = '2026-02-30'; }), 'entries[0].submitted_day', 'format'],
        ['répondant en anonyme', variant((b) => {
          b.entries[0].respondent = { first_name: 'A', last_name: 'B', email: null };
        }), 'entries[0].respondent', 'forbidden'],
        ['usage', variant((b) => { b.entries[0].usage = null; }), 'entries[0].usage', 'type'],
        ['valeur d’usage', variant((b) => { b.entries[0].usage.frequency = 3; }), 'entries[0].usage.frequency', 'type'],
        ['entrée en double', variant((b) => { b.entries[1].entry_id = b.entries[0].entry_id; }), 'entries[1]', 'duplicate'],
        ['niveau surchargé', variant((b) => { b.assessments[0].override_ai_act_level = 'extreme'; }), 'assessments[0].override_ai_act_level', 'enum'],
        ['niveau données', variant((b) => { b.assessments[0].override_data_level = 4; }), 'assessments[0].override_data_level', 'type'],
        ['statut action', variant((b) => { b.actions[0].status = 'waiting'; }), 'actions[0].status', 'enum'],
        ['échéance action', variant((b) => { b.actions[0].due_date = '31/12/2026'; }), 'actions[0].due_date', 'format'],
        ['action en double', variant((b) => { b.actions[1].id = b.actions[0].id; }), 'actions[1]', 'duplicate'],
        ['clé __proto__', variant((b) => {
          b.actions[0] = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(b.actions[0]).slice(1)}`);
        }), 'actions[0].__proto__', 'forbidden'],
      ];
      for (const [label, backup, path, code] of cases) {
        const err = await check.rejects(s.importCampaignData(backup), { code: 'invalid_backup' }, label);
        check.deepEqual(err.details, [{ path, code }], `raison du refus (${label})`);
      }
      check.equal((await s.listCampaigns()).length, 0, 'aucune écriture');
      const open1 = variant((b) => {
        b.campaign.mode = 'open';
        b.entries[0].respondent = { first_name: 'Anne', last_name: 'Durand', email: null };
      });
      await s.importCampaignData(open1);
      await s.deleteCampaign('campA');
      await s.importCampaignData(variant((b) => { b.entries[0].group_override = ''; }));
      check.equal((await s.getEntry('campA', good.entries[0].entry_id)).group_override, '', 'regroupement vide admis');
      await s.deleteCampaign('campA');
      await s.importCampaignData(open1);
      check.equal((await s.getEntry('campA', open1.entries[0].entry_id)).respondent.last_name, 'Durand', 'mode ouvert');
      const err = await check.rejects(
        s.importCampaignData(variant((b) => { b.entries[0].rev = 'x'; }), { overwrite: true }),
        { code: 'invalid_backup' },
      );
      check.ok(Array.isArray(err.details) && err.details.some((d) => d.path === 'entries[0].rev'), 'détail du chemin');
    },
  },
];

/** Exécute tous les scénarios ; → [{ name, ok, error }] (utilisé dans le navigateur). */
export async function runAll(ctx) {
  const results = [];
  for (const sc of scenarios) {
    try {
      await sc.run(ctx);
      results.push({ name: sc.name, ok: true });
    } catch (e) {
      results.push({ name: sc.name, ok: false, error: `${e?.name}: ${e?.message}` });
    }
  }
  return results;
}
