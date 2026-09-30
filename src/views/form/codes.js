// Construction du clair d'un code de réponse (CDC §7.2, §7.4 ; ARCHITECTURE §4.2) et génération
// des codes d'un brouillon. Mode anonyme : ni identité ni horodatage complet, la date est au jour.
// Mode ouvert : prénom, nom, e-mail facultatif et horodatage ISO complet.
//
// Module pur : le chiffrement (encryptEntry) est injectable pour les tests.

import { SCHEMA_VERSION } from '../../engine/validate.js';
import { encryptEntry, PLAIN_VERSION } from '../../crypto/codes.js';
import { canonicalContent, markCoded, revisionFor } from './draft.js';

/** Jour local AAAA-MM-JJ (fuseau de l'appareil). */
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Campagne clôturée ? (date de clôture indicative passée ; le jour même reste ouvert). */
export function isClosed(closes, today) {
  return typeof closes === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(closes)
    && typeof today === 'string' && today > closes;
}

/**
 * Clair d'un code.
 * @param {{ config: { id: string, mode: 'anonymous'|'open' }, entryId: string, rev: number,
 *   usage: object, respondent?: { first_name, last_name, email }|null, now?: Date }} input
 * @returns {object} { v, sv, campaign_id, entry_id, rev, submitted_day, [submitted_at, respondent], usage }
 */
export function buildPlain({ config, entryId, rev, usage, respondent = null, now = new Date() }) {
  if (!config || (config.mode !== 'anonymous' && config.mode !== 'open')) throw new TypeError('buildPlain : mode de campagne inconnu.');
  const plain = {
    v: PLAIN_VERSION,
    sv: SCHEMA_VERSION,
    campaign_id: config.id,
    entry_id: entryId,
    rev,
    submitted_day: localDay(now),
  };
  if (config.mode === 'open') {
    if (!respondent || typeof respondent.first_name !== 'string' || typeof respondent.last_name !== 'string') {
      throw new TypeError('buildPlain : identité requise en mode ouvert.');
    }
    plain.submitted_at = now.toISOString();
    plain.respondent = {
      first_name: respondent.first_name,
      last_name: respondent.last_name,
      email: typeof respondent.email === 'string' && respondent.email !== '' ? respondent.email : null,
    };
  }
  plain.usage = usage;
  return plain;
}

/**
 * Produit (ou réutilise) un code pour chaque usage du brouillon.
 * Les usages doivent avoir été validés : `usages` associe entry_id → usage normalisé.
 * @param {{ config, draft, usages: Map<string, object>, respondent: object|null, now?: Date,
 *   encrypt?: (plain, pk, id) => Promise<string>, onCode?: (info) => void }} input
 * @returns {Promise<{ draft: object, codes: { entry_id, rev, code, fresh: boolean }[], generated: number }>}
 */
export async function generateCodes({ config, draft, usages, respondent = null, now = new Date(), encrypt = encryptEntry, onCode }) {
  const who = config.mode === 'open' ? respondent : null;
  let next = draft;
  const codes = [];
  let generated = 0;
  for (const item of draft.items) {
    const usage = usages.get(item.entry_id) ?? item.usage;
    const current = { ...item, usage };
    const { rev, reuse } = revisionFor(current, who);
    if (reuse) {
      codes.push({ entry_id: item.entry_id, rev, code: item.coded.code, fresh: false });
      continue;
    }
    const plain = buildPlain({ config, entryId: item.entry_id, rev, usage, respondent: who, now });
    const code = await encrypt(plain, config.pk, config.id);
    next = markCoded(next, item.entry_id, { rev, content: canonicalContent(usage, who), code, usage });
    generated += 1;
    codes.push({ entry_id: item.entry_id, rev, code, fresh: true });
    if (typeof onCode === 'function') onCode({ entry_id: item.entry_id, rev });
  }
  return { draft: next, codes, generated };
}
