// Classeur XLSX (CDC §8.3) : feuilles « Registre », « Plan d'actions », « Synthèse », « Référentiel ».
// Toutes les cellules texte sont neutralisées contre l'injection de formules.
// Module sans DOM ; SheetJS (≈ 1 Mo) est chargé avec ce module : l'importer à la demande.

import * as XLSX from '../../vendor/xlsx.mjs';
import { AI_ACT_ORDER, DATA_LEVELS } from '../engine/levels.js';
import { neutralize } from './csv.js';
import {
  registryColumns, registryRows, commentsExportable, aiActLabel, dataLevelLabel, actionStatusLabel, priorityLabel,
  disclaimerText, formatDateFr, toDay,
} from './registry.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SHEET_NAMES = Object.freeze({
  registry: 'Registre',
  actions: "Plan d'actions",
  summary: 'Synthèse',
  reference: 'Référentiel',
});

const INDICATIVE = 'Indicatif, à confirmer : ne constitue pas un avis juridique. '
  + 'Dates et références à vérifier sur EUR-Lex / Journal officiel.';

const ACTION_COLUMNS = [
  'ID', 'Action', 'Description', 'Usage lié', "Modèle d'action", 'Priorité', 'Statut', 'Responsable',
  'Échéance', 'Rôle suggéré', 'Origine', 'Créée le', 'Mise à jour le',
];
const STATUS_ORDER = ['todo', 'in_progress', 'done', 'rejected'];
const PRIORITY_ORDER = ['high', 'medium', 'low'];
const AXIS_LABELS = { ai_act: 'AI Act', data: 'Données (RGPD)' };
// Statut d'une échéance du calendrier (champ `status`) : état de vérification de la date.
// L'état temporel (« En vigueur » / « À venir ») est calculé d'après la date et le jour de l'export.
export const CALENDAR_STATUS = Object.freeze({
  verified: 'Vérifiée',
  to_verify: 'À vérifier',
  to_confirm: 'À confirmer',
  postponed: 'Reportée',
  proposed: 'Proposée',
  in_force: 'En vigueur',
  upcoming: 'À venir',
});
// Statuts qui décrivent déjà l'état temporel (anciens calendriers) : rien à ajouter.
const TEMPORAL_STATUS = new Set(['in_force', 'upcoming']);
// Rôles visés par une échéance réservée (applies_to_roles) ; cellule vide sans restriction.
const ROLE_SCOPE = Object.freeze({ potential_provider: 'Fournisseurs uniquement', deployer: 'Déployeurs uniquement' });

// Vocabulaire de l'interface (tableau de bord, rapport, plan d'actions).
export const SHADOW_AI_SECTION = 'IA fantôme (shadow AI)';
export const SHADOW_AI_LABEL = 'Usages sur comptes personnels ou non maîtrisés';
/** Colonne « Origine » du plan d'actions (libellés de la liste du plan, actions.item.*). */
export const ACTION_ORIGIN = Object.freeze({ suggestion: "Issue d'une suggestion", manual: 'Ajoutée manuellement' });

/** Origine d'une action : acceptée depuis une suggestion (`suggested`) ou ajoutée à la main. */
export function originLabel(action) {
  return action?.suggested ? ACTION_ORIGIN.suggestion : ACTION_ORIGIN.manual;
}

function rank(list, value) {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
}

// Toute cellule texte passe par neutralize ; les nombres restent des nombres.
function sanitize(aoa) {
  return aoa.map((row) => row.map((v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? v : '';
    return neutralize(typeof v === 'string' ? v : String(v));
  }));
}

function columnWidths(aoa, { min = 8, max = 60 } = {}) {
  const widths = [];
  for (const row of aoa) {
    row.forEach((v, i) => {
      const longest = String(v ?? '').split(/\r?\n/).reduce((m, line) => Math.max(m, line.length), 0);
      widths[i] = Math.max(widths[i] ?? min, Math.min(max, longest + 2));
    });
  }
  return widths.map((wch) => ({ wch }));
}

