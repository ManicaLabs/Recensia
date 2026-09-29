# Vecteurs de test figés — format de code `RCN1`

`codes-v1.json` garantit la **compatibilité ascendante** des codes de réponse (CDC §7.2, §10.4, §15) :
toute version future de `src/crypto/codes.js` doit continuer à déchiffrer ces codes et à retrouver
exactement le clair attendu. Un service worker périmé chez un répondant ne doit jamais produire des
codes illisibles pour un responsable à jour.

## Clé de test

> **TEST KEY — NOT A SECRET.** La clé privée `test_key.private_key_jwk` (et la clé éphémère des vecteurs
> déterministes) a été générée uniquement pour ces vecteurs, le 29/09/2026. Elle est publique par
> construction, ne protège aucune donnée réelle et ne doit **jamais** être réutilisée ailleurs
> (démo, documentation, campagne).

Les outils de recherche de secrets (`tools/check.mjs`, section 12 du CDC) doivent ignorer ce dossier.

## Contenu

| Clé | Rôle |
|---|---|
| `test_key` | identifiant de campagne, clé publique brute (base64url), empreinte, JWK privé de test |
| `decrypt_vectors[]` | codes produits par `encryptEntry` (clé éphémère et IV aléatoires) ; `decryptEntry` doit renvoyer `expected` et `codeHash` doit renvoyer `code_hash` |
| `deterministic_vectors[]` | chiffrement déterministe : `_encryptEntryWith(plain, pk, campaign_id, { ephemeralPrivateJwk, iv })` doit produire **exactement** `code` |
| `reject_vectors[]` | codes qui doivent être refusés avec `CodeError.reason` = `reason` |

## Règles

1. **Ne jamais modifier ni régénérer** `codes-v1.json`. Pour un nouveau format (`RCN2`, `v: 2`, nouveau
   `sv`), ajouter un fichier `codes-v2.json` à côté ; les anciens vecteurs restent lus.
2. Le vecteur déterministe dépend aussi de la sortie de la compression (fflate 0.8.2, niveau 9). Si une
   mise à jour de `vendor/fflate.mjs` change cette sortie, seul le test déterministe peut échouer : le
   déchiffrement des anciens codes doit, lui, continuer à passer. Dans ce cas, ajouter un nouveau vecteur
   déterministe plutôt que de modifier l'ancien.
3. Aucune donnée réelle : les usages et identités sont fictifs.

## Génération (pour mémoire)

Généré une seule fois avec l'API publique du module : `generateCampaignKeys()` pour la clé de test et
la clé éphémère, `encryptEntry()` pour `decrypt_vectors`, `_encryptEntryWith()` avec un IV tiré par
`crypto.getRandomValues` pour `deterministic_vectors`, puis `decryptEntry()` pour les valeurs `expected`.
