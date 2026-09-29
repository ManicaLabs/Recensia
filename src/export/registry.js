// Lignes du registre prêt à l'emploi (CDC §8.2), communes aux exports CSV et XLSX.
// Module pur. Une ligne = un groupe consolidé (usage) ; jamais d'identité de répondant ni
// de commentaire libre. En mode anonyme, les effectifs inférieurs à min_group_size sont masqués.

import { formatUsageValue, optionLabel } from '../engine/labels.js';
import { maskCount } from '../engine/stats.js';
import { isAiActLevel, isDataLevel } from '../engine/levels.js';

export const REGISTRY_COLUMNS = Object.freeze([
  { key: 'id', label: 'ID' },
  { key: 'department', label: 'Service' },
  { key: 'usage_name', label: "Cas d'usage" },
  { key: 'tool', label: 'Outil' },
  { key: 'model', label: 'Modèle' },
  { key: 'account_type', label: 'Type de compte' },
  { key: 'task_types', label: 'Tâches' },
  { key: 'business_domain', label: 'Domaine' },
  { key: 'data_types', label: 'Catégories de données' },
  { key: 'frequency', label: 'Fréquence' },
  { key: 'people_count', label: 'Nombre de personnes concernées' },
  { key: 'role', label: 'Rôle (déployeur / fournisseur potentiel)' },
  { key: 'ai_act_level', label: 'Niveau AI Act' },
  { key: 'data_level', label: 'Exposition données' },
  { key: 'rules', label: 'Règles déclenchées (avec référence)' },
  { key: 'deadline', label: 'Échéance applicable' },
  { key: 'validation_status', label: 'Statut de validation' },
  { key: 'owner', label: 'Responsable' },
  { key: 'actions', label: 'Actions liées' },
  { key: 'last_review', label: 'Date de dernière revue' },
].map((c) => Object.freeze(c)));

// Libellés de repli, utilisés quand `t` est absent ou ne connaît pas la clé.
export const FALLBACK_LABELS = Object.freeze({
  ai_act: {
    prohibited_suspected: 'Interdit suspecté',
    high: 'Haut risque',
    to_qualify: 'À qualifier',
    limited: 'Risque limité',
    minimal: 'Risque minimal',
  },
  data: ['Faible', 'Modéré', 'Élevé', 'Critique'],
  validation: { to_review: 'À valider', validated: 'Validé', to_revise: 'À revoir' },
  action_status: { todo: 'À faire', in_progress: 'En cours', done: 'Fait', rejected: 'Rejeté' },
  priority: { high: 'Haute', medium: 'Moyenne', low: 'Basse' },
  role: { deployer: 'Déployeur', potential_provider: 'Fournisseur potentiel — à qualifier' },
  disclaimer: "Classification indicative, à confirmer — ceci n'est pas un avis juridique.",
});

const USERS_COUNT_ORDER = ['1', '2-5', '6-15', '>15'];
// Borne basse de chaque fourchette « collègues qui font pareil » (vous compris).
const USERS_COUNT_MIN = { '1': 1, '2-5': 2, '6-15': 6, '>15': 16 };
const DEFAULT_K = 5;
const SEP = ' ; ';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Jour 'YYYY-MM-DD' : chaîne déjà au format, sinon date locale de l'objet Date (ou d'aujourd'hui). */
export function toDay(today) {
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) return today;
  const d = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Traduction avec repli : `fallback` si `t` est absent ou renvoie la clé elle-même. */
export function tr(t, key, fallback, vars) {
  if (typeof t === 'function') {
    try {
      const v = t(key, vars);
      if (typeof v === 'string' && v !== '' && v !== key) return v;
    } catch {
      /* repli */
    }
  }
  return fallback;
}

export function aiActLabel(level, t) {
  return tr(t, `common.levels.ai_act.${level}`, FALLBACK_LABELS.ai_act[level] ?? String(level ?? ''));
}