// `footer` : lignes ajoutées sous le tableau, après une ligne vide, hors du filtre automatique
// et du calcul des largeurs.
function makeSheet(aoa, { filter = false, widths, footer = [] } = {}) {
  const clean = sanitize(aoa);
  const ws = XLSX.utils.aoa_to_sheet(footer.length ? [...clean, [], ...sanitize(footer)] : clean);
  ws['!cols'] = widths ?? columnWidths(clean);
  if (filter && clean.length > 0 && clean[0].length > 0) {
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(clean.length - 1, 0), c: clean[0].length - 1 } }),
    };
  }
  return ws;
}

/** Mention placée sous le registre quand les commentaires libres y figurent. */
export const COMMENTS_NOTICE = Object.freeze({
  anonymous: 'Commentaires libres inclus : même en mode anonyme, ils peuvent permettre d’identifier leur auteur. Relisez-les avant de diffuser ce registre.',
  open: 'Commentaires libres inclus : ils peuvent contenir des données personnelles. Relisez-les avant de diffuser ce registre.',
});

// Chaque classification exportée porte la mention « indicatif, à confirmer » (CDC §0).
// Colonnes : celles du CDC §8.2, puis « Commentaires » si la campagne l'autorise.
function registrySheet(ctx) {
  const columns = registryColumns(ctx.campaign);
  const rows = registryRows(ctx.groups, ctx);
  const aoa = [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => r[c.key]))];
  const footer = [[`${disclaimerText(ctx.t)} Registre exporté le ${formatDateFr(toDay(ctx.today))}.`]];
  if (commentsExportable(ctx.campaign)) footer.push([COMMENTS_NOTICE[ctx.campaign.mode === 'open' ? 'open' : 'anonymous']]);
  return makeSheet(aoa, { filter: true, footer });
}

