// Entrée saisie directement par le responsable (onglet « Saisir » de la console, ARCHITECTURE §3.3).
// Mode ouvert : déclarant facultatif (prénom et nom), horodatage complet. Mode anonyme : aucun
// déclarant, date au jour. Module pur.

import { SCHEMA_VERSION, validateRespondent } from '../../engine/validate.js';
import { localDay } from './codes.js';

/**
 * Déclarant saisi par le responsable. Anonyme : toujours null. Ouvert : null si les deux champs
 * sont vides, sinon validé par validateRespondent (prénom et nom requis ensemble).
 * @returns {{ ok: boolean, value: object|null, errors: { field, code }[] }}
 */
export function declarantFrom({ first_name = '', last_name = '' } = {}, mode) {
  if (mode !== 'open') return { ok: true, value: null, errors: [] };
  const first = typeof first_name === 'string' ? first_name.trim() : '';
  const last = typeof last_name === 'string' ? last_name.trim() : '';
  if (first === '' && last === '') return { ok: true, value: null, errors: [] };
  const result = validateRespondent({ first_name: first, last_name: last }, 'open');
  return { ok: result.ok, value: result.ok ? { ...result.value, email: null } : null, errors: result.errors };
}

/**
 * Entrée §3.3 pour un usage validé.
 * @param {{ campaign: object, usage: object, respondent?: object|null, now?: Date, entryId: string }} input
 */
export function buildManualEntry({ campaign, usage, respondent = null, now = new Date(), entryId }) {
  const open = campaign?.mode === 'open';
  const iso = now.toISOString();
  return {
    campaign_id: campaign.id,
    entry_id: entryId,
    rev: 1,
    submitted_day: localDay(now),
    submitted_at: open ? iso : null,
    respondent: open && respondent ? { first_name: respondent.first_name, last_name: respondent.last_name, email: respondent.email ?? null } : null,
    usage,
    schema_version: SCHEMA_VERSION,
    code_hash: null,
    source: 'manual',
    imported_at: iso,
    after_close: false,
    excluded: false,
    group_override: null,
  };
}
