# Recensia — vérifications manuelles

Document compagnon de [CDC.md](CDC.md) (§14, critères d'acceptation) et de
[ARCHITECTURE.md](ARCHITECTURE.md). Il décrit les vérifications qu'aucun test automatique ne couvre
entièrement : logiciels tiers (Excel, clients de messagerie), matériel (imprimante, appareil photo,
téléphone), technologies d'assistance et chronométrage avec de vraies personnes.

Chaque section donne le protocole pas à pas, l'environnement à noter et un tableau de résultats
daté par version. **On ajoute une ligne par exécution, on n'efface jamais une ligne existante.**
Les lignes dont seule la première colonne utile est remplie (client, appareil, support…) sont des
lignes à compléter : on les remplit lors de la première exécution, puis on ajoute une nouvelle ligne
aux exécutions suivantes. L'intégrateur reporte l'état dans le CDC (§5bis) quand une vérification a
été exécutée.

## 0. Conventions

- **Version** : `appVersion` de `config.js`, affichée dans le pied de page (« Recensia version 0.9.0 »).
  Une vérification ne vaut que pour la version testée ; la refaire à chaque version qui touche la
  zone concernée (voir le tableau ci-dessous).
- **Environnement** : système et version, navigateur et version, logiciel testé et version exacte
  (menu « À propos »), appareil pour les tests mobiles.
- **Résultat** : `OK`, `KO` (avec la référence du ticket ou du correctif) ou `partiel` (préciser).
- **Données** : utiliser la démo (`#/demo`) ou une campagne de test créée pour l'occasion, jamais de
  données réelles. Les codes et fichiers produits pendant les tests ne sont pas versionnés
  (`tools/check.mjs` refuse les `.rcn`, `.recensia-key` et sauvegardes dans le dépôt).
- **Personne** : prénom et nom, ou « automatisé » pour une exécution par script (préciser l'outil).
- Adresse de production : <https://manicalabs.github.io/Recensia/>. Après un déploiement, attendre la
  fin du build GitHub Pages et recharger (bouton « Recharger » de la bannière, ou rechargement forcé).

### Quand refaire quoi

| Vérification | Section | Critère | À refaire |
|---|---|---|---|
| Exports dans Microsoft Excel et LibreOffice | 1 | CDC §14 (phase 1) | à chaque version qui touche `src/export/`, les colonnes du registre ou `data/` |
| Premier usage chronométré avec 5 personnes | 2 | CDC §4 et §14 (phase 1) | à chaque version qui modifie la notice, le questionnaire ou l'envoi du code |
| Liens dans Outlook, Gmail, Teams, WhatsApp, Slack, Safe Links | 3 | CDC §7.7 et §14 (phase 2) | **à chaque release** (les URL de partage des services tiers changent sans préavis) |
| QR code imprimé et projeté | 4 | ARCHITECTURE §7 | à chaque version qui change le lien de collecte, le QR ou la fiche imprimable |
| Lecteurs d'écran | 5 | CDC §10.5 | à chaque version qui touche l'interface |
| Hors ligne et installation (ordinateur et mobile) | 6 | CDC §10.2 et §14 (phases 0 à 2) | à chaque version qui touche `sw.js`, le manifest, les icônes ou `index.html` ; au moins une fois par release |
| Origine partagée, intégrité du cache hors ligne, page 404 | 7 | ARCHITECTURE §5.6, page de confidentialité (Hébergement) | **à chaque release**, et dès qu'un autre site est publié sous `manicalabs.github.io` |

## 1. Exports Excel (.xlsx) et CSV dans Microsoft Excel et LibreOffice

Critère §14 (phase 1) : « exports XLSX/CSV s'ouvrent sans erreur dans Excel et LibreOffice » et
« injection de formules neutralisée ». Formats : CDC §8.3 (CSV UTF-8 avec BOM, séparateur `;`, CRLF).

### Préparation

1. Ouvrir `#/demo`, puis l'onglet **Registre** de la campagne de démonstration.
2. Onglet **Saisir un usage** : ajouter un usage dont le nom est `=1+1` et le commentaire `@SOMME(A1)`
   (contrôle de l'injection de formules), puis revenir au **Registre**.
3. Cliquer sur **Exporter le registre en CSV** puis **Exporter en Excel (.xlsx)**. Deux fichiers
   `recensia-registre-<campagne>-<date>.csv` et `.xlsx` sont téléchargés. Pour contrôler
   `@SOMME(A1)`, cocher **Inclure les commentaires libres dans les exports** (onglet **Paramètres**)
   puis refaire les deux exports.
4. Onglet **Rapport** : **Imprimer / PDF** vers un fichier PDF (contrôle de l'impression propre, §14).

### Partie automatisable (LibreOffice sans interface)

```sh
# Chaque feuille du classeur devient un CSV (séparateur ;, UTF-8) : échec si le fichier est illisible.
soffice --headless --convert-to 'csv:Text - txt - csv (StarCalc):59,34,76,1,,0,false,true,false,false,false,-1' \
  --outdir out recensia-registre-*.xlsx
# Le CSV exporté, relu avec séparateur ; et encodage UTF-8, puis réécrit en XLSX.
soffice --headless --infilter='CSV:59,34,76,1' --convert-to xlsx --outdir out recensia-registre-*.csv
```

Attendu : quatre CSV (`Registre`, `Plan d'actions`, `Synthèse`, `Référentiel`) ; la première ligne de
`Registre` est l'en-tête du registre (§8.2, 20 colonnes) ; accents intacts ; la conversion du CSV
réussit. Cette étape ne remplace pas l'ouverture interactive ci-dessous.

### Partie manuelle

Logiciels, dans cet ordre de priorité : **Microsoft Excel Microsoft 365 sous Windows** (obligatoire),
Excel 2019 ou 2021 sous Windows si l'entreprise en a encore, **Excel pour le web** (fichier ouvert
depuis OneDrive, SharePoint ou une pièce jointe Teams), Excel sous macOS si disponible, LibreOffice
Calc. Noter la version exacte (Fichier → Compte → À propos d'Excel) et la langue d'Excel.

1. Ouvrir le fichier `.xlsx` par double-clic depuis le dossier Téléchargements. Le bandeau jaune
   **Mode protégé** d'Excel est normal (fichier venu d'Internet) : cliquer sur **Activer la
   modification**. Attendu : aucun message « Nous avons trouvé un problème dans le contenu… » ni
   proposition de réparation ; quatre feuilles présentes ; en-têtes lisibles ; colonnes de largeur
   raisonnable ; aucune cellule `#NOM?` ni `#VALEUR!`.
2. Ouvrir le fichier `.csv` par double-clic (Excel en français : séparateur `;` reconnu sans
   assistant) : une colonne par champ, accents corrects (« Exposition données », « Échéance »),
   aucun caractère parasite en tête de la première cellule (BOM correctement interprété).
   Avec un Excel réglé en anglais, le `;` n'est pas reconnu (tout tient dans la colonne A) : c'est
   la contrepartie du séparateur `;` retenu pour Excel en français (CDC §17) ; noter le cas et
   vérifier que l'import par Data → From Text/CSV, délimiteur « Semicolon », fonctionne.
3. Vérifier la ligne `=1+1` : la cellule affiche `'=1+1` ou `=1+1` comme **texte**, jamais `2` ;
   idem pour `@SOMME(A1)` dans la colonne « Commentaires ». Modifier puis quitter la cellule ne doit
   pas déclencher de calcul.
4. En mode anonyme : les effectifs inférieurs au seuil apparaissent « < 5 » (texte), pas un nombre.
5. Dates au format jour/mois/année, lisibles.
6. Enregistrer le classeur sous un autre nom dans Excel, le fermer, le rouvrir : aucun avertissement.
7. PDF du rapport : pas de page blanche, pas de bouton ni de menu imprimé, tableaux non coupés au
   milieu d'une ligne, lisible en noir et blanc.

### Résultats

| Date | Version | Personne | Environnement | Fichiers | Résultat | Remarques |
|---|---|---|---|---|---|---|
| 2026-09-30 | 0.9.0 | automatisé (Chrome sans interface + `soffice --headless`) | Linux, LibreOffice 24.2.7.2 | XLSX de la démo, CSV de la démo | OK | Conversion sans erreur : 4 feuilles, en-tête du registre + 10 usages ; CSV relu en UTF-8 avec `;`. Ouverture interactive, Excel et contrôle `=1+1` : à faire. |
| | | | Microsoft Excel Microsoft 365, Windows | XLSX, CSV | | |
| | | | Excel pour le web (OneDrive, SharePoint ou Teams) | XLSX | | |
| | | | Excel sous macOS | XLSX, CSV | | |
| | | | LibreOffice Calc (ouverture interactive) | XLSX, CSV | | |
| | | | Impression du rapport (PDF) | PDF | | |

## 2. Premier usage en moins de 3 minutes (test chronométré, 5 personnes)

Critère §14 (phase 1) et §4 : un répondant décrit son premier usage en moins de 3 minutes.

### Protocole

1. Recruter **5 personnes** qui ne connaissent pas Recensia, de profils variés (au moins une personne
   peu à l'aise avec l'informatique). Au moins 2 sur téléphone et 2 sur ordinateur. Les prévenir que
   l'on teste l'outil, pas elles, et qu'elles peuvent s'arrêter à tout moment.
2. Créer une campagne de test en mode anonyme, 5 services, canal de retour « Copier-coller »
   (ou utiliser le lien de la démo, onglet **Diffuser**). La supprimer à la fin des tests
   (Paramètres, Zone de danger).
3. Donner à chaque personne le lien et une consigne orale unique : « Décrivez un usage de l'IA que
   vous avez eu au travail, par exemple la reformulation d'un e-mail. » Aucune autre aide ; ne pas
   répondre aux questions pendant le chronométrage (les noter).
4. Démarrer le chronomètre à l'ouverture du lien ; noter le temps au passage de la notice au
   questionnaire ; l'arrêter quand l'écran **Votre code est prêt** s'affiche. Noter le temps total,
   le temps passé sur la notice, les hésitations (champ, durée) et les questions posées.
5. Refaire l'exercice en saisie directe par le responsable (onglet **Saisir un usage**) avec une
   personne, pour comparaison.
6. Remplir une ligne par participant, puis la ligne de synthèse.

Critère : chaque personne obtient son premier code en moins de 3 minutes ; on note aussi la médiane.
Toute hésitation de plus de 20 secondes sur un même champ est signalée (libellé ou aide à revoir).

### Résultats par participant

| Date | Version | Personne (testeur) | Participant | Profil, appareil | Temps notice | Temps total | Hésitations (> 20 s) | Questions posées | Résultat | Remarques |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | P1 | | | | | | | |
| | | | P2 | | | | | | | |
| | | | P3 | | | | | | | |
| | | | P4 | | | | | | | |
| | | | P5 | | | | | | | |
| | | | Saisie directe (responsable) | | | | | | | |

### Synthèse

| Date | Version | Participants | Médiane | Temps maximal | Tous en moins de 3 min | Champs à revoir | Suites données |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 3. Liens d'invitation et d'import dans les messageries

Critères §14 (phase 2) et §7.7 : un lien d'invitation reçu par e-mail, Teams, Gmail et WhatsApp
s'ouvre sans être tronqué ni réécrit ; un lien d'import ouvert sans la clé privée affiche la marche à
suivre sans perdre le code ; repli sur le code brut. Les URL de partage des services tiers changent
sans préavis : **à refaire à chaque release**.

### Liens à tester

- **L1** — lien de collecte d'une campagne à **10 services** : onglet **Diffuser**, **Copier le
  lien** ; noter la longueur affichée sous le lien et l'empreinte. Critère §14 (phase 2) : moins de
  1 500 caractères ; le lien est compressé, compter environ 600 à 700 caractères.
- **L1 long** — le lien le plus long que l'application permet : **30 services** (le maximum) aux noms
  longs, titre et organisation longs, trois canaux de retour. Compter environ 1 000 à 1 100
  caractères ; au-delà de 1 500, la page **Diffuser** affiche l'avertissement « Lien long ». Sert aux
  cas dégradés (texte brut) et au QR (section 4).
- **L2** — lien d'import d'**un** code : depuis le formulaire, étape **Envoyer mon code**
  (e-mail prérempli ou **Copier avec le message d'accompagnement**).
- **L3** — lien d'import de **trois** codes (`#/i/<code>~<code>~<code>`).
- **L4** — le **code brut** seul (`RCN1.…`), pour le repli.

### Clients et canaux

Outlook (Windows, bureau), Outlook web (Microsoft 365, **Safe Links** actif si le locataire le
permet), Gmail (web et application mobile), Teams (bureau et mobile), WhatsApp (mobile et web),
Slack (bureau ; pas d'URL de partage : **Copier** puis coller).

### Protocole, pour chaque client et chaque lien

1. Envoyer le lien par le bouton prévu par l'application quand il existe ; sinon par copier-coller.
   Onglet **Diffuser** (L1) : **Ouvrir dans ma messagerie** (ou **Ouvrir la version courte dans ma
   messagerie** quand l'invitation complète est trop longue), **Ouvrir dans Gmail**, **Ouvrir dans
   Outlook sur le web**, **Partager**. Formulaire, étape **Envoyer mon code** (L2, L3) : e-mail
   prérempli, **Partager**, boutons Teams ou WhatsApp quand ces canaux sont activés.
   Dans Outlook et Gmail, tester aussi **Copier en texte riche** puis coller dans le corps du
   message : le lien doit rester cliquable (repli attendu sur le texte brut sinon).
2. Chez le destinataire, vérifier que le lien est **cliquable sur toute sa longueur** et **sur une
   seule ligne** (pas de coupure, pas de ponctuation collée à la fin).
3. Cliquer : la bonne vue s'ouvre (formulaire pour L1, import pour L2 et L3), sans message « Lien
   incomplet ou abîmé » ; pour L1, l'empreinte affichée est celle de la campagne.
4. **Réécriture de sécurité** (Safe Links, passerelles) : noter l'adresse réellement ouverte ; le
   lien réécrit doit ramener à l'adresse d'origine **avec son fragment** (`#/c/…`).
5. **Sans la clé** (L2 et L3 ouverts dans un autre navigateur) : la page explique quoi faire et le
   code n'est pas perdu (import possible après chargement du fichier de récupération).
6. **Repli** : coller L4 dans l'onglet **Importer des codes** : un code détecté, importé.

### Safe Links (Microsoft Defender pour Office 365) et passerelles de sécurité

À faire dans un locataire Microsoft 365 où Safe Links est activé (demander à l'administrateur la
stratégie en vigueur), et, si l'entreprise en utilise une, derrière une autre passerelle de filtrage
des e-mails (Proofpoint, Mimecast…) : noter son nom.

1. Envoyer L1 et L2 par **Ouvrir dans ma messagerie** vers une boîte du locataire.
2. **Outlook web** : survoler le lien et noter l'adresse affichée (forme attendue :
   `https://<région>.safelinks.protection.outlook.com/?url=…&data=…`). Cliquer : la barre d'adresse
   doit finir sur `https://manicalabs.github.io/Recensia/#/c/…` (ou `#/i/…`) **complet** ; comparer
   l'empreinte (L1) ou le nombre de codes détectés (L2) avec l'original.
3. **Outlook bureau (Windows)** : selon la version et la stratégie, le lien est réécrit comme dans
   Outlook web ou vérifié au moment du clic sans réécriture visible ; noter le cas, mêmes contrôles.
4. **Teams** : Safe Links s'applique aussi aux liens des conversations quand la stratégie le prévoit ;
   envoyer L1 dans une conversation et refaire le contrôle.
5. Transférer l'e-mail reçu à une autre adresse : le lien doit rester utilisable (noter s'il est
   réécrit une seconde fois).
6. Si un avertissement « site non vérifié » ou une page d'attente s'affiche, noter son texte et si
   l'utilisateur peut poursuivre. Rappel : l'adresse d'origine (fragment compris) passe par le service
   de Microsoft ; le lien de collecte ne contient que des données publiques (configuration et clé
   publique) et le lien d'import un code chiffré.

### Cas dégradés à provoquer

- **Lien coupé à 76 colonnes** : envoyer L1 long dans un e-mail au format **texte brut** (Outlook :
  Format du message → Texte brut), puis répondre en citant. Noter ce qui reste cliquable ; recoller
  le lien complet dans la barre d'adresse doit fonctionner. Coller le message reçu contenant L2 dans
  **Importer des codes** et noter si le code est retrouvé malgré les retours à la ligne ; sinon, le
  repli L4 doit suffire.
- **Citation « > »** : répondre en texte brut à un e-mail contenant L2 ; coller toute la réponse dans
  **Importer des codes** et noter si le code est retrouvé.
- **« # » encodé en `%23`** : ouvrir à la main `https://manicalabs.github.io/Recensia/%23/c/<config>`
  (remplacer `#` par `%23` dans L1) et la même chose avec L2. Attendu : la page 404 du site
  (`404.html`) renvoie aussitôt vers `…/Recensia/#/c/<config>` et le formulaire s'ouvre. Contrôle
  rapide en ligne de commande :

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' 'https://manicalabs.github.io/Recensia/%23/c/abc'
  # 404 attendu (statut), mais le contenu doit être la page 404.html de Recensia, pas celle de GitHub :
  curl -s 'https://manicalabs.github.io/Recensia/%23/c/abc' | grep -c 'id="nf-broken"'   # 1 attendu
  ```

  Une adresse abîmée qui ne peut pas être réparée affiche « Lien abîmé » avec la consigne de demander
  le code brut ou le lien complet, et un bouton vers l'accueil.

### Résultats

Une ligne par client ; la colonne « Lien » indique les liens testés (L1 à L4) et « Remarques » ceux
qui ont échoué.

| Date | Version | Personne | Client (version, plateforme) | Lien | Tronqué | Réécrit | Ouvre la bonne vue | Repli code brut | Résultat | Remarques |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-30 | 0.9.0 | automatisé (Chrome sans interface, serveur local imitant GitHub Pages) | Linux, Chrome | L1 avec `%23`, `%2523`, `index.html%23`, sans `#` | — | — | oui | — | OK | Redirection de 404.html vérifiée en local ; à revérifier en production après déploiement (commande `curl` ci-dessus). Clients de messagerie : à faire. |
| | | | Outlook bureau (Windows) | L1 à L4 | | | | | | |
| | | | Outlook web (Microsoft 365), Safe Links actif | L1 à L4 | | | | | | |
| | | | Outlook, e-mail en texte brut (76 colonnes, citation « > ») | L1 long, L2 | | | | | | |
| | | | Gmail (web) | L1 à L4 | | | | | | |
| | | | Gmail (application Android ou iOS) | L1 à L4 | | | | | | |
| | | | Teams (bureau) | L1 à L4 | | | | | | |
| | | | Teams (mobile) | L1 à L4 | | | | | | |
| | | | WhatsApp (mobile) | L1 à L4 | | | | | | |
| | | | WhatsApp (web) | L1 à L4 | | | | | | |
| | | | Slack (bureau, copier-coller) | L1 à L4 | | | | | | |
| | | | Autre passerelle de sécurité (nom) | L1, L2 | | | | | | |

## 4. QR code imprimé et projeté (niveau de correction L)

ARCHITECTURE §7 : le QR du lien de collecte est produit en niveau de correction L, prévu pour un lien
allant jusqu'à 1 500 caractères (plafond du CDC §14) ; sa lisibilité sur papier et en projection doit
être vérifiée en vrai. Plus le lien est long, plus le QR est dense : on teste le lien le plus long.

### Protocole

1. Campagne du lien **L1 long** (section 3 : 30 services aux noms longs) ; noter la longueur du lien
   affichée dans l'onglet **Diffuser**. **Fiche imprimable**, format **Page A4**, **Imprimer la
   fiche** : imprimante laser noir et blanc, 100 %, papier ordinaire. Mesurer le côté du QR imprimé
   (en centimètres) et le noter. Refaire le premier scan avec la campagne de L1 (10 services).
2. Scanner le QR imprimé avec l'appareil photo d'un iPhone (iOS récent), d'un téléphone Android
   (appareil photo natif ou Google Lens) et d'un téléphone d'entrée de gamme, à 30 cm puis à 1 m,
   en lumière normale puis faible. Refaire une fois avec une impression jet d'encre ou une photocopie
   de la fiche (qualité dégradée).
3. Format **Diapositive (16:9)**, **Projeter en plein écran** sur un vidéoprojecteur : scanner depuis
   le premier rang puis le fond de la salle (3 à 5 m). Noter la taille de l'image projetée et la
   luminosité de la salle. Refaire sur un grand écran de salle de réunion si disponible, et en
   partage d'écran Teams (QR scanné sur l'écran d'un participant).
4. Vérifier que le lien ouvert est complet : le formulaire s'affiche avec la bonne empreinte.
5. Télécharger le QR en **PNG** et en **SVG** : les fichiers s'ouvrent et se scannent aussi (à l'écran,
   et une fois insérés dans un document Word ou une diapositive PowerPoint puis imprimés).

### Résultats

| Date | Version | Personne | Support (imprimante, projecteur) | Téléphone (modèle, système) | Distance, lumière | Résultat | Remarques |
|---|---|---|---|---|---|---|---|
| | | | Fiche A4, laser noir et blanc (lien de … caractères, côté du QR : … cm) | iPhone | 30 cm et 1 m, lumière normale et faible | | |
| | | | Fiche A4, laser noir et blanc | Android (appareil photo natif ou Google Lens) | 30 cm et 1 m, lumière normale et faible | | |
| | | | Fiche A4, laser noir et blanc | Téléphone d'entrée de gamme | 30 cm et 1 m | | |
| | | | Fiche A4, jet d'encre ou photocopie | | 30 cm | | |
| | | | Diapositive 16:9 projetée (vidéoprojecteur) | iPhone et Android | premier rang, puis 3 à 5 m | | |
| | | | Partage d'écran Teams | | écran d'un participant | | |
| | | | QR téléchargé en PNG et en SVG | | écran, puis imprimé | | |

## 5. Lecteurs d'écran : annonces et dialogues

Accessibilité visée : WCAG 2.2 AA (CDC §10.5). Lecteurs : **NVDA** (Windows, Firefox et Chrome),
**VoiceOver** (macOS, Safari), **VoiceOver** (iOS, Safari) ; TalkBack (Android, Chrome) si possible.
Noter les versions du lecteur, du système et du navigateur.

### Annonces (régions live)

Les régions `#live-region` (polie) et `#live-region-assertive` existent dès le chargement de la page.

1. Formulaire répondant : recharger la page, puis **Enregistrer cet usage** sans rien saisir : le
   nombre d'erreurs est annoncé **dès la première tentative** (« … réponses sont à vérifier »).
2. Mot de passe incorrect à l'ouverture d'un fichier de récupération : annoncé immédiatement.
3. Identité invalide (mode nominatif), lien trop long : annoncés.
4. **Copier le lien** : « Copié dans le presse-papiers » annoncé (poli).
5. Bannière « Nouvelle version disponible » : annoncée, bouton **Recharger** atteignable au clavier.

### Dialogues de confirmation

1. `#/new`, créer une campagne, puis **Reporter** à l'étape de la clé : le lecteur annonce le titre
   (« Reporter l'enregistrement de la clé ? ») **et** le message (« Tant que le fichier de
   récupération n'est pas enregistré, la clé n'existe que dans ce navigateur… ») avant le bouton
   **Annuler**, qui a le focus. Le dialogue est annoncé comme une alerte (action risquée).
2. Même contrôle sur la suppression d'une action (Plan d'actions) et sur **Supprimer toutes les
   déclarations** (Paramètres, Zone de danger) : alerte, focus sur **Annuler**.
   **Supprimer la campagne** (même zone) : alerte, les deux avertissements sont lus avant le champ
   **Titre de la campagne**, qui a le focus ; un titre erroné est annoncé (« Le titre saisi ne
   correspond pas. ») et le focus reste dans le champ.
3. **Tout accepter** (Plan d'actions, suggestions) ouvre un dialogue ordinaire : titre et message
   annoncés, focus sur le bouton de confirmation.
4. Échap ferme le dialogue ; le focus revient sur le bouton d'origine.

### Notifications

1. Provoquer une erreur (par exemple un export impossible) : la notification d'erreur reste affichée
   jusqu'à sa fermeture ; elle est annoncée ; le bouton **Fermer la notification** est atteignable
   au clavier ; Échap la ferme et le focus revient à l'élément précédent.
2. Sur téléphone (375 px), accepter plusieurs suggestions d'affilée au clavier : au plus deux
   notifications à la fois, et le bouton qui a le focus n'est jamais caché dessous.

### Niveaux de risque

Dans les cartes du registre (vue mobile), les usages prioritaires du tableau de bord et du rapport,
et les résumés du plan d'actions, chaque badge est lu avec son axe : « AI Act : Haut risque »,
« Exposition des données : Critique ».

### Affichage (sans lecteur d'écran)

- Fenêtre de 320 px de large, ou 1 280 px zoomés à 400 % : tous les liens du menu sont visibles et
  entiers (le menu passe sur deux lignes), aucun défilement horizontal de la page.
- Windows, thème de contraste élevé (couleurs forcées) : le champ qui a le focus a un contour épais.

### Résultats

| Date | Version | Personne | Lecteur d'écran (version) | Système, navigateur | Contrôles | Résultat | Remarques |
|---|---|---|---|---|---|---|---|
| | | | NVDA | Windows, Firefox | | | |
| | | | NVDA | Windows, Chrome | | | |
| | | | VoiceOver | macOS, Safari | | | |
| | | | VoiceOver | iOS, Safari | | | |
| | | | TalkBack (si possible) | Android, Chrome | | | |
| | | | sans lecteur (affichage 320 px, zoom 400 %, contraste élevé) | | | | |

## 6. Hors ligne et installation

Critères §14 (phases 0 et 1) : application installable, utilisable hors ligne après le premier
chargement ; en phase 2, saisie, chiffrement et import sans aucun appel réseau. CDC §10.2 : PWA
installable (manifest, service worker, icônes).

### 6.1 Ordinateur (Chrome, Edge)

1. Ouvrir le site en production, attendre la fin du chargement, installer l'application (icône
   d'installation de la barre d'adresse, ou menu du navigateur → installation de l'application) ;
   l'application installée s'appelle « Recensia — registre des usages IA ».
2. Couper le réseau (mode avion). Rouvrir l'application : accueil, démo, formulaire d'une campagne
   (n'importe quel lien de collecte : la configuration est dans le lien), import de codes, registre et
   exports fonctionnent.
3. Outils de développement, onglet Réseau, pendant une saisie, un chiffrement et un import : aucune
   requête hors du site (GoatCounter excepté quand il est activé).
4. Après un déploiement : la bannière « Nouvelle version disponible » apparaît ; **Recharger** installe
   la nouvelle version (le numéro du pied de page change).

### Résultats (ordinateur)

| Date | Version | Personne | Système, navigateur | Contrôles | Résultat | Remarques |
|---|---|---|---|---|---|---|
| | | | Windows, Edge | | | |
| | | | Windows ou macOS, Chrome | | | |

### 6.2 Installation sur mobile

Appareils : un **iPhone** (iOS récent, Safari ; sur iOS 16.4 et suivants, refaire l'installation
depuis Chrome ou Edge si possible), un **téléphone Android** (Chrome) et, si disponible, un téléphone
Samsung (Samsung Internet). Noter le modèle, la version du système et du navigateur.

1. **Installation.** Ouvrir <https://manicalabs.github.io/Recensia/> et attendre la fin du chargement.
   - Android, Chrome : menu ⋮ → **Installer l'application** (ou **Ajouter à l'écran d'accueil**) ;
     noter si une proposition d'installation apparaît d'elle-même.
   - iPhone, Safari : bouton **Partager** → **Sur l'écran d'accueil** → **Ajouter**.
2. **Icône et nom.** L'icône Recensia n'est ni rognée ni déformée (icône adaptative sur Android) ;
   le nom affiché sous l'icône est « Recensia ».
3. **Lancement.** Depuis l'icône : l'application s'ouvre en plein écran (sans barre d'adresse) sur
   l'accueil ; écran de démarrage aux couleurs de Recensia sur Android ; barre d'état lisible ; en
   mode portrait et paysage, rien n'est caché sous l'encoche ni sous la barre de gestes (en-tête,
   pied de page, notifications, bannière de mise à jour).
4. **Parcours.** Charger la démo (`#/demo`), ouvrir le registre, exporter en CSV et en Excel, ouvrir
   le rapport ; créer une campagne de test et **Télécharger le fichier de récupération** : le fichier
   est enregistré (Fichiers sur iPhone, Téléchargements sur Android) et peut être rouvert ;
   **Copier le lien** et **Partager** fonctionnent ; **Ouvrir dans ma messagerie** ouvre l'application
   de messagerie ; **Importer des codes** permet de choisir un fichier `.rcn`.
5. **Hors ligne.** Mode avion, fermer complètement l'application puis la relancer depuis l'icône :
   accueil, démo, registre, formulaire d'un lien de collecte et import de codes fonctionnent.
6. **Liens reçus.** Depuis l'application de messagerie du téléphone, toucher un lien de collecte (L1)
   et un lien d'import (L2, section 3) ; noter où ils s'ouvrent (application installée ou navigateur).
   Sur iPhone, les liens s'ouvrent dans Safari, dont le stockage est **séparé** de celui de
   l'application installée : un lien d'import doit alors afficher la marche à suivre (clé absente)
   sans perdre le code ; noter le comportement. Sur Android, noter si le lien s'ouvre dans
   l'application installée et si la campagne créée dans l'application y est retrouvée.
7. **Mise à jour.** Après un déploiement, relancer l'application ou la remettre au premier plan
   (Recensia cherche une nouvelle version au lancement puis, au plus une fois toutes les 30 minutes,
   quand l'application revient au premier plan) : la bannière « Nouvelle version disponible »
   apparaît ; **Recharger** installe la nouvelle version (le numéro du pied de page change), sans
   perte des campagnes.
8. **Désinstallation.** Retirer l'application de l'écran d'accueil ; noter si les campagnes restent
   disponibles dans le navigateur (attendu sur Android : même stockage que Chrome ; sur iPhone, le
   stockage propre à l'application disparaît avec elle). D'où le rappel : fichier de récupération et
   sauvegardes régulières avant de désinstaller.

### Résultats (mobile)

| Date | Version | Personne | Appareil (modèle, système) | Navigateur (version) | Installation | Icône, nom, plein écran | Parcours et fichiers | Hors ligne | Liens reçus | Mise à jour | Résultat | Remarques |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | iPhone | Safari | | | | | | | | |
| | | | Android | Chrome | | | | | | | | |
| | | | Samsung (si disponible) | Samsung Internet | | | | | | | | |

## 7. Origine partagée, intégrité du cache hors ligne et page 404

Les navigateurs cloisonnent IndexedDB, le stockage local et le cache du service worker **par origine**
(`https://manicalabs.github.io`), pas par chemin (`/Recensia/`). Tout autre site publié sous la même
origine peut lire et modifier les données de Recensia dans ce navigateur (campagnes et clés privées,
réponses déchiffrées, brouillons des répondants) : seule une origine réservée à Recensia (domaine
dédié) supprime ce risque. Ces vérifications contrôlent ce qui est limité côté Recensia : le cache hors
ligne n'est servi que si chaque fichier a l'empreinte SHA-256 publiée dans `sw-precache.js`, la page 404
ne charge rien hors de `/Recensia/`, et la page de confidentialité décrit la situation réelle.

### Protocole

1. **Sites de l'origine.** Lister les sites publiés sous l'origine : dépôts GitHub Pages du compte
   (`gh api orgs/manicalabs/repos --paginate -q '.[] | select(.has_pages) | .name'`) et site racine
   (`curl -s -o /dev/null -w '%{http_code}\n' https://manicalabs.github.io/`, 404 attendu tant que le
   dépôt `manicalabs.github.io` n'existe pas). Noter chaque site autre que Recensia : il partage l'origine.
2. **Page de confidentialité.** Ouvrir `#/privacy` en production : l'encadré « Origine partagée » de la
   section « Hébergement » affiche l'adresse réelle, et le résumé « En bref » le signale. Avec un
   domaine dédié (fichier `CNAME`, Recensia à la racine), la phrase « publié à la racine de son
   origine » le remplace.
3. **Cache modifié écarté.** Ouvrir Recensia et attendre la fin du chargement (service worker actif).
   Dans la console des outils de développement, sur Recensia ou sur un autre site de l'origine :

   ```js
   const [name] = (await caches.keys()).filter((n) => n.startsWith('recensia-'));
   await (await caches.open(name)).put('https://manicalabs.github.io/Recensia/src/views/home.js',
     new Response("export async function render(root) { root.textContent = 'MODIFIÉ'; }",
       { headers: { 'content-type': 'text/javascript' } }));
   ```

   Recharger Recensia : l'accueil normal s'affiche, jamais « MODIFIÉ ». Outils de développement →
   Application → Stockage du cache : l'entrée `src/views/home.js` contient de nouveau le vrai module.
   Refaire l'essai réseau coupé : l'accueil ne s'affiche pas (fichier écarté, réseau absent), mais
   « MODIFIÉ » n'apparaît pas non plus ; au retour du réseau, l'accueil revient.
4. **Page 404 limitée au projet.** Ouvrir `https://manicalabs.github.io/Recensia/inconnu/page` et
   `https://manicalabs.github.io/Recensia/%23/c/abc` avec l'onglet Réseau ouvert : aucune requête hors
   de `/Recensia/` (pas de `/404.js` ni de `/src/styles/app.css` à la racine). Contrôle rapide :

   ```sh
   curl -s 'https://manicalabs.github.io/Recensia/inconnu/page' | grep -oE '(src|href)="[^"]*"'
   # seulement des adresses « /Recensia/… » attendues
   ```

### Résultats

| Date | Version | Personne | Environnement | Sites de l'origine | Confidentialité à jour | Cache modifié écarté | 404 limitée au projet | Résultat | Remarques |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-30 | 0.9.0 | automatisé (Chrome sans interface, serveur local imitant GitHub Pages avec un second site et un site racine sur la même origine) | Linux, Chrome | `/Recensia/`, `/Autre-site/`, racine | oui | oui (module de l'accueil, `index.html` avec en-tête `Refresh` ; hors ligne : copie écartée, jamais servie) | oui (`/Recensia/inconnu`, `/Recensia/inconnu/page`, `%23/c/…`, `%23/i/…`) | partiel | Protections de Recensia vérifiées en local. La lecture des clés privées et des brouillons depuis l'autre site reste possible : limite de l'origine partagée. En production (vérifié le 2026-09-30) : `Check-up-IA-by-Manica` et `proto-plateforme-marketing-sport2000` partagent l'origine. |
| | | | Production, Chrome | | | | | | |
| | | | Production, Firefox | | | | | | |