function actionsSheet({ campaign, groups, actions, t }) {
  const byKey = new Map((groups ?? []).map((g) => [g.usage_key, g]));
  const list = (actions ?? [])
    .filter((a) => a && (!campaign?.id || !a.campaign_id || a.campaign_id === campaign.id))
    .sort((a, b) =>
      rank(STATUS_ORDER, a.status) - rank(STATUS_ORDER, b.status)
      || rank(PRIORITY_ORDER, a.priority) - rank(PRIORITY_ORDER, b.priority)
      || String(a.due_date ?? '9999-99-99').localeCompare(String(b.due_date ?? '9999-99-99'))
      || String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fr'));
  const usageOf = (a) => {
    if (a.usage_key === null || a.usage_key === undefined) return 'Transverse (toute l’organisation)';
    const g = byKey.get(a.usage_key);
    return g ? `${g.id} — ${g.name}` : 'Usage absent du registre';
  };
  const aoa = [ACTION_COLUMNS, ...list.map((a) => [
    a.id ?? '',
    a.title ?? '',
    a.description ?? '',
    usageOf(a),
    a.template_id ?? '',
    priorityLabel(a.priority, t),
    actionStatusLabel(a.status, t),
    a.owner ?? '',
    formatDateFr(a.due_date ?? ''),
    a.suggested_role ?? '',
    originLabel(a),
    formatDateFr(a.created_at ?? ''),
    formatDateFr(a.updated_at ?? ''),
  ])];
  const widths = columnWidths(sanitize(aoa));
  widths[2] = { wch: 60 }; // description : colonne large
  return makeSheet(aoa, { filter: true, widths });
}

function summarySheet({ campaign, groups, stats, t, today }) {
  const s = stats ?? {};
  const rows = [['Rubrique', 'Indicateur', 'Valeur']];
  const add = (section, label, value) => rows.push([section, label, value ?? '']);
  add('Campagne', 'Titre', campaign?.title ?? '');
  add('Campagne', 'Organisation', campaign?.org_name ?? '');
  add('Campagne', 'Mode', campaign?.mode === 'open' ? 'Ouvert (nominatif)' : 'Anonyme');
  if (campaign?.settings?.closes_on) add('Campagne', 'Date de clôture indicative', formatDateFr(campaign.settings.closes_on));
  add('Campagne', "Date d'export", formatDateFr(toDay(today)));
  add('Campagne', 'Commentaires libres', commentsExportable(campaign) ? 'Inclus dans le registre' : 'Exclus des exports');
  if (campaign?.mode !== 'open') {
    const k = s.mask?.k ?? campaign?.settings?.min_group_size ?? 5;
    add('Campagne', 'Masquage des petits effectifs', `Effectifs inférieurs à ${k} affichés « < ${k} »`);
  }

  add('Volumes', 'Usages recensés (lignes du registre)', s.usages ?? (groups ?? []).length);
  if (Number.isInteger(s.responses)) add('Volumes', 'Déclarations prises en compte', s.responses);
  if (Number.isInteger(s.respondents)) add('Volumes', 'Répondants', s.respondents);

  for (const level of AI_ACT_ORDER) add('Niveau AI Act', aiActLabel(level, t), s.by_ai_act?.[level] ?? 0);
  for (const level of DATA_LEVELS) add('Exposition des données', dataLevelLabel(level, t), s.by_data?.[level] ?? 0);

  if (s.shadow_ai) {
    const pct = Math.round((Number(s.shadow_ai.share) || 0) * 100);
    add(SHADOW_AI_SECTION, SHADOW_AI_LABEL, `${s.shadow_ai.count ?? 0} (${pct} %)`);
  }
  for (const tool of s.top_tools ?? []) add('Principaux outils', tool.label ?? tool.tool ?? '', tool.display ?? String(tool.count ?? ''));
  for (const d of s.by_department ?? []) add('Répartition par service', d.department ?? 'Non renseigné', d.display ?? String(d.count ?? ''));
  if (Number.isInteger(s.to_qualify)) add('À qualifier', 'Usages à qualifier', s.to_qualify);

  const p = s.actions_progress;
  if (p) {
    for (const status of STATUS_ORDER) add("Plan d'actions", actionStatusLabel(status, t), p[status] ?? 0);
    add("Plan d'actions", 'Suggestions en attente', p.pending_suggestions ?? 0);
    add("Plan d'actions", 'Total des actions', p.total ?? 0);
  }
  for (const d of s.upcoming_deadlines ?? []) add('Échéances à venir', formatDateFr(d.date), d.label ?? d.id ?? '');
  add('Avertissement', 'Classification', disclaimerText(t));
  add('Avertissement', 'Référentiel', INDICATIVE);
  return makeSheet(rows);
}

function ruleLevel(rule, t) {
  if (rule.kind === 'modifier') {
    const delta = Number.isInteger(rule.delta) ? rule.delta : 0;
    return `Modificateur ${delta >= 0 ? '+' : ''}${delta}`;
  }
  if (rule.axis === 'ai_act' && typeof rule.level === 'string') return aiActLabel(rule.level, t);
  if (rule.axis === 'data' && Number.isInteger(rule.level)) return dataLevelLabel(rule.level, t);
  if (rule.kind === 'question') return 'À qualifier';
  return '—';
}

/**
 * Statut lisible d'une échéance : « En vigueur » (date passée) ou « À venir » (date du jour
 * comprise, comme au tableau de bord), suivi de l'état de vérification s'il n'est pas « vérifiée »
 * (« À venir (à vérifier) »). Jamais la clé brute du calendrier.
 */
export function calendarStatusText(deadline, today) {
  const date = typeof deadline?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deadline.date) ? deadline.date : null;
  const timing = date === null ? 'Date non précisée' : date < toDay(today) ? 'En vigueur' : 'À venir';
  const status = deadline?.status;
  if (status === null || status === undefined || status === '' || status === 'verified' || TEMPORAL_STATUS.has(status)) return timing;
  const label = Object.hasOwn(CALENDAR_STATUS, status) ? CALENDAR_STATUS[status].toLocaleLowerCase('fr') : 'vérification non précisée';
  return `${timing} (${label})`;
}

