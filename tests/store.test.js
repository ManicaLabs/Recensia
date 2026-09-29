import test from 'node:test';
import assert from 'node:assert/strict';

import { openStore, StoreError, validateBackup, BACKUP_FORMAT } from '../src/storage/store.js';
import { compareKeys } from '../src/storage/schema.js';
import { decodeB64url, isValidDay, isValidIso } from '../src/storage/backup-format.js';
import { scenarios } from './helpers/store-scenarios.js';
import { makeKeys, seedCampaign } from './helpers/storage-fixtures.js';

const ctx = {
  kind: 'memory',
  open: () => openStore({ forceMemory: true }),
  scratch: () => openStore({ forceMemory: true }),
};

for (const sc of scenarios) {
  test(`mémoire — ${sc.name}`, () => sc.run(ctx));
}

// Fausse fabrique IndexedDB : `behavior` décide des événements émis par la requête d'ouverture.
function fakeFactory(behavior) {
  return {
    open() {
      const req = { result: null, error: null, transaction: null };
      setTimeout(() => behavior(req), 5);
      return req;
    },
  };
}

test('repli mémoire : IndexedDB absent (Node)', async () => {
  const s = await openStore();
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'unavailable');
  assert.equal(s.persisted, false);
});

test('repli mémoire : forceMemory', async () => {
  const s = await openStore({ forceMemory: true });
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'forced');
});

test('repli mémoire : accès à indexedDB qui lève une exception', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() { throw new Error('SecurityError'); },
  });
  try {
    const s = await openStore();
    assert.equal(s.kind, 'memory');
    assert.equal(s.reason, 'unavailable');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'indexedDB', desc);
    else delete globalThis.indexedDB;
  }
});

test('repli mémoire : open() lève une exception', async () => {
  const s = await openStore({ indexedDB: { open() { throw new Error('InvalidStateError'); } } });
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'unavailable');
});

test("repli mémoire : échec de l'ouverture", async () => {
  const factory = fakeFactory((req) => {
    req.error = new Error('UnknownError');
    req.onerror?.({ preventDefault() {} });
  });
  const s = await openStore({ indexedDB: factory, timeoutMs: 500 });
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'error');
});

test("repli mémoire : ouverture qui n'aboutit jamais (délai)", async () => {
  const started = Date.now();
  const s = await openStore({ indexedDB: fakeFactory(() => {}), timeoutMs: 60 });
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'timeout');
  assert.ok(Date.now() - started < 1000);
});

test('repli mémoire : ouverture bloquée', async () => {
  const s = await openStore({ indexedDB: fakeFactory((req) => req.onblocked?.()), timeoutMs: 60 });
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'blocked');
});

test('repli mémoire : base existante au schéma inattendu', async () => {
  let closed = false;
  const db = {
    objectStoreNames: { contains: (n) => n === 'campaigns' },
    close() { closed = true; },
  };
  const factory = fakeFactory((req) => { req.result = db; req.onsuccess?.(); });
  const s = await openStore({ indexedDB: factory, timeoutMs: 500 });
  assert.equal(s.kind, 'memory');
  assert.equal(s.reason, 'schema');
  assert.ok(closed, 'connexion refermée');
});

test('chaque store mémoire est indépendant', async () => {
  const a = await openStore({ forceMemory: true });
  const b = await openStore({ forceMemory: true });
  await seedCampaign(a, 'campA', null);
  assert.equal((await b.listCampaigns()).length, 0);
});

test('store fermé : opérations refusées', async () => {
  const s = await openStore({ forceMemory: true });
  s.close();
  await assert.rejects(s.listCampaigns(), (e) => e instanceof StoreError && e.code === 'closed');
});

test('appVersion inscrite dans les sauvegardes', async () => {
  const s = await openStore({ forceMemory: true, appVersion: '0.4.0' });
  await seedCampaign(s, 'campA', null);
  const b = await s.exportCampaignData('campA');
  assert.equal(b.app_version, '0.4.0');
  assert.equal(b.format, BACKUP_FORMAT);
  assert.deepEqual(validateBackup(b), { ok: true, errors: [] });
});

test('sauvegarde exportée valide, avec et sans clé privée', async () => {
  const s = await openStore({ forceMemory: true });
  await seedCampaign(s, 'campA', await makeKeys());
  assert.equal(validateBackup(await s.exportCampaignData('campA')).ok, true);
  assert.equal(validateBackup(await s.exportCampaignData('campA', { includePrivateKey: true })).ok, true);
});

test('utilitaires : ordre des clés, dates, base64url', () => {
  assert.ok(compareKeys('a', 'b') < 0);
  assert.ok(compareKeys('B', 'a') < 0, 'ordre des unités de code');
  assert.ok(compareKeys(['a', 'b'], ['a', 'c']) < 0);
  assert.ok(compareKeys(['a'], ['a', 'a']) < 0);
  assert.ok(compareKeys('z', ['a']) < 0, 'chaînes avant tableaux');
  assert.equal(compareKeys(['x', 'y'], ['x', 'y']), 0);
  assert.equal(isValidDay('2026-02-28'), true);
  assert.equal(isValidDay('2026-02-29'), false);
  assert.equal(isValidDay('2026-9-1'), false);
  assert.equal(isValidIso('2026-09-29T10:00:00.000Z'), true);
  assert.equal(isValidIso('2026-09-29'), false);
  assert.deepEqual([...decodeB64url('AQID')], [1, 2, 3]);
  assert.equal(decodeB64url('AQ+D'), null);
  assert.equal(decodeB64url('A'), null);
});
