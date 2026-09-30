import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import * as XLSX from '../vendor/xlsx.mjs';
import {
  REGISTRY_COLUMNS, registryRows, applicableDeadline, formatDateFr, slugify, exportFilename, FALLBACK_LABELS, toDay,
  registryColumns, commentsText, COMMENTS_MAX_CHARS,
} from '../src/export/registry.js';
import { toCSV } from '../src/export/csv.js';
import {
  buildWorkbook, workbookBlob, XLSX_MIME, SHEET_NAMES, CALENDAR_STATUS, calendarStatusText, ACTION_ORIGIN, originLabel,
  SHADOW_AI_SECTION, SHADOW_AI_LABEL,
} from '../src/export/xlsx.js';
import { loadCalendar } from './helpers/load-data.js';
import { exportJson, importJson, backupFilename, MAX_IMPORT_CHARS } from '../src/export/json.js';
import { openStore, validateBackup } from '../src/storage/store.js';
import { consolidate } from '../src/engine/consolidate.js';
import { computeStats } from '../src/engine/stats.js';
import {
  questionnaire, t, rules, calendar, makeGroups, makeActions, makeCampaign, makeStats, CID,
} from './helpers/export-fixtures.js';
import { makeKeys, seedCampaign, makeEntry, makeUsage } from './helpers/storage-fixtures.js';

const TODAY = '2026-09-29';
const DEMO_URL = new URL('../data/demo-company.json', import.meta.url);

function rowsFor(mode, extra = {}) {
  const groups = makeGroups({ open: mode === 'open' });
  const campaign = makeCampaign(mode, extra.campaign);
  return registryRows(groups, {
    campaign, actions: makeActions(groups), questionnaire, rules, calendar, t, today: TODAY, ...extra.opts,
  });
}

// ---------------------------------------------------------------- registre

test('REGISTRY_COLUMNS : exactement les 20 colonnes du CDC §8.2, dans l’ordre', () => {
  assert.deepEqual(REGISTRY_COLUMNS.map((c) => c.label), [
    'ID', 'Service', "Cas d'usage", 'Outil', 'Modèle', 'Type de compte', 'Tâches', 'Domaine',
    'Catégories de données', 'Fréquence', 'Nombre de personnes concernées',
    'Rôle (déployeur / fournisseur potentiel)', 'Niveau AI Act', 'Exposition données',
    'Règles déclenchées (avec référence)', 'Échéance applicable', 'Statut de validation', 'Responsable',
    'Actions liées', 'Date de dernière revue',
  ]);
  const keys = REGISTRY_COLUMNS.map((c) => c.key);
  assert.equal(new Set(keys).size, 20, 'clés uniques');
  assert.ok(keys.every((k) => /^[a-z_]+$/.test(k)), 'clés snake_case ASCII');
  assert.ok(Object.isFrozen(REGISTRY_COLUMNS));
});

test('registryRows : une ligne par groupe, toutes les colonnes renseignées en texte', () => {
  const rows = rowsFor('anonymous');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), REGISTRY_COLUMNS.map((c) => c.key));
    for (const v of Object.values(row)) assert.equal(typeof v, 'string');
  }
});

test('registryRows : libellés lisibles issus du questionnaire', () => {
  const [g1, g2, g3] = rowsFor('anonymous');
  assert.equal(g1.id, 'U-00A1B2');
  assert.equal(g1.department, 'RH');
  assert.equal(g1.usage_name, 'Tri automatique de CV');
  assert.equal(g1.tool, 'IA intégrée à un logiciel');
  assert.equal(g1.model, 'Modèle X');
  assert.equal(g1.account_type, 'Compte fourni par l’entreprise');
  assert.equal(g1.task_types, 'Évaluation ou tri de personnes');
  assert.equal(g1.business_domain, 'Ressources humaines');
  assert.equal(g1.data_types, 'Données de candidats');
  assert.equal(g1.frequency, 'Chaque semaine');
  assert.equal(g2.tool, 'Autre (Outil maison)');
  assert.equal(g2.department, 'Commercial et devis, Direction');
  assert.equal(g2.frequency, 'Chaque jour, Chaque semaine');
  assert.equal(g3.data_types, 'Aucune');
});

test('registryRows : rôle, niveaux effectifs et surcharges', () => {
  const [g1, g2, g3] = rowsFor('anonymous');
  assert.equal(g1.role, 'Déployeur');
  assert.equal(g2.role, 'Fournisseur potentiel — à qualifier');
  assert.equal(g1.ai_act_level, 'Haut risque');
  assert.equal(g1.data_level, '3 — Critique (surchargé)');
  assert.equal(g2.ai_act_level, 'Limité (surchargé)');
  assert.equal(g2.data_level, '1 — Modéré (à qualifier)');
  assert.equal(g3.ai_act_level, 'Limité');
  assert.equal(g3.data_level, '0 — Faible');
});

test('registryRows : règles déclenchées avec référence', () => {
  const [g1, g2, g3] = rowsFor('anonymous');
  assert.equal(g1.rules, 'R-AIA-HI-EMP (annexe III (emploi)) ; R-AIA-LIT (art. 4)');
  assert.equal(g2.rules, 'R-AIA-PRV-01 (art. 3) ; R-AIA-LIT (art. 4) ; R-DATA-PERSO');
  assert.equal(g3.rules, 'R-AIA-LIM-02 (art. 50)');
});

