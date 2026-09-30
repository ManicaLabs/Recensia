# Recensia — contrat d'architecture

Document technique compagnon de [CDC.md](CDC.md). Le CDC dit **quoi** ; ce document fixe
**comment** les modules se parlent (API, formats, conventions). Toute évolution d'une API
publique listée ici doit être répercutée dans ce fichier dans le même commit.

## 1. Conventions générales

- **ES modules sans build.** Imports relatifs avec extension explicite (`./dom.js`).
  `package.json` déclare `"type": "module"` pour que Node exécute les mêmes fichiers.
- **Modules « purs »** (`src/engine/`, `src/crypto/`, `src/share/` hors `qr-png`/`sheet`,
  `src/export/csv.js`, `src/export/registry.js`, `src/analytics.js` pour la partie liste blanche,
  `src/storage/` backend mémoire) : aucun accès au DOM **à l'import**, exécutables sous
  `node --test` (Node ≥ 20, `globalThis.crypto`).
- **Aucune requête réseau** hors GoatCounter : seul `src/data.js` fait des `fetch`, et uniquement
  vers des fichiers du site (`data/*.json`, `src/i18n/**`).
- **Jamais `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`** avec des données.
  Tout passe par `h()` (`src/ui/dom.js`) qui utilise `textContent`. Seule exception tolérée :
  aucune. (Le QR est construit en éléments SVG via `svg()`.) Un test grep le vérifie.
- **CSP** : pas d'attribut `style="..."`, pas de `<style>` inline, pas de script inline.
  Les styles dynamiques passent par des classes ou par l'API CSSOM (`el.style.setProperty`),
  autorisée par la CSP.
- `localStorage`, `sessionStorage`, IndexedDB : **toujours** dans un `try/catch`
  (utiliser `src/ui/safe-storage.js`).
- Identifiants et valeurs d'énumération : `snake_case` ASCII. Les accents restent dans les libellés.
- Textes d'interface : via `t('namespace.key', vars)` (voir §6). Les libellés métier
  (questionnaire, règles, actions, messages) vivent dans `data/*.json`.
- Dates : `YYYY-MM-DD` pour les jours, ISO 8601 complet pour les horodatages.
  **Aucune date réglementaire en dur dans le code** : tout vient de `data/regulatory-calendar.json`.
- Tests : `tests/*.test.js`, lancés par `node --test` (sans argument, motif par défaut).
  Les helpers de test vont dans `tests/helpers/` (noms ne correspondant pas au motif de test).
- Pas de commit ni de push par les agents : l'intégrateur s'en charge.

## 2. Arborescence et propriété des fichiers

```
index.html  manifest.webmanifest  sw.js  sw-precache.js (généré)  config.js  .nojekyll
icon.svg  icon-192.png  icon-512.png  icon-maskable-512.png  favicon-32.png
package.json  README.md  .gitignore
src/
  app.js            démarrage : i18n, données, store, analytics, routeur, bannière de mise à jour
  router.js         routage par hash
  data.js           chargement/cache des fichiers data/*.json
  i18n.js           t(), chargement des espaces de noms src/i18n/fr/*.json
  i18n/fr/*.json    un fichier par espace de noms (common, home, privacy, new, share, form, admin, console, …)
  analytics.js      GoatCounter (liste blanche)
  ui/               dom.js, components.js, clipboard.js, download.js, safe-storage.js, charts.js, questionnaire.js
  styles/           app.css (tokens + composants), print.css, <vue>.css
  views/            home.js, privacy.js, not-found.js, new.js, form.js, admin.js, console.js, import-link.js, demo.js
  views/console/    dashboard.js, registry.js, actions.js, import.js, add.js, share.js, report.js, settings.js
  services/         model.js (modèle de campagne), import.js (pipeline d'import)
  engine/           evaluate.js, classify.js, validate.js, consolidate.js, actions.js, stats.js, levels.js
  crypto/           b64url.js, compress.js, keys.js, link.js, codes.js, backup.js, random.js
  storage/          store.js (IndexedDB + repli mémoire)
  share/            channels.js, urls.js, messages.js, qr.js, sheet.js
  export/           registry.js, csv.js, xlsx.js, json.js
data/  questionnaire.json rules.json actions.json regulatory-calendar.json messages.fr.json channels.json demo-company.json
vendor/  fflate.mjs  xlsx.mjs  qrcode.mjs  (+ licences, README)
tests/  *.test.js  fixtures/  helpers/  vectors/
tools/  check.mjs  precache.mjs
docs/   CDC.md  ARCHITECTURE.md  TESTS-MANUELS.md
.github/workflows/ci.yml
```

## 3. Modèle de données

### 3.1 Usage (objet du CDC §5.1)

Clés et valeurs d'énumération **exactes** (les libellés sont dans `data/questionnaire.json`) :

