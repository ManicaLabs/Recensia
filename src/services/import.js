// Pipeline d'import des codes de réponse (CDC §7.2, §7.5, §7.7 ; ARCHITECTURE §3.3, §4.2).
//
// Texte collé, fichiers ou lien d'import ⇒ extraction des codes ⇒ empreinte (doublon exact) ⇒
// déchiffrement avec la clé privée de la campagne ⇒ validation stricte (questionnaire, identité selon
// le mode) ⇒ déduplication par entry_id (le rev le plus élevé gagne) ⇒ écriture en une transaction.
//
// Module pur hors store : aucun accès au DOM, exécutable sous node --test avec
// openStore({ forceMemory: true }). Seule dépendance au navigateur : le rapport transmis d'une vue à
// l'autre passe par la session (src/ui/safe-storage.js, repli mémoire sous Node).

import { B64URL_RE, b64urlDecode } from '../crypto/b64url.js';
import {
  CODE_MAX_LENGTH, CODE_MIN_BYTES, CODE_PREFIX, CODE_VERSION, CodeError, codeHash, decryptEntry, extractCodes,
} from '../crypto/codes.js';
import { importPrivateKey } from '../crypto/keys.js';
import { validateRespondent, validateUsage } from '../engine/validate.js';
import { session } from '../ui/safe-storage.js';

/** Nombre maximal de codes traités par import (au-delà : ignorés et signalés). */
export const MAX_CODES_PER_IMPORT = 2000;
/** Taille maximale du texte analysé (caractères). */
export const MAX_TEXT_CHARS = 20 * 1024 * 1024;
/** Clé de session du rapport transmis à l'onglet Import (lien d'import, rechargement de l'onglet). */
export const REPORT_KEY = 'import_report';
/** Durée de validité d'un rapport transmis par la session. */
export const REPORT_TTL_MS = 30 * 60 * 1000;

const PREVIEW_HEAD = 14;
const PREVIEW_TAIL = 6;
// Issues qui laissent le code « en attente » : il peut encore servir (autre clé, mise à jour).
const UNRESOLVED = new Set(['other_campaign', 'unsupported_version', 'undecryptable']);

/**
 * Erreur d'import. code : 'no_store' (stockage indisponible) · 'no_key' (clé privée absente de ce
 * navigateur) · 'invalid_campaign' (campagne inutilisable) · 'too_large' (texte trop volumineux).
 */
export class ImportError extends Error {
  constructor(code, message) {
    super(message || IMPORT_MESSAGES[code] || 'Import impossible.');
    this.name = 'ImportError';
    this.code = code;
  }
}

const IMPORT_MESSAGES = {
  no_store: 'Stockage local indisponible.',
  no_key: 'La clé privée de cette campagne n’est pas dans ce navigateur.',
  invalid_campaign: 'Campagne invalide.',
  too_large: 'Texte trop volumineux.',
};

// --- Utilitaires purs --------------------------------------------------------

/** Aperçu d'un code pour l'affichage : début et fin seulement (« RCN1.AbCdEfGhI…xYz123 »). */
export function previewCode(code) {
  const s = String(code ?? '');
  if (s.length <= PREVIEW_HEAD + PREVIEW_TAIL + 1) return s;
  return `${s.slice(0, PREVIEW_HEAD)}…${s.slice(-PREVIEW_TAIL)}`;
}

const FUTURE_PREFIX_RE = /^RCN\d+\./;

/**
 * Contrôle de forme d'un code, SANS clé : longueur, préfixe, alphabet base64url strict, taille minimale,
 * octet de version (les contrôles que decryptEntry fait avant tout déchiffrement, dans le même ordre).
 * Un code qui échoue ici ne sera lisible par aucune clé : typiquement un lien coupé par la messagerie.
 * @param {unknown} code
 * @returns {null | 'format' | 'size' | 'version'} null : forme valide (le déchiffrement reste à tenter)
 */
export function codeFormatIssue(code) {
  if (typeof code !== 'string') return 'format';
  if (code.length > CODE_MAX_LENGTH) return 'size';
  if (!code.startsWith(CODE_PREFIX)) return FUTURE_PREFIX_RE.test(code) ? 'version' : 'format';
  const body = code.slice(CODE_PREFIX.length);
  if (!B64URL_RE.test(body)) return 'format';
  let bytes;
  try {
    bytes = b64urlDecode(body);
  } catch {
    return 'format';
  }
  if (bytes.length < CODE_MIN_BYTES) return 'format';
  return bytes[0] === CODE_VERSION ? null : 'version';
}