test('registryRows : échéance applicable (prochaine à venir, sinon la plus récente en vigueur)', () => {
  const [g1, g2, g3] = rowsFor('anonymous');
  assert.equal(g1.deadline, '02/12/2027 — Haut risque — annexe III');
  assert.equal(g2.deadline, '02/08/2025 — Modèles à usage général (en vigueur)');
  assert.equal(g3.deadline, '');
  const ds = calendar.deadlines;
  assert.equal(applicableDeadline(ds, '2027-12-02').deadline.id, 'annex3', 'le jour même : encore à venir');
  assert.equal(applicableDeadline(ds, '2027-12-03').in_force, true);
  assert.equal(applicableDeadline(ds, '2027-12-03').deadline.id, 'annex3');
  assert.equal(applicableDeadline(ds, '2020-01-01').deadline.id, 'art5_art4');
  assert.equal(applicableDeadline([{ id: 'x', date: null }], TODAY), null, 'date absente ignorée');
  assert.equal(applicableDeadline([{ id: 'annex3' }], TODAY, calendar).deadline.date, '2027-12-02', 'complété par le calendrier');
});

test('registryRows : validation, responsable, actions liées, dernière revue', () => {
  const [g1, g2, g3] = rowsFor('anonymous');
  assert.equal(g1.validation_status, 'Validé');
  assert.equal(g2.validation_status, 'À revoir');
  assert.equal(g3.validation_status, 'À valider');
  assert.equal(g1.owner, 'Responsable RH');
  assert.equal(g3.owner, '');
  assert.equal(g1.actions, 'Supervision humaine documentée (En cours) ; Tester les biais (À faire)');
  assert.equal(g2.actions, '=HYPERLINK("http://exemple.invalid","clic") (À faire)');
  assert.equal(g3.actions, '', 'les actions transverses ne sont rattachées à aucun usage');
  assert.equal(g1.last_review, '20/09/2026');
  assert.equal(g3.last_review, '');
});

test('registryRows : masquage « < k » en mode anonyme uniquement', () => {
  const anon = rowsFor('anonymous');
  assert.equal(anon[0].people_count, '< 5 déclarations ; collègues concernés : 6 à 15',
    'fourchette ≥ k : conservée, elle ne désigne pas un petit groupe');
  assert.equal(anon[1].people_count, '7 déclarations');
  assert.equal(anon[2].people_count, '< 5 déclarations', '« Moi seul » trahirait n = 1 : retiré');
  const open = rowsFor('open');
  assert.equal(open[0].people_count, '3 déclarations ; collègues concernés : 6 à 15');
  assert.equal(open[2].people_count, '1 déclaration ; collègues concernés : Moi seul');
  const k3 = rowsFor('anonymous', { campaign: { settings: { min_group_size: 3 } } });
  assert.equal(k3[0].people_count, '3 déclarations ; collègues concernés : 6 à 15', 'n = k : non masqué');
  assert.equal(k3[2].people_count, '< 3 déclarations');
  const k7 = rowsFor('anonymous', { campaign: { settings: { min_group_size: 7 } } });
  assert.equal(k7[0].people_count, '< 7 déclarations', 'fourchette 6 à 15 < k = 7 : retirée');
});

test('registryRows : masquage appliqué par défaut si la campagne manque', () => {
  const groups = makeGroups();
  const rows = registryRows(groups, { actions: [], questionnaire, rules, calendar, t, today: TODAY });
  assert.equal(rows[0].people_count, '< 5 déclarations ; collègues concernés : 6 à 15');
  assert.equal(rows[2].people_count, '< 5 déclarations');
});

test('libellés de repli identiques à src/i18n/fr/common.json', () => {
  const common = JSON.parse(readFileSync(new URL('../src/i18n/fr/common.json', import.meta.url), 'utf8'));
  assert.deepEqual(FALLBACK_LABELS.ai_act, common.levels.ai_act);
  assert.deepEqual(FALLBACK_LABELS.data, [0, 1, 2, 3].map((n) => common.levels.data[n]));
  assert.deepEqual(FALLBACK_LABELS.validation, common.validation);
  assert.deepEqual(FALLBACK_LABELS.action_status, common.action_status);
  assert.deepEqual(FALLBACK_LABELS.priority, common.priority);
  assert.equal(FALLBACK_LABELS.disclaimer, common.disclaimer);
});

test('registryRows : jamais d’identité de répondant ni de commentaire', () => {
  const text = JSON.stringify(rowsFor('open'));
  for (const s of ['Jeanne', 'Dupont', 'jeanne.dupont', '@exemple.fr', 'confidentiel', 'Durand']) {
    assert.ok(!text.includes(s), `fuite : ${s}`);
  }
});

// CDC §7.4 : les commentaires libres « peuvent être exclus des exports » (option de campagne).
test('registryRows : commentaires libres seulement si la campagne l’autorise', () => {
  const withComments = (mode) => makeCampaign(mode, { settings: { ...makeCampaign(mode).settings, comments_exportable: true } });
  assert.equal(registryColumns(makeCampaign()), REGISTRY_COLUMNS, 'défaut : les 20 colonnes du §8.2');
  assert.equal(registryColumns(undefined), REGISTRY_COLUMNS);
  const cols = registryColumns(withComments('anonymous'));
  assert.deepEqual(cols.slice(0, 20), [...REGISTRY_COLUMNS], 'ordre du §8.2 conservé');
  assert.deepEqual(cols[20], { key: 'comments', label: 'Commentaires' });
  assert.ok(Object.isFrozen(cols));
  for (const row of rowsFor('open')) assert.ok(!('comments' in row), 'option inactive : aucune colonne');

  const groups = makeGroups({ open: true });
  groups[0].members[1].usage.comment = '  =1+1\u202E commentaire\ntest  ';
  groups[0].members[2].excluded = true;
  groups[0].members[2].usage.comment = 'Commentaire d’une déclaration écartée';
  const rows = registryRows(groups, { campaign: withComments('open'), actions: [], questionnaire, rules, calendar, t, today: TODAY });
  assert.deepEqual(Object.keys(rows[0]), cols.map((c) => c.key));
  assert.equal(rows[0].comments, 'Commentaire confidentiel sur Mme Durand ; =1+1 commentaire test',
    'nettoyé (contrôles, retours à la ligne), sans doublon, déclarations écartées ignorées');
  assert.equal(rows[1].comments, 'Commentaire confidentiel sur Mme Durand', 'sept fois le même commentaire : une seule fois');
  const csv = toCSV([{ ...rows[0], comments: '=1+1 commentaire test' }], cols);
  assert.ok(csv.split('\r\n')[1].endsWith(";'=1+1 commentaire test"), 'neutralisé dans le CSV');
  for (const s of ['Jeanne', 'Dupont', 'jeanne.dupont']) assert.ok(!JSON.stringify(rows).includes(s), `jamais d’identité : ${s}`);
});