| Clé | Type | Valeurs |
|---|---|---|
| `usage_name` | string 1..80 | |
| `department` | string \| null | une valeur de `campaign.departments` |
| `tool` | enum | `chatgpt` `claude` `gemini` `microsoft_copilot` `github_copilot` `mistral_le_chat` `perplexity` `deepl` `midjourney` `notion_ai` `embedded_software_ai` `internal_system` `other` |
| `tool_other` | string 0..80 \| null | requis si `tool = other` |
| `model` | string 0..80 \| null | |
| `account_type` | enum | `enterprise_provided` `personal_paid` `personal_free` `api_integration` `internal_system` `unknown` |
| `task_types` | enum[] (≥1, uniques) | `redaction` `resume` `traduction` `code` `analyse_donnees` `recherche_information` `generation_media` `transcription` `chatbot_externe` `evaluation_tri_personnes` `aide_decision` `agent_automatisation` `autre` |
| `business_domain` | enum | `rh` `finance_credit` `service_client` `marketing_com` `juridique` `it_dev` `production` `formation` `sante` `direction` `commercial_devis` `autre` |
| `data_types` | enum[] (≥1, uniques ; `aucune` exclusif) | `aucune` `docs_internes` `donnees_clients` `donnees_collaborateurs` `donnees_candidats` `donnees_sensibles` `secrets_affaires` `code_source` `donnees_financieres` `identifiants` |
| `frequency` | enum | `daily` `weekly` `monthly` `occasional` |
| `users_count` | enum \| null | `1` `2-5` `6-15` `>15` |
| `output_audience` | enum | `internal_only` `external_clients` `public` `not_applicable` |
| `output_review` | enum | `systematic` `partial` `none` |
| `affects_people` | enum | `yes_decision` `yes_input` `no` `unknown` |
| `direct_interaction` | enum | `yes` `no` |
| `biometric_emotion` | enum | `yes` `no` `unknown` |
| `built_or_customized` | enum | `use_as_is` `configured_prompt` `built_own` |
| `status` | enum | `in_use` `pilot` `planned` |
| `comment` | string 0..500 \| null | |

`SCHEMA_VERSION = 1` (exporté par `src/engine/validate.js`, identique à `questionnaire.schema_version`).

### 3.2 Campagne (store `campaigns`, clé `id`)

```js
{
  id: 'k3J9xQ2mP0aZ',            // 12 car. base64url aléatoires ('demo' pour la démo)
  title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept',
  mode: 'anonymous' | 'open',
  departments: ['Direction', 'Commercial et devis', ...],
  settings: {
    min_group_size: 5, department_required: false, comments_exportable: false,
    closes_on: '2026-10-31' | null, group_by_department: false,
    channels: [{ type: 'mailto', target: 'ia@exemple.fr' }, { type: 'copy', target: 'consigne…' }]
  },
  public_key: '<base64url, 65 octets bruts non compressés>',
  private_key_jwk: { kty:'EC', crv:'P-256', x, y, d } | null,
  fingerprint: 'A1B2C3D4',
  created_at: ISO, demo: false, last_backup_at: ISO | null, recovery_saved_at: ISO | null
}
```

### 3.3 Entrée (store `entries`, clé `[campaign_id, entry_id]`)

```js
{
  campaign_id, entry_id: '16 car. base64url', rev: 1,
  submitted_day: 'YYYY-MM-DD', submitted_at: ISO | null,   // horodatage complet en mode ouvert seulement
  respondent: null | { first_name, last_name, email: string | null },   // toujours null en anonyme
  usage: { …§3.1 }, schema_version: 1,
  code_hash: 'hex sha-256 du code' | null,   // null si saisie directe / démo
  source: 'code' | 'manual' | 'demo',
  imported_at: ISO, after_close: false, excluded: false, group_override: null | string
}
```

### 3.4 Évaluation (store `assessments`, clé `[campaign_id, usage_key]`)

```js
{ campaign_id, usage_key, override_ai_act_level: null | level, override_data_level: null | 0..3,
  justification: '', owner: '' /* responsable de l'usage, saisi par l'admin */, validation_status: 'to_review' | 'validated' | 'to_revise',
  history: [{ at: ISO, field, from, to, justification }], updated_at: ISO }
```

### 3.5 Action (store `actions`, clé `id`)

```js
{ id, campaign_id, usage_key: null | string, template_id: null | 'ACT-…', title, description,
  owner: '', due_date: null | 'YYYY-MM-DD', priority: 'high' | 'medium' | 'low',
  status: 'todo' | 'in_progress' | 'done' | 'rejected', suggested: true | false,
  suggested_role: 'Direction' | 'DSI' | 'RH' | 'DPO/juriste' | 'Métier' | null,
  created_at: ISO, updated_at: ISO }
```
`owner` n'est **jamais** rempli automatiquement.

## 4. API des modules purs

### 4.1 `src/engine/`

