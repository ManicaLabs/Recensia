// Chargement des fichiers data/*.json et des fixtures pour les tests (lecture synchrone, sans fetch).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
}

export function readText(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

export const loadQuestionnaire = () => readJson('data/questionnaire.json');
export const loadRules = () => readJson('data/rules.json');
export const loadActions = () => readJson('data/actions.json');
export const loadCalendar = () => readJson('data/regulatory-calendar.json');
export const loadDemo = () => readJson('data/demo-company.json');

/** Fixtures de classification : { rules_version, note, cases: [{ id, description, usage, expected }] }. */
export const loadFixtures = () => readJson('tests/fixtures/usages.json');

export function loadAll() {
  return {
    questionnaire: loadQuestionnaire(),
    rules: loadRules(),
    actions: loadActions(),
    calendar: loadCalendar(),
    demo: loadDemo(),
    fixtures: loadFixtures(),
  };
}

/** Usage complet et valide, modifiable par surcharge (tests unitaires). */
export function makeUsage(overrides = {}) {
  return {
    usage_name: 'Reformulation de mails',
    department: null,
    tool: 'chatgpt',
    tool_other: null,
    model: null,
    account_type: 'enterprise_provided',
    task_types: ['redaction'],
    business_domain: 'commercial_devis',
    data_types: ['docs_internes'],
    frequency: 'weekly',
    users_count: null,
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

let seq = 0;

/** Entrée §3.3 minimale autour d'un usage. */
export function makeEntry(usageOverrides = {}, entryOverrides = {}) {
  seq += 1;
  return {
    campaign_id: 'test',
    entry_id: `testEntry${String(seq).padStart(7, '0')}`,
    rev: 1,
    submitted_day: '2026-09-20',
    submitted_at: null,
    respondent: null,
    usage: makeUsage(usageOverrides),
    schema_version: 1,
    code_hash: null,
    source: 'manual',
    imported_at: '2026-09-20T10:00:00.000Z',
    after_close: false,
    excluded: false,
    group_override: null,
    ...entryOverrides,
  };
}
