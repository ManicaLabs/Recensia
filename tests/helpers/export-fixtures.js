// Données synthétiques pour les tests des exports : questionnaire, traductions, règles,
// calendrier et groupes au format de consolidate() (ARCHITECTURE §4.1). Aucune donnée réelle.

const opts = (pairs) => ({ options: pairs.map(([value, label]) => ({ value, label })) });

export const questionnaire = {
  schema_version: 1,
  fields: {
    tool: opts([['chatgpt', 'ChatGPT'], ['embedded_software_ai', 'IA intégrée à un logiciel'], ['other', 'Autre'], ['midjourney', 'Midjourney']]),
    account_type: opts([['enterprise_provided', 'Compte fourni par l’entreprise'], ['personal_free', 'Compte personnel gratuit']]),
    task_types: opts([['evaluation_tri_personnes', 'Évaluation ou tri de personnes'], ['redaction', 'Rédaction'], ['generation_media', 'Génération d’images, audio ou vidéo']]),
    business_domain: opts([['rh', 'Ressources humaines'], ['commercial_devis', 'Commercial et devis'], ['marketing_com', 'Marketing et communication']]),
    data_types: opts([['donnees_candidats', 'Données de candidats'], ['docs_internes', 'Documents internes'], ['aucune', 'Aucune']]),
    frequency: opts([['weekly', 'Chaque semaine'], ['daily', 'Chaque jour']]),
    users_count: opts([['1', 'Moi seul'], ['2-5', '2 à 5'], ['6-15', '6 à 15'], ['>15', 'Plus de 15']]),
  },
};

const dict = {
  'common.levels.ai_act.prohibited_suspected': 'Interdit suspecté',
  'common.levels.ai_act.high': 'Haut risque',
  'common.levels.ai_act.to_qualify': 'À qualifier',
  'common.levels.ai_act.limited': 'Limité',
  'common.levels.ai_act.minimal': 'Minimal',
  'common.levels.data.0': 'Faible',
  'common.levels.data.1': 'Modéré',
  'common.levels.data.2': 'Élevé',
  'common.levels.data.3': 'Critique',
  'common.validation.to_review': 'À valider',
  'common.validation.validated': 'Validé',
  'common.validation.to_revise': 'À revoir',
  'common.action_status.todo': 'À faire',
  'common.action_status.in_progress': 'En cours',
  'common.action_status.done': 'Fait',
  'common.action_status.rejected': 'Rejeté',
  'common.priority.high': 'Haute',
  'common.priority.medium': 'Moyenne',
  'common.priority.low': 'Basse',
  'common.disclaimer': 'Classification indicative, à confirmer.',
};

/** Traduction factice : renvoie la clé si elle est inconnue (comme src/i18n.js). */
export function t(key) {
  return dict[key] ?? key;
}

export const rules = {
  version: '2026-09-15',
  rules: [
    { id: 'R-AIA-HI-EMP', axis: 'ai_act', kind: 'level', level: 'high', label: 'Emploi et gestion des travailleurs', legal_ref: 'annexe III (emploi)' },
    { id: 'R-AIA-LIM-02', axis: 'ai_act', kind: 'level', level: 'limited', label: 'Contenu généré publié', legal_ref: 'art. 50' },
    { id: 'R-AIA-PRV-01', axis: 'ai_act', kind: 'question', level: 'to_qualify', label: 'Rôle de fournisseur possible', legal_ref: 'art. 3' },
    { id: 'R-AIA-LIT', axis: 'ai_act', kind: 'transverse', level: null, label: 'Littératie IA', legal_ref: 'art. 4' },
    { id: 'R-DATA-PERSO', axis: 'data', kind: 'modifier', delta: 1, level: null, label: 'Compte personnel', legal_ref: '' },
    { id: 'R-AIA-MIN', axis: 'ai_act', kind: 'level', level: 'minimal', label: 'Aucune autre règle', legal_ref: '—', fallback: true },
  ],
};