/**
 * Vrai si le code mérite d'être gardé en attente : forme valide, ou version plus récente du format
 * (lisible après une mise à jour). Un code tronqué ou mal formé ne le sera jamais : il n'est pas gardé.
 */
export function isKeepableCode(code) {
  const issue = codeFormatIssue(code);
  return issue === null || issue === 'version';
}

/**
 * Diagnostic de codes qu'aucune campagne de ce navigateur ne déchiffre (lien d'import, codes en attente) :
 * - 'version' : tous produits par une version plus récente du format (mettre l'application à jour) ;
 * - 'unreadable' : au moins une campagne locale a sa clé, ou aucun code n'a une forme valide : le lien a
 *   probablement été coupé par la messagerie (la clé n'est pas en cause) ;
 * - 'no_key' : codes bien formés et aucune clé de campagne dans ce navigateur.
 * @returns {'version' | 'unreadable' | 'no_key'}
 */
export function diagnoseUnmatched(codes, campaigns) {
  const issues = (Array.isArray(codes) ? codes : []).map(codeFormatIssue);
  if (issues.length > 0 && issues.every((issue) => issue === 'version')) return 'version';
  if ((campaigns ?? []).some(hasKey) || !issues.includes(null)) return 'unreadable';
  return 'no_key';
}

/**
 * Codes contenus dans un texte libre et/ou une liste (e-mails entiers, liens #/i/…, un code par ligne).
 * Dédoublonnés, ordre d'apparition conservé, plafonnés à MAX_CODES_PER_IMPORT.
 * @returns {{ codes: string[], over_limit: number }}
 */
export function collectCodes({ text, codes } = {}) {
  const parts = [];
  if (typeof text === 'string' && text !== '') {
    if (text.length > MAX_TEXT_CHARS) throw new ImportError('too_large');
    parts.push(text);
  }
  if (Array.isArray(codes)) {
    for (const c of codes) if (typeof c === 'string' && c !== '') parts.push(c);
  }
  const all = extractCodes(parts.join('\n'));
  return {
    codes: all.slice(0, MAX_CODES_PER_IMPORT),
    over_limit: Math.max(0, all.length - MAX_CODES_PER_IMPORT),
  };
}

const MIME_RE = /^(?:content-transfer-encoding|content-type|mime-version)\s*:/im;
const BASE64_HEADER_RE = /^content-transfer-encoding\s*:\s*base64\b/i;
const BASE64_LINE_RE = /^[A-Za-z0-9+/=]+$/;
const MAX_PART_HEADER_LINES = 50;

/**
 * Parties base64 d'un e-mail enregistré, décodées. Analyse ligne à ligne, en temps linéaire (une
 * expression régulière multi-lignes équivalente peut « exploser » en retours arrière sur un fichier reçu).
 */
function base64Parts(source) {
  const lines = source.split('\n').map((line) => line.trim());
  const parts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!BASE64_HEADER_RE.test(lines[i])) continue;
    // Autres en-têtes de la partie, jusqu'à la ligne vide qui précède le contenu.
    let j = i + 1;
    while (j < lines.length && lines[j] !== '' && j - i <= MAX_PART_HEADER_LINES) j += 1;
    if (j >= lines.length || lines[j] !== '') continue;
    j += 1;
    const chunk = [];
    while (j < lines.length && BASE64_LINE_RE.test(lines[j])) {
      chunk.push(lines[j]);
      j += 1;
    }
    if (chunk.length > 0) parts.push(decodeBase64Text(chunk.join('')));
    i = j - 1;
  }
  return parts;
}

