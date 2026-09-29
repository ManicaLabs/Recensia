// Chargement des fichiers de données du site (data/*.json), avec cache.
// Seuls les fichiers de la liste blanche peuvent être demandés : aucune autre requête.

export const DATA_FILES = Object.freeze([
  'questionnaire', 'rules', 'actions', 'regulatory-calendar', 'messages.fr', 'channels', 'demo-company',
]);

async function fetchDataFile(name) {
  const url = new URL(`../data/${name}.json`, import.meta.url);
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`Impossible de charger data/${name}.json : ${err.message}`, { cause: err });
  }
  if (!response.ok) throw new Error(`Impossible de charger data/${name}.json (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch (err) {
    throw new Error(`data/${name}.json n'est pas un JSON valide`, { cause: err });
  }
}

/**
 * Crée un chargeur de données. loader(name) → Promise<json> (par défaut : fetch du fichier du site ;
 * les tests sous Node peuvent fournir une lecture par fs).
 * Les objets renvoyés sont partagés via le cache : les traiter en lecture seule.
 */
export function createData(loader = fetchDataFile) {
  const cache = new Map();
  function get(name) {
    if (!DATA_FILES.includes(name)) {
      return Promise.reject(new Error(`Fichier de données inconnu : « ${name} » (autorisés : ${DATA_FILES.join(', ')})`));
    }
    if (!cache.has(name)) {
      const promise = Promise.resolve()
        .then(() => loader(name))
        .catch((err) => {
          cache.delete(name); // un échec (hors ligne, par exemple) n'est pas mis en cache
          throw err;
        });
      cache.set(name, promise);
    }
    return cache.get(name);
  }
  return Object.freeze({ get, clear: () => cache.clear(), names: DATA_FILES });
}

/** Instance partagée par l'application (ctx.data). */
export const data = createData();

/** Raccourci : data.get(name). */
export function get(name) {
  return data.get(name);
}
