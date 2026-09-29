// Stockage local du responsable (CDC §5.2, §7.6, §10.3 ; ARCHITECTURE §4.3).
// IndexedDB avec repli automatique en mémoire. Les objets renvoyés sont toujours des
// copies : modifier un résultat ne modifie jamais le contenu du store.

import { StoreError, assertId, assertRecord } from './schema.js';
import { createMemoryBackend } from './memory.js';
import { openIdbBackend } from './idb.js';
import { BACKUP_FORMAT, BACKUP_VERSION, validateBackup } from './backup-format.js';

export { StoreError } from './schema.js';
export { BACKUP_FORMAT, BACKUP_VERSION, validateBackup } from './backup-format.js';

const DEFAULT_OPEN_TIMEOUT_MS = 4000;
const PERSIST_TIMEOUT_MS = 1500;
const CHILD_STORES = ['entries', 'assessments', 'actions'];

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

// navigator.storage.persist() peut attendre une réponse de l'utilisateur (Firefox) :
// on n'attend pas au-delà d'un court délai, et une réponse tardive met à jour store.persisted.
async function requestPersistence(store) {
  let storage;
  try {
    storage = globalThis.navigator?.storage;
  } catch {
    return false;
  }
  if (!storage) return false;
  try {
    if (typeof storage.persisted === 'function') {
      const already = await withTimeout(Promise.resolve().then(() => storage.persisted()), PERSIST_TIMEOUT_MS, false);
      if (already === true) return true;
    }
    if (typeof storage.persist !== 'function') return false;
    const asked = Promise.resolve().then(() => storage.persist()).then((v) => v === true, () => false);
    asked.then((v) => { store.persisted = v; });
    return await withTimeout(asked, PERSIST_TIMEOUT_MS, false);
  } catch {
    return false;
  }
}

function describeFailure(errors) {
  const shown = errors.slice(0, 5).map((e) => `${e.path || 'racine'} (${e.code})`).join(', ');
  return errors.length > 5 ? `${shown}…` : shown;
}