test('commentsText : borné, mention des commentaires non repris', () => {
  const members = Array.from({ length: 10 }, (_, i) => ({ usage: { comment: `${i}`.repeat(400) } }));
  const text = commentsText({ members });
  assert.ok(text.length <= COMMENTS_MAX_CHARS + 40, `${text.length} caractères`);
  assert.ok(text.endsWith('… (6 commentaires non repris)'), text.slice(-40));
  assert.equal(commentsText({ members: [...members.slice(0, 5), { usage: { comment: '' } }, { usage: {} }, null] }).endsWith('… (1 commentaire non repris)'), true);
  assert.equal(commentsText({ members: [] }), '');
  assert.equal(commentsText(undefined), '');
});

test('registryRows : repli sur les libellés intégrés sans t ni questionnaire', () => {
  const groups = makeGroups();
  const [g1] = registryRows(groups, { campaign: makeCampaign(), actions: makeActions(groups), today: TODAY });
  assert.equal(g1.ai_act_level, 'Haut risque');
  assert.equal(g1.data_level, '3 — Critique (surchargé)');
  assert.equal(g1.validation_status, 'Validé');
  assert.equal(g1.tool, 'embedded_software_ai', 'valeur brute sans questionnaire');
  assert.ok(g1.actions.includes('(En cours)'));
  assert.deepEqual(registryRows([], {}), []);
});

test('registre en CSV : en-tête §8.2 et cellules neutralisées', () => {
  const csv = toCSV(rowsFor('anonymous'), REGISTRY_COLUMNS);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], REGISTRY_COLUMNS.map((c) => c.label).join(';'));
  assert.ok(lines[2].includes(";'=1+1;"), 'nom d’usage neutralisé');
  assert.ok(lines[2].includes('"\'=HYPERLINK(""http://exemple.invalid"",""clic"") (À faire)"'), 'action neutralisée et guillemets doublés');
});

test('utilitaires : dates FR, slug, noms de fichiers', () => {
  assert.equal(formatDateFr('2027-12-02'), '02/12/2027');
  assert.equal(formatDateFr('2026-09-20T12:00:00.000Z'), '20/09/2026');
  assert.equal(formatDateFr(''), '');
  assert.equal(toDay('2026-09-29'), '2026-09-29');
  assert.equal(toDay(new Date(2026, 0, 5)), '2026-01-05');
  assert.match(toDay(new Date('invalide')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatDateFr('n’importe quoi'), '');
  assert.equal(slugify('Recensement IA 2026 — Été !'), 'recensement-ia-2026-ete');
  assert.equal(slugify('   '), 'campagne');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
  assert.equal(exportFilename('registre', { title: 'Mon registre' }, TODAY, 'xlsx'), 'recensia-registre-mon-registre-2026-09-29.xlsx');
});

// ---------------------------------------------------------------- XLSX

function readBack(wb) {
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  return XLSX.read(out, { type: 'array' });
}

function sheetRows(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
}

// Tableau du registre : de l'en-tête jusqu'à la première ligne vide (la mention suit).
function registryTable(wb) {
  const rows = sheetRows(wb, 'Registre');
  const blank = rows.findIndex((r) => r.every((c) => c === ''));
  return blank === -1 ? rows : rows.slice(0, blank);
}

function buildSample(mode = 'anonymous') {
  const groups = makeGroups({ open: mode === 'open' });
  return buildWorkbook({
    campaign: makeCampaign(mode), groups, actions: makeActions(groups), stats: makeStats(), rules, calendar,
    questionnaire, t, today: TODAY,
  });
}

test('classeur : 4 feuilles, relu par SheetJS', async () => {
  const wb = buildSample();
  assert.deepEqual(wb.SheetNames, ['Registre', "Plan d'actions", 'Synthèse', 'Référentiel']);
  assert.deepEqual(Object.values(SHEET_NAMES), wb.SheetNames);
  const blob = workbookBlob(wb);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, XLSX_MIME);
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b], 'archive ZIP');
  const back = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(back.SheetNames, wb.SheetNames);
  const reg = registryTable(back);
  assert.deepEqual(reg[0], REGISTRY_COLUMNS.map((c) => c.label));
  assert.equal(reg.length, 4, 'en-tête + 3 usages');
  assert.equal(reg[1][0], 'U-00A1B2');
  assert.equal(reg[1][10], '< 5 déclarations ; collègues concernés : 6 à 15');
  const all = sheetRows(back, 'Registre');
  assert.equal(all.length, 6, 'une ligne vide puis la mention sous le tableau');
  assert.equal(all[5][0], 'Classification indicative, à confirmer. Registre exporté le 29/09/2026.');
});