/** Exposition des données : « 2 — Élevé ». */
export function dataLevelLabel(level, t) {
  if (!Number.isInteger(level)) return '';
  return `${level} — ${tr(t, `common.levels.data.${level}`, FALLBACK_LABELS.data[level] ?? '')}`;
}

export function validationLabel(status, t) {
  return tr(t, `common.validation.${status}`, FALLBACK_LABELS.validation[status] ?? String(status ?? ''));
}

export function actionStatusLabel(status, t) {
  return tr(t, `common.action_status.${status}`, FALLBACK_LABELS.action_status[status] ?? String(status ?? ''));
}

export function priorityLabel(priority, t) {
  return tr(t, `common.priority.${priority}`, FALLBACK_LABELS.priority[priority] ?? String(priority ?? ''));
}

export function roleLabel(role) {
  return FALLBACK_LABELS.role[role] ?? FALLBACK_LABELS.role.deployer;
}

export function disclaimerText(t) {
  return tr(t, 'common.disclaimer', FALLBACK_LABELS.disclaimer);
}

/** 'YYYY-MM-DD' ou horodatage ISO → 'JJ/MM/AAAA' (date locale pour un horodatage) ; '' sinon. */
export function formatDateFr(value) {
  if (typeof value !== 'string' || value === '') return '';
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return `${day[3]}/${day[2]}/${day[1]}`;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Fragment de nom de fichier ASCII : minuscules, tirets, 40 caractères au plus. */
export function slugify(text, fallback = 'campagne') {
  const slug = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** recensia-<type>-<slug du titre>-<AAAA-MM-JJ>.<ext> */
export function exportFilename(kind, campaign, today, ext) {
  const slug = slugify(campaign?.title || campaign?.org_name || campaign?.id);
  return `recensia-${kind}-${slug}-${toDay(today)}.${ext}`;
}

function minGroupSize(campaign) {
  const k = campaign?.settings?.min_group_size;
  return Number.isInteger(k) && k > 0 ? k : DEFAULT_K;
}

function highestUsersCount(values) {
  let best = -1;
  for (const v of values ?? []) best = Math.max(best, USERS_COUNT_ORDER.indexOf(v));
  return best >= 0 ? USERS_COUNT_ORDER[best] : null;
}

// Sans campagne, on applique la règle la plus prudente : le mode anonyme.
function campaignMode(campaign) {
  return campaign?.mode === 'open' ? 'open' : 'anonymous';
}

/**
 * « n déclaration(s) » + fourchette déclarée la plus haute. En mode anonyme, un effectif
 * inférieur à k est masqué (« < k ») et la fourchette n'est alors affichée que si elle ne
 * désigne pas elle-même un groupe de moins de k personnes (« Moi seulement » trahirait n = 1).
 */
function peopleCount(group, campaign, questionnaire) {
  const n = Number.isInteger(group.count) ? group.count : (group.members ?? []).length;
  const k = minGroupSize(campaign);
  const shown = maskCount(n, k, campaignMode(campaign));
  const masked = shown !== String(n);
  let text = `${shown} ${n > 1 || masked ? 'déclarations' : 'déclaration'}`;
  const range = highestUsersCount(group.users_counts);
  if (range && (!masked || USERS_COUNT_MIN[range] >= k)) {
    text += ` ; collègues concernés : ${optionLabel(questionnaire, 'users_count', range)}`;
  }
  return text;
}

function toolText(group, questionnaire) {
  const label = optionLabel(questionnaire, 'tool', group.tool);
  if (group.tool === 'other' && group.tool_other) return `${label} (${group.tool_other})`;
  return label;
}

function hasRef(ref) {
  return typeof ref === 'string' && ref.trim() !== '' && ref.trim() !== '—' && ref.trim() !== '-';
}

function rulesText(group, rules) {
  const byId = new Map((Array.isArray(rules?.rules) ? rules.rules : Array.isArray(rules) ? rules : []).map((r) => [r.id, r]));
  const seen = new Set();
  const parts = [];
  for (const trig of group.computed?.triggers ?? []) {
    if (!trig?.rule_id || seen.has(trig.rule_id)) continue;
    seen.add(trig.rule_id);
    const ref = hasRef(trig.legal_ref) ? trig.legal_ref : byId.get(trig.rule_id)?.legal_ref;
    parts.push(hasRef(ref) ? `${trig.rule_id} (${ref.trim()})` : trig.rule_id);
  }
  return parts.join(SEP);
}

/**
 * Échéance applicable : la prochaine à venir (date ≥ aujourd'hui), sinon la plus récente
 * déjà passée, suivie de « (en vigueur) ».
 */
export function applicableDeadline(deadlines, today, calendar) {
  const day = toDay(today);
  const byId = new Map((calendar?.deadlines ?? []).map((d) => [d.id, d]));
  const dated = (deadlines ?? [])
    .map((d) => ({ ...byId.get(d?.id), ...d }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? ''))
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = dated.find((d) => d.date >= day);
  if (next) return { deadline: next, in_force: false };
  const past = dated.at(-1);
  return past ? { deadline: past, in_force: true } : null;
}

function deadlineText(group, today, calendar) {
  const found = applicableDeadline(group.computed?.deadlines, today, calendar);
  if (!found) return '';
  const { deadline, in_force } = found;
  const label = deadline.label ?? deadline.id;
  return `${formatDateFr(deadline.date)} — ${label}${in_force ? ' (en vigueur)' : ''}`;
}

function aiActText(group, t) {
  const level = group.effective?.ai_act_level ?? group.computed?.ai_act_level;
  // Même critère que consolidate() : seule une surcharge valide compte.
  const overridden = isAiActLevel(group.assessment?.override_ai_act_level);
  return `${aiActLabel(level, t)}${overridden ? ' (surchargé)' : ''}`;
}

function dataText(group, t) {
  const level = group.effective?.data_level ?? group.computed?.data_level;
  const overridden = isDataLevel(group.assessment?.override_data_level);
  let text = dataLevelLabel(level, t);
  if (overridden) text += ' (surchargé)';
  else if (group.computed?.data_to_qualify) text += ' (à qualifier)';
  return text;
}

function actionsText(group, actions, campaign, t) {
  return (actions ?? [])
    .filter((a) => a && a.usage_key === group.usage_key && (!campaign?.id || !a.campaign_id || a.campaign_id === campaign.id))
    .map((a) => `${a.title ?? ''} (${actionStatusLabel(a.status, t)})`)
    .join(SEP);
}

/**
 * Lignes du registre, une par groupe issu de consolidate() (ARCHITECTURE §4.1).
 * → [{ id, department, usage_name, …, last_review }] (clés de REGISTRY_COLUMNS, valeurs texte)
 */
export function registryRows(groups, { campaign, actions, questionnaire, rules, calendar, t, today } = {}) {
  return (groups ?? []).map((g) => ({
    id: g.id ?? '',
    department: (g.departments ?? []).filter((d) => typeof d === 'string' && d !== '').join(', '),
    usage_name: g.name ?? '',
    tool: toolText(g, questionnaire),
    model: (g.models ?? []).join(', '),
    account_type: formatUsageValue(questionnaire, 'account_type', g.account_types ?? []),
    task_types: formatUsageValue(questionnaire, 'task_types', g.task_types ?? []),
    business_domain: optionLabel(questionnaire, 'business_domain', g.business_domain),
    data_types: formatUsageValue(questionnaire, 'data_types', g.data_types ?? []),
    frequency: formatUsageValue(questionnaire, 'frequency', g.frequencies ?? []),
    people_count: peopleCount(g, campaign, questionnaire),
    role: roleLabel(g.computed?.role),
    ai_act_level: aiActText(g, t),
    data_level: dataText(g, t),
    rules: rulesText(g, rules),
    deadline: deadlineText(g, today, calendar),
    validation_status: validationLabel(g.validation_status ?? 'to_review', t),
    owner: typeof g.assessment?.owner === 'string' ? g.assessment.owner : '',
    actions: actionsText(g, actions, campaign, t),
    last_review: formatDateFr(g.last_review ?? ''),
  }));
}