function createStore(backend, { kind, reason = null, appVersion = null }) {
  const read1 = async (query) => (await backend.read([query]))[0];
  const put1 = async (storeName, record) => {
    assertRecord(storeName, record);
    await backend.write([{ type: 'put', store: storeName, value: record }]);
  };
  const putMany = async (storeName, records) => {
    if (!Array.isArray(records)) {
      throw new StoreError('invalid_record', `Liste attendue pour « ${storeName} ».`);
    }
    for (const r of records) assertRecord(storeName, r);
    await backend.write(records.map((value) => ({ type: 'put', store: storeName, value })));
    return records.length;
  };

  const store = {
    kind,
    persisted: false,
    /** Raison du repli en mémoire (forced, unavailable, timeout, blocked, error, schema) ; null sinon. */
    reason,
    /** Rappel facultatif appelé quand une autre version de l'application ferme la connexion. */
    onclose: null,

    // Campagnes
    async listCampaigns() {
      return read1({ store: 'campaigns' });
    },
    async getCampaign(id) {
      assertId(id, 'campaign.id');
      return (await read1({ store: 'campaigns', key: id })) ?? null;
    },
    async putCampaign(campaign) {
      await put1('campaigns', campaign);
    },
    /** Supprime la campagne et, dans la même transaction, ses entrées, évaluations et actions. */
    async deleteCampaign(id) {
      assertId(id, 'campaign.id');
      const res = await backend.write([
        { type: 'delete', store: 'campaigns', key: id },
        ...CHILD_STORES.map((name) => ({ type: 'deleteWhere', store: name, campaignId: id })),
      ]);
      return { entries: res[1], assessments: res[2], actions: res[3] };
    },

    // Entrées
    async listEntries(cid) {
      assertId(cid, 'campaign_id');
      return read1({ store: 'entries', campaignId: cid });
    },
    async getEntry(cid, eid) {
      assertId(cid, 'campaign_id');
      assertId(eid, 'entry_id');
      return (await read1({ store: 'entries', key: [cid, eid] })) ?? null;
    },
    async putEntry(entry) {
      await put1('entries', entry);
    },
    async putEntries(entries) {
      return putMany('entries', entries);
    },
    async deleteEntry(cid, eid) {
      assertId(cid, 'campaign_id');
      assertId(eid, 'entry_id');
      await backend.write([{ type: 'delete', store: 'entries', key: [cid, eid] }]);
    },

    // Évaluations
    async listAssessments(cid) {
      assertId(cid, 'campaign_id');
      return read1({ store: 'assessments', campaignId: cid });
    },
    async putAssessment(assessment) {
      await put1('assessments', assessment);
    },
    async deleteAssessment(cid, usageKey) {
      assertId(cid, 'campaign_id');
      assertId(usageKey, 'usage_key');
      await backend.write([{ type: 'delete', store: 'assessments', key: [cid, usageKey] }]);
    },

    // Actions
    async listActions(cid) {
      assertId(cid, 'campaign_id');
      return read1({ store: 'actions', campaignId: cid });
    },
    async putAction(action) {
      await put1('actions', action);
    },
    async putActions(actions) {
      return putMany('actions', actions);
    },
    async deleteAction(id) {
      assertId(id, 'action.id');
      await backend.write([{ type: 'delete', store: 'actions', key: id }]);
    },

    // Métadonnées (préférences locales, date du dernier rappel…)
    async getMeta(key) {
      assertId(key, 'meta.key');
      const rec = await read1({ store: 'meta', key });
      return rec === undefined || rec.value === undefined ? null : rec.value;
    },
    async setMeta(key, value) {
      assertId(key, 'meta.key');
      await backend.write([{ type: 'put', store: 'meta', value: { key, value } }]);
    },

    /**
     * Sauvegarde complète d'une campagne. Sans includePrivateKey, la clé privée est retirée.
     * → { format, v, exported_at, app_version, campaign, entries, assessments, actions }
     */
    async exportCampaignData(cid, { includePrivateKey = false, appVersion: version } = {}) {
      assertId(cid, 'campaign_id');
      const [campaign, entries, assessments, actions] = await backend.read([
        { store: 'campaigns', key: cid },
        { store: 'entries', campaignId: cid },
        { store: 'assessments', campaignId: cid },
        { store: 'actions', campaignId: cid },
      ]);
      if (!campaign) throw new StoreError('not_found', `Campagne introuvable : ${cid}.`);
      if (!includePrivateKey) delete campaign.private_key_jwk;
      return {
        format: BACKUP_FORMAT,
        v: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        app_version: version ?? appVersion ?? null,
        campaign,
        entries,
        assessments,
        actions,
      };
    },

    /**
     * Importe une sauvegarde après validation stricte. Si la campagne existe déjà :
     * erreur « conflict » sans overwrite ; avec overwrite, ses données sont remplacées en une
     * transaction, et une clé privée déjà présente n'est jamais remplacée par une absence de clé.
     * → { campaign_id, entries, assessments, actions } (nombres d'enregistrements importés)
     */
    async importCampaignData(obj, { overwrite = false } = {}) {
      const check = validateBackup(obj);
      if (!check.ok) {
        throw new StoreError('invalid_backup', `Sauvegarde invalide : ${describeFailure(check.errors)}.`, {
          details: check.errors,
        });
      }
      const data = structuredClone(obj);
      const campaign = data.campaign;
      const cid = campaign.id;
      if (campaign.private_key_jwk === undefined) campaign.private_key_jwk = null;

      const mergeCampaign = (existing, incoming) => {
        if (!existing) return incoming;
        if (!overwrite) {
          throw new StoreError('conflict',
            `Une campagne avec l'identifiant « ${cid} » existe déjà dans ce navigateur. Confirmez le remplacement pour l'écraser.`);
        }
        if (existing.public_key && incoming.public_key && existing.public_key !== incoming.public_key) {
          throw new StoreError('key_mismatch',
            'La sauvegarde porte le même identifiant de campagne mais une autre clé publique : import refusé.');
        }
        const merged = { ...incoming };
        if (!merged.private_key_jwk && existing.private_key_jwk) merged.private_key_jwk = existing.private_key_jwk;
        if (!merged.public_key && existing.public_key) merged.public_key = existing.public_key;
        return merged;
      };
      const mergeAction = (existing, incoming) => {
        if (existing && existing.campaign_id !== cid) {
          throw new StoreError('conflict',
            `L'action « ${incoming.id} » appartient déjà à une autre campagne de ce navigateur.`);
        }
        return incoming;
      };

      await backend.write([
        { type: 'put', store: 'campaigns', value: campaign, merge: mergeCampaign },
        ...CHILD_STORES.map((name) => ({ type: 'deleteWhere', store: name, campaignId: cid })),
        ...data.entries.map((value) => ({ type: 'put', store: 'entries', value })),
        ...data.assessments.map((value) => ({ type: 'put', store: 'assessments', value })),
        ...data.actions.map((value) => ({ type: 'put', store: 'actions', value, merge: mergeAction })),
      ]);
      return {
        campaign_id: cid,
        entries: data.entries.length,
        assessments: data.assessments.length,
        actions: data.actions.length,
      };
    },

    /** Ferme la connexion (tests, changement de contexte). */
    close() {
      backend.close();
    },
  };
  return store;
}

/**
 * Ouvre le store. Repli en mémoire si IndexedDB est absent, inaccessible, bloqué, en échec
 * ou trop lent. Options additionnelles : appVersion (inscrite dans les sauvegardes),
 * timeoutMs (délai d'ouverture), indexedDB (fabrique à utiliser à la place de globalThis.indexedDB).
 */
export async function openStore({
  forceMemory = false,
  appVersion = null,
  timeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  indexedDB: factoryOption,
} = {}) {
  const memory = (reason) => createStore(createMemoryBackend(), { kind: 'memory', reason, appVersion });
  if (forceMemory) return memory('forced');

  let factory;
  try {
    factory = factoryOption ?? globalThis.indexedDB;
  } catch {
    factory = undefined; // accès refusé (contexte sandboxé)
  }
  if (!factory || typeof factory.open !== 'function') return memory('unavailable');

  let store = null;
  let backend;
  try {
    backend = await openIdbBackend(factory, {
      timeoutMs,
      onClose: (why) => {
        try { store?.onclose?.(why); } catch { /* le rappel ne doit pas casser le store */ }
      },
    });
  } catch (e) {
    const code = e instanceof StoreError ? e.code : 'error';
    return memory(['timeout', 'blocked', 'schema', 'unavailable'].includes(code) ? code : 'error');
  }
  store = createStore(backend, { kind: 'indexeddb', appVersion });
  store.persisted = await requestPersistence(store);
  return store;
}