test('classeur : toutes les cellules texte neutralisées, aucune formule', () => {
  const back = readBack(buildSample());
  for (const name of back.SheetNames) {
    const ws = back.Sheets[name];
    for (const [addr, c] of Object.entries(ws)) {
      if (addr.startsWith('!')) continue;
      assert.equal(c.f, undefined, `formule en ${name}!${addr}`);
      if (c.t === 's') {
        assert.ok(!/^\s*[=+\-@]/.test(c.v) && !/^[\t\r]/.test(c.v), `cellule non neutralisée ${name}!${addr} : ${c.v}`);
      }
    }
  }
  const reg = sheetRows(back, 'Registre');
  assert.equal(reg[2][2], "'=1+1");
  const acts = sheetRows(back, "Plan d'actions");
  const flat = acts.flat();
  assert.ok(flat.includes('\'=HYPERLINK("http://exemple.invalid","clic")'));
  assert.ok(flat.includes("'@SUM(A1:A2)"));
  assert.ok(flat.includes("'+33 6 00 00 00 00"));
  assert.ok(flat.includes("'-2+3+cmd|' /C calc'!A0"));
});

test('classeur : contenus hostiles neutralisés dans les quatre feuilles (Synthèse et Référentiel compris)', () => {
  const groups = makeGroups();
  groups[0].departments = ['@Service'];
  const hostileRules = {
    version: '=version()',
    rules: rules.rules.map((r) => (r.id === 'R-AIA-HI-EMP' ? { ...r, label: '=règle()', legal_ref: '+réf' } : r)),
  };
  const hostileCalendar = {
    version: '+2026',
    last_verified: '2026-09-15',
    deadlines: [{ id: '-id', date: '2027-12-02', label: '@échéance', status: '=statut', source_url: '=HYPERLINK("http://exemple.invalid")' }],
  };
  const stats = makeStats();
  stats.top_tools[0].label = '-outil';
  stats.by_department[0].department = '=RH';
  stats.upcoming_deadlines = [{ id: 'x', date: '2027-12-02', label: '\t@échéance à venir' }];
  const campaign = makeCampaign('anonymous', { title: '=cmd|\' /C calc\'!A0', org_name: '+Organisation' });
  const wb = buildWorkbook({
    campaign, groups, actions: makeActions(groups), stats, rules: hostileRules, calendar: hostileCalendar, questionnaire, t, today: TODAY,
  });
  const back = readBack(wb);
  let hostile = 0;
  for (const name of back.SheetNames) {
    for (const [addr, c] of Object.entries(back.Sheets[name])) {
      if (addr.startsWith('!')) continue;
      assert.equal(c.f, undefined, `formule en ${name}!${addr}`);
      if (c.t !== 's') continue;
      assert.ok(!/^[\s\u00a0]*[=+\-@]/.test(c.v) && !/^[\t\r]/.test(c.v), `cellule non neutralisée ${name}!${addr} : ${c.v}`);
      if (/^'[\s]*[=+\-@]/.test(c.v)) hostile += 1;
    }
  }
  const flat = (name) => sheetRows(back, name).flat();
  for (const v of ["'=cmd|' /C calc'!A0", "'+Organisation", "'-outil", "'=RH", "'\t@échéance à venir"]) {
    assert.ok(flat('Synthèse').includes(v), `Synthèse : ${v}`);
  }
  for (const v of ["'=version()", "'+2026", "'=règle()", "'+réf", "'-id", "'@échéance", '\'=HYPERLINK("http://exemple.invalid")']) {
    assert.ok(flat('Référentiel').includes(v), `Référentiel : ${v}`);
  }
  // Un statut inconnu n'est jamais recopié tel quel : libellé neutre.
  assert.ok(!flat('Référentiel').some((v) => String(v).includes('statut')), 'statut brut absent');
  assert.ok(flat('Référentiel').includes('À venir (vérification non précisée)'));
  assert.ok(flat('Registre').includes("'@Service"));
  assert.ok(hostile >= 16, `contenus hostiles effectivement exercés : ${hostile}`);
});

test('classeur : largeurs de colonnes et filtres', () => {
  const wb = buildSample();
  for (const name of wb.SheetNames) {
    const cols = wb.Sheets[name]['!cols'];
    assert.ok(Array.isArray(cols) && cols.length > 0, `largeurs ${name}`);
    assert.ok(cols.every((c) => c.wch >= 8 && c.wch <= 60), `bornes ${name}`);
  }
  assert.equal(wb.Sheets.Registre['!cols'].length, 20);
  assert.equal(wb.Sheets.Registre['!autofilter'].ref, 'A1:T4');
  assert.equal(wb.Sheets["Plan d'actions"]['!autofilter'].ref, 'A1:M5');
});

test('classeur : plan d’actions trié et lisible', () => {
  const acts = sheetRows(readBack(buildSample()), "Plan d'actions");
  assert.deepEqual(acts[0], ['ID', 'Action', 'Description', 'Usage lié', "Modèle d'action", 'Priorité', 'Statut',
    'Responsable', 'Échéance', 'Rôle suggéré', 'Origine', 'Créée le', 'Mise à jour le']);
  assert.deepEqual(acts.slice(1).map((r) => r[0]), ['a2', 'a4', 'a1', 'a3'], 'à faire (priorité), en cours, fait');
  const a1 = acts.find((r) => r[0] === 'a1');
  assert.equal(a1[3], 'U-00A1B2 — Tri automatique de CV');
  assert.equal(a1[5], 'Haute');
  assert.equal(a1[6], 'En cours');
  assert.equal(a1[8], '15/12/2026');
  assert.equal(a1[10], "Issue d'une suggestion", 'action acceptée depuis une suggestion');
  assert.equal(acts.find((r) => r[0] === 'a3')[3], 'Transverse (toute l’organisation)');
  assert.equal(acts.find((r) => r[0] === 'a3')[10], 'Ajoutée manuellement');
  assert.ok(!acts.flat().includes('Suggérée'), 'plus de « Suggérée » dans le plan');
});

test('classeur : vocabulaire aligné sur l’interface (origine des actions, IA fantôme)', () => {
  // Libellés de la liste du plan d'actions (src/i18n/fr/actions.json, item.*), espaces normalisés.
  const catalog = JSON.parse(readFileSync(new URL('../src/i18n/fr/actions.json', import.meta.url), 'utf8'));
  const plain = (s) => String(s).replace(/[\u00a0\u202f]/g, ' ');
  assert.equal(ACTION_ORIGIN.suggestion, plain(catalog.item.from_suggestion));
  assert.equal(ACTION_ORIGIN.manual, plain(catalog.item.manual));
  assert.equal(originLabel({ suggested: true }), ACTION_ORIGIN.suggestion);
  for (const a of [{ suggested: false }, {}, null, undefined]) assert.equal(originLabel(a), ACTION_ORIGIN.manual);
  // Synthèse : « IA fantôme (shadow AI) », comptes « personnels ou non maîtrisés » (tableau de bord, rapport).
  const dashboard = JSON.parse(readFileSync(new URL('../src/i18n/fr/dashboard.json', import.meta.url), 'utf8'));
  const report = JSON.parse(readFileSync(new URL('../src/i18n/fr/report.json', import.meta.url), 'utf8'));
  assert.ok(plain(JSON.stringify(report)).includes(SHADOW_AI_SECTION), 'glose du rapport');
  assert.ok(plain(JSON.stringify(dashboard)).toLowerCase().includes('personnels ou non maîtrisés'));
  assert.ok(SHADOW_AI_LABEL.endsWith('personnels ou non maîtrisés'));
  const flat = sheetRows(readBack(buildSample()), 'Synthèse').flat().map(String);
  assert.ok(!flat.some((v) => /non identifiés|^shadow ai$/i.test(v)), 'ni « non identifiés » ni « Shadow AI » seul');
});

test('classeur : synthèse avec effectifs masqués et mention indicative', () => {
  const rows = sheetRows(readBack(buildSample()), 'Synthèse');
  const find = (section, label) => rows.find((r) => r[0] === section && r[1] === label)?.[2];
  assert.deepEqual(rows[0], ['Rubrique', 'Indicateur', 'Valeur']);
  assert.equal(find('Campagne', 'Mode'), 'Anonyme');
  assert.equal(find('Campagne', "Date d'export"), '29/09/2026');
  assert.equal(find('Volumes', 'Usages recensés (lignes du registre)'), 3);
  assert.equal(find('Niveau AI Act', 'Haut risque'), 1);
  assert.equal(find('Exposition des données', '3 — Critique'), 1);
  assert.equal(find('Répartition par service', 'RH'), '< 5');
  assert.equal(find('Principaux outils', 'IA intégrée à un logiciel'), '< 5');
  assert.equal(find('IA fantôme (shadow AI)', 'Usages sur comptes personnels ou non maîtrisés'), '1 (33 %)');
  assert.equal(find("Plan d'actions", 'Suggestions en attente'), 2);
  assert.equal(find('Échéances à venir', '02/12/2027'), 'Haut risque — annexe III');
  assert.ok(rows.some((r) => String(r[2]).startsWith('Indicatif, à confirmer')));
});

test('classeur : référentiel (règles utilisées, calendrier, versions, mention)', () => {
  const rows = sheetRows(readBack(buildSample()), 'Référentiel');
  const value = (label) => rows.find((r) => r[0] === label)?.[1];
  assert.ok(String(value('Mention')).startsWith('Indicatif, à confirmer'));
  assert.equal(value('Version des règles'), '2026-09-15');
  assert.equal(value('Version du calendrier'), '2026.09');
  assert.equal(value('Calendrier vérifié le'), '15/09/2026');
  assert.equal(value("Date d'export"), '29/09/2026');
  const ruleHeader = rows.findIndex((r) => r[0] === 'ID' && r[1] === 'Axe');
  const calHeader = rows.findIndex((r) => r[0] === 'ID' && r[1] === 'Date');
  assert.ok(ruleHeader > 0 && calHeader > ruleHeader);
  const used = rows.slice(ruleHeader + 1, calHeader - 2);
  assert.deepEqual(used.map((r) => r[0]), ['R-AIA-HI-EMP', 'R-AIA-LIM-02', 'R-AIA-PRV-01', 'R-AIA-LIT', 'R-DATA-PERSO'],
    'seules les règles déclenchées, dans l’ordre du référentiel');
  const lit = used.find((r) => r[0] === 'R-AIA-LIT');
  assert.deepEqual(lit.slice(0, 6), ['R-AIA-LIT', 'AI Act', '—', 'Littératie IA', 'art. 4', 2]);
  assert.deepEqual(used.find((r) => r[0] === 'R-AIA-HI-EMP').slice(0, 3), ['R-AIA-HI-EMP', 'AI Act', 'Haut risque']);
  assert.equal(used.find((r) => r[0] === 'R-DATA-PERSO')[2], 'Modificateur +1');
  const cal = rows.slice(calHeader + 1);
  assert.equal(cal.length, 4);
  assert.deepEqual(rows[calHeader], ['ID', 'Date', 'Libellé', 'Statut', 'Concerne', 'Source', 'Dernière vérification']);
  assert.deepEqual(cal[3], ['annex3', '02/12/2027', 'Haut risque — annexe III', 'À venir', '',
    'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', '15/09/2026']);
  assert.equal(cal[2][3], 'En vigueur', 'art. 50 : date passée au jour de l’export');
  assert.equal(cal[2][6], '15/09/2026', 'date de vérification globale en repli');
});

test('classeur : statut du calendrier réel en français, jamais la clé brute', () => {
  const real = loadCalendar();
  for (const d of real.deadlines) assert.ok(Object.hasOwn(CALENDAR_STATUS, d.status), `${d.id} : statut « ${d.status} » sans libellé`);
  const wb = buildWorkbook({ campaign: makeCampaign(), groups: [], calendar: real, rules, today: '2026-09-30' });
  const rows = sheetRows(readBack(wb), 'Référentiel');
  const calHeader = rows.findIndex((r) => r[0] === 'ID' && r[1] === 'Date');
  const cal = rows.slice(calHeader + 1);
  assert.equal(cal.length, real.deadlines.length);
  const keys = new Set(real.deadlines.map((d) => d.status));
  for (const r of cal) {
    assert.ok(!keys.has(r[3]), `${r[0]} : statut brut « ${r[3]} »`);
    assert.match(r[3], /^(En vigueur|À venir)( \(.+\))?$/, r[0]);
  }
  const byId = Object.fromEntries(cal.map((r) => [r[0], r]));
  assert.equal(byId.transparency_art50[3], 'En vigueur');
  assert.equal(byId.marking_grace_art50_2[3], 'À venir');
  assert.equal(byId.marking_grace_art50_2[4], 'Fournisseurs uniquement');
  assert.equal(byId.high_risk_annex_iii[4], '', 'sans restriction de rôle : cellule vide');
  assert.equal(calendarStatusText({ date: '2027-12-02', status: 'to_verify' }, '2026-09-30'), 'À venir (à vérifier)');
  assert.equal(calendarStatusText({ date: '2026-09-30', status: 'verified' }, '2026-09-30'), 'À venir', 'le jour même : encore à venir');
  assert.equal(calendarStatusText({ date: '2026-09-29', status: 'inconnu' }, '2026-09-30'), 'En vigueur (vérification non précisée)');
  assert.equal(calendarStatusText({ status: 'verified' }, '2026-09-30'), 'Date non précisée');
});

test('classeur : colonne « Commentaires » et mention si la campagne l’autorise', () => {
  const groups = makeGroups();
  groups[1].members[0].usage.comment = '=1+1 commentaire test';
  const campaign = makeCampaign('anonymous', { settings: { ...makeCampaign().settings, comments_exportable: true } });
  const wb = buildWorkbook({ campaign, groups, actions: [], stats: makeStats(), rules, calendar, questionnaire, t, today: TODAY });
  assert.equal(wb.Sheets.Registre['!autofilter'].ref, 'A1:U4');
  const back = readBack(wb);
  const reg = registryTable(back);
  assert.equal(reg[0].length, 21);
  assert.equal(reg[0][20], 'Commentaires');
  assert.equal(reg[2][20], "'=1+1 commentaire test", 'neutralisé');
  const all = sheetRows(back, 'Registre');
  assert.ok(all.some((r) => String(r[0]).startsWith('Commentaires libres inclus : même en mode anonyme')), 'avertissement');
  const summary = sheetRows(back, 'Synthèse');
  assert.equal(summary.find((r) => r[1] === 'Commentaires libres')[2], 'Inclus dans le registre');
  const off = readBack(buildSample());
  assert.equal(sheetRows(off, 'Synthèse').find((r) => r[1] === 'Commentaires libres')[2], 'Exclus des exports');
  assert.equal(registryTable(off)[0].length, 20);
});

test('classeur : mode ouvert sans identité ni commentaire', () => {
  const back = readBack(buildSample('open'));
  const all = back.SheetNames.map((n) => JSON.stringify(sheetRows(back, n))).join('\n');
  for (const s of ['Jeanne', 'Dupont', 'jeanne.dupont', 'confidentiel']) assert.ok(!all.includes(s), `fuite : ${s}`);
  const reg = registryTable(back);
  assert.equal(reg[1][10], '3 déclarations ; collègues concernés : 6 à 15');
});

test('classeur : paramètres minimaux (sans stats, sans actions)', () => {
  const wb = buildWorkbook({ campaign: makeCampaign(), groups: [], today: TODAY });
  const back = readBack(wb);
  assert.equal(back.SheetNames.length, 4);
  assert.equal(registryTable(back).length, 1);
  assert.equal(wb.Sheets.Registre['!autofilter'].ref, 'A1:T1');
  assert.ok(sheetRows(back, 'Registre').at(-1)[0].startsWith('Classification indicative, à confirmer'), 'mention présente');
});

// ---------------------------------------------------------------- intégration moteur

test('intégration : groupes produits par consolidate() et stats de computeStats()', () => {
  const engineRules = {
    version: 'test',
    rules: [
      { id: 'R-T-HI', axis: 'ai_act', kind: 'level', level: 'high', label: 'Tri de personnes', legal_ref: 'annexe III',
        condition: { field: 'task_types', includes_any: ['evaluation_tri_personnes'] }, action_ids: ['ACT-HR-01'], deadline_ids: ['annex3'] },
      { id: 'R-T-MIN', axis: 'ai_act', kind: 'level', level: 'minimal', label: 'Aucune autre règle', legal_ref: '—',
        fallback: true, condition: { all: [] } },
    ],
    data_base: { docs_internes: 1, donnees_candidats: 2 },
  };
  const entries = [
    makeEntry(CID, 'a1', { usage: makeUsage({ task_types: ['evaluation_tri_personnes'], business_domain: 'rh', data_types: ['donnees_candidats'] }) }),
    makeEntry(CID, 'a2', { usage: makeUsage({ task_types: ['evaluation_tri_personnes'], business_domain: 'rh', data_types: ['donnees_candidats'] }) }),
    makeEntry(CID, 'b1', { usage: makeUsage() }),
  ];
  const groups = consolidate(entries, engineRules, calendar, {});
  const campaign = makeCampaign();
  const rows = registryRows(groups, { campaign, actions: [], questionnaire, rules: engineRules, calendar, t, today: TODAY });
  assert.equal(rows.length, 2);
  const hi = rows.find((r) => r.ai_act_level === 'Haut risque');
  assert.ok(hi, 'groupe haut risque');
  assert.equal(hi.people_count, '< 5 déclarations', 'fourchette 2 à 5 < k : retirée');
  assert.equal(hi.rules, 'R-T-HI (annexe III)');
  assert.equal(hi.deadline, '02/12/2027 — Haut risque — annexe III');
  const stats = computeStats({ campaign, entries, groups, actions: [], suggestions: [], calendar, today: TODAY, questionnaire });
  const back = readBack(buildWorkbook({ campaign, groups, actions: [], stats, rules: engineRules, calendar, questionnaire, t, today: TODAY }));
  assert.equal(registryTable(back).length, 3);
});

// ---------------------------------------------------------------- JSON

async function storeWithCampaign(keys) {
  const s = await openStore({ forceMemory: true, appVersion: '0.9.0' });
  await seedCampaign(s, 'campA', keys, { entries: 3, actions: 2 });
  return s;
}

test('export JSON sans mot de passe : sauvegarde en clair sans clé privée', async () => {
  const keys = await makeKeys();
  const s = await storeWithCampaign(keys);
  const blob = await exportJson(s, 'campA');
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'application/json');
  const text = await blob.text();
  assert.ok(!text.includes('"d"'), 'aucun "d" de JWK');
  assert.ok(!text.includes(keys.private_key_jwk.d), 'aucune trace de la clé privée');
  const obj = JSON.parse(text);
  assert.equal(obj.format, 'recensia-backup');
  assert.equal(obj.v, 1);
  assert.equal(obj.app_version, '0.9.0');
  assert.ok(!('private_key_jwk' in obj.campaign));
  assert.equal(obj.entries.length, 3);
  const c = await s.getCampaign('campA');
  assert.ok(c.last_backup_at && !Number.isNaN(Date.parse(c.last_backup_at)), 'date de sauvegarde inscrite');
  assert.deepEqual(c.private_key_jwk, keys.private_key_jwk, 'clé privée conservée localement');
});