function decodeBase64Text(b64) {
  try {
    const bin = globalThis.atob(b64.replace(/[\r\n]/g, ''));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Texte exploitable d'un fichier reçu. Un e-mail enregistré (.eml, source MIME) peut couper les codes
 * (quoted-printable : « = » en fin de ligne) ou les encoder (base64) : il est décodé avant l'extraction.
 * Les autres fichiers (.rcn, .txt) sont lus tels quels.
 * @param {string} name nom du fichier
 * @param {string} text contenu (UTF-8)
 * @returns {string}
 */
export function textFromFile(name, text) {
  const source = String(text ?? '');
  const isMail = /\.eml$/i.test(String(name ?? '')) || MIME_RE.test(source.slice(0, 4000));
  if (!isMail) return source;
  const unfolded = source
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => {
      const code = Number.parseInt(hex, 16);
      return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ' ';
    });
  return [unfolded, ...base64Parts(source)].join('\n');
}

/** Le service est-il obligatoire pour cette campagne ? (mode ouvert, ou exigé en anonyme) */
export function departmentRequired(campaign) {
  return campaign?.mode === 'open' || campaign?.settings?.department_required === true;
}

/**
 * Valide un clair déchiffré pour une campagne : usage (questionnaire), identité selon le mode.
 * Mode anonyme : aucune identité ni horodatage complet (sinon refus, jamais d'effacement silencieux).
 * Mode ouvert : répondant obligatoire et valide.
 * @returns {{ ok: true, usage, respondent, submitted_at } | { ok: false, reason, fields: string[] }}
 */
export function checkPlain(plain, campaign, questionnaire) {
  const mode = campaign?.mode;
  if (mode !== 'anonymous' && mode !== 'open') return { ok: false, reason: 'schema', fields: [] };
  let respondent = null;
  let submittedAt = null;
  if (mode === 'anonymous') {
    if (plain.respondent != null || plain.submitted_at != null) {
      return { ok: false, reason: 'identity_in_anonymous', fields: [] };
    }
  } else {
    const who = validateRespondent(plain.respondent, 'open');
    if (!who.ok) return { ok: false, reason: 'respondent_invalid', fields: fieldsOf(who.errors) };
    respondent = who.value;
    submittedAt = plain.submitted_at ?? null;
  }
  const check = validateUsage(plain.usage, questionnaire, {
    departments: Array.isArray(campaign.departments) ? campaign.departments : [],
    department_required: departmentRequired(campaign),
    mode,
  });
  if (!check.ok) return { ok: false, reason: 'usage_invalid', fields: fieldsOf(check.errors) };
  return { ok: true, usage: check.value, respondent, submitted_at: submittedAt };
}

function fieldsOf(errors) {
  return [...new Set((errors ?? []).map((e) => e.field).filter((f) => typeof f === 'string'))].slice(0, 10);
}

/** Vrai si le jour déclaré est postérieur à la date de clôture indicative. */
export function isAfterClose(submittedDay, closesOn) {
  return typeof closesOn === 'string' && closesOn !== '' && typeof submittedDay === 'string' && submittedDay > closesOn;
}

/**
 * Déduplication et révisions (pur). candidates : [{ code, hash, plain, usage, respondent, submitted_at }]
 * déjà déchiffrés et validés ; existing : entrées déjà stockées pour la campagne.
 * Même entry_id : le rev le plus élevé l'emporte, quel que soit l'ordre d'arrivée des codes ; les autres
 * sont des doublons (version déjà stockée, plus ancienne, ou reçue plusieurs fois dans le lot).
 * Une révision conserve excluded et group_override de l'entrée remplacée.
 * @returns {{ writes: object[], accepted, revised, duplicates, after_close, outcomes }}
 */
export function planImport(candidates, existing, campaign, { importedAt = new Date().toISOString() } = {}) {
  const stored = new Map();
  for (const e of existing ?? []) if (e && typeof e.entry_id === 'string') stored.set(e.entry_id, e);
  const closesOn = campaign?.settings?.closes_on ?? null;

  // Version retenue dans ce lot pour chaque entry_id : le rev le plus élevé, la première arrivée à égalité.
  // (Pas de tri : un comparateur mêlant ordre d'arrivée et rev n'est pas transitif.)
  const best = new Map();
  for (const c of candidates) {
    const current = best.get(c.plain.entry_id);
    if (!current || c.plain.rev > current.plain.rev) best.set(c.plain.entry_id, c);
  }

  const out = { writes: [], accepted: [], revised: [], duplicates: [], after_close: [], outcomes: [] };
  for (const c of candidates) {
    const { plain } = c;
    const preview = previewCode(c.code);
    const name = c.usage?.usage_name ?? null;
    const previous = stored.get(plain.entry_id) ?? null;
    if (previous && plain.rev <= previous.rev) {
      out.duplicates.push({
        preview, reason: plain.rev === previous.rev ? 'same_rev' : 'older_rev', entry_id: plain.entry_id, rev: plain.rev, usage_name: name,
      });
      out.outcomes.push({ code: c.code, status: 'duplicate' });
      continue;
    }
    const winner = best.get(plain.entry_id);
    if (winner !== c) {
      out.duplicates.push({
        preview, reason: plain.rev < winner.plain.rev ? 'obsolete' : 'repeated', entry_id: plain.entry_id, rev: plain.rev, usage_name: name,
      });
      out.outcomes.push({ code: c.code, status: 'duplicate' });
      continue;
    }
    const afterClose = isAfterClose(plain.submitted_day, closesOn);
    out.writes.push({
      campaign_id: campaign.id,
      entry_id: plain.entry_id,
      rev: plain.rev,
      submitted_day: plain.submitted_day,
      submitted_at: c.submitted_at ?? null,
      respondent: c.respondent ?? null,
      usage: c.usage,
      schema_version: plain.sv,
      code_hash: c.hash,
      source: 'code',
      imported_at: importedAt,
      after_close: afterClose,
      excluded: previous?.excluded === true,
      group_override: typeof previous?.group_override === 'string' ? previous.group_override : null,
    });
    const item = { preview, entry_id: plain.entry_id, rev: plain.rev, usage_name: name, after_close: afterClose };
    if (previous) {
      out.revised.push({ ...item, previous_rev: previous.rev });
      out.outcomes.push({ code: c.code, status: 'revised' });
    } else {
      out.accepted.push(item);
      out.outcomes.push({ code: c.code, status: 'accepted' });
    }
    if (afterClose) out.after_close.push({ preview, entry_id: plain.entry_id, usage_name: name, submitted_day: plain.submitted_day });
  }
  return out;
}

/**
 * Recalcule after_close des entrées issues de codes après un changement de date de clôture (pur).
 * Les saisies directes et la démo ne sont pas concernées.
 * @returns {object[]} entrées modifiées (copies)
 */
export function recomputeAfterClose(entries, closesOn) {
  const changed = [];
  for (const e of entries ?? []) {
    if (e?.source !== 'code') continue;
    const next = isAfterClose(e.submitted_day, closesOn);
    if ((e.after_close === true) !== next) changed.push({ ...e, after_close: next });
  }
  return changed;
}

/** Rapport vide (forme stable). */
export function emptyReport(campaign) {
  return {
    campaign_id: campaign?.id ?? null,
    imported_at: null,
    total: 0,
    over_limit: 0,
    written: 0,
    accepted: [],
    revised: [],
    duplicates: [],
    invalid: [],
    other_campaign: [],
    after_close: [],
    unsupported_version: [],
    outcomes: [],
  };
}

/** Copie du rapport sans les codes eux-mêmes (affichage, transmission par la session). */
export function publicReport(report) {
  if (!report || typeof report !== 'object') return null;
  const { outcomes, ...rest } = report;
  return JSON.parse(JSON.stringify(rest));
}

/** Codes définitivement traités (acceptés, révisés, doublons, invalides) : à retirer des codes en attente. */
export function resolvedCodes(report) {
  return (report?.outcomes ?? []).filter((o) => !UNRESOLVED.has(o.status)).map((o) => o.code);
}

/** Codes appartenant à une autre campagne locale : à garder en attente pour son onglet Import. */
export function otherCampaignCodes(report) {
  return (report?.outcomes ?? []).filter((o) => o.status === 'other_campaign').map((o) => o.code);
}

/** Résumé chiffré d'un rapport (annonces, bandeaux). */
export function reportCounts(report) {
  const n = (k) => (Array.isArray(report?.[k]) ? report[k].length : 0);
  return {
    total: report?.total ?? 0,
    accepted: n('accepted'),
    revised: n('revised'),
    duplicates: n('duplicates'),
    invalid: n('invalid'),
    other_campaign: n('other_campaign'),
    after_close: n('after_close'),
    unsupported_version: n('unsupported_version'),
  };
}

// --- Clés privées ------------------------------------------------------------

function hasKey(campaign) {
  return Boolean(campaign && campaign.private_key_jwk && typeof campaign.id === 'string');
}

/** Cache de clés importées (importPrivateKey une seule fois par campagne). */
function keyCache() {
  const cache = new Map();
  return async (campaign) => {
    if (!cache.has(campaign.id)) {
      cache.set(campaign.id, importPrivateKey(campaign.private_key_jwk).catch(() => null));
    }
    return cache.get(campaign.id);
  };
}

// Le déchiffrement a abouti (clair lisible, éventuellement invalide) : le code appartient à la campagne.
const OPENED_REASONS = new Set(['schema', 'campaign']);

async function tryOpen(code, key, campaignId) {
  if (!key) return { opened: false, reason: 'decrypt' };
  try {
    return { opened: true, plain: await decryptEntry(code, key, campaignId) };
  } catch (err) {
    if (err instanceof CodeError) return { opened: OPENED_REASONS.has(err.reason), reason: err.reason };
    return { opened: false, reason: 'decrypt' };
  }
}

/**
 * Répartit des codes entre les campagnes locales dont la clé les déchiffre.
 * @returns {Promise<{ byCampaign: Map<string, string[]>, unmatched: string[] }>}
 */
export async function sortCodesByCampaign(codes, campaigns) {
  const withKey = (campaigns ?? []).filter(hasKey);
  const getKey = keyCache();
  const byCampaign = new Map();
  const unmatched = [];
  for (const code of codes ?? []) {
    let owner = null;
    for (const c of withKey) {
      // eslint-disable-next-line no-await-in-loop
      const res = await tryOpen(code, await getKey(c), c.id);
      if (res.opened) { owner = c; break; }
      if (res.reason === 'format' || res.reason === 'version' || res.reason === 'size') break;
    }
    if (owner) {
      if (!byCampaign.has(owner.id)) byCampaign.set(owner.id, []);
      byCampaign.get(owner.id).push(code);
    } else {
      unmatched.push(code);
    }
  }
  return { byCampaign, unmatched };
}

/** Codes (parmi `codes`) que la clé de `campaign` déchiffre. */
export async function codesForCampaign(codes, campaign) {
  if (!hasKey(campaign) || !Array.isArray(codes) || codes.length === 0) return [];
  const { byCampaign } = await sortCodesByCampaign(codes, [campaign]);
  return byCampaign.get(campaign.id) ?? [];
}

/**
 * Campagne locale qui déchiffre le plus de codes (lien d'import, codes en attente).
 * @returns {Promise<{ campaign: object, codes: string[] } | null>}
 */
export async function findCampaignForCodes(codes, campaigns) {
  const { byCampaign } = await sortCodesByCampaign(codes, campaigns);
  let best = null;
  for (const c of campaigns ?? []) {
    const list = byCampaign.get(c.id);
    if (list && (!best || list.length > best.codes.length)) best = { campaign: c, codes: list };
  }
  return best;
}

// --- Import --------------------------------------------------------------------

/**
 * Importe des codes dans une campagne.
 * @param {object} args
 * @param {string} [args.text] texte libre (e-mails, liens d'import, codes)
 * @param {string[]} [args.codes] codes ou liens
 * @param {object} args.campaign campagne cible (relue depuis le store, avec private_key_jwk)
 * @param {object[]} [args.campaigns] campagnes locales (détection « autre campagne ») ; par défaut store.listCampaigns()
 * @param {object} args.store store ouvert
 * @param {object} args.questionnaire data/questionnaire.json
 * @param {string} [args.today] accepté pour compatibilité (la clôture se compare au jour déclaré)
 * @param {Date|string} [args.now] horodatage d'import
 * @returns {Promise<object>} rapport { campaign_id, imported_at, total, over_limit, written, accepted, revised,
 *   duplicates, invalid: [{ preview, reason, fields? }], other_campaign: [{ campaign_id, title, preview }],
 *   after_close, unsupported_version: [{ preview }], outcomes: [{ code, status }] }
 * @throws {ImportError}
 */
export async function importCodes({ text, codes, campaign, campaigns, store, questionnaire, now = new Date() } = {}) {
  if (!store) throw new ImportError('no_store');
  if (!campaign || typeof campaign.id !== 'string') throw new ImportError('invalid_campaign');
  if (!hasKey(campaign)) throw new ImportError('no_key');
  const importedAt = (now instanceof Date ? now : new Date(now)).toISOString();

  const { codes: list, over_limit: overLimit } = collectCodes({ text, codes });
  const report = emptyReport(campaign);
  report.imported_at = importedAt;
  report.total = list.length;
  report.over_limit = overLimit;
  if (list.length === 0) return report;

  const getKey = keyCache();
  const targetKey = await getKey(campaign);
  if (!targetKey) throw new ImportError('no_key');

  const existing = await store.listEntries(campaign.id);
  const knownHashes = new Set(existing.map((e) => e.code_hash).filter(Boolean));
  const others = (Array.isArray(campaigns) ? campaigns : await store.listCampaigns())
    .filter((c) => hasKey(c) && c.id !== campaign.id);

  const candidates = [];
  for (const code of list) {
    const preview = previewCode(code);
    // eslint-disable-next-line no-await-in-loop
    const hash = await codeHash(code);
    if (knownHashes.has(hash)) {
      report.duplicates.push({ preview, reason: 'already_imported' });
      report.outcomes.push({ code, status: 'duplicate' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const res = await tryOpen(code, targetKey, campaign.id);
    if (!res.opened) {
      if (res.reason === 'version') {
        report.unsupported_version.push({ preview });
        report.outcomes.push({ code, status: 'unsupported_version' });
        continue;
      }
      if (res.reason === 'decrypt') {
        let owner = null;
        for (const c of others) {
          // eslint-disable-next-line no-await-in-loop
          const probe = await tryOpen(code, await getKey(c), c.id);
          if (probe.opened) { owner = c; break; }
        }
        if (owner) {
          report.other_campaign.push({ campaign_id: owner.id, title: owner.title ?? '', preview });
          report.outcomes.push({ code, status: 'other_campaign' });
        } else {
          report.invalid.push({ preview, reason: 'decrypt' });
          report.outcomes.push({ code, status: 'undecryptable' });
        }
        continue;
      }
      report.invalid.push({ preview, reason: res.reason === 'size' ? 'size' : 'format' });
      report.outcomes.push({ code, status: 'invalid' });
      continue;
    }
    if (!res.plain) {
      // Déchiffré mais structure refusée (schema / campaign).
      report.invalid.push({ preview, reason: res.reason === 'campaign' ? 'campaign' : 'schema' });
      report.outcomes.push({ code, status: 'invalid' });
      continue;
    }
    const check = checkPlain(res.plain, campaign, questionnaire);
    if (!check.ok) {
      report.invalid.push({ preview, reason: check.reason, fields: check.fields });
      report.outcomes.push({ code, status: 'invalid' });
      continue;
    }
    knownHashes.add(hash);
    candidates.push({ code, hash, plain: res.plain, usage: check.usage, respondent: check.respondent, submitted_at: check.submitted_at });
  }

  const plan = planImport(candidates, existing, campaign, { importedAt });
  if (plan.writes.length > 0) await store.putEntries(plan.writes);
  report.written = plan.writes.length;
  report.accepted = plan.accepted;
  report.revised = plan.revised;
  report.duplicates.push(...plan.duplicates);
  report.after_close = plan.after_close;
  report.outcomes.push(...plan.outcomes);
  return report;
}

// --- Transmission du rapport par la session --------------------------------------

/** Garde le rapport (sans les codes) pour l'onglet Import de sa campagne. */
export function stashReport(report, { area = session, now = Date.now() } = {}) {
  const pub = publicReport(report);
  if (!pub || !pub.campaign_id) return false;
  return area.set(REPORT_KEY, { at: now, report: pub });
}

/** Reprend (et efface) le rapport transmis pour cette campagne ; null s'il n'y en a pas ou s'il est périmé. */
export function takeReport(campaignId, { area = session, now = Date.now() } = {}) {
  const saved = area.get(REPORT_KEY, null);
  if (!saved || typeof saved !== 'object' || !saved.report || saved.report.campaign_id !== campaignId) return null;
  area.remove(REPORT_KEY);
  if (typeof saved.at !== 'number' || now - saved.at > REPORT_TTL_MS) return null;
  return saved.report;
}