```js
// levels.js
export const AI_ACT_ORDER = ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal']; // du plus grave au moins grave
export function compareAiAct(a, b)        // < 0 si a plus grave que b
export function maxAiAct(levels)          // niveau le plus grave ; 'minimal' si liste vide
export const DATA_LEVELS = [0, 1, 2, 3];

// labels.js
export function optionLabel(questionnaire, field, value)      // libellé FR d'une valeur d'énumération (ou la valeur brute)
export function formatUsageValue(questionnaire, field, value) // idem pour tableaux (libellés joints par ', ')

// evaluate.js
export function evaluateCondition(condition, usage) // bool ; opérateurs all/any/not + feuilles {field, eq|in|includes_any|includes_all}

// validate.js
export const SCHEMA_VERSION = 1;
export function validateUsage(usage, questionnaire, { departments, department_required, mode })
  // → { ok, errors: [{ field, code }], value }  (value = usage normalisé : trim, contrôles retirés, clés inconnues ⇒ erreur)
export function validateRespondent(respondent, mode) // → { ok, errors, value }

// classify.js
export function classifyUsage(usage, rules, calendar)
  // → { ai_act_level, data_level, data_to_qualify, role: 'deployer'|'potential_provider',
  //     triggers: [{ rule_id, axis, level, label, legal_ref, explanation }],
  //     deadlines: [{ id, date, label, status, source_url, last_verified }]  (tri par date),
  //     action_ids: [...], questions_to_confirm: [{ rule_id, question }], signals: [{ id, label }] }

// consolidate.js
export function usageKey(usage, { byDepartment = false } = {})   // chaîne déterministe
export function groupId(usageKey)                                   // 'U-' + 6 hex stables
export function consolidate(entries, rules, calendar, { byDepartment = false, assessments = [] } = {})
  // entries exclus (excluded=true) ignorés ; clé = entry.group_override ?? usageKey(entry.usage)
  // → groups[] triés par gravité puis nom :
  // { usage_key, id, name, names[], members[], count, tool, tool_other, task_types[], business_domain,
  //   departments[], account_types[], models[], data_types[], frequencies[], output_audiences[],
  //   statuses[], users_counts[], comments_count,
  //   computed: { ai_act_level, data_level, data_to_qualify, role, triggers[], deadlines[], action_ids[],
  //               questions_to_confirm[], signals[] },        // max / union des membres
  //   assessment: object | null,
  //   effective: { ai_act_level, data_level, overridden: bool },
  //   validation_status, last_review: ISO | null }

// actions.js
export function suggestActions(groups, actionTemplates, storedActions)
  // → suggestions non encore présentes dans storedActions (même template_id + usage_key) :
  //   [{ template_id, usage_key | null, group_id | null, title, description, priority, effort,
  //      suggested_role, horizon, rule_ids[] }]
export function actionFromSuggestion(suggestion, campaignId, { status = 'todo' } = {}) // → action (§3.5), suggested=true

// stats.js
export function maskCount(n, k, mode)     // anonyme et 0 < n < k ⇒ '< k' ; sinon String(n)
export function computeStats({ campaign, entries, groups, actions, suggestions, calendar, today })
  // → { usages, responses, respondents|null, by_ai_act:{level:n}, by_data:{0..3:n},
  //     shadow_ai:{ count, share }, top_tools:[{tool,label,count}],
  //     by_department:[{ department, count, display, masked }],
  //     upcoming_deadlines:[…], past_deadlines:[…], actions_progress:{ todo, in_progress, done, rejected, pending_suggestions, total },
  //     to_qualify, questions }
```

### 4.2 `src/crypto/`