test('export JSON avec mot de passe : enveloppe chiffrée incluant la clé privée', async () => {
  const keys = await makeKeys();
  const s = await storeWithCampaign(keys);
  const blob = await exportJson(s, 'campA', { password: 'correct horse battery staple' });
  const text = await blob.text();
  const env = JSON.parse(text);
  assert.equal(env.format, 'recensia-encrypted');
  assert.ok(!text.includes('"d"') && !text.includes(keys.private_key_jwk.d), 'rien en clair');
  assert.ok(!text.includes('Recensement'), 'contenu chiffré');

  const target = await openStore({ forceMemory: true });
  await assert.rejects(importJson(text, '', target), { code: 'password_required' });
  await assert.rejects(importJson(text, 'mauvais', target), { code: 'wrong_password' });
  const res = await importJson(text, 'correct horse battery staple', target);
  assert.deepEqual(res, { campaign_id: 'campA', entries: 3, assessments: 1, actions: 2, encrypted: true });
  const c = await target.getCampaign('campA');
  assert.deepEqual(c.private_key_jwk, keys.private_key_jwk, 'clé privée restaurée');
  assert.equal((await target.listEntries('campA')).length, 3);
});

test('import JSON clair : aller-retour, conflit, écrasement sans perte de clé', async () => {
  const keys = await makeKeys();
  const s = await storeWithCampaign(keys);
  const text = await (await exportJson(s, 'campA', { markBackup: false })).text();
  const fresh = await openStore({ forceMemory: true });
  const res = await importJson(`\uFEFF${text}`, null, fresh);
  assert.deepEqual(res, { campaign_id: 'campA', entries: 3, assessments: 1, actions: 2, encrypted: false });
  assert.equal((await fresh.getCampaign('campA')).private_key_jwk, null);

  await assert.rejects(importJson(text, null, s), { code: 'conflict' });
  const res2 = await importJson(text, null, s, { overwrite: true });
  assert.equal(res2.entries, 3);
  assert.deepEqual((await s.getCampaign('campA')).private_key_jwk, keys.private_key_jwk, 'clé existante non écrasée');

  const blobRes = await importJson(new Blob([text]), undefined, await openStore({ forceMemory: true }));
  assert.equal(blobRes.campaign_id, 'campA', 'Blob / File accepté');
});

