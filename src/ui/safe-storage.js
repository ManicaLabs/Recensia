// localStorage / sessionStorage protégés : tout accès est dans un try/catch (contextes sandboxés,
// navigation privée, quota), avec repli en mémoire. Valeurs sérialisées en JSON.
// Les clés sont préfixées pour éviter les collisions : l'origine <compte>.github.io est partagée par tous
// les sites du compte. Le préfixe n'isole rien : ces sites peuvent lire et modifier ces valeurs (brouillons
// des répondants compris), comme l'IndexedDB. Seule une origine réservée à Recensia les protège
// (page de confidentialité, section « Hébergement »).

const PREFIX = 'recensia:';

function createArea(getStorage) {
  const memory = new Map();

  function storage() {
    try {
      return getStorage() ?? null;
    } catch {
      return null;
    }
  }

  function parse(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  return Object.freeze({
    /** Valeur enregistrée, ou fallback si absente ou illisible. */
    get(key, fallback = null) {
      const name = PREFIX + key;
      // Une valeur en mémoire est toujours la plus récente : set() ne l'y garde que si
      // l'écriture dans le navigateur a échoué (le navigateur peut alors contenir une valeur périmée).
      if (memory.has(name)) return parse(memory.get(name), fallback);
      const store = storage();
      if (store) {
        try {
          const raw = store.getItem(name);
          if (raw !== null) return parse(raw, fallback);
        } catch {
          // lecture refusée : valeur par défaut
        }
      }
      return fallback;
    },

    /** Enregistre une valeur. Renvoie false si seul le repli mémoire a pu la garder. */
    set(key, value) {
      const name = PREFIX + key;
      let raw;
      try {
        raw = JSON.stringify(value);
      } catch {
        return false;
      }
      if (raw === undefined) raw = 'null';
      const store = storage();
      if (store) {
        try {
          store.setItem(name, raw);
          memory.delete(name);
          return true;
        } catch {
          // quota dépassé ou accès refusé : l'ancienne valeur, périmée, ne doit pas réapparaître
          try {
            store.removeItem(name);
          } catch {
            // ignoré
          }
        }
      }
      memory.set(name, raw);
      return false;
    },

    remove(key) {
      const name = PREFIX + key;
      memory.delete(name);
      const store = storage();
      if (!store) return;
      try {
        store.removeItem(name);
      } catch {
        // ignoré
      }
    },

    /** Le stockage du navigateur est-il réellement utilisable ? */
    available() {
      const store = storage();
      if (!store) return false;
      try {
        const probe = `${PREFIX}__probe__`;
        store.setItem(probe, '1');
        store.removeItem(probe);
        return true;
      } catch {
        return false;
      }
    },
  });
}

export const local = createArea(() => globalThis.localStorage);
export const session = createArea(() => globalThis.sessionStorage);
