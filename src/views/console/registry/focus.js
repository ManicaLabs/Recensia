// Ouverture du registre depuis un autre onglet (tableau de bord, rapport…) sur un usage précis
// ou avec des filtres. Le hash est réservé au routeur : la demande est gardée en mémoire le temps
// de la navigation vers #/admin/<id>/registre, puis consommée par l'onglet Registre.

const MAX_AGE_MS = 60_000;
let pendingDetail = null;
let pendingFilters = null;

function take(request, campaignId, now) {
  if (!request || request.campaignId !== campaignId || now - request.at > MAX_AGE_MS) return null;
  return request.value;
}

/** Demande l'ouverture du détail de `usageKey` au prochain affichage du registre de la campagne. */
export function requestRegistryDetail(campaignId, usageKey) {
  pendingDetail = typeof campaignId === 'string' && typeof usageKey === 'string' && usageKey !== ''
    ? { campaignId, value: usageKey, at: Date.now() }
    : null;
}

/** Consomme la demande d'ouverture en attente pour cette campagne (null sinon, ou si elle est périmée). */
export function takeRegistryDetail(campaignId, now = Date.now()) {
  const request = pendingDetail;
  pendingDetail = null;
  return take(request, campaignId, now);
}

/**
 * Demande l'affichage du registre avec ces filtres (ex. { to_qualify: true }) ; les autres filtres
 * sont remis à zéro, le tri est conservé.
 */
export function requestRegistryFilters(campaignId, filters) {
  pendingFilters = typeof campaignId === 'string' && filters && typeof filters === 'object'
    ? { campaignId, value: { ...filters }, at: Date.now() }
    : null;
}

/** Consomme les filtres demandés pour cette campagne (null sinon). */
export function takeRegistryFilters(campaignId, now = Date.now()) {
  const request = pendingFilters;
  pendingFilters = null;
  return take(request, campaignId, now);
}