```js
// b64url.js   alphabet A-Za-z0-9-_ sans padding ; decode rejette tout autre caractère
export function b64urlEncode(bytes) ; export function b64urlDecode(str)
// random.js
export function randomId(bytes = 12)      // base64url (12 octets ⇒ 16 car.)
// compress.js (fflate, raw deflate)
export function deflateJson(obj) ; export function inflateJson(bytes, maxBytes = 16384) // dépassement ⇒ erreur
// keys.js
export async function generateCampaignKeys() // → { publicKeyB64, privateKeyJwk, fingerprint }
export async function importPublicKey(b64) ; export async function importPrivateKey(jwk)
export async function fingerprint(publicKeyB64)  // 8 hex MAJUSCULES = 4 premiers octets de SHA-256(clé brute)
export function formatFingerprint(fp)            // 'A1B2-C3D4'
export async function publicKeyFromPrivateJwk(jwk)
// link.js
export const LINK_VERSION = 1;
export function encodeCampaignLink(config)   // → payload base64url(deflate(JSON))
export function decodeCampaignLink(payload)  // → config validée (synchrone, forme de pk seulement) ; sinon LinkError { code }
export async function decodeAndVerifyCampaignLink(payload) // + vérifie que pk est un point P-256 valide : À UTILISER dans le formulaire
export async function verifyCampaignKey(pk)
export function validateCampaignConfig(obj)  // → { ok, errors, value }
export function campaignToLinkConfig(campaign) // campagne (§3.2) → config de lien
export function buildCollectUrl(baseUrl, campaign)  // `${baseUrl}#/c/${payload}`
//   config = { v:1, id, title, org, mode, depts:[], dreq?:bool, pk, closes?:'YYYY-MM-DD',
//              channels?:[{ type, target? }] }   (≤ 3 canaux)
// codes.js
export const CODE_PREFIX = 'RCN1.';
export async function encryptEntry(plain, publicKeyB64, campaignId) // → 'RCN1.…'
export async function decryptEntry(code, privateKey /* CryptoKey | JWK */, campaignId) // → plain ; sinon CodeError
export function extractCodes(text)   // trouve les codes RCN1.… et les liens #/i/… dans un texte collé
export async function codeHash(code) // hex sha-256
export class CodeError extends Error { /* reason: 'format'|'version'|'size'|'decrypt'|'campaign'|'schema' */ }
//   plain = { v:1, sv:1, campaign_id, entry_id, rev, submitted_day, submitted_at?, respondent?, usage }
// backup.js  (PBKDF2-SHA-256 ≥ 600 000 itérations + AES-256-GCM)
export async function encryptWithPassword(obj, password) ; export async function decryptWithPassword(envelope, password)
export async function wrapPrivateKey(campaign, passphrase | null)   // → fichier de récupération (objet JSON)
export async function unwrapPrivateKey(file, passphrase)            // → { campaign, private_key_jwk }
export async function exportEncrypted(data, password) ; export async function importEncrypted(file, password)
```

Format binaire du code : `0x01 ‖ clé publique éphémère (65) ‖ IV (12) ‖ chiffré+tag`.
Dérivation : `ECDH(éphémère, pk)` → HKDF-SHA-256 (sel = clé publique éphémère brute,
info = `recensia-v1|<campaign_id>`) → clé AES-256-GCM ; AAD = `campaign_id` (UTF-8).

### 4.3 `src/storage/store.js`

```js
export async function openStore({ forceMemory = false } = {})
// store.kind: 'indexeddb' | 'memory' ; store.persisted: bool
// listCampaigns() getCampaign(id) putCampaign(c) deleteCampaign(id)  (cascade)
// listEntries(cid) getEntry(cid, eid) putEntry(e) putEntries(es) deleteEntry(cid, eid)
// listAssessments(cid) putAssessment(a) deleteAssessment(cid, usageKey)
// listActions(cid) putAction(a) putActions(as) deleteAction(id)
// getMeta(key) setMeta(key, value)
// exportCampaignData(cid, { includePrivateKey = false }) → { format:'recensia-backup', v:1, exported_at, app_version, campaign, entries, assessments, actions }
// importCampaignData(obj, { overwrite = false }) → { campaign_id, entries, assessments, actions }
```

### 4.4 `src/share/`

```js
// channels.js (données : data/channels.json)
export function channelInfo(type, channelsData)    // { type, label, identifies_sender: 'yes'|'depends'|'no', … }
export function anonymityWarning(mode, type, channelsData) // phrase d'avertissement ou null
// urls.js
export const MAILTO_MAX = 1800;
export function sanitizeText(s, max)  // retire les contrôles et tous les invisibles Cf (hors ZWNJ/ZWJ) + remplisseurs hangûl, NFC ensuite, espaces normalisés, tronque
export function isValidEmail(s)
export function mailtoUrl({ to, subject, body }) ; export function whatsappUrl(text)
export function teamsShareUrl(url, text) ; export function gmailComposeUrl({ to, subject, body })
export function outlookComposeUrl({ to, subject, body })
export function importLink(baseUrl, codes)   // `${baseUrl}#/i/${codes.join('~')}`
// messages.js (données : data/messages.fr.json)
export function renderMessage(templateId, ctx, templates, channelsData, { compact } = {})  // → { subject, body, html, locked_block }
//   channelsData (data/channels.json) est OBLIGATOIRE : sans lui ⇒ MessageError('missing_data')
//   ctx = { title, org, link, closes_on, duration_min, mode, channels, fingerprint, codes?, import_link? }
export function anonymityBlock(mode, channels, templates, channelsData)
export function hasLockedBlock(text, lockedBlock) // bool
export function listTemplates(templates)
// qr.js
export function qrMatrix(text, ecc = 'M')   // { size, isDark(r, c) }
export function qrSvgString(text, opts)      // chaîne SVG (téléchargement)
export function qrSvgElement(text, opts)     // élément SVG (DOM, navigateur)
export async function qrPngBlob(text, opts)  // Blob PNG (canvas, navigateur)
// sheet.js (navigateur)
export function buildPrintableSheet({ campaign, link, fingerprint, templates, channelsData, layout = 'page' | 'slide' }) // → élément DOM A4
export function printSheet(sheet)   // impression de la fiche seule
// urls.js : planMailto({ to, subject, codes, baseUrl, templates, ctx, channelsData, max })
//   → [{ url, codes, subject, body, compact }] ou [{ tooLong: true, fallback: 'file', codes }]
// messages.js : messageContextFromCampaign(campaign, { link, duration_min }) construit un ctx public
```

### 4.5 `src/export/`

```js
// registry.js — lignes du registre (CDC §8.2), communes au CSV et au XLSX
export const REGISTRY_COLUMNS = [{ key, label }, …]
export function registryRows(groups, { campaign, actions, questionnaire, rules, calendar, t, today }) // → [{ key: value }]
// csv.js
export function neutralize(value)      // préfixe ' si commence par = + - @ \t \r
export function toCSV(rows, columns)   // BOM UTF-8 + séparateur ';' + CRLF + guillemets
// xlsx.js (vendor/xlsx.mjs)
export function buildWorkbook({ campaign, groups, actions, stats, rules, calendar, questionnaire, t, today }) // feuilles Registre, Plan d'actions, Synthèse, Référentiel
export function workbookBlob(wb)
// json.js
export async function exportJson(store, campaignId, { password }) // Blob ; chiffré si mot de passe (clé privée incluse seulement si chiffré)
export async function importJson(fileText, password, store)
```

## 5. Application (navigateur)

### 5.1 Routes

| Hash | Vue | Chemin GoatCounter |
|---|---|---|
| `#/` | `views/home.js` | `/home` |
| `#/new` | `views/new.js` | `/new` |
| `#/c/<payload>` | `views/form.js` | `/form` |
| `#/admin` | `views/admin.js` | — |
| `#/admin/<id>[/<onglet>]` | `views/console.js` | `/admin/registre`, `/admin/actions`, `/admin/rapport` (autres onglets : non comptés) |
| `#/i/<code>[~<code>…]` | `views/import-link.js` | — (événement `event/import_link`) |
| `#/demo` | `views/demo.js` | `/demo` |
| `#/privacy` | `views/privacy.js` | `/privacy` |

