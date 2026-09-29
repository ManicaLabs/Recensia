# CDC — Recensia (registre des usages IA en entreprise)

> Document de passation pour Claude Code. Source de vérité du code = le dépôt git.
> Ce document est **vivant** : le mettre à jour à chaque déploiement (section 5).
> Version du CDC : 1.1 (architecture sans stockage serveur) — 29/09/2026.

## 0. Consignes de travail

- Lire ce document en entier avant d'écrire du code.
- Travailler en autonomie ; ne poser de question qu'en cas de blocage réel (code GoatCounter, ambiguïté produit non couverte ici).
- Un commit = une version cohérente (`v0.3: moteur de règles + tests`). L'historique git doit se lire comme un changelog.
- Valider avant chaque push (section 12). Ne jamais pousser « en espérant ».
- Jamais de secret dans le dépôt (il est public). Jamais de dates réglementaires en dur dans le code.
- L'outil aide à s'organiser, il **ne donne pas d'avis juridique** : chaque classification affiche « indicatif, à confirmer ».

## 1. Contexte et objectifs

**Problème.** Les entreprises (PME en priorité) utilisent l'IA de façon diffuse : comptes personnels, outils non validés, données sensibles collées dans des prompts. Elles n'ont ni inventaire, ni vision du risque AI Act / RGPD, ni plan d'action.

**Solution.** Une PWA gratuite et déployable en un `git push` qui permet de :

1. **Recenser** les usages IA (outil, modèle, type de tâche, données envoyées, fréquence, etc.) via un lien unique diffusable aux collaborateurs, en mode **anonyme** ou **ouvert (nominatif)**, au choix de la personne qui lance la campagne. **Sans aucun serveur de stockage** : les réponses voyagent sous forme de codes chiffrés que seul le responsable peut lire (section 7).
2. **Classer** automatiquement chaque usage par niveau de risque AI Act et par niveau d'exposition des données.
3. **Recommander** des actions standard, rattachées aux risques détectés, et permettre de les piloter (responsable, échéance, statut).
4. **Restituer** : tableau de bord, rapport de synthèse, **registre prêt à l'emploi**, exports.

**Contraintes dures.**

- Dépôt git **public**, déploiement **GitHub Pages** depuis `main`.
- **Aucun stockage d'information côté serveur** : ni base de données, ni backend, ni compte. Seules les statistiques d'audience agrégées de GoatCounter existent hors du navigateur.
- Approche **PWA** (installable, shell hors ligne).
- Sonde de trafic **GoatCounter** (voir section 11).
- Aucune donnée client réelle nécessaire pour la démo ; un jeu de données fictif est fourni (annexe A).
- Langue : français d'abord, code prêt pour l'i18n.

## 2. Décisions structurantes (défauts retenus)

| # | Décision | Défaut retenu | Pourquoi |
|---|---|---|---|
| D1 | Stockage des réponses | **Aucun serveur.** Chaque usage saisi devient un **code chiffré** que le répondant transmet au responsable ; déchiffrement et stockage **uniquement dans le navigateur du responsable** | Exigence : ne rien stocker |
| D2 | Chiffrement | **ECDH P-256 + HKDF + AES-256-GCM** (WebCrypto). Le lien contient la clé **publique** (elle sait chiffrer, pas déchiffrer) ; la clé **privée** reste chez le responsable | Standard éprouvé. L'obfuscation n'est pas une protection : le dépôt est public, tout algorithme « caché » y est lisible |
| D3 | Stack front | HTML/CSS/JS **ES modules sans build**, bibliothèques vendorisées dans `/vendor` (dont `fflate` pour la compression) | Déploiement trivial, cohérent avec le pattern PWA + Pages |
| D4 | Classification | **Moteur de règles déterministe** (JSON déclaratif), pas de LLM en v1 | Auditable, testable, aucune clé API dans un repo public |
| D5 | Axes de risque | **Deux axes séparés** : niveau AI Act et exposition des données (RGPD) | Deux questions différentes ; les mélanger rend le résultat illisible |
| D6 | Unité du registre | L'**usage** (pas la personne) ; consolidation de doublons | 10 personnes qui font la même chose = 1 ligne |
| D7 | Routage et transport | Par **hash** (`#/...`) ; configuration de campagne et codes voyagent dans le fragment, jamais envoyé à un serveur | Pas de réécriture serveur sur GitHub Pages ; garde tout hors des logs et de GoatCounter |
| D8 | Accès du responsable | Pas de compte : **clé privée** dans le navigateur + **fichier de récupération** protégé par mot de passe | Zéro serveur, zéro identité à gérer |
| D9 | Hors ligne | Shell PWA en cache ; **tout le flux** (saisie, chiffrement, import, déchiffrement) fonctionne hors ligne ; pas de synchronisation | Aucune dépendance réseau |
| D10 | Canal de retour | Au choix du responsable : e-mail (`mailto`), copier-coller vers un canal partagé, fichier `.rcn` | Sans serveur il faut un canal ; **c'est lui qui conditionne l'anonymat réel** |
| D11 | Persistance côté responsable | IndexedDB + export JSON chiffrable + rappel de sauvegarde | Pas de synchronisation entre postes |

Si l'une de ces décisions change, mettre à jour ce tableau avant de coder.

## 3. Périmètre

### Must (v1)
- Création de campagne : paire de clés générée dans le navigateur, lien de collecte auto-porteur, fichier de récupération.
- Questionnaire d'usage (section 5.1), plusieurs usages par répondant, **un code chiffré par usage**.
- Import et déchiffrement des codes dans la console du responsable.
- Modes anonyme / ouvert (section 7), avec avertissement selon le canal de retour.
- **Partage en un clic** : boutons de partage, messages générés avec liens prêts à l'emploi (clé publique et configuration déjà incluses), QR code, fiche imprimable, empreinte de campagne, liens d'import cliquables (section 7.7).
- Moteur de règles, deux axes, déclencheurs expliqués (section 6).
- Registre consolidé filtrable, tableau de bord.
- Plan d'actions : suggestions automatiques + édition manuelle.
- Exports XLSX, CSV, JSON, rapport imprimable (PDF via impression).
- PWA installable, GoatCounter, page de confidentialité.
- Jeu de démo « PME fictive de 40 personnes ».

### Should
- Sauvegarde chiffrée avec rappel de sauvegarde.
- Copie en texte riche (lien cliquable) pour Outlook et Teams.
- QR d'un code de réponse (passage d'un poste à l'autre).