test('sauvegarde JSON : le fichier porte la date de cette sauvegarde ; restaurée, la campagne l’affiche', async () => {
  const s = await storeWithCampaign(await makeKeys());
  const before = '2026-09-01T08:00:00.000Z';
  await s.putCampaign({ ...(await s.getCampaign('campA')), last_backup_at: before });

  // Sans marquage : le fichier garde la date précédente, le store n'est pas modifié.
  const unmarked = JSON.parse(await (await exportJson(s, 'campA', { markBackup: false })).text());
  assert.equal(unmarked.campaign.last_backup_at, before);
  assert.equal((await s.getCampaign('campA')).last_backup_at, before);

  const obj = JSON.parse(await (await exportJson(s, 'campA')).text());
  assert.ok(Date.parse(obj.exported_at) > Date.parse(before));
  assert.equal(obj.campaign.last_backup_at, obj.exported_at, 'date de cette sauvegarde dans le fichier');
  assert.equal((await s.getCampaign('campA')).last_backup_at, obj.exported_at, 'même date dans le store');
  const restored = await openStore({ forceMemory: true });
  await importJson(JSON.stringify(obj), null, restored);
  assert.equal((await restored.getCampaign('campA')).last_backup_at, obj.exported_at, 'plus « jamais » après restauration');

  // Sauvegarde chiffrée : même date, lue après déchiffrement.
  const password = 'correct horse battery staple';
  const env = await (await exportJson(s, 'campA', { password })).text();
  const stamp = (await s.getCampaign('campA')).last_backup_at;
  assert.ok(Date.parse(stamp) >= Date.parse(obj.exported_at));
  const target = await openStore({ forceMemory: true });
  await importJson(env, password, target);
  assert.equal((await target.getCampaign('campA')).last_backup_at, stamp);
});