Onglets de console : `tableau` · `registre` · `actions` · `import` · `saisir` · `diffuser` · `rapport` · `parametres`.

### 5.2 Contrat d'une vue

```js
// src/views/<vue>.js
export async function render(root, { params, ctx }) { … ; return cleanup? }
// ctx = { store, data, t, i18n, navigate, config, track, toast, baseUrl, setTitle }
//   store peut être null si le module de stockage est indisponible (afficher un message)
//   i18n.load('registry') → Promise (charge src/i18n/fr/registry.json) ; l'app charge automatiquement
//   'common' + l'espace de noms de la vue avant render() (home, privacy, new, form, admin, console,
//   import_link, demo, not_found) ; console.js charge celui de l'onglet (dashboard, registry, actions,
//   import, add, share, report, settings).
//   data.get('rules') → Promise<json> (cache) ; navigate('/admin/x', { replace })
//   track.view('/home') ; track.event('event/share_link')  (liste blanche imposée)
//   baseUrl = URL absolue de la racine de l'app, sans hash (ex. https://manicalabs.github.io/Recensia/)
```

### 5.3 Contrat d'un onglet de console

```js
// src/views/console/<onglet>.js
export async function render(root, { campaign, model, ctx, refresh }) { … }
// model = await buildCampaignModel(ctx, campaign)   (src/services/model.js)
//   { campaign, entries, assessments, actions, groups, suggestions, stats,
//     rules, calendar, actionTemplates, questionnaire, channels }
// refresh() : recharge le modèle depuis le store et ré-affiche l'onglet courant
```

### 5.4 Composants partagés (`src/ui/`)

```js
// dom.js
export function h(tag, attrs, ...children)   // attrs : class, id, text, on<Event> (fonctions), aria-*, data-*, et attributs HTML ; pas de style
export function svg(tag, attrs, ...children)
export function mount(root, ...nodes)        // remplace le contenu
export function loadCss(href)                // <link rel=stylesheet> une seule fois
export function announce(message)            // région aria-live
// components.js
export function button(label, onClick, { variant = 'secondary', type = 'button', icon, attrs } = {})
export function field({ id, label, help, error, required, control })
export function levelBadge(axis /* 'ai_act'|'data' */, level, t)
export function callout(kind /* info|warn|danger|success */, ...children)
export function modal({ title, content, actions }) // <dialog>, → Promise<valeur de l'action>
export function confirmDialog({ title, message, confirmLabel, danger }) // → Promise<bool>
export function toast(message, kind)
export function copyButton(getText, { label, rich })
export function disclaimer(t)                // « indicatif, à confirmer »
// clipboard.js : copyText(text) ; copyRich(html, text)
// download.js  : downloadBlob(blob, filename) ; downloadText(text, filename, mime)
// safe-storage.js : local.get/set/remove, session.get/set/remove (JSON, try/catch)
// charts.js : barChart(items, opts) ; stackedBar(items, opts) ; donut(items, opts) → SVG
// questionnaire.js :
export function renderQuestionnaire(root, { questionnaire, campaign, initial, t, onChange, idPrefix, headingLevel })
  // → { getValue(), validate() → { ok, errors, value }, focusFirstError(), reset(value), destroy() }
  // fonctions pures exportées : fieldOrder, isFieldVisible, isFieldRequired, toggleChoice, nextFieldKey,
  // visibleValue, errorText, frenchSpacing (espaces insécables à l'affichage des textes de data/)
```

### 5.5 i18n

