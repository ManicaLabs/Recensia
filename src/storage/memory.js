// Backend mémoire : même sémantique que le backend IndexedDB (clones, ordre des clés,
// écritures atomiques), sans persistance au-delà de la vie de l'objet.

import {
  STORES, STORE_NAMES, StoreError, assertRecord, compareKeys, keyOf, sameKey, serializeKey,
} from './schema.js';

function storeMap(maps, name) {
  const m = maps.get(name);
  if (!m) throw new StoreError('invalid_store', `Magasin inconnu : ${name}.`);
  return m;
}

function sortedValues(map, campaignId) {
  let recs = [...map.values()];
  if (campaignId !== undefined) recs = recs.filter((r) => r.value.campaign_id === campaignId);
  recs.sort((a, b) => compareKeys(a.key, b.key));
  return recs.map((r) => structuredClone(r.value));
}

export function createMemoryBackend() {
  let data = new Map(STORE_NAMES.map((n) => [n, new Map()]));
  let closed = false;

  function ensureOpen() {
    if (closed) throw new StoreError('closed', 'La base locale est fermée.');
  }

  return {
    kind: 'memory',

    async read(queries) {
      ensureOpen();
      return queries.map((q) => {
        const map = storeMap(data, q.store);
        if ('key' in q) {
          const rec = map.get(serializeKey(q.key));
          return rec === undefined ? undefined : structuredClone(rec.value);
        }
        if (q.campaignId !== undefined && !STORES[q.store].index) {
          throw new StoreError('invalid_store', `Le magasin « ${q.store} » n'a pas d'index campaign_id.`);
        }
        return sortedValues(map, q.campaignId);
      });
    },

    async write(ops) {
      ensureOpen();
      // Les modifications portent sur des copies des tables touchées, substituées
      // d'un bloc à la fin : une erreur en cours de route ne laisse aucune trace.
      const staged = new Map();
      const table = (name) => {
        if (!staged.has(name)) staged.set(name, new Map(storeMap(data, name)));
        return staged.get(name);
      };
      const results = [];
      for (const op of ops) {
        const map = table(op.store);
        if (op.type === 'put') {
          const key = keyOf(op.store, op.value);
          let value = op.value;
          if (op.merge) {
            const existing = map.get(serializeKey(key));
            value = op.merge(existing === undefined ? undefined : structuredClone(existing.value), op.value);
            assertRecord(op.store, value);
            if (!sameKey(keyOf(op.store, value), key)) {
              throw new StoreError('invalid_key', 'La fusion ne doit pas modifier la clé.');
            }
          }
          map.set(serializeKey(key), { key: structuredClone(key), value: structuredClone(value) });
          results.push(1);
        } else if (op.type === 'delete') {
          map.delete(serializeKey(op.key));
          results.push(undefined);
        } else if (op.type === 'deleteWhere') {
          let n = 0;
          for (const [k, rec] of map) {
            if (rec.value.campaign_id === op.campaignId) { map.delete(k); n++; }
          }
          results.push(n);
        } else {
          throw new StoreError('invalid_op', `Opération inconnue : ${op.type}.`);
        }
      }
      const next = new Map(data);
      for (const [name, map] of staged) next.set(name, map);
      data = next;
      return results;
    },

    close() {
      closed = true;
    },
  };
}