test('restauration d’une sauvegarde antérieure : date du fichier retenue si plus récente', async () => {
  const s = await storeWithCampaign(null);
  const legacy = await s.exportCampaignData('campA');
  const exportedAt = '2026-09-20T10:00:00.000Z';
  const restore = async (last) => {
    const target = await openStore({ forceMemory: true });
    const data = structuredClone(legacy);
    data.exported_at = exportedAt;
    data.campaign.last_backup_at = last;
    await importJson(JSON.stringify(data), null, target);
    return (await target.getCampaign('campA')).last_backup_at;
  };
  assert.equal(await restore(null), exportedAt, 'jamais sauvegardée avant ce fichier');
  assert.equal(await restore('2026-09-10T10:00:00.000Z'), exportedAt, 'date de la sauvegarde précédente remplacée');
  assert.equal(await restore('2026-09-25T10:00:00.000Z'), '2026-09-25T10:00:00.000Z', 'date plus récente conservée');
  const bad = structuredClone(legacy);
  bad.campaign.last_backup_at = 'hier';
  await assert.rejects(importJson(JSON.stringify(bad), null, await openStore({ forceMemory: true })), { code: 'invalid_backup' });
  // Le store garde l'aller-retour brut : exportCampaignData / importCampaignData ne touchent pas la date.
  const raw = await openStore({ forceMemory: true });
  await raw.importCampaignData(legacy);
  assert.equal((await raw.getCampaign('campA')).last_backup_at, legacy.campaign.last_backup_at);
});