`t('form.notice.title', { org })` cherche `src/i18n/fr/form.json` → `{ "notice": { "title": "…{org}…" } }`.
Chaque vue possède son espace de noms (fichier). `common.json` contient les libellés partagés,
dont les niveaux : `common.levels.ai_act.<niveau>` et `common.levels.data.<0..3>`
(+ `common.levels.ai_act_short.*`), `common.validation.<statut>`, `common.action_status.<statut>`,
`common.priority.<p>`, `common.disclaimer`.
Une clé absente renvoie la clé elle-même et journalise un avertissement (en local uniquement).
`tools/check.mjs` vérifie que toute clé littérale utilisée dans `src/` existe.

### 5.6 Service worker

`sw.js` importe `sw-precache.js` (généré par `node tools/precache.mjs`) qui contient la liste
des fichiers du shell et une version (`appVersion` + empreinte du contenu). Toute modification
de fichier change la version ⇒ nouveau cache ⇒ bannière « nouvelle version disponible ».
`tools/check.mjs` échoue si `sw-precache.js` n'est pas à jour. Depuis la v1.0, `sw-precache.js` porte aussi
`integrity` (SHA-256 par fichier) et `types` (type MIME par extension) : voir §10.

## 6. Sécurité : invariants testés

1. La clé privée (`d` du JWK) n'apparaît dans aucun lien, message, log, événement.
2. Tout texte venant d'un lien ou d'un code est validé (schéma, longueurs, énumérations) puis affiché par `textContent`.
3. Les exports neutralisent les formules.
4. Les appels GoatCounter n'utilisent que des chemins de la liste blanche.
5. Aucun `fetch` vers un domaine tiers.

## 7. Compléments constatés à l'implémentation (v0.1 → v0.5)

Ces points précisent ou étendent le contrat ; ils font foi pour les vues à venir.

