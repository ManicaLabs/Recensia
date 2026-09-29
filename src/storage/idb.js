// Backend IndexedDB. Aucun accès à IndexedDB à l'import : tout passe par la fabrique
// transmise à openIdbBackend (globalThis.indexedDB en production).

import {
  CAMPAIGN_INDEX, DB_NAME, DB_VERSION, STORES, STORE_NAMES, StoreError,
  assertRecord, keyOf, sameKey,
} from './schema.js';

const PROBE_KEY = '__recensia_probe__';

function upgrade(db) {
  for (const [name, def] of Object.entries(STORES)) {
    if (db.objectStoreNames.contains(name)) continue;
    const os = db.createObjectStore(name, { keyPath: Array.isArray(def.keyPath) ? [...def.keyPath] : def.keyPath });
    if (def.index) os.createIndex(CAMPAIGN_INDEX, CAMPAIGN_INDEX, { unique: false });
  }
}

function openDatabase(factory, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let blocked = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      fn(value);
      return true;
    };
    let req;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(new StoreError('unavailable', 'IndexedDB est inaccessible.', { cause: e }));
      return;
    }
    timer = setTimeout(() => {
      finish(reject, blocked
        ? new StoreError('blocked', "L'ouverture de la base locale est bloquée par un autre onglet.")
        : new StoreError('timeout', "L'ouverture de la base locale a expiré."));
    }, timeoutMs);
    req.onupgradeneeded = () => {
      try {
        upgrade(req.result);
      } catch (e) {
        try { req.transaction.abort(); } catch { /* déjà interrompue */ }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Ouverture arrivée après expiration du délai : on referme pour ne rien laisser traîner.
      if (!finish(resolve, db)) {
        try { db.close(); } catch { /* ignoré */ }
      }
    };
    req.onerror = (ev) => {
      try { ev.preventDefault(); } catch { /* ignoré */ }
      finish(reject, new StoreError('error', "Échec de l'ouverture de la base locale.", { cause: req.error }));
    };
    req.onblocked = () => { blocked = true; };
  });
}

function hasExpectedSchema(db) {
  for (const name of STORE_NAMES) {
    if (!db.objectStoreNames.contains(name)) return false;
  }
  const tx = db.transaction(STORE_NAMES, 'readonly');
  for (const [name, def] of Object.entries(STORES)) {
    const os = tx.objectStore(name);
    if (JSON.stringify(os.keyPath) !== JSON.stringify(def.keyPath)) return false;
    if (def.index && !os.indexNames.contains(CAMPAIGN_INDEX)) return false;
  }
  return true;
}

// Écriture puis effacement d'une clé de test : certains contextes ouvrent la base
// mais refusent ensuite toute écriture.
function probeWrite(db, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreError('timeout', "L'écriture de test a expiré.")), timeoutMs);
    try {
      const tx = db.transaction(['meta'], 'readwrite');
      const os = tx.objectStore('meta');
      os.put({ key: PROBE_KEY, value: 1 });
      os.delete(PROBE_KEY);
      tx.oncomplete = () => { clearTimeout(timer); resolve(); };
      tx.onabort = () => {
        clearTimeout(timer);
        reject(new StoreError('error', "L'écriture de test a échoué.", { cause: tx.error }));
      };
    } catch (e) {
      clearTimeout(timer);
      reject(new StoreError('error', "L'écriture de test a échoué.", { cause: e }));
    }
  });
}

async function connect(factory, timeoutMs) {
  const db = await openDatabase(factory, timeoutMs);
  let ok = false;
  try {
    ok = hasExpectedSchema(db);
  } catch {
    ok = false;
  }
  if (!ok) {
    try { db.close(); } catch { /* ignoré */ }
    throw new StoreError('schema', 'La base locale existante a un schéma inattendu.');
  }
  try {
    await probeWrite(db, timeoutMs);
  } catch (e) {
    try { db.close(); } catch { /* ignoré */ }
    throw e;
  }
  return db;
}

function uniqueStores(list) {
  return [...new Set(list.map((x) => x.store))];
}

function abortQuietly(tx) {
  try { tx.abort(); } catch { /* déjà terminée */ }
}

/**
 * Ouvre la base et renvoie un backend { kind, read, write, close }.
 * `onClose(reason)` est appelé quand la connexion est fermée par une autre version de
 * l'application (versionchange) ou par le navigateur ; la connexion est rouverte à la
 * demande lors de l'opération suivante.
 */