test('import JSON : fichiers refusés avec un code explicite', async () => {
  const s = await openStore({ forceMemory: true });
  await assert.rejects(importJson('{pas du json', null, s), { code: 'invalid_json' });
  await assert.rejects(importJson(42, null, s), { code: 'invalid_json' });
  await assert.rejects(importJson('{"format":"autre"}', null, s), { code: 'invalid_backup' });
  await assert.rejects(importJson('[]', null, s), { code: 'invalid_backup' });
  await assert.rejects(importJson(JSON.stringify({ format: 'recensia-key', v: 1 }), null, s), { code: 'recovery_file' });
  await assert.rejects(importJson(JSON.stringify({ format: 'recensia-encrypted', v: 1 }), 'x', s), { code: 'invalid_backup' });
  assert.equal((await s.listCampaigns()).length, 0);
});

test('export JSON : données non réimportables refusées avant toute production', async () => {
  const s = await storeWithCampaign(null);
  const c = await s.getCampaign('campA');
  await s.putCampaign({ ...c, mode: 'public' });
  const err = await exportJson(s, 'campA').then(() => null, (e) => e);
  assert.ok(err, 'export refusé');
  assert.equal(err.code, 'invalid_backup');
  assert.ok(err.message.includes('campaign.mode'), err.message);
  assert.deepEqual(err.details, [{ path: 'campaign.mode', code: 'enum' }]);
  assert.equal((await s.getCampaign('campA')).last_backup_at, null, 'aucune date de sauvegarde inscrite');
  await assert.rejects(exportJson(s, 'campA', { password: 'secret' }), { code: 'invalid_backup' });
});

test('import JSON : fichier manifestement trop gros refusé sans être lu', async () => {
  const s = await openStore({ forceMemory: true });
  const huge = { size: MAX_IMPORT_CHARS * 3 + 1, text() { throw new Error('ne doit pas être lu'); } };
  await assert.rejects(importJson(huge, null, s), { code: 'too_large' });
  await assert.rejects(importJson('x'.repeat(MAX_IMPORT_CHARS + 1), null, s), { code: 'too_large' });
});

test('intégration : la campagne de démonstration se sauvegarde et se réimporte', { skip: !existsSync(DEMO_URL) }, async () => {
  const demo = JSON.parse(readFileSync(DEMO_URL, 'utf8'));
  const cid = demo.campaign.id;
  const s = await openStore({ forceMemory: true });
  await s.putCampaign(demo.campaign);
  await s.putEntries(demo.entries.map((e) => ({ ...e, campaign_id: cid })));
  await s.putActions(demo.actions ?? []);
  for (const a of demo.assessments ?? []) await s.putAssessment(a);
  const backup = await s.exportCampaignData(cid);
  assert.deepEqual(validateBackup(backup), { ok: true, errors: [] });
  const text = await (await exportJson(s, cid, { markBackup: false })).text();
  const target = await openStore({ forceMemory: true });
  const res = await importJson(text, null, target);
  assert.equal(res.entries, demo.entries.length);
  assert.deepEqual(await target.listEntries(cid), await s.listEntries(cid));
});

test('backupFilename : recensia-sauvegarde-<slug>-<AAAA-MM-JJ>.json', () => {
  assert.equal(backupFilename({ title: 'Recensement IA 2026 — Été !' }, '2026-09-29'),
    'recensia-sauvegarde-recensement-ia-2026-ete-2026-09-29.json');
  assert.equal(backupFilename({ id: 'k3J9xQ2mP0aZ', title: '' }, new Date(2026, 0, 5)),
    'recensia-sauvegarde-k3j9xq2mp0az-2026-01-05.json');
  assert.match(backupFilename({}, TODAY), /^recensia-sauvegarde-campagne-2026-09-29\.json$/);
});
