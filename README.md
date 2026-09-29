# Recensia — registre des usages IA en entreprise

Recensia aide une entreprise, et d'abord une PME, à **recenser les usages de l'intelligence
artificielle** auprès de ses équipes, à les **classer** (niveau AI Act d'un côté, exposition des
données de l'autre), à **piloter un plan d'actions** et à **exporter un registre** prêt à l'emploi.

Application web progressive (PWA) gratuite, sans compte et **sans serveur de stockage** :
<https://manicalabs.github.io/Recensia/>

> **Recensia est un outil d'organisation, pas un avis juridique.** Toute classification est
> indicative et doit être confirmée par un juriste ou votre DPO.

## Principes

- **Zéro serveur.** Pas de base de données, pas de backend, pas de compte. GitHub Pages ne fait
  que livrer des fichiers statiques ; tout le traitement a lieu dans le navigateur.
- **Chiffrement de bout en bout.** À la création d'une campagne, le navigateur du responsable
  génère une paire de clés (ECDH P-256). Le lien de collecte ne contient que la clé **publique** :
  chaque usage déclaré est chiffré dans le navigateur du répondant (HKDF-SHA-256 + AES-256-GCM)
  en un code que seul le responsable peut lire. La clé **privée** ne quitte jamais son navigateur,
  sauf s'il exporte lui-même un fichier de récupération (protégé par un mot de passe s'il en
  choisit un) ou une sauvegarde chiffrée.
- **Rien dans les URL envoyées au serveur.** Configuration de campagne et codes voyagent dans le
  fragment (`#/…`), que les navigateurs ne transmettent jamais.
- **Anonymat honnête.** En mode anonyme, le code ne contient aucune identité ; l'interface rappelle
  que le canal de retour (un e-mail, par exemple) peut, lui, révéler l'expéditeur.
- **Mesure d'audience minimale.** GoatCounter, sans cookie, avec une liste blanche de chemins fixes
  et désactivé en local ; aucun script chargé tant que `goatcounterCode` est vide dans `config.js`.
- **Hors ligne.** Le service worker met en cache l'application, ses données et ses bibliothèques.
- **Sans build.** HTML, CSS et modules ES servis tels quels ; bibliothèques vendorisées dans
  `vendor/` (fflate, SheetJS, générateur de QR code). Aucune dépendance npm.

## Développement local

Aucune installation n'est nécessaire : servez la racine du dépôt avec n'importe quel serveur
statique, par exemple :

```sh
python3 -m http.server 8000
# puis ouvrir http://localhost:8000/
```

Les modules ES et le service worker exigent `http://localhost` (ou HTTPS) : l'ouverture directe du
fichier `index.html` (`file://`) ne fonctionne pas. En local, la mesure d'audience est toujours
désactivée.

Après une modification, le service worker de votre navigateur peut servir l'ancienne version :
utilisez le bouton « Recharger » de la bannière de mise à jour, ou un rechargement forcé.

## Validation

Node.js 20 ou plus récent suffit (aucune dépendance) :

```sh
node tools/check.mjs && node --test
```

`tools/check.mjs` vérifie la syntaxe des modules, les fichiers JSON et le manifest (icônes
comprises), la structure d'`index.html`, l'absence de secrets et de fichiers sensibles, la
fraîcheur de `sw-precache.js`, les interdits de sécurité dans `src/` (HTML interprété, `eval`,
styles inline, requêtes réseau, URL tierces) et l'existence des clés de traduction utilisées.

`sw-precache.js` est généré : après toute modification de fichier, régénérez-le avec
`node tools/precache.mjs` (ou `node tools/check.mjs --fix`) avant de committer.

La même validation tourne en intégration continue (GitHub Actions, Node 20 et 22) à chaque push
et pull request.

## Déploiement

GitHub Pages sert la branche `main` à la racine du dépôt (un fichier `.nojekyll` désactive
Jekyll). Déployer, c'est pousser :

```sh
node tools/check.mjs && node --test
git push origin main
```

La publication prend environ une minute ; GitHub Pages met ensuite les fichiers en cache une
dizaine de minutes. Ne jamais committer de secret : le dépôt est public, et `config.js` ne
contient que des réglages publics.

## Documentation

- [Cahier des charges](docs/CDC.md) : périmètre, règles métier, sécurité, feuille de route.
- [Contrat d'architecture](docs/ARCHITECTURE.md) : modules, API, formats et conventions.

## Licence

[MIT](LICENSE).

Recensia ne fournit aucun avis juridique ni certification de conformité : les règles de
classification et les références réglementaires sont un point de départ à faire relire.