export const calendar = {
  version: '2026.09',
  last_verified: '2026-09-15',
  deadlines: [
    { id: 'art5_art4', date: '2025-02-02', label: 'Interdictions et littératie IA', status: 'in_force', source_url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', last_verified: '2026-09-15' },
    { id: 'gpai', date: '2025-08-02', label: 'Modèles à usage général', status: 'in_force', source_url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', last_verified: '2026-09-15' },
    { id: 'art50', date: '2026-08-02', label: 'Transparence (art. 50)', status: 'in_force', source_url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' },
    { id: 'annex3', date: '2027-12-02', label: 'Haut risque — annexe III', status: 'upcoming', source_url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', last_verified: '2026-09-15' },
  ],
};

const trig = (id) => {
  const r = rules.rules.find((x) => x.id === id);
  return { rule_id: r.id, axis: r.axis, kind: r.kind, level: r.level, label: r.label, legal_ref: r.legal_ref, explanation: '' };
};
const dl = (id) => {
  const d = calendar.deadlines.find((x) => x.id === id);
  return { id: d.id, date: d.date, label: d.label, status: d.status, source_url: d.source_url, last_verified: d.last_verified ?? null };
};

export const CID = 'campA';

function member(i, { respondent = null, comment = null, usage = {} } = {}) {
  return {
    campaign_id: CID,
    entry_id: `e${i}`,
    rev: 1,
    submitted_day: '2026-09-10',
    respondent,
    usage: { usage_name: 'x', comment, ...usage },
    schema_version: 1,
  };
}

/**
 * Trois groupes : haut risque RH (3 déclarations, surcharge de l'exposition), outil « autre »
 * (7 déclarations, surcharge AI Act, fournisseur potentiel), et un visuel marketing (1 déclaration).
 * `open` : membres avec identité et commentaire (pour vérifier qu'ils n'apparaissent jamais).
 */
export function makeGroups({ open = false } = {}) {
  const who = (i) => (open ? { first_name: 'Jeanne', last_name: `Dupont${i}`, email: `jeanne.dupont${i}@exemple.fr` } : null);
  const note = open ? 'Commentaire confidentiel sur Mme Durand' : null;
  const g1Key = 'embedded_software_ai|evaluation_tri_personnes|rh';
  const g2Key = 'other:outil maison|redaction|commercial_devis';
  const g3Key = 'midjourney|generation_media|marketing_com';
  return [
    {
      usage_key: g1Key, id: 'U-00A1B2', name: 'Tri automatique de CV', names: ['Tri automatique de CV', 'Présélection'],
      members: [0, 1, 2].map((i) => member(i, { respondent: who(i), comment: note })),
      count: 3, tool: 'embedded_software_ai', tool_other: null, task_types: ['evaluation_tri_personnes'], business_domain: 'rh',
      departments: ['RH'], account_types: ['enterprise_provided'], models: ['Modèle X'], data_types: ['donnees_candidats'],
      frequencies: ['weekly'], output_audiences: ['internal_only'], statuses: ['in_use'], users_counts: ['2-5', '6-15'],
      comments_count: open ? 3 : 0,
      computed: {
        ai_act_level: 'high', data_level: 2, data_to_qualify: false, role: 'deployer',
        triggers: [trig('R-AIA-HI-EMP'), trig('R-AIA-LIT')],
        deadlines: [dl('art5_art4'), dl('annex3')],
        action_ids: ['ACT-HR-01', 'ACT-LIT-01'], questions_to_confirm: [], signals: [],
      },
      assessment: {
        campaign_id: CID, usage_key: g1Key, override_ai_act_level: null, override_data_level: 3,
        justification: 'Données sensibles possibles', owner: 'Responsable RH', validation_status: 'validated',
        history: [], updated_at: '2026-09-20T12:00:00.000Z',
      },
      effective: { ai_act_level: 'high', data_level: 3, overridden: true },
      validation_status: 'validated', last_review: '2026-09-20T12:00:00.000Z',
    },
    {
      usage_key: g2Key, id: 'U-00C3D4', name: '=1+1', names: ['=1+1'],
      members: [0, 1, 2, 3, 4, 5, 6].map((i) => member(10 + i, { respondent: who(10 + i), comment: note })),
      count: 7, tool: 'other', tool_other: 'Outil maison', task_types: ['redaction'], business_domain: 'commercial_devis',
      departments: ['Commercial et devis', 'Direction'], account_types: ['personal_free'], models: [], data_types: ['docs_internes'],
      frequencies: ['daily', 'weekly'], output_audiences: ['internal_only'], statuses: ['in_use'], users_counts: [],
      comments_count: 0,
      computed: {
        ai_act_level: 'to_qualify', data_level: 1, data_to_qualify: true, role: 'potential_provider',
        triggers: [trig('R-AIA-PRV-01'), trig('R-AIA-LIT'), trig('R-DATA-PERSO')],
        deadlines: [dl('art5_art4'), dl('gpai')],
        action_ids: ['ACT-QUAL-01'], questions_to_confirm: [{ rule_id: 'R-AIA-PRV-01', question: 'Développé en interne ?' }],
        signals: [{ id: 'shadow_ai', label: 'Shadow AI' }],
      },
      assessment: {
        campaign_id: CID, usage_key: g2Key, override_ai_act_level: 'limited', override_data_level: null,
        justification: 'Outil configuré, pas développé', owner: '', validation_status: 'to_revise',
        history: [], updated_at: '2026-09-21T12:00:00.000Z',
      },
      effective: { ai_act_level: 'limited', data_level: 1, overridden: true },
      validation_status: 'to_revise', last_review: '2026-09-21T12:00:00.000Z',
    },
    {
      usage_key: g3Key, id: 'U-00E5F6', name: 'Visuels marketing', names: ['Visuels marketing'],
      members: [member(30, { respondent: who(30), comment: note })],
      count: 1, tool: 'midjourney', tool_other: null, task_types: ['generation_media'], business_domain: 'marketing_com',
      departments: ['Marketing'], account_types: ['personal_free'], models: [], data_types: ['aucune'],
      frequencies: ['weekly'], output_audiences: ['public'], statuses: ['in_use'], users_counts: ['1'],
      comments_count: 0,
      computed: {
        ai_act_level: 'limited', data_level: 0, data_to_qualify: false, role: 'deployer',
        triggers: [trig('R-AIA-LIM-02')], deadlines: [], action_ids: [], questions_to_confirm: [], signals: [],
      },
      assessment: null,
      effective: { ai_act_level: 'limited', data_level: 0, overridden: false },
      validation_status: 'to_review', last_review: null,
    },
  ];
}

export function makeActions(groups) {
  return [
    { id: 'a1', campaign_id: CID, usage_key: groups[0].usage_key, template_id: 'ACT-HR-01', title: 'Supervision humaine documentée', description: 'Documenter la supervision.', owner: 'DRH', due_date: '2026-12-15', priority: 'high', status: 'in_progress', suggested: true, suggested_role: 'RH', created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-22T10:00:00.000Z' },
    { id: 'a2', campaign_id: CID, usage_key: groups[0].usage_key, template_id: 'ACT-HR-02', title: 'Tester les biais', description: '', owner: '', due_date: null, priority: 'medium', status: 'todo', suggested: true, suggested_role: 'RH', created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z' },
    { id: 'a3', campaign_id: CID, usage_key: null, template_id: 'ACT-POL-01', title: 'Charte IA', description: '-2+3+cmd|\' /C calc\'!A0', owner: 'Direction', due_date: '2026-10-31', priority: 'high', status: 'done', suggested: false, suggested_role: null, created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-25T10:00:00.000Z' },
    { id: 'a4', campaign_id: CID, usage_key: groups[1].usage_key, template_id: null, title: '=HYPERLINK("http://exemple.invalid","clic")', description: '@SUM(A1:A2)', owner: '+33 6 00 00 00 00', due_date: null, priority: 'low', status: 'todo', suggested: false, suggested_role: null, created_at: '2026-09-21T10:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z' },
  ];
}

export function makeCampaign(mode = 'anonymous', overrides = {}) {
  return {
    id: CID, title: 'Recensement IA 2026', org_name: 'Menuiserie Alpine Concept', mode,
    departments: ['Direction', 'Commercial et devis', 'RH', 'Marketing'],
    settings: { min_group_size: 5, department_required: false, comments_exportable: false, closes_on: '2026-10-31', group_by_department: false, channels: [] },
    public_key: null, private_key_jwk: null, fingerprint: null, created_at: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

export function makeStats() {
  return {
    mask: { k: 5, active: true },
    usages: 3, responses: 11, respondents: null,
    by_ai_act: { prohibited_suspected: 0, high: 1, to_qualify: 0, limited: 2, minimal: 0 },
    by_data: { 0: 1, 1: 1, 2: 0, 3: 1 },
    shadow_ai: { count: 1, share: 1 / 3 },
    top_tools: [{ tool: 'other', label: 'Outil maison', count: 7, display: '7', masked: false }, { tool: 'embedded_software_ai', label: 'IA intégrée à un logiciel', count: 3, display: '< 5', masked: true }],
    by_department: [{ department: 'RH', count: 3, display: '< 5', masked: true }, { department: 'Commercial et devis', count: 6, display: '6', masked: false }],
    upcoming_deadlines: [calendar.deadlines[3]], past_deadlines: calendar.deadlines.slice(0, 3),
    actions_progress: { todo: 2, in_progress: 1, done: 1, rejected: 0, pending_suggestions: 2, total: 4 },
    to_qualify: 1, questions: [],
  };
}