function roleScopeText(deadline) {
  const roles = Array.isArray(deadline?.applies_to_roles) ? deadline.applies_to_roles : [];
  const labels = roles.map((r) => (Object.hasOwn(ROLE_SCOPE, r) ? ROLE_SCOPE[r] : null)).filter(Boolean);
  return labels.join(' ; ');
}

function referenceSheet({ groups, rules, calendar, t, today }) {
  const ruleList = Array.isArray(rules?.rules) ? rules.rules : [];
  const byId = new Map(ruleList.map((r) => [r.id, r]));
  // Règles effectivement déclenchées, avec le nombre d'usages concernés.
  const used = new Map();
  for (const g of groups ?? []) {
    for (const trig of g.computed?.triggers ?? []) {
      if (!trig?.rule_id) continue;
      const item = used.get(trig.rule_id) ?? { trigger: trig, count: 0 };
      item.count += 1;
      used.set(trig.rule_id, item);
    }
  }
  const order = (id) => {
    const i = ruleList.findIndex((r) => r.id === id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const usedRules = [...used.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([id, { trigger, count }]) => {
      const rule = { ...trigger, ...byId.get(id), id };
      return [id, AXIS_LABELS[rule.axis] ?? rule.axis ?? '', ruleLevel(rule, t), rule.label ?? '', rule.legal_ref ?? '', count];
    });

  const deadlines = [...(Array.isArray(calendar?.deadlines) ? calendar.deadlines : [])]
    .filter((d) => d && typeof d === 'object')
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || String(a.id).localeCompare(String(b.id)));

  const day = toDay(today);
  const aoa = [
    ['Référentiel de classification et calendrier réglementaire'],
    ['Mention', INDICATIVE],
    ['Version des règles', rules?.version ?? ''],
    ['Version du calendrier', calendar?.version ?? ''],
    ['Calendrier vérifié le', formatDateFr(calendar?.last_verified ?? '')],
    ["Date d'export", formatDateFr(toDay(today))],
    [],
    ['Règles utilisées'],
    ['ID', 'Axe', 'Niveau', 'Libellé', 'Référence', 'Usages concernés'],
    ...usedRules,
    [],
    ['Calendrier réglementaire'],
    ['ID', 'Date', 'Libellé', 'Statut', 'Concerne', 'Source', 'Dernière vérification'],
    ...deadlines.map((d) => [
      d.id ?? '',
      formatDateFr(d.date ?? ''),
      d.label ?? '',
      calendarStatusText(d, day),
      roleScopeText(d),
      d.source_url ?? '',
      formatDateFr(d.last_verified ?? calendar?.last_verified ?? ''),
    ]),
  ];
  const widths = columnWidths(sanitize(aoa.slice(7)));
  widths[0] = { wch: Math.max(widths[0]?.wch ?? 8, 22) };
  return makeSheet(aoa, { widths });
}

/**
 * Construit le classeur. Paramètres : ceux de registryRows, plus `stats` (computeStats) pour
 * la synthèse. → objet classeur SheetJS (à passer à workbookBlob).
 */
export function buildWorkbook({ campaign, groups, actions, stats, rules, calendar, questionnaire, t, today } = {}) {
  const ctx = { campaign, groups: groups ?? [], actions: actions ?? [], stats, rules, calendar, questionnaire, t, today };
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: 'Registre des usages IA', Author: 'Recensia', CreatedDate: new Date() };
  XLSX.utils.book_append_sheet(wb, registrySheet(ctx), SHEET_NAMES.registry);
  XLSX.utils.book_append_sheet(wb, actionsSheet(ctx), SHEET_NAMES.actions);
  XLSX.utils.book_append_sheet(wb, summarySheet(ctx), SHEET_NAMES.summary);
  XLSX.utils.book_append_sheet(wb, referenceSheet(ctx), SHEET_NAMES.reference);
  return wb;
}

/** Classeur → Blob XLSX. */
export function workbookBlob(wb) {
  const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  return new Blob([bytes], { type: XLSX_MIME });
}