### Could
- Mode « atelier live » par WebRTC (nécessite un serveur de signalisation tiers : ce n'est plus zéro infrastructure).
- Multi-responsables : transfert de la clé par fichier ou par lien **chiffré par phrase de passe** (jamais en clair, voir 7.7).
- Liste d'invités locale pour cibler les relances (mode ouvert uniquement).
- Suggestions par LLM (jamais sur les champs libres), anglais, instantanés du registre.

### Hors périmètre
- Tout serveur de stockage, tout compte utilisateur.
- Clôture technique, limitation de débit et anti-spam côté serveur (impossibles sans serveur).
- Aucun avis juridique automatique ni certification de conformité.
- Aucune analyse de contenu des prompts ; aucune connexion aux outils d'IA ; aucune donnée personnelle de clients finaux.

## 4. Rôles et parcours

**Responsable de campagne.** Ouvre `#/new` : titre, entreprise, mode, liste des départements, date de clôture indicative, canal de retour (adresse e-mail et/ou consigne d'envoi). Le navigateur génère la paire de clés. Il obtient le *lien de collecte* (auto-porteur), un QR code, l'*empreinte* de campagne et le *fichier de récupération* de la clé (mot de passe conseillé). Il diffuse le lien en un clic (boutons de partage, messages générés, QR, fiche imprimable), reçoit les codes (il clique sur les liens d'import, ou les colle / glisse dans la console), puis consolide, valide les classifications, pilote les actions et exporte.

**Répondant.** Ouvre le lien → lit une notice courte (finalité, mode, canal de retour, ton non punitif) → décrit 1 à n usages (moins de 3 min pour le premier) → obtient **un code par usage** → l'envoie en un clic (e-mail prérempli, copie, fichier, partage natif) par le canal indiqué. Pour corriger : il renvoie un nouveau code (même `entry_id`, `rev` + 1).

**Parcours démo.** `#/demo` charge la PME fictive, sans compte ni réseau.

Routes (hash) : `#/` accueil · `#/new` création · `#/c/<config>` formulaire répondant · `#/admin` liste des campagnes locales (ouverture par clé locale ou import du fichier de récupération) · `#/admin/<campaign_id>/...` console · `#/i/<code>` import cliquable (Should) · `#/demo` · `#/privacy`.

## 5. Modèle de données et questionnaire

### 5.1 Champs d'un usage déclaré

| Clé | Libellé | Type / valeurs | Requis |
|---|---|---|---|
| `usage_name` | Nom court du cas d'usage | texte ≤ 80 | oui |
| `department` | Service | liste définie par la campagne | oui (ouvert) / configurable (anonyme) |
| `tool` | Outil ou service | catalogue (ChatGPT, Claude, Gemini, Microsoft Copilot, GitHub Copilot, Mistral Le Chat, Perplexity, DeepL, Midjourney, Notion AI, IA intégrée à un logiciel, système interne, autre) | oui |
| `tool_other` | Précision si « autre » | texte | si autre |
| `model` | Modèle si connu | texte libre avec suggestions | non |
| `account_type` | Type de compte | `enterprise_provided` · `personal_paid` · `personal_free` · `api_integration` · `internal_system` · `unknown` | oui |
| `task_types` | Types de tâche | multi : rédaction, résumé, traduction, code, analyse de données, recherche d'information, génération d'images/audio/vidéo, transcription, chatbot externe, évaluation ou tri de personnes, aide à la décision, agent/automatisation, autre | oui (≥ 1) |
| `business_domain` | Domaine métier | rh · finance_credit · service_client · marketing_com · juridique · it_dev · production · formation · sante · direction · commercial_devis · autre | oui |
| `data_types` | Données envoyées | multi : `aucune` (exclusif), docs_internes, donnees_clients, donnees_collaborateurs, donnees_candidats, donnees_sensibles (santé, opinions, etc.), secrets_affaires, code_source, donnees_financieres, identifiants | oui |
| `frequency` | Fréquence | daily · weekly · monthly · occasional | oui |
| `users_count` | Collègues qui font pareil | 1 · 2-5 · 6-15 · >15 | non |
| `output_audience` | Destinataire du résultat | internal_only · external_clients · public · not_applicable | oui |
| `output_review` | Relecture humaine | systematic · partial · none | oui |
| `affects_people` | Sert à décider, évaluer ou trier des personnes | yes_decision · yes_input · no · unknown | oui |
| `direct_interaction` | Interagit directement avec des personnes (chatbot, agent) | yes · no | oui |
| `biometric_emotion` | Reconnaissance d'émotions ou biométrie | yes · no · unknown | oui |
| `built_or_customized` | Système développé ou personnalisé sous le nom de l'entreprise | use_as_is · configured_prompt · built_own | oui |
| `status` | Statut | in_use · pilot · planned | oui |
| `comment` | Commentaire | texte ≤ 500, avec avertissement « n'y mettez aucune donnée personnelle » | non |

Chaque réponse porte un `schema_version`. Le questionnaire est décrit dans `data/questionnaire.json` (libellés, aides, valeurs), pas codé en dur dans les vues.

### 5.2 Entités (IndexedDB, côté responsable uniquement)

- `campaigns` : id, title, org_name, mode (`anonymous` | `open`), departments[], settings (min_group_size, department_required, comments_exportable, closes_on informatif, return_channel), public_key, private_key_jwk (jamais exportée sans action explicite), fingerprint, created_at.
- `entries` : campaign_id, entry_id, rev, submitted_day, respondent (null en anonyme), usage (objet du 5.1), schema_version, code_hash (déduplication), imported_at.
- `assessments` : campaign_id, usage_key, override_ai_act_level, override_data_level, justification, validation_status, updated_at.
- `actions` : id, campaign_id, usage_key (nullable), template_id (nullable), title, description, owner, due_date, priority, status, suggested (bool).

Il n'existe aucune table serveur. Le niveau de risque calculé n'est **pas stocké** : il est recalculé à chaque lecture avec la version courante des règles. Seuls les arbitrages de l'admin (`assessments`) sont persistés. Le format des codes est décrit en 7.2.

### 5.3 Consolidation

Clé de regroupement : `tool` + `task_types` (triés) + `business_domain` (+ `department` configurable). Une ligne du registre regroupe n déclarations. Niveau du groupe = **maximum** des membres (approche prudente). L'admin peut fusionner ou scinder manuellement.

## 6. Moteur de règles

### 6.1 Principes
- Règles **déclaratives** dans `data/rules.json` (conditions `all` / `any` / `not` avec `eq`, `in`, `includes_any`, `includes_all`), évaluées par un petit évaluateur pur dans `src/engine/`.
- Chaque règle : `id`, `axis` (`ai_act` | `data`), `level`, `label`, `legal_ref`, `explanation`, `action_ids`, `condition`.
- Sortie par usage : `ai_act_level` (`prohibited_suspected` > `high` > `limited` > `minimal`, ou `to_qualify`), `data_level` (0 faible, 1 modéré, 2 élevé, 3 critique), `triggers[]`, `deadlines[]`, `action_ids[]`, `questions_to_confirm[]`.
- Un usage peut cumuler plusieurs déclencheurs (ex. chatbot RH = limité + haut risque). Le niveau affiché est le plus élevé, tous les déclencheurs restent visibles.
- Toute réponse « je ne sais pas » qui pourrait changer le niveau produit `to_qualify` et une question à confirmer.
- L'admin peut **surcharger** un niveau avec justification obligatoire ; la surcharge est tracée.

### 6.2 Règles AI Act de départ (à relire par un juriste)

| ID | Condition (résumé) | Niveau | Référence |
|---|---|---|---|
| R-AIA-PRO-01 | `biometric_emotion = yes` et domaine travail ou formation | prohibited_suspected | art. 5 (reconnaissance d'émotions au travail / à l'école) |
| R-AIA-PRO-02 | biométrie inférant des attributs sensibles | prohibited_suspected | art. 5 |
| R-AIA-HI-EMP | tâche « évaluation ou tri de personnes » ou `affects_people ∈ {yes_decision, yes_input}` avec domaine `rh` | high | annexe III (emploi, gestion des travailleurs) |
| R-AIA-HI-CRE | `affects_people` avec domaine `finance_credit` (personnes physiques) | high | annexe III (services essentiels, crédit) |
| R-AIA-HI-EDU | `affects_people` avec domaine `formation` (admission, évaluation, orientation) | high | annexe III (éducation) |
| R-AIA-HI-OTH | `affects_people` dans un autre domaine listé à l'annexe III | to_qualify | annexe III |
| R-AIA-LIM-01 | `direct_interaction = yes` | limited | art. 50 (information de l'utilisateur) |
| R-AIA-LIM-02 | génération d'images/audio/vidéo ou texte publié (`output_audience ∈ {external_clients, public}`) | limited | art. 50 (marquage, divulgation) |
| R-AIA-PRV-01 | `built_or_customized = built_own` | to_qualify | possible rôle de **fournisseur** (obligations plus lourdes) |
| R-AIA-MIN | aucune autre règle | minimal | — |
| R-AIA-LIT | s'applique à **tous** les usages (action transverse) | — | art. 4 (littératie IA) |

Rôle par défaut de la PME : **déployeur**. Ne jamais déclarer « fournisseur » automatiquement : lever `to_qualify`.

### 6.3 Règles d'exposition des données

Base : `identifiants` ou `donnees_sensibles` = 3 · données personnelles (clients, collaborateurs, candidats), `secrets_affaires`, `code_source`, `donnees_financieres` = 2 · `docs_internes` = 1 · `aucune` = 0.
Modificateurs : compte `personal_free` ou `personal_paid` = +1 (plafonné à 3) · `unknown` = signal « shadow AI » + `to_qualify`.
Signaux additionnels : identifiants dans un prompt (action de sécurité immédiate) ; données sensibles (analyse d'impact probablement nécessaire) ; absence de relecture avant envoi externe.

Tous les seuils sont dans `data/rules.json` et couverts par des tests.

### 6.4 Tests
Table de vérité dans `tests/fixtures/usages.json` (≥ 30 cas, dont les 10 de l'annexe A). Lancés par `node --test`. Un changement de règle sans mise à jour des fixtures fait échouer la CI.

## 7. Collecte sans serveur : modes, liens, codes chiffrés

### 7.1 Principe
Aucune donnée n'est stockée par l'application. À la création de la campagne, le navigateur du responsable génère une paire de clés. Le lien de collecte contient la configuration et la **clé publique**. Chaque usage saisi est chiffré dans le navigateur du répondant en un **code** que celui-ci transmet au responsable. Seule la clé privée du responsable permet de le lire.

Ce n'est **pas** de l'obfuscation : le dépôt étant public, un encodage « difficile à décoder » serait lisible par tous. La protection repose uniquement sur un chiffrement standard dont la clé de déchiffrement n'apparaît jamais dans le lien.

### 7.2 Formats
**Lien de collecte** : `https://<owner>.github.io/<repo>/#/c/<payload>` avec `payload = base64url(deflate(JSON))` de `{v, id, title, org, mode, depts[], pk, closes?, channels?}`. Cible : moins de 1 500 caractères. Plafond de 16 Ko une fois décompressé (protection contre les « bombes »).

**Code de réponse** : `RCN1.` + base64url(octets), avec octets = version (1) ‖ clé publique éphémère (65) ‖ IV (12) ‖ chiffré + tag.
- Clair : JSON compressé `{v, campaign_id, entry_id, rev, submitted_day, respondent?, usage}`.
- Dérivation : ECDH(clé éphémère, `pk`) → HKDF-SHA-256 (info = `recensia-v1|<campaign_id>`) → AES-256-GCM, IV aléatoire de 12 octets, **AAD = `campaign_id`**.
- **Un code par usage** (environ 300 à 500 caractères). Clé éphémère et IV neufs à chaque code : deux codes au contenu identique sont différents et impossibles à corréler.

**Import** : le responsable colle un ou plusieurs codes (un par ligne) ou glisse des fichiers `.rcn`, ou ouvre un lien d'import (`#/i/<code>`, voir 7.7). Déchiffrement local → validation stricte du schéma → déduplication par `entry_id` (le `rev` le plus élevé gagne) → rapport d'import : acceptés, doublons, invalides, hors campagne, postérieurs à la clôture.

**Empreinte** : hash court (8 caractères hexadécimaux) de la clé publique, affiché sur le formulaire et dans la console. Le responsable la communique par un autre canal, pour qu'on puisse détecter un lien falsifié (substitution de clé par un tiers).

### 7.3 Canaux de retour (choisis par le responsable)

| Canal | Intérêt | Anonymat |
|---|---|---|
| `mailto` vers une adresse fournie (un code par message) | le plus simple | **identifie l'expéditeur** |
| Copier-coller vers un canal partagé (boîte partagée, formulaire anonyme, fil de discussion) | souple | dépend du canal |
| Fichier `.rcn` téléchargé puis déposé | plusieurs usages d'un coup | dépend du canal de dépôt |
| Lien d'import cliquable / QR | un clic pour le responsable | dépend du canal |

### 7.4 Modes

| | Anonyme | Ouvert (nominatif) |
|---|---|---|
| Identité dans le code | aucune | prénom + nom obligatoires, e-mail facultatif |
| Département | facultatif (configurable) | obligatoire |
| Date de réponse | jour uniquement | horodatage complet |

Le mode est fixé à la création et figure dans le lien.

**Ce que garantit le mode anonyme** : le contenu du code ne contient aucune identité ; les clés éphémères empêchent de relier deux codes ; la date est au jour ; tout regroupement de moins de `min_group_size` (défaut 5) est masqué (« < 5 ») dans le tableau de bord et les exports ; les commentaires libres déclenchent une alerte et peuvent être exclus des exports.

**Ce qu'il ne garantit pas** : l'application ne contrôle pas le canal de retour. Par e-mail, l'expéditeur est connu. En mode anonyme, l'interface impose donc au responsable de choisir un canal et affiche au répondant un avertissement explicite (« Votre réponse est anonyme, mais l'e-mail ne l'est pas »). Ne jamais promettre plus dans les textes.

### 7.5 Abus et limites assumées
- Sans serveur : pas de limitation de débit, pas de clôture technique, pas de captcha. Toute personne ayant le lien peut fabriquer de faux codes. Le responsable peut écarter ou supprimer des entrées ; `campaign_id` en AAD empêche le mélange entre campagnes ; un code rejoué est dédupliqué. Acceptable pour un usage interne.
- La date de clôture est **informative** : le formulaire affiche « clôturée » après cette date, et l'import signale les codes postérieurs.
- **Clé privée perdue = données illisibles, sans recours.** Le dire clairement à la création et proposer le fichier de récupération.
- Les codes reçus (dans des boîtes mail, par exemple) sont des données de l'entreprise, personnelles en mode ouvert : leur conservation relève de sa politique de rétention. L'application n'en garde aucune trace.

### 7.6 Persistance côté responsable
Les données vivent dans l'IndexedDB du navigateur du responsable. Risques : effacement du navigateur, changement de poste. Mesures : `navigator.storage.persist()`, bandeau « dernière sauvegarde il y a X jours », export JSON complet chiffrable par mot de passe (PBKDF2-SHA-256 ≥ 600 000 itérations + AES-GCM), réimport. Pas de synchronisation entre postes : le partage se fait par fichier de récupération + export.

### 7.7 Partage, messages générés et liens prêts à l'emploi

Objectif : le responsable diffuse en deux clics et le répondant renvoie en deux clics, sans rien copier à la main ni assembler de lien.

**Côté responsable : page « Diffuser »** (affichée à la création, accessible ensuite depuis la console).
- Lien de collecte complet, configuration et clé publique déjà incluses : boutons *Copier*, *Partager* (`navigator.share` si disponible), *QR code* (PNG et SVG téléchargeables), *Fiche imprimable* (A4 : titre, QR, trois consignes, canal de retour, empreinte ; utilisable comme diapositive).
- **Messages générés** à partir de gabarits (`data/messages.fr.json`), sans IA : *invitation* (version e-mail, version courte pour messagerie), *relance* (J-3, J-1), *clôture et remerciement*. Chaque message est prérempli : titre, entreprise, lien, date de clôture, durée estimée, canal de retour, phrase sur l'anonymat, empreinte. Modifiable avant envoi. Boutons : *Copier* (texte brut), *Copier en texte riche* (lien cliquable, via l'API Presse-papiers, repli sur le texte brut), *Ouvrir dans ma messagerie* (`mailto:` avec objet et corps encodés).
- Blocs **verrouillés** : la phrase « mode, anonymat, canal » est générée d'après la configuration (par exemple « Réponses anonymes ; l'envoi par e-mail, lui, n'est pas anonyme »). Elle ne peut pas être supprimée sans avertissement, pour ne jamais promettre un anonymat faux.
- Sans serveur, le responsable ne sait pas qui a répondu en mode anonyme : les relances partent donc à tous. En mode ouvert, une liste d'invités locale (Could) permet de cibler.

**Côté répondant : étape « Envoyer mon code »** (après la saisie).
- Un code par usage. Les boutons dépendent des canaux activés par le responsable (`channels` dans le lien) : *E-mail prérempli* (destinataire, objet, corps contenant le lien d'import et, en secours, le code brut), *Copier* (un code ou tous), *Télécharger .rcn*, *Partager* (Web Share, avec fichier si supporté) et, si activés, liens directs vers Teams ou WhatsApp.
- Avant tout envoi : affichage du **destinataire** et de l'**empreinte** de la campagne (anti-hameçonnage) et de l'avertissement d'anonymat propre au canal choisi.
- Un `mailto` dépasse vite environ 1 800 caractères : au-delà, l'interface passe en « un message par code » ou propose le fichier.

**Liens d'import.** Format `#/i/<code>[~<code>...]`. Le responsable clique dans le message reçu : l'application s'ouvre, déchiffre avec la clé locale, importe puis retire le code de l'URL (`history.replaceState`). Si la clé n'est pas dans ce navigateur : message clair, et le code est gardé en `sessionStorage` le temps d'importer le fichier de récupération. Le code reste chiffré partout où il transite.

**Configuration des canaux** (`channels` dans le lien, 3 entrées maximum) : `{type: mailto | copy | file | share | teams | whatsapp, target?}`. Chaque type porte un drapeau `identifies_sender` (oui pour `mailto`, `teams`, `whatsapp` ; « dépend » pour `copy` et `file`). En mode anonyme, le responsable voit ce drapeau au moment du choix.

**Services tiers.** Les boutons Teams, WhatsApp et webmail ouvrent l'URL de partage du service (par exemple `https://wa.me/?text=...`, lien de partage Teams, composition Gmail ou Outlook web) par navigation déclenchée par l'utilisateur : l'application n'émet aucune requête. Ces URL évoluent : **à vérifier à chaque release**. Le socle garanti est *Copier*, `mailto` et *Partager* (détecté à l'exécution). Slack n'a pas d'URL de partage : *Copier*. Ne jamais s'appuyer sur un raccourcisseur de liens (il exigerait un serveur).

**La clé privée ne figure jamais dans un lien en clair.** Un tel lien donnerait accès à toutes les réponses à quiconque le lit (historique de messagerie, aperçu, copie). Pour passer la main à un suppléant : fichier de récupération, ou *lien de transfert* dont le contenu est chiffré par une **phrase de passe générée** (4 mots ; PBKDF2 + AES-GCM), communiquée par un autre canal (Could).

**Robustesse des liens.**
- Alphabet base64url uniquement (`A-Za-z0-9-_`), sans `+`, `/` ni `=`, pour survivre aux clients de messagerie.
- Dans les gabarits : lien seul sur sa ligne, jamais coupé.
- Test manuel documenté dans Outlook, Gmail, Teams, WhatsApp et Slack : lien ni tronqué ni réécrit (vérifier en particulier la réécriture de liens de sécurité), sinon repli sur le code brut à copier.
- Retirer tout caractère de contrôle et limiter la longueur des champs issus du lien (titre, entreprise) avant de les injecter dans un objet ou un corps de message ; encoder avec `encodeURIComponent` ; valider strictement l'adresse `mailto` du lien.

## 8. Rapports et exports

### 8.1 Tableau de bord et rapport de synthèse
Indicateurs : nombre d'usages et de réponses ; répartition par niveau AI Act ; répartition par exposition des données ; part de comptes personnels (shadow AI) ; top outils ; répartition par service (masquée si < k) ; échéances réglementaires à venir ; avancement du plan d'actions ; usages « à qualifier ». Graphiques en SVG/CSS natifs (pas de bibliothèque lourde). Le rapport est imprimable proprement (feuille de style `@media print`), ce qui donne un PDF via l'impression du navigateur.

### 8.2 Registre prêt à l'emploi (colonnes)
ID · Service · Cas d'usage · Outil · Modèle · Type de compte · Tâches · Domaine · Catégories de données · Fréquence · Nombre de personnes concernées · Rôle (déployeur / fournisseur potentiel) · Niveau AI Act · Exposition données · Règles déclenchées (avec référence) · Échéance applicable · Statut de validation · Responsable · Actions liées · Date de dernière revue.

### 8.3 Formats
- **XLSX** (SheetJS vendorisé) : feuilles *Registre*, *Plan d'actions*, *Synthèse*, *Référentiel* (règles utilisées, date de vérification, version du calendrier réglementaire).
- **CSV** du registre (UTF-8 avec BOM pour Excel).
- **JSON** complet, chiffrable par mot de passe (sauvegarde, réimport, transfert entre postes).
- **Impression / PDF** du rapport.
- **Sécurité des exports** : neutraliser l'injection de formules (préfixer d'une apostrophe toute cellule commençant par `=`, `+`, `-`, `@`, tabulation ou retour chariot).

## 9. Plan d'actions

Bibliothèque `data/actions.json` (point de départ à relire par un juriste). Chaque modèle : `id`, titre, description, règles déclencheuses, priorité par défaut, effort (S/M/L), rôle suggéré (Direction, DSI, RH, DPO/juriste, métier), horizon typique.

| ID | Action standard |
|---|---|
| ACT-POL-01 | Rédiger une charte d'usage de l'IA (outils autorisés, données interdites) |
| ACT-LIT-01 | Former / sensibiliser les équipes (littératie IA, art. 4) |
| ACT-SHADOW-01 | Basculer les comptes personnels vers un compte pro ou un outil validé |
| ACT-DPA-01 | Vérifier contrat / DPA, localisation des données, désactivation de l'entraînement |
| ACT-DPIA-01 | Évaluer la nécessité d'une analyse d'impact (AIPD) |
| ACT-SEC-01 | Retirer identifiants et secrets des prompts ; les renouveler si exposés |
| ACT-REV-01 | Imposer une relecture humaine avant tout envoi externe |
| ACT-TRANS-01 | Informer l'utilisateur qu'il interagit avec une IA |
| ACT-TRANS-02 | Mentionner / marquer les contenus générés publiés |
| ACT-HR-01 | Supervision humaine documentée + information des candidats/salariés + consultation du CSE |
| ACT-HR-02 | Tester les biais et la qualité des données sur les outils RH |
| ACT-HR-03 | Contrôler les obligations contractuelles du fournisseur (notice, journalisation) |
| ACT-LOG-01 | Conserver les journaux d'usage sur les systèmes à haut risque |
| ACT-PRO-01 | Suspendre l'usage et le faire qualifier juridiquement (suspicion d'interdit) |
| ACT-QUAL-01 | Lever les points « à qualifier » (questions listées) |
| ACT-INV-01 | Réviser le registre chaque trimestre |

Règles de fonctionnement : les actions sont **suggérées** (`suggested = true`) ; l'admin les accepte, modifie ou rejette. **Jamais d'affectation automatique d'un responsable** (l'outil ne sait pas qui fait quoi) ; seul un rôle suggéré est proposé. Chaque action a : responsable, échéance, priorité, statut (à faire / en cours / fait / rejeté), lien vers l'usage.

## 10. Architecture technique

### 10.1 Arborescence cible
```
/
├─ index.html
├─ manifest.webmanifest
├─ sw.js
├─ config.js                 # goatcounterCode, appVersion (aucun secret)
├─ .nojekyll
├─ icon.svg, icon-192.png, icon-512.png, favicon-32.png
├─ src/
│  ├─ app.js, router.js, i18n/fr.json
│  ├─ views/                 # home, new, form, admin, demo, privacy
│  ├─ engine/                # évaluateur de règles, consolidation
│  ├─ crypto/                # clés, lien de campagne, chiffrement des codes, sauvegarde chiffrée
│  ├─ storage/               # store IndexedDB (repli mémoire)
│  ├─ share/                 # canaux, liens de partage, messages générés, QR, fiche imprimable
│  ├─ export/                # xlsx.js, csv.js, json.js, print.css
│  └─ analytics.js           # GoatCounter (section 11)
├─ data/                     # questionnaire.json, rules.json, actions.json, regulatory-calendar.json, messages.fr.json, channels.json, demo-company.json
├─ vendor/                   # SheetJS, fflate, générateur de QR (versions figées)
├─ tests/                    # node --test, fixtures
├─ docs/CDC.md               # ce document
└─ .github/workflows/ci.yml  # tests uniquement, pas de build
```

### 10.2 PWA
- `manifest.webmanifest` : `display: standalone`, `start_url: "./"`, `scope: "./"` (le site vit sous `/<repo>/`), icônes, couleur de thème.
- `sw.js` : cache versionné (constante de version), précache du shell et des fichiers `data/` et `vendor/`, stratégie réseau d'abord pour `config.js`, **jamais de cache du script GoatCounter**, message « nouvelle version disponible » avec rechargement à la demande.
- Rappel : GitHub Pages met en cache ~10 min ; un rechargement forcé peut être nécessaire après un déploiement.
- `localStorage`, `sessionStorage` et IndexedDB **toujours** dans un `try/catch` (contextes sandboxés).

### 10.3 Stockage local
Interface `store` (campagnes, entrées, évaluations, actions) implémentée sur IndexedDB, avec repli en mémoire si l'accès est bloqué (toujours en `try/catch`). Aucune couche réseau : le code de l'application n'émet aucune requête sortante hors GoatCounter.

### 10.4 Module de chiffrement
- Fonctions : `generateCampaignKeys`, `encodeCampaignLink` / `decodeCampaignLink`, `fingerprint`, `encryptEntry`, `decryptEntry`, `wrapPrivateKey(passphrase)` / `unwrapPrivateKey`, `exportEncrypted` / `importEncrypted`.
- WebCrypto uniquement (ECDH P-256, HKDF, AES-GCM : disponibles partout). Compression par `fflate` vendorisé (pas de dépendance à `CompressionStream`).
- Le même code s'exécute sous `node --test` via `globalThis.crypto`.
- Tests obligatoires : aller-retour ; code altéré rejeté ; mauvaise clé privée rejetée ; code d'une autre campagne rejeté (AAD) ; deux chiffrements du même clair différents ; plafonds de taille respectés ; vecteurs de test figés ; lien décodé strictement validé.
- Jamais de cryptographie « maison » ni d'obfuscation.

### 10.5 Sécurité front
- CSP via `<meta http-equiv="Content-Security-Policy">` : `default-src 'self'; script-src 'self' https://gc.zgo.at; connect-src 'self' https://*.goatcounter.com; img-src 'self' data: blob: https://*.goatcounter.com; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; manifest-src 'self'; worker-src 'self'`.
  (v0.1 : `'self'` ajouté à `connect-src`, indispensable au chargement de `data/*.json` ; `img-src` étendu au pixel de repli de GoatCounter et aux aperçus `blob:`. Une CSP en `<meta>` ne peut pas imposer `frame-ancestors` : pas de protection contre le *clickjacking* sur GitHub Pages.)
- Tout texte issu d'un lien ou d'un code est affiché via `textContent` (jamais `innerHTML`) et validé strictement (schéma, longueurs, valeurs autorisées).
- La clé privée n'est jamais journalisée, affichée dans l'URL ni envoyée où que ce soit.
- Aucune dépendance chargée depuis un CDN au runtime (tout est vendorisé, y compris pour le hors ligne).
- Accessibilité : viser WCAG AA (formulaires étiquetés, contrastes, navigation clavier), mobile d'abord.

## 11. Sonde de trafic GoatCounter

- Le code du compteur est dans `config.js` (`goatcounterCode`). **S'il est vide, aucun script n'est chargé.** Le compte GoatCounter est créé par l'utilisateur.
- Chargement dynamique de `https://gc.zgo.at/count.js` avec `data-goatcounter="https://<code>.goatcounter.com/count"` et `data-goatcounter-settings='{"no_onload": true}'` ; échec silencieux (bloqueur de publicité, hors ligne) sans jamais casser l'application.
- **Aucun envoi automatique de l'URL.** Les vues sont comptées à la main via `goatcounter.count({path, title})` avec des chemins **nettoyés et fixes** : `/home`, `/new`, `/form`, `/admin/registre`, `/admin/actions`, `/admin/rapport`, `/demo`, `/privacy`. Ne jamais inclure le contenu du lien de campagne, un code de réponse, une clé, un nom, un département ou du texte libre dans `path`, `title` ou `referrer`.
- Événements (chemins fictifs, sans donnée) : `event/campaign_created`, `event/code_generated`, `event/share_link`, `event/share_code`, `event/import_link`, `event/export_xlsx`, `event/export_csv`, `event/export_print`. Jamais de donnée dans le nom d'événement.
- Désactivé en local (`localhost`, `127.0.0.1`) et sur la console admin pour les actions sensibles.
- La page `#/privacy` mentionne GoatCounter (mesure d'audience sans cookie), les données collectées par la campagne, la durée de conservation et l'hébergeur. **À faire valider** (exemption de consentement, mentions RGPD).
- Test de non-régression : un test vérifie qu'aucun appel `count()` ne reçoit un chemin hors de la liste blanche ci-dessus.

## 12. Déploiement (GitHub Pages) et validation

- Pages servi depuis `main`, racine. Fichier `.nojekyll` présent.
- **Deploy = `git push origin main`** (build ~1 min). Interroger `GET /repos/OWNER/REPO/pages/builds/latest` jusqu'à `built`, puis donner l'URL.
- Authentification git : celle de la machine locale (`gh auth` ou clé SSH). Ne jamais écrire de token dans un fichier du dépôt.
- Aucun fichier > ~40 Mo dans le dépôt (limite de l'API Contents ; préférer `git push`).
- **Validation avant push (jamais sautée)** :
  1. `node --check` sur chaque module JS modifié.
  2. `node --test` : moteur de règles, consolidation, neutralisation CSV, liste blanche GoatCounter.
  3. Validation du manifest et du JSON de `data/` (schéma, identifiants uniques, `action_ids` existants).
  4. Vérification structurelle du HTML généré (balises équilibrées, attributs `id` uniques).
  5. Aucun secret dans le dépôt (`git grep` sur `PRIVATE`, `token`, `secret`, `.recensia-key`).
  6. Tests de chiffrement : aller-retour, altération, mauvais `campaign_id`, plafonds de taille.
  7. Gabarits de messages : toutes les combinaisons (type × mode × canal) se génèrent sans jeton `{...}` résiduel, sans matériel de clé privée, dans les limites de longueur, avec le bloc « anonymat » présent.
- CI GitHub Actions : rejoue les étapes 1 à 3, 6 et 7 sur chaque push (aucun build).

## 13. Références réglementaires (à re-vérifier avant chaque release)

Le calendrier vit dans `data/regulatory-calendar.json` avec, pour chaque échéance : `date`, `label`, `status`, `source_url`, `last_verified`. L'interface affiche « règles vérifiées le … ».

**Vérification du 29/09/2026** : les huit points ci-dessous ont été confirmés sur le texte publié au JO (règlement de base et règlement (UE) 2026/1744 du 8 juillet 2026, publié au JOUE le 24/07/2026, entré en vigueur le 27/07/2026 ; lecture du PDF officiel via l'Office des publications, EUR-Lex bloquant la lecture automatisée). Vérification automatisée : **à faire confirmer par un juriste**. Nuances à retenir : le délai de grâce du 2 décembre 2026 (nouvel art. 111(4)) ne vise que le **marquage** de l'art. 50(2) par les **fournisseurs** de systèmes déjà sur le marché, pas les obligations des déployeurs (art. 50(1), (3), (4)) ; les nouvelles interdictions (art. 5(1)(ba) et (bb)) visent les images intimes non consenties et les contenus pédocriminels ; le nouvel art. 111(2) exclut les systèmes à haut risque déjà en service avant la date d'application, sauf modification importante de leur conception ; la nouvelle rédaction de l'art. 4 (« favoriser » la maîtrise de l'IA, sans obligation de résultat) s'applique depuis le 27/07/2026, « obligation de moyens » étant une qualification doctrinale.

Valeurs de départ (sources secondaires), confirmées le 29/09/2026 :

| Sujet | Date | Note |
|---|---|---|
| Interdictions (art. 5) et littératie IA (art. 4) | 2 février 2025 | en vigueur ; l'art. 4 serait devenu une obligation de moyens |
| Obligations des fournisseurs de modèles à usage général | 2 août 2025 | en vigueur |
| Transparence (art. 50) | 2 août 2026 | en vigueur ; délai de grâce annoncé pour le marquage (art. 50(2)) jusqu'au 2 décembre 2026, à vérifier |
| Nouvelles interdictions introduites par l'Omnibus | 2 décembre 2026 | contenu exact à vérifier |
| Haut risque — annexe III (RH, crédit, éducation…) | 2 décembre 2027 | reporté du 2 août 2026 |
| Haut risque — produits réglementés (annexe I) | 2 août 2028 | reporté du 2 août 2027 |

Texte de référence : règlement (UE) 2024/1689 modifié par le règlement (UE) 2026/1744 (« Digital Omnibus » sur l'IA), entré en vigueur le 27 juillet 2026 selon les sources consultées.

## 14. Roadmap et critères d'acceptation

### Phase 0 — Socle (1 session)
Dépôt initialisé, PWA minimale, CI, page de confidentialité, GoatCounter branché, déploiement Pages.
**Acceptation** : URL Pages en ligne · manifest valide et application installable · service worker enregistré · CI verte · GoatCounter compte une vue en production et aucune en local · aucun secret dans le dépôt.

### Phase 1 — MVP local
Questionnaire, moteur de règles + tests, consolidation, registre filtrable, tableau de bord, plan d'actions, exports, démo PME fictive, stockage IndexedDB (saisie directe par le responsable).
**Acceptation** : premier usage saisi en moins de 3 min · 30 fixtures de classification au vert · `#/demo` affiche le registre de l'annexe A avec les niveaux attendus · exports XLSX/CSV s'ouvrent sans erreur dans Excel et LibreOffice · injection de formules neutralisée · application utilisable hors ligne après le premier chargement · impression du rapport propre.

### Phase 2 — Collecte par codes chiffrés
Module de chiffrement + tests, création de campagne avec paire de clés, lien auto-porteur, QR, empreinte, formulaire répondant, codes, canaux de retour, partage et messages générés (7.7), import en console (dont liens d'import), fichier de récupération, sauvegarde chiffrée.
**Acceptation** :
- Bout en bout sur deux appareils : lien créé sur A, code produit sur B, import sur A, usage visible et classé.
- Mauvaise clé privée : échec. Code altéré : rejeté. Code d'une autre campagne : rejeté. Même code importé deux fois : une seule entrée.
- Deux codes du même contenu sont différents.
- En mode anonyme, le clair déchiffré ne contient aucun champ d'identité ; le masquage < 5 fonctionne.
- Aucun appel réseau pendant la saisie, le chiffrement et l'import (vérifié dans l'onglet réseau, hors GoatCounter) ; le tout fonctionne hors ligne.
- Import de 100 codes en moins de 2 s ; lien de collecte < 1 500 caractères avec 10 départements.
- Avertissement d'anonymat affiché selon le canal de retour choisi.
- Partage : chaque bouton produit le résultat attendu (copie, e-mail prérempli, partage natif si disponible, fichier `.rcn`, QR, fiche imprimable). Un lien d'invitation reçu par e-mail, Teams, Gmail et WhatsApp s'ouvre sans être tronqué ni réécrit (test manuel documenté). Un lien d'import ouvert sans la clé privée affiche la marche à suivre sans perdre le code.
- Aucun lien ni message généré ne contient la clé privée (test automatisé sur tous les gabarits). Le bloc « anonymat » ne peut pas être supprimé sans avertissement.
- Perte de clé : le message est explicite ; le fichier de récupération restaure l'accès.

### Phase 3 — Finition
Rapport PDF soigné, instantanés du registre, anglais, accessibilité.

### Backlog
Mode atelier live (WebRTC, avec serveur de signalisation tiers à évaluer), multi-responsables, suggestions par LLM, comparaison entre campagnes.

## 15. Pièges connus et conventions

- Ne jamais mélanger niveau AI Act et exposition des données dans un même score.
- Une réponse « je ne sais pas » ne doit jamais faire baisser un niveau : elle produit `to_qualify`.
- Le niveau calculé n'est pas persisté : recalculer avec la version courante des règles ; stocker seulement les surcharges de l'admin.
- Versionner le schéma du questionnaire et le format des codes (`RCN1`) ; un service worker périmé ne doit pas produire de codes illisibles pour un responsable à jour.
- Ne jamais présenter le mode anonyme comme une garantie totale : l'anonymat dépend aussi du canal de retour.
- Ne jamais mettre la clé privée dans une URL en clair, un log, une requête, un message généré ou un événement GoatCounter. Elle ne se transmet que par fichier ou lien **chiffré par phrase de passe**.
- Les URL de partage des services tiers (Teams, WhatsApp, webmails) changent sans préavis : les vérifier à chaque release, garder *Copier*, `mailto` et *Partager* comme socle.
- Les messageries tronquent ou réécrivent parfois les longs liens : toujours proposer le code brut en repli.
- Les échéances réglementaires changent : lire `regulatory-calendar.json`, ne rien coder en dur.
- Éviter les apostrophes et caractères spéciaux dans les identifiants et clés de données (`snake_case` ASCII) ; les accents restent dans les libellés.
- `localStorage`, `sessionStorage` et IndexedDB toujours dans un `try/catch`.

## 16. Checklist de démarrage de session

1. Lire ce CDC et `git log --oneline` ; vérifier `git status` (état inattendu = le signaler avant de pousser).
2. Demander seulement ce qui manque et bloque : code GoatCounter, adresse de retour à utiliser pour la démo.
3. Implémenter la phase en cours (section 14).
4. Valider (section 12), pousser, vérifier le build Pages.
5. Mettre à jour l'état d'avancement ci-dessous avant de terminer.

## 17. Précisions d'implémentation (journal des décisions)

Décisions prises pendant l'implémentation, là où le CDC était ambigu. Toute révision passe par `data/rules.json` et les fixtures.

- **Ordre de gravité AI Act** : `prohibited_suspected > high > to_qualify > limited > minimal`. `to_qualify` est placé au-dessus de `limited` : une incertitude peut cacher un haut risque. Formulation exacte de la règle « je ne sais pas » (§15), vérifiée par recherche exhaustive : une réponse `unknown` ne donne jamais un niveau inférieur à min(niveau obtenu avec la réponse connue, `to_qualify`), ni inférieur au niveau obtenu avec la réponse « non ».
- **R-AIA-PRO-01** : « travail ou formation » = domaine `rh`, `formation`, `direction` ou `production`, ou données de collaborateurs / candidats. **R-AIA-PRO-02** approché par biométrie + `donnees_sensibles`. Ajouts : **R-AIA-HI-BIO** (biométrie hors travail ⇒ haut risque), **R-AIA-Q-BIO** et **R-AIA-Q-AFF** (réponses « je ne sais pas » ⇒ `to_qualify` + question).
- **R-AIA-HI-EMP** : domaine `rh` avec tri de personnes ou `affects_people`, ou tri de personnes portant sur des candidats / collaborateurs. Le **B2B** se traduit par `affects_people = no` (l'aide du questionnaire le précise).
- **R-AIA-LIM-02** resserrée : contenu généré (image, audio, vidéo) destiné à l'extérieur, ou texte publié sans relecture systématique. Sans cela, le devis relu de l'annexe A (n°2) serait « limité » ; un texte relu sous contrôle éditorial humain n'est pas soumis à la divulgation (art. 50).
- **Données** : le +1 « compte personnel » ne s'applique que si au moins une donnée est envoyée (annexe A n°6 : Midjourney sans données = 0). `account_type = unknown` ⇒ `data_to_qualify` + signal shadow AI, sans +1.
- **Annexe A, usage n°1** : l'échelle numérique fait foi ; 2 = « élevé » (le libellé « modéré (2) » était une coquille).
- **Liens et codes** : HKDF avec sel = clé publique éphémère brute. Le lien porte aussi `dreq` (service obligatoire en mode anonyme). Les codes réels font 650 à 900 caractères (plus que l'estimation de §7.2) : l'e-mail du répondant contient le lien d'import (qui contient le code) et bascule vers le fichier `.rcn` s'il dépasse la limite `mailto`.
- **Empreinte** : 8 caractères hexadécimaux (32 bits), comme demandé. Limite assumée : un attaquant déterminé peut fabriquer une clé de même empreinte en environ 2^32 essais (quelques heures sur une grappe). Allonger l'empreinte est une décision produit ouverte.
- **Masquage anonyme** : les effectifs inférieurs à `min_group_size` sont affichés « < k » ; le service d'un usage reste visible dans le registre (information d'organisation). Pas de suppression secondaire : si un seul service est masqué, son effectif peut se déduire des totaux.
- **CSV** : séparateur `;` (Excel en français), BOM UTF-8, CRLF.
- **Audience** : la query string est retirée de l'adresse au démarrage (le script GoatCounter l'enverrait sinon) ; comptage désactivé hors HTTPS et en local.

## 5bis. État d'avancement (à tenir à jour)

- ✅ **v0.1 — socle (phase 0)** : shell PWA, service worker et précache versionné, manifest et icônes, page de confidentialité, GoatCounter à liste blanche, CSP, `tools/check.mjs`, CI (Node 20 et 22).
- ✅ **v0.2 — moteur de règles** : `data/rules.json`, questionnaire, actions, calendrier vérifié le 29/09/2026, démo ; 57 fixtures (dont l'annexe A).
- ✅ **v0.3 — chiffrement** : codes RCN1, lien de collecte, fichier de récupération, sauvegarde chiffrée ; vecteurs figés.
- ✅ **v0.4 — stockage et exports** : IndexedDB avec repli mémoire, registre (§8.2), CSV, XLSX, JSON.
- ✅ **v0.5 — partage** : canaux, messages générés, liens `mailto` et services tiers, QR, fiche imprimable.
- 🚧 **Phases 1 et 2, vues** : création de campagne, page Diffuser, formulaire répondant, console (tableau de bord, registre, actions, import, saisie, rapport, paramètres), liens d'import, démo.
- ⚠️ **Points d'attention**
  - Le code GoatCounter est vide : aucune mesure en production tant qu'il n'est pas fourni.
  - Page de confidentialité à faire valider : éditeur, contact, exemption de consentement.
  - Règles et actions à faire relire par un juriste (`reviewed: false`).
  - Calendrier vérifié automatiquement sur le JO : à confirmer par un juriste.
  - Test manuel des liens dans Outlook, Gmail, Teams, WhatsApp et Slack : à faire.
  - Empreinte de 32 bits (voir §17).
  - Nom du projet à valider.

---

## Annexe A — Jeu de démo : PME fictive de 40 personnes

Fictive, aucune donnée réelle. Entreprise « Menuiserie Alpine Concept » (négoce et fabrication de menuiseries), 40 salariés : direction (2), commercial et devis (8), production (18), RH/administratif (4), comptabilité (3), service client (3), marketing (2). Les 10 usages ci-dessous servent aussi de fixtures de test.

| # | Usage | Service | Outil / compte | Données | Attendu AI Act | Attendu données |
|---|---|---|---|---|---|---|
| 1 | Reformulation de mails | Commercial | ChatGPT, compte perso gratuit | docs internes | minimal | modéré (2, compte perso) |
| 2 | Rédaction de devis | Commercial et devis | Copilot pro | données clients | minimal | élevé (2) |
| 3 | Chatbot du site web | Service client | outil tiers, configuré | données clients | limité (art. 50) | élevé (2) |
| 4 | Tri automatique de CV | RH | IA intégrée à l'outil de recrutement | données candidats | **haut risque** (annexe III, emploi) | élevé (2) |
| 5 | Aide à l'évaluation annuelle | RH | ChatGPT, compte perso | données collaborateurs | **haut risque** | **critique (3)** |
| 6 | Visuels marketing | Marketing | Midjourney | aucune | limité (contenu publié) | faible (0) |
| 7 | Résumé de contrats fournisseurs | Direction | Claude, compte pro | secrets d'affaires | minimal | élevé (2) |
| 8 | Transcription de réunions | Direction | outil de transcription, compte pro | docs internes | minimal | modéré (1) |
| 9 | Analyse d'émotions en visio (test) | RH | outil tiers, pilote | données collaborateurs | **interdit suspecté** (art. 5) | élevé (2) |
| 10 | Aide au code du site | Marketing | GitHub Copilot, compte pro | code source | minimal | élevé (2) |

Cas limites à tester en plus : scoring de solvabilité **B2B** (pas de personne physique : ne devrait pas être haut risque), usage avec `unknown` partout (doit produire `to_qualify`), identifiants collés dans un prompt (exposition critique), système développé en interne sous le nom de l'entreprise (`to_qualify`, rôle de fournisseur possible).