- **Routes** (`src/router.js`) : `form ⇒ { payload }` (séquences %XX décodées) ;
  `import_link ⇒ { payload, codes[] }` (découpage sur « ~ ») ; `console ⇒ { id, tab }`,
  `tab ∈ CONSOLE_TABS` ou `null` (onglet par défaut) ; onglet inconnu ⇒ `not_found`.
  `baseUrlFrom(href)` calcule `ctx.baseUrl`. Au démarrage, la query string est retirée de l'adresse
  (le script GoatCounter l'enverrait sinon).
- **Audience** : désactivée aussi sur `*.localhost`, `0.0.0.0` et toute page non HTTPS.
  `trackRoute(route)` est appelé par `app.js` : les vues n'ont pas à compter leur affichage.
- **Styles** : le thème sombre est réservé à l'écran (`@media screen and (prefers-color-scheme: dark)`) ;
  toute règle sombre d'une feuille de vue doit suivre la même convention. La feuille d'impression
  globale est `src/export/print.css`.
- **UI** : `icon(name, { label, className })`, `setFieldError(fieldNode, message)` ;
  `levelBadge(axis, level, t, { short })` ; `button(…, { size: 'sm' })` ;
  `field({ …, group: true })` (fieldset + legend) ; `modal({ …, dismissible, size })` ;
  `toast(message, kind, { timeout })` ; `download.safeFilename()` ; `local/session.available()`.
- **i18n** : `formatDate`, `formatDateTime`, `formatNumber`, `has`, `LOCALE`.
- **Stockage** : `openStore({ forceMemory, appVersion, timeoutMs, indexedDB })` ;
  `store.reason` (cause du repli mémoire) ; `putCampaign` écrase l'objet entier : **relire la campagne
  depuis le store avant de la modifier** (sinon `last_backup_at` ou la clé privée peuvent être perdus).
  `exportJson` valide la sauvegarde avant de la produire (`StoreError('invalid_backup', { details })`).
- **Crypto** : `extractCodes` renvoie aussi les codes `RCNn.` (n ≠ 1) pour que l'import puisse répondre
  « version non supportée » ; `decryptEntry` renvoie `respondent` et `submitted_at` à `null` quand ils
  sont absents. **`decryptEntry` ne connaît pas le mode de la campagne** : l'import doit refuser un
  code portant une identité ou un horodatage complet en mode anonyme (`validateRespondent`).
  `wrapPrivateKey(campaign, null)` (explicite) produit un fichier non protégé ; `''` est refusé.
- **Services** : `new.js` doit stocker les services **normalisés** tels que renvoyés par
  `validateCampaignConfig(campaignToLinkConfig(c)).value.depts` et exiger au moins un service en
  mode ouvert (sinon aucun usage ne peut être validé).
- **Moteur** : une surcharge d'évaluation n'est retenue que si elle est un niveau valide
  (`isAiActLevel` / `isDataLevel`) ; `computeStats` accepte `questionnaire` (libellés des outils).
- **Exports** : `registry.js` exporte aussi `toDay`, `exportFilename`, `slugify`, `applicableDeadline`,
  `FALLBACK_LABELS` (égaux à `common.json`) ; `xlsx.js` importe SheetJS (≈ 1 Mo) : **charger ce module
  à la demande** (`import()` au clic).
- **Partage** : codes réels de 650 à 900 caractères (au-delà de l'estimation du CDC) : l'e-mail du
  répondant passe en corps compact (lien d'import seul, qui contient le code) ; au-delà, repli fichier.
  QR en niveau L, prévu pour un lien allant jusqu'à 1 500 caractères (plafond du CDC §14 ; liens réels : 600 à
  700 caractères pour 10 services, 1 100 au plus) ; lisibilité sur papier à tester en vrai.

## 8. Vues et services (v0.6 → v0.9)

- **Services** (`src/services/`, logique pure testée sous Node avec `openStore({ forceMemory: true })`) :
  - `model.js` : `buildCampaignModel(ctx, campaign, { today })`, `localDay()`, `daysSince()`.
  - `import.js` : `importCodes({ text | codes, campaign, campaigns, store, questionnaire, now })` →
    rapport `{ total, accepted, revised, duplicates, invalid, other_campaign, after_close, unsupported_version }` ;
    `planImport` (révisions : le `rev` le plus élevé gagne, tri déterministe), `textFromFile` (.rcn/.txt/.eml,
    sans regex à retour arrière), `stashReport`/`takeReport` (rapport lu une seule fois, 30 min, session).
    En mode anonyme, un code portant `respondent` ou `submitted_at` est refusé (`identity_in_anonymous`).
  - `recovery.js` : `importRecovery({ store, file, passphrase })` (création de la campagne ou ajout de la clé
    à une campagne de même clé publique, jamais d'écrasement), `buildRecoveryFile`, `recoveryFilename`,
    codes en attente de session (`add/list/remove/clearPendingCodes`, clé `pending_codes`).
  - `demo.js` : `DEMO_ID`, `buildDemoRecords(demoData, keys, now)`, `loadDemo(store, data, { reset, now, keys })`.
    Les dates du jeu de démo sont décalées d'un nombre entier de jours pour que le dernier événement tombe
    dans les 24 h précédant `now` (les dates réglementaires ne sont jamais décalées) ; un `reset` prépare
    données et clés avant de supprimer l'ancienne démo.
- **Console** : `refresh({ keepScroll })` ; si l'onglet a placé le focus dans son contenu, la position de
  défilement n'est pas restaurée. Styles communs : `src/styles/console.css`.
- **Graphiques** (`src/ui/charts.js`) : `barChart`, `stackedBar`, `donut` → `<figure class="chart">` (SVG
  `role="img"` + table de repli). Effectif masqué : `maskedItem(label, { count, display, masked }, k)`
  exporté par `views/console/dashboard.js`, référence commune au tableau de bord et au rapport.
- **Liens** : `decodeCampaignLink` et le routeur retirent la ponctuation qu'une messagerie colle en fin de
  lien (`.`, `)`, `»`, `%29`…) par un parcours linéaire, après le contrôle de longueur.
- **Boîtes de dialogue** : sans action `autofocus`, `modal()` place le focus sur le premier champ du contenu.
- **Messages** : `reminder_j3` et `reminder_j1` ont un `body_compact` (repli `mailto`) ; l'invitation e-mail
  se replie sur le corps de `invitation_short` (`planMessageMailto`, `src/views/new/share-helpers.js`).

## 9. Recette v1.0 : compléments d'API

- **Fichiers ajoutés** : `404.html` + `404.js` (réparation des liens `%23`, fonction pure `repairedHash`),
  `src/views/form/notice.js` (`anonymousLimits`, `channelLimits`), `docs/TESTS-MANUELS.md`,
  `tests/components.test.js`, `tests/console-view.test.js`.
- **UI** : `levelBadge(axis, level, t, { short, axisLabel: 'hidden' | 'visible' | 'none' })` (l'axe « AI Act » /
  « Exposition des données » est toujours exposé aux lecteurs d'écran par défaut) ; `modal({ …, describe: true | nœud,
  alert })` (aria-describedby, role alertdialog) ; `confirmDialog` décrit son message et passe en alertdialog si
  `danger` ; `toast` : erreurs et avertissements persistants, doublons remplacés, pile limitée ;
  `watchBottomOverlays()` (app.js) expose la hauteur des notifications dans `--bottom-overlay` (scroll-padding).
  Région live assertive présente dans `index.html`.
- **Moteur** : `resolveDeadlines(ids, calendar, { role })`, `deadlineAppliesToRole(deadline, role)` ; champ
  `applies_to_roles` d'une échéance du calendrier.
- **Crypto** : `extractCodeCandidates(text)` → `[{ code, candidates }]` (codes recoupés par la messagerie ; parcours
  linéaire) ; `extractCodes` renvoie le candidat préféré.
- **Partage** : `frenchSpacing` (messages.js), appliqué aux valeurs insérées dans les gabarits, jamais aux lignes de
  lien ou de code.
- **Exports** : `registryColumns(campaign)` (20 colonnes + « Commentaires » si `comments_exportable`),
  `COMMENTS_COLUMN`, `commentsExportable`, `commentsText` ; `CALENDAR_STATUS`, `calendarStatusText(deadline, today)`.
- **Import** : `codeFormatIssue(code)`, `isKeepableCode`, `diagnoseUnmatched(codes, campaigns)` → `'version' |
  'unreadable' | 'no_key'`.
- **Récupération** : `buildRecoveryFile(campaign, passphrase, { today })` → `{ text, filename, mime, protected }`,
  `RECOVERY_MIME = 'application/json'`, nom `recensia-cle-<slug>-<EMPREINTE>-<AAAA-MM-JJ>.recensia-key` (protégé) ou
  `…-<AAAA-MM-JJ>-NON-PROTEGEE.recensia-key` (sans mot de passe), utilisé par la création de campagne ET l'onglet
  Paramètres. `recoveryFilename(campaign, today, { protected })` : marqueur ajouté sauf `protected === true`.
  `backupDownloadFilename(campaign, today, { encrypted })` : `…-EN-CLAIR.json` sauf `encrypted === true`.
  Constantes `UNPROTECTED_RECOVERY_MARK = 'NON-PROTEGEE'`, `PLAIN_BACKUP_MARK = 'EN-CLAIR'`.
- **Vues** : `mailPlan` (form/send-plan.js), `lockedStatusChange` (new/share-helpers.js), `tabCounter` / `tabsNav`
  (console.js), `isAlwaysOptional` / `displaySections` (ui/questionnaire.js).
- **Outillage** : `tools/check.mjs` [9] (`cdcVersions`, `versionIssues`) : version de config.js = package.json, et
  cohérente avec la dernière ligne ✅ ou 🚧 de CDC §5bis.
- **Registre** : `src/views/console/registry/cells.js` : `levelCell(axis, group, t, { axisLabel })`,
  `alertSlot(className)`, `setAlert(slot, message)` ; `createDetailDialog()` renvoie aussi `setError(text)`.
- **Pilotage** (actions.js) : `statusControl(action, t, { id, onApply })` → `{ select, apply, sync, reset }`,
  `axisBadges(effective, t)`, `saveErrorSlot({ live })`, `saveErrorPresenter(t, fallback)`,
  `visibleActions(actions, view, keep)`. Saisie directe : `savedNotice(campaign, saved, t)` (add.js).
- **Codes** : `checkCodeFormat(code)` → `null | 'format' | 'size' | 'version'` (contrôles de `decryptEntry` avant
  déchiffrement, sans clé).
- **Sauvegarde** : `exportJson` écrit `last_backup_at = exported_at` dans le fichier et le store ; `importJson`
  garde la plus récente des deux dates.
- **XLSX** : `SHADOW_AI_SECTION`, `SHADOW_AI_LABEL`, `ACTION_ORIGIN`, `originLabel`.

## 10. Durcissement sécurité v1.0

- **Caractères invisibles** : un même ensemble est retiré sur les trois chemins (codes : `cleanLine` /
  `cleanMultiline` ; lien : `decodeCampaignLink` / `validateCampaignConfig` / `encodeCampaignLink` ; messages et fiche :
  `sanitizeText`) : catégorie Unicode Cf sauf U+200C/U+200D, plus les remplisseurs hangûl U+115F, U+1160, U+3164,
  U+FFA0. NFC après les retraits ; fonctions idempotentes. Dans un lien, contrôles C0/C1, U+2028/2029 et marques
  bidi restent refusés (`'chars'`) ; un texte fait seulement d'invisibles donne `'required'`.
- **Intégrité du cache** (contre un autre site de la même origine) : `tools/precache.mjs` exporte `MIME_TYPES`,
  `extensionOf(file)`, `integrityOf(content)` → `'sha256-<base64>'` ; `renderPrecache(version, files, integrity)` ;
  `buildPrecache()` → `{ version, files, integrity, content }`. Format généré :
  `self.__RECENSIA_PRECACHE = { version, files, integrity: { './f': 'sha256-…' }, types: { '.ext': 'mime' } }`.
  `sw.js` ne sert une copie en cache que si son SHA-256 correspond (réponse reconstruite : statut 200, seul
  `content-type`) ; une copie altérée est supprimée puis rechargée ; hors précache et query string (sauf config.js),
  rien n'est intercepté ; `config.js` en réseau d'abord, jamais remis en cache ; installation : chaque fichier
  vérifié, nouvel essai avec `?v=<version>`, échec ⇒ installation abandonnée et cache supprimé.
- **404** : `404.html` n'utilise que des chemins absolus sous `/Recensia/` (script unique `/Recensia/404.js`,
  feuille de style, icône). `tools/check.mjs` [4] : `pagesBasePath(root)` → `'/Recensia/'` ou `'/'` si un fichier
  `CNAME` existe ; `projectPathOf(value, basePath)` → `{ ok, path } | { ok: false, reason: 'relative' | 'outside' }`.
- **Confidentialité** : `originScope(baseUrl)` → `{ origin, url, shared }` (privacy.js) ; avertissement « origine
  partagée » affiché quand l'application n'est pas à la racine de son origine.
