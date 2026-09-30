// Jeu de démonstration (CDC §4 « Parcours démo », annexe A) : PME fictive chargée dans le store local.
// buildDemoRecords() est pur (aucun accès au store ni au DOM) ; loadDemo() écrit dans le store.
// Les données de data/demo-company.json sont partagées par le cache de ctx.data : elles sont
// copiées, jamais modifiées.

import { SCHEMA_VERSION } from '../engine/validate.js';
import { generateCampaignKeys } from '../crypto/keys.js';

/** Identifiant fixe de la campagne de démonstration. */
export const DEMO_ID = 'demo';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isoOf(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('buildDemoRecords : date « now » invalide.');
  return date.toISOString();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------------------------
// Dates relatives : le jeu de démonstration est daté (data/demo-company.json). Pour qu'il reste
// vraisemblable quel que soit le jour du chargement (échéances à venir, campagne non clôturée),
// toutes ses dates sont décalées d'un même nombre de jours entiers : la plus récente des dates
// d'événements (création, réponses, imports, mises à jour) tombe dans les 24 heures qui précèdent
// `now`. Les écarts entre dates sont conservés et le résultat ne dépend que de `now`.
// Les dates réglementaires (data/regulatory-calendar.json) ne sont jamais décalées.
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86400000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayMs(value) {
  const m = typeof value === 'string' ? DAY_RE.exec(value) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
}

function isoMs(value) {
  return isIso(value) ? Date.parse(value) : null;
}

/** Jour AAAA-MM-JJ décalé de `days` jours (valeur invalide ou absente : inchangée). */
export function shiftDay(value, days) {
  const ms = dayMs(value);
  if (ms === null || !days) return value;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Horodatage ISO décalé de `days` jours (valeur invalide ou absente : inchangée). */
export function shiftIso(value, days) {
  const ms = isoMs(value);
  if (ms === null || !days) return value;
  return new Date(ms + days * DAY_MS).toISOString();
}

/**
 * Date de référence du jeu : la plus récente des dates d'événements passés (création de la
 * campagne, réponses, imports, créations et mises à jour d'actions, évaluations), en ms.
 * Les dates à venir (échéances d'actions, clôture indicative) n'en font pas partie.
 * → nombre (ms) ou null si le jeu n'est pas daté.
 */
export function demoReferenceTime(demoData) {
  const times = [isoMs(demoData?.campaign?.created_at)];
  for (const e of list(demoData?.entries)) times.push(dayMs(e?.submitted_day), isoMs(e?.submitted_at), isoMs(e?.imported_at));
  for (const a of list(demoData?.actions)) times.push(isoMs(a?.created_at), isoMs(a?.updated_at));
  for (const a of list(demoData?.assessments)) {
    times.push(isoMs(a?.updated_at));
    for (const item of list(a?.history)) times.push(isoMs(item?.at));
  }
  const valid = times.filter((ms) => ms !== null);
  return valid.length ? Math.max(...valid) : null;
}

/**
 * Décalage (en jours entiers, éventuellement négatif) à appliquer aux dates du jeu pour que la
 * date de référence tombe dans les 24 heures qui précèdent `now`. 0 si le jeu n'est pas daté.
 */
export function demoDayShift(demoData, now = new Date()) {
  const ref = demoReferenceTime(demoData);
  if (ref === null) return 0;
  const nowMs = Date.parse(isoOf(now));
  return Math.floor((nowMs - ref) / DAY_MS);
}

/**
 * Enregistrements de la démo, prêts pour le store (ARCHITECTURE §3.2 à §3.5).
 * Les dates du jeu sont décalées relativement à `now` (voir demoDayShift) : le même `now`
 * donne toujours les mêmes enregistrements.
 * @param {object} demoData contenu de data/demo-company.json
 * @param {{ publicKeyB64: string, privateKeyJwk: object, fingerprint: string } | null} keys
 *   paire de clés de campagne (generateCampaignKeys) ; null ⇒ campagne sans clé (formulaire indisponible)
 * @param {Date|string|number} [now] horodatage de chargement
 * @returns {{ campaign: object, entries: object[], actions: object[], assessments: object[], shift_days: number }}
 */
export function buildDemoRecords(demoData, keys, now = new Date()) {
  if (!demoData || typeof demoData !== 'object' || !demoData.campaign || typeof demoData.campaign !== 'object') {
    throw new TypeError('buildDemoRecords : données de démonstration invalides (campagne absente).');
  }
  const at = isoOf(now);
  const shift = demoDayShift(demoData, now);
  const day = (value) => shiftDay(value, shift);
  const iso = (value) => shiftIso(value, shift);
  const source = clone(demoData.campaign);
  const settings = { ...(source.settings ?? {}) };
  if (dayMs(settings.closes_on) !== null) settings.closes_on = day(settings.closes_on);

  const campaign = {
    ...source,
    id: DEMO_ID,
    title: String(source.title ?? ''),
    org_name: String(source.org_name ?? demoData.company?.name ?? ''),
    mode: source.mode === 'open' ? 'open' : 'anonymous',
    departments: list(source.departments).map(String),
    settings,
    public_key: keys?.publicKeyB64 ?? null,
    private_key_jwk: keys?.privateKeyJwk ? clone(keys.privateKeyJwk) : null,
    fingerprint: keys?.fingerprint ?? null,
    created_at: isIso(source.created_at) ? iso(source.created_at) : at,
    demo: true,
    last_backup_at: null,
    recovery_saved_at: null,
  };

  const entries = list(demoData.entries).map((raw) => {
    const e = clone(raw);
    return {
      ...e,
      campaign_id: DEMO_ID,
      entry_id: String(e.entry_id),
      rev: Number.isInteger(e.rev) && e.rev > 0 ? e.rev : 1,
      submitted_day: day(e.submitted_day),
      submitted_at: isIso(e.submitted_at) ? iso(e.submitted_at) : null,
      // Mode anonyme : aucune identité, quelles que soient les données fournies.
      respondent: campaign.mode === 'anonymous' ? null : (e.respondent ?? null),
      usage: e.usage,
      schema_version: Number.isInteger(e.schema_version) ? e.schema_version : SCHEMA_VERSION,
      code_hash: null,
      source: 'demo',
      imported_at: isIso(e.imported_at) ? iso(e.imported_at) : at,
      after_close: e.after_close === true,
      excluded: e.excluded === true,
      group_override: typeof e.group_override === 'string' && e.group_override !== '' ? e.group_override : null,
    };
  });

  const actions = list(demoData.actions).map((raw) => {
    const a = clone(raw);
    const created = isIso(a.created_at) ? iso(a.created_at) : at;
    return {
      ...a,
      id: String(a.id),
      campaign_id: DEMO_ID,
      usage_key: typeof a.usage_key === 'string' && a.usage_key !== '' ? a.usage_key : null,
      template_id: typeof a.template_id === 'string' && a.template_id !== '' ? a.template_id : null,
      title: String(a.title ?? ''),
      description: String(a.description ?? ''),
      owner: typeof a.owner === 'string' ? a.owner : '',
      due_date: dayMs(a.due_date) !== null ? day(a.due_date) : null,
      priority: a.priority ?? 'medium',
      status: a.status ?? 'todo',
      suggested: a.suggested === true,
      suggested_role: a.suggested_role ?? null,
      created_at: created,
      updated_at: isIso(a.updated_at) ? iso(a.updated_at) : created,
    };
  });

  const assessments = list(demoData.assessments).map((raw) => {
    const a = clone(raw);
    return {
      ...a,
      campaign_id: DEMO_ID,
      override_ai_act_level: a.override_ai_act_level ?? null,
      override_data_level: a.override_data_level ?? null,
      justification: typeof a.justification === 'string' ? a.justification : '',
      owner: typeof a.owner === 'string' ? a.owner : '',
      validation_status: a.validation_status ?? 'to_review',
      history: list(a.history).map((item) => (item && typeof item === 'object' ? { ...item, at: iso(item.at) } : item)),
      updated_at: isIso(a.updated_at) ? iso(a.updated_at) : at,
    };
  });

  return { campaign, entries, actions, assessments, shift_days: shift };
}

async function demoJson(data) {
  if (data && typeof data.get === 'function') return data.get('demo-company');
  return data;
}

/**
 * Charge la démo dans le store. Sans reset, une démo déjà présente est laissée telle quelle.
 * Avec reset, la démo existante (entrées, évaluations, actions comprises) est supprimée puis
 * rechargée à l'identique : l'opération est idempotente. Les données et les clés sont préparées
 * AVANT la suppression : si elles sont indisponibles (hors ligne sans cache…), la démo existante
 * est conservée.
 * @param {object} store store ouvert (openStore)
 * @param {object} data ctx.data (chargeur avec get()) ou contenu de data/demo-company.json
 * @param {{ reset?: boolean, now?: Date, keys?: object }} [options] keys : paire imposée (tests)
 * @returns {Promise<{ loaded: boolean, campaign: object, counts: { entries: number, actions: number, assessments: number } }>}
 */
export async function loadDemo(store, data, { reset = false, now = new Date(), keys } = {}) {
  if (!store) throw new TypeError('loadDemo : stockage indisponible.');
  if (!reset) {
    const existing = await store.getCampaign(DEMO_ID);
    if (existing) return { loaded: false, campaign: existing, counts: null };
  }

  const json = await demoJson(data);
  const records = buildDemoRecords(json, keys ?? await generateCampaignKeys(), now);
  if (reset) await store.deleteCampaign(DEMO_ID);
  try {
    // La campagne est écrite en dernier : sa présence signale une démo complète.
    if (records.entries.length) await store.putEntries(records.entries);
    if (records.actions.length) await store.putActions(records.actions);
    for (const assessment of records.assessments) await store.putAssessment(assessment);
    await store.putCampaign(records.campaign);
  } catch (err) {
    try {
      await store.deleteCampaign(DEMO_ID);
    } catch {
      // Nettoyage impossible : l'erreur d'origine est la plus utile.
    }
    throw err;
  }
  return {
    loaded: true,
    campaign: records.campaign,
    counts: { entries: records.entries.length, actions: records.actions.length, assessments: records.assessments.length },
  };
}