export async function openIdbBackend(factory, { timeoutMs = 4000, onClose } = {}) {
  let db = null;
  let reopening = null;
  let closedByUser = false;

  const attach = (conn) => {
    conn.onversionchange = () => {
      try { conn.close(); } catch { /* ignoré */ }
      if (db === conn) db = null;
      if (onClose) onClose('versionchange');
    };
    conn.onclose = () => {
      if (db === conn) db = null;
      if (onClose) onClose('closed');
    };
    db = conn;
  };

  attach(await connect(factory, timeoutMs));

  async function getDb() {
    if (closedByUser) throw new StoreError('closed', 'La base locale est fermée.');
    if (db) return db;
    if (!reopening) {
      reopening = connect(factory, timeoutMs)
        .then((conn) => { attach(conn); return conn; })
        .finally(() => { reopening = null; });
    }
    try {
      return await reopening;
    } catch (e) {
      throw new StoreError('closed',
        "La base locale a été fermée (mise à jour dans un autre onglet ?). Rechargez la page.", { cause: e });
    }
  }

  // La transaction est créée et ses requêtes émises dans le même bloc synchrone.
  async function runTransaction(names, mode, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await getDb();
      let tx;
      try {
        tx = conn.transaction(names, mode);
      } catch (e) {
        // Connexion fermée entre-temps : on la rouvre une fois.
        if (e && e.name === 'InvalidStateError' && attempt === 0) {
          if (db === conn) db = null;
          continue;
        }
        throw e;
      }
      return new Promise((resolve, reject) => body(tx, resolve, reject));
    }
    throw new StoreError('closed', 'La base locale est fermée.');
  }

  async function read(queries) {
    if (queries.length === 0) return [];
    return runTransaction(uniqueStores(queries), 'readonly', (tx, resolve, reject) => {
      const results = new Array(queries.length);
      try {
        queries.forEach((q, i) => {
          const os = tx.objectStore(q.store);
          let req;
          if ('key' in q) req = os.get(q.key);
          else if (q.campaignId !== undefined) req = os.index(CAMPAIGN_INDEX).getAll(q.campaignId);
          else req = os.getAll();
          req.onsuccess = () => { results[i] = req.result; };
        });
      } catch (e) {
        abortQuietly(tx);
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(results);
      tx.onabort = () => reject(tx.error ?? new StoreError('aborted', 'Lecture interrompue.'));
    });
  }

  // Les opérations sont émises dans l'ordre : une opération qui dépend d'une lecture
  // préalable (fusion, suppression par index) n'émet la suivante qu'une fois ses propres
  // requêtes placées, ce qui garantit l'ordre d'exécution dans la transaction.
  async function write(ops) {
    if (ops.length === 0) return [];
    return runTransaction(uniqueStores(ops), 'readwrite', (tx, resolve, reject) => {
      const results = new Array(ops.length).fill(undefined);
      let failure = null;
      const fail = (err) => {
        if (!failure) failure = err;
        abortQuietly(tx);
      };

      const run = (start) => {
        for (let i = start; i < ops.length; i++) {
          const op = ops[i];
          try {
            const os = tx.objectStore(op.store);
            if (op.type === 'put' && !op.merge) {
              os.put(op.value);
              results[i] = 1;
            } else if (op.type === 'put') {
              const key = keyOf(op.store, op.value);
              const req = os.get(key);
              req.onsuccess = () => {
                try {
                  const value = op.merge(req.result, op.value);
                  assertRecord(op.store, value);
                  if (!sameKey(keyOf(op.store, value), key)) {
                    throw new StoreError('invalid_key', 'La fusion ne doit pas modifier la clé.');
                  }
                  os.put(value);
                  results[i] = 1;
                } catch (e) {
                  fail(e);
                  return;
                }
                run(i + 1);
              };
              return;
            } else if (op.type === 'delete') {
              os.delete(op.key);
            } else if (op.type === 'deleteWhere') {
              const req = os.index(CAMPAIGN_INDEX).getAllKeys(op.campaignId);
              req.onsuccess = () => {
                try {
                  for (const k of req.result) os.delete(k);
                  results[i] = req.result.length;
                } catch (e) {
                  fail(e);
                  return;
                }
                run(i + 1);
              };
              return;
            } else {
              throw new StoreError('invalid_op', `Opération inconnue : ${op.type}.`);
            }
          } catch (e) {
            fail(e);
            return;
          }
        }
      };

      tx.oncomplete = () => resolve(results);
      tx.onerror = (ev) => {
        if (!failure) failure = ev?.target?.error ?? tx.error ?? null;
      };
      tx.onabort = () => reject(failure ?? tx.error ?? new StoreError('aborted', 'Écriture interrompue.'));
      run(0);
    });
  }

  function close() {
    closedByUser = true;
    if (db) {
      try { db.close(); } catch { /* ignoré */ }
      db = null;
    }
  }

  return { kind: 'indexeddb', read, write, close };
}
