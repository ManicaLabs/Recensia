// Consolidation des déclarations en lignes de registre (CDC §5.3).
// Clé : outil (+ précision « autre » en minuscules) + types de tâche triés + domaine
// (+ service si demandé). Niveau d'un groupe = maximum de ses membres (approche prudente).
// Module pur : entrées, règles, calendrier et évaluations sont passés en paramètre.

import { classifyUsage, resolveDeadlines } from './classify.js';
import { compareAiAct, isAiActLevel, isDataLevel, maxAiAct, maxDataLevel } from './levels.js';

const encoder = new TextEncoder();

/** Hachage FNV-1a 32 bits (octets UTF-8) ; renvoie un entier non signé. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(String(str))) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

/** Normalise une précision d'outil libre pour la clé : minuscules, espaces réduits. */
export function normalizeToolOther(s) {
  return String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeSegment(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Clé de regroupement déterministe d'un usage. */
export function usageKey(usage, { byDepartment = false } = {}) {
  const tool = String(usage?.tool ?? '');
  const toolPart = tool === 'other' ? `other:${escapeSegment(normalizeToolOther(usage?.tool_other))}` : tool;
  const tasks = [...(Array.isArray(usage?.task_types) ? usage.task_types : [])].map(String).sort().join(',');
  const parts = [toolPart, tasks, String(usage?.business_domain ?? '')];
  if (byDepartment) parts.push(escapeSegment(usage?.department ?? ''));
  return parts.join('|');
}

/** Identifiant court et stable d'une ligne : 'U-' + 6 hexadécimaux (FNV-1a replié sur 24 bits). */
export function groupId(key) {
  const h = fnv1a32(key);
  return `U-${hex(((h >>> 24) ^ (h & 0xffffff)) >>> 0, 6)}`;
}

function compareText(a, b) {
  const r = String(a).localeCompare(String(b), 'fr');
  return r !== 0 ? r : compareCodePoints(a, b);
}

function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Valeurs distinctes triées par fréquence décroissante puis ordre alphabétique (ou `tieBreak`). */
function byFrequency(values, tieBreak = compareText) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || tieBreak(a[0], b[0])).map(([v]) => v);
}

function uniqueSorted(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))].sort(compareText);
}

/** Modèles déclarés, dédoublonnés sans tenir compte de la casse (graphie la plus fréquente). */
function distinctModels(values) {
  const byKey = new Map();
  for (const v of values) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    const k = v.trim().toLowerCase();
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(v.trim());
  }
  return [...byKey.values()].map((spellings) => byFrequency(spellings, compareCodePoints)[0]).sort(compareText);
}

