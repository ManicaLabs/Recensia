// Données synthétiques pour les tests du stockage et des exports (aucune donnée réelle).

// Utilisable sous Node et dans le navigateur (scénarios partagés).
function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Paire de clés P-256 au format du contrat (clé publique brute en base64url, JWK privé). */
export async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    public_key: b64url(raw),
    private_key_jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
  };
}

export function makeCampaign(id, keys, overrides = {}) {
  return {
    id,
    title: 'Recensement IA 2026',
    org_name: 'Menuiserie Alpine Concept',
    mode: 'anonymous',
    departments: ['Direction', 'Commercial et devis', 'RH'],
    settings: {
      min_group_size: 5,
      department_required: false,
      comments_exportable: false,
      closes_on: '2026-10-31',
      group_by_department: false,
      channels: [{ type: 'mailto', target: 'ia@exemple.fr' }],
    },
    public_key: keys ? keys.public_key : null,
    private_key_jwk: keys ? keys.private_key_jwk : null,
    fingerprint: 'A1B2C3D4',
    created_at: '2026-09-01T08:00:00.000Z',
    demo: false,
    last_backup_at: null,
    recovery_saved_at: null,
    ...overrides,
  };
}

export function makeUsage(overrides = {}) {
  return {
    usage_name: 'Reformulation de mails',
    department: 'Commercial et devis',
    tool: 'chatgpt',
    tool_other: null,
    model: null,
    account_type: 'personal_free',
    task_types: ['redaction'],
    business_domain: 'commercial_devis',
    data_types: ['docs_internes'],
    frequency: 'daily',
    users_count: '2-5',
    output_audience: 'internal_only',
    output_review: 'systematic',
    affects_people: 'no',
    direct_interaction: 'no',
    biometric_emotion: 'no',
    built_or_customized: 'use_as_is',
    status: 'in_use',
    comment: null,
    ...overrides,
  };
}

export function makeEntry(campaignId, entryId, overrides = {}) {
  return {
    campaign_id: campaignId,
    entry_id: entryId,
    rev: 1,
    submitted_day: '2026-09-15',
    submitted_at: null,
    respondent: null,
    usage: makeUsage(),
    schema_version: 1,
    code_hash: null,
    source: 'manual',
    imported_at: '2026-09-15T10:00:00.000Z',
    after_close: false,
    excluded: false,
    group_override: null,
    ...overrides,
  };
}

export function makeAssessment(campaignId, usageKey, overrides = {}) {
  return {
    campaign_id: campaignId,
    usage_key: usageKey,
    override_ai_act_level: null,
    override_data_level: null,
    justification: '',
    owner: '',
    validation_status: 'to_review',
    history: [],
    updated_at: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

export function makeAction(campaignId, id, overrides = {}) {
  return {
    id,
    campaign_id: campaignId,
    usage_key: null,
    template_id: 'ACT-LIT-01',
    title: 'Former les équipes',
    description: 'Sensibilisation à la littératie IA (art. 4).',
    owner: '',
    due_date: null,
    priority: 'medium',
    status: 'todo',
    suggested: true,
    suggested_role: 'Direction',
    created_at: '2026-09-16T10:00:00.000Z',
    updated_at: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

/** Remplit un store avec une campagne complète ; renvoie la campagne insérée. */
export async function seedCampaign(store, id, keys, { entries = 3, withAssessment = true, actions = 2 } = {}) {
  const campaign = makeCampaign(id, keys);
  await store.putCampaign(campaign);
  const list = [];
  for (let i = 0; i < entries; i++) list.push(makeEntry(id, `e${String(i).padStart(3, '0')}`));
  await store.putEntries(list);
  if (withAssessment) await store.putAssessment(makeAssessment(id, 'chatgpt|redaction|commercial_devis'));
  const acts = [];
  for (let i = 0; i < actions; i++) acts.push(makeAction(id, `${id}-act-${i}`));
  await store.putActions(acts);
  return campaign;
}