function unionBy(lists, keyOf) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list) {
      const k = keyOf(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

function mergeClassifications(classes, rules, calendar) {
  // Rôle : le premier rôle différent du rôle par défaut l'emporte (approche prudente).
  const defaultRole = rules?.default_role ?? 'deployer';
  const ruleIndex = new Map((rules?.rules ?? []).map((r, i) => [r.id, i]));
  const order = (id) => ruleIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const triggers = unionBy(classes.map((c) => c.triggers), (t) => t.rule_id).sort((a, b) => order(a.rule_id) - order(b.rule_id));
  const questions = unionBy(classes.map((c) => c.questions_to_confirm), (q) => q.rule_id).sort((a, b) => order(a.rule_id) - order(b.rule_id));
  const deadlineIds = [...new Set(classes.flatMap((c) => c.deadlines.map((d) => d.id)))];
  const role = classes.find((c) => c.role && c.role !== defaultRole)?.role ?? defaultRole;
  return {
    ai_act_level: maxAiAct(classes.map((c) => c.ai_act_level)),
    data_level: maxDataLevel(classes.map((c) => c.data_level)),
    data_to_qualify: classes.some((c) => c.data_to_qualify),
    role,
    triggers,
    // Union des échéances des membres (chacune déjà filtrée selon le rôle de son membre).
    deadlines: resolveDeadlines(deadlineIds, calendar, { role }),
    action_ids: [...new Set(classes.flatMap((c) => c.action_ids))],
    questions_to_confirm: questions,
    signals: unionBy(classes.map((c) => c.signals), (s) => s.id),
  };
}

function buildGroup(key, members, classes, rules, calendar, assessmentsByKey) {
  const usages = members.map((m) => m.usage ?? {});
  const names = byFrequency(usages.map((u) => u.usage_name).filter((n) => typeof n === 'string' && n !== ''));
  const tool = byFrequency(usages.map((u) => u.tool).filter(Boolean))[0] ?? null;
  const toolOthers = usages
    .filter((u) => u.tool === 'other' && typeof u.tool_other === 'string' && u.tool_other.trim() !== '')
    .map((u) => u.tool_other.trim());
  const computed = mergeClassifications(classes, rules, calendar);
  const assessment = assessmentsByKey.get(key) ?? null;
  // Une surcharge n'est retenue que si elle porte un niveau valide (une valeur vide ou corrompue est ignorée).
  const overrideAi = isAiActLevel(assessment?.override_ai_act_level) ? assessment.override_ai_act_level : null;
  const overrideData = isDataLevel(assessment?.override_data_level) ? assessment.override_data_level : null;

  return {
    usage_key: key,
    id: groupId(key),
    name: names[0] ?? '',
    names,
    members,
    count: members.length,
    tool,
    // Graphie affichée : la plus fréquente ; à égalité, l'ordre des points de code favorise la majuscule.
    tool_other: tool === 'other' ? (byFrequency(toolOthers, compareCodePoints)[0] ?? null) : null,
    task_types: uniqueSorted(usages.flatMap((u) => u.task_types ?? [])),
    business_domain: byFrequency(usages.map((u) => u.business_domain).filter(Boolean))[0] ?? null,
    departments: uniqueSorted(usages.map((u) => u.department)),
    account_types: uniqueSorted(usages.map((u) => u.account_type)),
    models: distinctModels(usages.map((u) => u.model)),
    data_types: uniqueSorted(usages.flatMap((u) => u.data_types ?? [])),
    frequencies: uniqueSorted(usages.map((u) => u.frequency)),
    output_audiences: uniqueSorted(usages.map((u) => u.output_audience)),
    statuses: uniqueSorted(usages.map((u) => u.status)),
    users_counts: uniqueSorted(usages.map((u) => u.users_count)),
    comments_count: usages.filter((u) => typeof u.comment === 'string' && u.comment.trim() !== '').length,
    computed,
    assessment,
    effective: {
      ai_act_level: overrideAi ?? computed.ai_act_level,
      data_level: overrideData ?? computed.data_level,
      overridden: overrideAi !== null || overrideData !== null,
    },
    validation_status: assessment?.validation_status ?? 'to_review',
    last_review: assessment?.updated_at ?? null,
  };
}

/** Tri des lignes : gravité AI Act, puis exposition des données, puis nom. */
export function compareGroups(a, b) {
  return (
    compareAiAct(a.effective.ai_act_level, b.effective.ai_act_level) ||
    b.effective.data_level - a.effective.data_level ||
    compareText(a.name, b.name) ||
    compareText(a.id, b.id)
  );
}

/**
 * Regroupe les entrées (§3.3) en lignes de registre.
 * Les entrées exclues sont ignorées ; entry.group_override prime sur la clé calculée.
 */
export function consolidate(entries, rules, calendar, { byDepartment = false, assessments = [] } = {}) {
  const assessmentsByKey = new Map((assessments ?? []).map((a) => [a.usage_key, a]));
  const buckets = new Map();
  for (const entry of entries ?? []) {
    if (!entry || entry.excluded === true) continue;
    const override = typeof entry.group_override === 'string' && entry.group_override !== '' ? entry.group_override : null;
    const key = override ?? usageKey(entry.usage, { byDepartment });
    if (!buckets.has(key)) buckets.set(key, { members: [], classes: [] });
    const bucket = buckets.get(key);
    bucket.members.push(entry);
    bucket.classes.push(classifyUsage(entry.usage, rules, calendar));
  }
  const groups = [...buckets.entries()].map(([key, b]) => buildGroup(key, b.members, b.classes, rules, calendar, assessmentsByKey));
  resolveIdCollisions(groups);
  return groups.sort(compareGroups);
}

// Collision d'identifiants courts (24 bits, très improbable) : les clés sont traitées par ordre
// alphabétique et la suivante est re-hachée avec un suffixe, de façon déterministe.
function resolveIdCollisions(groups) {
  const used = new Set();
  for (const group of [...groups].sort((a, b) => (a.usage_key < b.usage_key ? -1 : a.usage_key > b.usage_key ? 1 : 0))) {
    let id = group.id;
    for (let n = 1; used.has(id); n += 1) id = groupId(`${group.usage_key}#${n}`);
    group.id = id;
    used.add(id);
  }
}
