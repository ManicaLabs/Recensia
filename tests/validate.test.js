// Validation stricte des usages et des répondants.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION, validateUsage, validateRespondent, cleanLine, cleanMultiline } from '../src/engine/validate.js';
import { loadQuestionnaire, makeUsage } from './helpers/load-data.js';
import { sanitizeText } from '../src/share/channels.js';
import { validateCampaignConfig, hasForbiddenChars } from '../src/crypto/link.js';
import { generateCampaignKeys } from '../src/crypto/keys.js';

const questionnaire = loadQuestionnaire();
const DEPTS = ['Direction', 'Commercial et devis', 'Production'];
const ANON = { departments: DEPTS, department_required: false, mode: 'anonymous' };
const OPEN = { departments: DEPTS, department_required: false, mode: 'open' };

// Caractères construits par code (jamais écrits en clair dans le source).
const ch = (code) => String.fromCharCode(code);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const ZWSP = ch(0x200b);
const NUL = ch(0x00);
const BEL = ch(0x07);
const ESC = ch(0x1b);
const C1 = ch(0x85);
const LS = ch(0x2028);

function codes(result) {
  return result.errors.map((e) => `${e.field}:${e.code}`).sort();
}

describe('validateUsage : cas nominaux', () => {
  test('SCHEMA_VERSION identique au questionnaire', () => {
    assert.equal(SCHEMA_VERSION, 1);
    assert.equal(questionnaire.schema_version, SCHEMA_VERSION);
  });

  test('usage complet valide', () => {
    const r = validateUsage(makeUsage({ department: 'Direction' }), questionnaire, ANON);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.department, 'Direction');
  });

  test('champs facultatifs absents ⇒ null, toutes les clés présentes', () => {
    const u = makeUsage();
    for (const k of ['department', 'tool_other', 'model', 'users_count', 'comment']) delete u[k];
    const r = validateUsage(u, questionnaire, ANON);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(Object.keys(r.value).sort(), Object.keys(questionnaire.fields).sort());
    for (const k of ['department', 'tool_other', 'model', 'users_count', 'comment']) assert.equal(r.value[k], null, k);
  });

  test('chaînes vides facultatives ⇒ null', () => {
    const r = validateUsage(makeUsage({ model: '   ', comment: '', department: '' }), questionnaire, ANON);
    assert.equal(r.ok, true);
    assert.equal(r.value.model, null);
    assert.equal(r.value.comment, null);
    assert.equal(r.value.department, null);
  });

  test('trim, espaces normalisés, caractères de contrôle et bidi retirés', () => {
    const r = validateUsage(makeUsage({
      usage_name: `  Reformu${RLO}lation${NUL} de${BEL}   mails${ZWSP}${ESC}${C1}  `,
      model: `\tGPT${LRI}\n4 `,
    }), questionnaire, ANON);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.usage_name, 'Reformulation de mails');
    assert.equal(r.value.model, 'GPT 4');
  });

  test('caractères de mise en forme invisibles et demi-codets isolés retirés, liants conservés', () => {
    const cp = (...codes) => String.fromCodePoint(...codes);
    const hidden = [
      String.fromCharCode(0xdc00), // demi-codet bas isolé
      cp(0xad), // trait d'union conditionnel
      cp(0x2062, 0x2063), // opérateurs invisibles
      cp(0xfff9) + 'x' + cp(0xfffb), // annotation interlinéaire (le texte annoté reste)
      cp(0x180e), // séparateur de voyelles mongol
      cp(0x206a), // mise en forme dépréciée
      cp(0xe0001, 0xe0041, 0xe0042, 0xe007f), // étiquettes Unicode (texte caché)
      String.fromCharCode(0xd800), // demi-codet haut isolé (suivi d'une lettre)
    ];
    const r = validateUsage(makeUsage({ usage_name: `Re${hidden.join('')}formuler`, comment: `a${hidden.join('')}b` }), questionnaire, ANON);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.usage_name, 'Rexformuler');
    assert.equal(r.value.comment, 'axb');
    assert.doesNotThrow(() => encodeURIComponent(r.value.usage_name));
    const emoji = `${cp(0x1f469)}${cp(0x200d)}${cp(0x1f4bb)}`;
    assert.equal(cleanLine(`${emoji} ${cp(0x1f600)}`), `${emoji} ${cp(0x1f600)}`, 'liant U+200D et paires de substitution valides conservés');
  });

  test('commentaire multiligne : sauts de ligne conservés, contrôles retirés', () => {
    const r = validateUsage(makeUsage({ comment: `  Ligne 1\r\nLigne${BEL} 2${LS}\n\n\n\nLigne 3${RLO}  ` }), questionnaire, ANON);
    assert.equal(r.ok, true);
    assert.equal(r.value.comment, 'Ligne 1\nLigne 2\n\nLigne 3');
  });

  test('listes remises dans l\'ordre du questionnaire', () => {
    const r = validateUsage(makeUsage({ task_types: ['resume', 'redaction'], data_types: ['code_source', 'docs_internes'] }), questionnaire, ANON);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.task_types, ['redaction', 'resume']);
    assert.deepEqual(r.value.data_types, ['docs_internes', 'code_source']);
  });

  test('l\'objet d\'entrée n\'est pas modifié', () => {
    const u = makeUsage({ usage_name: '  X  ', task_types: ['resume', 'redaction'] });
    const copy = structuredClone(u);
    validateUsage(u, questionnaire, ANON);
    assert.deepEqual(u, copy);
  });
});

describe('validateUsage : erreurs', () => {
  test('objet attendu', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const r = validateUsage(bad, questionnaire, ANON);
      assert.equal(r.ok, false);
      assert.deepEqual(r.errors, [{ field: null, code: 'not_object' }]);
      assert.equal(r.value, null);
    }
  });

  test('clé inconnue ⇒ erreur', () => {
    const r = validateUsage({ ...makeUsage(), prompt: 'contenu', __proto__x: 1 }, questionnaire, ANON);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ['__proto__x:unknown_field', 'prompt:unknown_field']);
    assert.equal(r.value, null);
  });

  test('champs requis manquants', () => {
    const u = makeUsage();
    for (const k of ['usage_name', 'tool', 'account_type', 'task_types', 'business_domain', 'data_types', 'frequency',
      'output_audience', 'output_review', 'affects_people', 'direct_interaction', 'biometric_emotion', 'built_or_customized', 'status']) {
      const r = validateUsage({ ...u, [k]: undefined }, questionnaire, ANON);
      assert.deepEqual(codes(r), [`${k}:required`], k);
    }
    assert.deepEqual(codes(validateUsage(makeUsage({ usage_name: '   ' }), questionnaire, ANON)), ['usage_name:required']);
    assert.deepEqual(codes(validateUsage(makeUsage({ task_types: [] }), questionnaire, ANON)), ['task_types:required']);
  });

  test('types incorrects', () => {
    assert.deepEqual(codes(validateUsage(makeUsage({ usage_name: 42 }), questionnaire, ANON)), ['usage_name:invalid_type']);
    assert.deepEqual(codes(validateUsage(makeUsage({ tool: ['chatgpt'] }), questionnaire, ANON)), ['tool:invalid_type']);
    assert.deepEqual(codes(validateUsage(makeUsage({ task_types: 'redaction' }), questionnaire, ANON)), ['task_types:invalid_type']);
    assert.deepEqual(codes(validateUsage(makeUsage({ data_types: [1] }), questionnaire, ANON)), ['data_types:invalid_type']);
    assert.deepEqual(codes(validateUsage(makeUsage({ department: 3 }), questionnaire, ANON)), ['department:invalid_type']);
    assert.deepEqual(codes(validateUsage(makeUsage({ comment: { a: 1 } }), questionnaire, ANON)), ['comment:invalid_type']);
  });

  test('valeurs hors énumération (sans tolérance de casse ni d\'espaces)', () => {
    assert.deepEqual(codes(validateUsage(makeUsage({ tool: 'ChatGPT' }), questionnaire, ANON)), ['tool:invalid_value']);
    assert.deepEqual(codes(validateUsage(makeUsage({ frequency: ' daily' }), questionnaire, ANON)), ['frequency:invalid_value']);
    assert.deepEqual(codes(validateUsage(makeUsage({ task_types: ['redaction', 'hack'] }), questionnaire, ANON)), ['task_types:invalid_value']);
    assert.deepEqual(codes(validateUsage(makeUsage({ users_count: '3' }), questionnaire, ANON)), ['users_count:invalid_value']);
  });

  test('longueurs maximales (en caractères, accents compris)', () => {
    assert.equal(validateUsage(makeUsage({ usage_name: 'é'.repeat(80) }), questionnaire, ANON).ok, true);
    assert.deepEqual(codes(validateUsage(makeUsage({ usage_name: 'é'.repeat(81) }), questionnaire, ANON)), ['usage_name:too_long']);
    assert.deepEqual(codes(validateUsage(makeUsage({ model: 'x'.repeat(81) }), questionnaire, ANON)), ['model:too_long']);
    assert.equal(validateUsage(makeUsage({ comment: 'a'.repeat(500) }), questionnaire, ANON).ok, true);
    assert.deepEqual(codes(validateUsage(makeUsage({ comment: 'a'.repeat(501) }), questionnaire, ANON)), ['comment:too_long']);
    assert.deepEqual(codes(validateUsage(makeUsage({ tool: 'other', tool_other: 'x'.repeat(81) }), questionnaire, ANON)), ['tool_other:too_long']);
  });

  test('unicité des listes et « aucune » exclusif', () => {
    assert.deepEqual(codes(validateUsage(makeUsage({ task_types: ['redaction', 'redaction'] }), questionnaire, ANON)), ['task_types:duplicate']);
    assert.deepEqual(codes(validateUsage(makeUsage({ data_types: ['aucune', 'docs_internes'] }), questionnaire, ANON)), ['data_types:exclusive']);
    assert.equal(validateUsage(makeUsage({ data_types: ['aucune'] }), questionnaire, ANON).ok, true);
  });

  test('tool_other requis si « autre », interdit sinon', () => {
    assert.deepEqual(codes(validateUsage(makeUsage({ tool: 'other', tool_other: null }), questionnaire, ANON)), ['tool_other:required']);
    assert.deepEqual(codes(validateUsage(makeUsage({ tool: 'other', tool_other: '  ' }), questionnaire, ANON)), ['tool_other:required']);
    const ok = validateUsage(makeUsage({ tool: 'other', tool_other: ' Outil de transcription ' }), questionnaire, ANON);
    assert.equal(ok.ok, true);
    assert.equal(ok.value.tool_other, 'Outil de transcription');
    assert.deepEqual(codes(validateUsage(makeUsage({ tool: 'chatgpt', tool_other: 'X' }), questionnaire, ANON)), ['tool_other:not_allowed']);
    assert.equal(validateUsage(makeUsage({ tool: 'chatgpt', tool_other: '' }), questionnaire, ANON).ok, true);
  });

  test('plusieurs erreurs rapportées ensemble', () => {
    const r = validateUsage(makeUsage({ tool: 'x', frequency: 'hourly', extra: 1 }), questionnaire, ANON);
    assert.deepEqual(codes(r), ['extra:unknown_field', 'frequency:invalid_value', 'tool:invalid_value']);
  });
});

describe('validateUsage : service', () => {
  test('mode ouvert : service obligatoire', () => {
    assert.deepEqual(codes(validateUsage(makeUsage({ department: null }), questionnaire, OPEN)), ['department:required']);
    assert.equal(validateUsage(makeUsage({ department: 'Production' }), questionnaire, OPEN).ok, true);
  });

  test('mode anonyme : selon department_required', () => {
    assert.equal(validateUsage(makeUsage({ department: null }), questionnaire, ANON).ok, true);
    const required = { ...ANON, department_required: true };
    assert.deepEqual(codes(validateUsage(makeUsage({ department: null }), questionnaire, required)), ['department:required']);
    assert.equal(validateUsage(makeUsage({ department: 'Direction' }), questionnaire, required).ok, true);
  });

  test('service fourni : doit appartenir à la liste de la campagne', () => {
    assert.deepEqual(codes(validateUsage(makeUsage({ department: 'Inconnu' }), questionnaire, ANON)), ['department:invalid_value']);
    assert.deepEqual(codes(validateUsage(makeUsage({ department: 'direction' }), questionnaire, ANON)), ['department:invalid_value']);
    const trimmed = validateUsage(makeUsage({ department: '  Commercial et devis ' }), questionnaire, ANON);
    assert.equal(trimmed.ok, true);
    assert.equal(trimmed.value.department, 'Commercial et devis');
    assert.deepEqual(codes(validateUsage(makeUsage({ department: 'Direction' }), questionnaire, { ...ANON, departments: [] })), ['department:invalid_value']);
  });

  test('campagne sans service proposé : le service n\'est pas exigé (sinon aucune réponse ne serait valide)', () => {
    const none = { departments: [], department_required: true, mode: 'open' };
    assert.equal(validateUsage(makeUsage({ department: null }), questionnaire, none).ok, true);
    assert.deepEqual(codes(validateUsage(makeUsage({ department: 'Direction' }), questionnaire, none)), ['department:invalid_value']);
    assert.deepEqual(codes(validateUsage(makeUsage({ department: null }), questionnaire, { mode: 'open' })), ['department:required'], 'sans liste : texte libre exigé en mode ouvert');
  });

  test('mode de campagne inconnu rejeté', () => {
    assert.deepEqual(validateUsage(makeUsage(), questionnaire, { ...ANON, mode: 'public' }).errors, [{ field: 'mode', code: 'invalid_mode' }]);
    assert.equal(validateUsage(makeUsage(), questionnaire, { ...ANON, mode: undefined }).ok, true, 'mode absent : règles du mode anonyme');
  });

  test('sans liste de services : texte libre limité à 80 caractères', () => {
    assert.equal(validateUsage(makeUsage({ department: 'Atelier' }), questionnaire, { mode: 'anonymous' }).ok, true);
    assert.deepEqual(codes(validateUsage(makeUsage({ department: 'x'.repeat(81) }), questionnaire, {})), ['department:too_long']);
    assert.equal(validateUsage(makeUsage(), questionnaire).ok, true);
  });
});

describe('validateRespondent', () => {
  test('anonyme : aucun répondant', () => {
    assert.deepEqual(validateRespondent(null, 'anonymous'), { ok: true, errors: [], value: null });
    assert.deepEqual(validateRespondent(undefined, 'anonymous'), { ok: true, errors: [], value: null });
    const r = validateRespondent({ first_name: 'Camille', last_name: 'Martin' }, 'anonymous');
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, [{ field: 'respondent', code: 'not_allowed' }]);
    assert.equal(validateRespondent({}, 'anonymous').ok, false);
  });

  test('ouvert : prénom et nom requis, e-mail facultatif', () => {
    const ok = validateRespondent({ first_name: ' Camille ', last_name: `Mar${RLO}tin`, email: null }, 'open');
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.deepEqual(ok.value, { first_name: 'Camille', last_name: 'Martin', email: null });
    const withEmail = validateRespondent({ first_name: 'Camille', last_name: 'Martin', email: ' camille.martin@exemple.fr ' }, 'open');
    assert.equal(withEmail.value.email, 'camille.martin@exemple.fr');
    assert.equal(validateRespondent({ first_name: 'Camille', last_name: 'Martin' }, 'open').value.email, null);
    assert.equal(validateRespondent({ first_name: 'Camille', last_name: 'Martin', email: '' }, 'open').value.email, null);
  });

  test('ouvert : erreurs', () => {
    assert.deepEqual(codes(validateRespondent(null, 'open')), ['respondent:required']);
    assert.deepEqual(codes(validateRespondent('Camille', 'open')), ['respondent:not_object']);
    assert.deepEqual(codes(validateRespondent({ first_name: '', last_name: 'Martin' }, 'open')), ['first_name:required']);
    assert.deepEqual(codes(validateRespondent({ first_name: '  ', last_name: 'Martin' }, 'open')), ['first_name:required']);
    assert.deepEqual(codes(validateRespondent({ first_name: 'Camille' }, 'open')), ['last_name:required']);
    assert.deepEqual(codes(validateRespondent({ first_name: 'x'.repeat(61), last_name: 'Martin' }, 'open')), ['first_name:too_long']);
    assert.equal(validateRespondent({ first_name: 'x'.repeat(60), last_name: 'Martin' }, 'open').ok, true);
    assert.deepEqual(codes(validateRespondent({ first_name: 1, last_name: 'Martin' }, 'open')), ['first_name:invalid_type']);
    assert.deepEqual(codes(validateRespondent({ first_name: 'Camille', last_name: 'Martin', phone: '06' }, 'open')), ['phone:unknown_field']);
    for (const email of ['camille', 'camille@', '@exemple.fr', 'camille@exemple', 'ca mille@exemple.fr', 'a@b@c.fr', 'a<b>@exemple.fr']) {
      assert.deepEqual(codes(validateRespondent({ first_name: 'Camille', last_name: 'Martin', email }, 'open')), ['email:invalid_email'], email);
    }
  });

  test('mode inconnu', () => {
    assert.deepEqual(codes(validateRespondent(null, 'public')), ['mode:invalid_mode']);
  });
});

describe('nettoyage de texte', () => {
  test('cleanLine et cleanMultiline', () => {
    assert.equal(cleanLine(`a${NUL}b\u0009c\nd`), 'ab c d');
    assert.equal(cleanLine(`  e${ch(0x301)}té  `), 'été', 'normalisation NFC');
    assert.equal(cleanMultiline('a\r\nb\rc'), 'a\nb\nc');
  });

  test('NFC après le retrait des invisibles : résultat stable', () => {
    const cp = (...codes) => String.fromCodePoint(...codes);
    assert.equal(cleanLine(`Cafe${cp(0x200b, 0x301)}`), 'Caf\u00e9');
    assert.equal(cleanMultiline(`Cafe${NUL}${cp(0x301)}\nx`), 'Caf\u00e9\nx');
    const pool = ['a', 'e', ' ', '\u00a0', '\n', '\t', ch(0x301), ch(0x327), NUL, BEL, C1, LS, RLO, LRI, ZWSP, ch(0x200d),
      ch(0x200c), ch(0x3164), ch(0xad), cp(0xe0041), cp(0x1f469), '\u2000', '\u212b', '\ufe0f'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 3000; i++) {
      let x = '';
      for (let j = 0; j < 12; j++) x += pool[Math.floor(rnd() * pool.length)];
      assert.equal(cleanLine(cleanLine(x)), cleanLine(x), JSON.stringify(x));
      assert.equal(cleanMultiline(cleanMultiline(x)), cleanMultiline(x), JSON.stringify(x));
      assert.equal(sanitizeText(sanitizeText(x)), sanitizeText(x), JSON.stringify(x));
    }
  });

  test('chemins code, lien et messages : mêmes caractères invisibles retirés (catégorie Cf, remplisseurs hangûl)', async () => {
    const keys = await generateCampaignKeys();
    const linkTitle = (title) => {
      const r = validateCampaignConfig({ v: 1, id: 'k3J9xQ2mP0aZ', title, org: '', mode: 'anonymous', depts: [], pk: keys.publicKeyB64 });
      return r.ok ? r.value.title : `refus:${r.errors.map((e) => e.code).join(',')}`;
    };
    // Tous les points de code Cf de la version d'Unicode du moteur, plus les remplisseurs hangûl.
    const invisible = [0x115f, 0x1160, 0x3164, 0xffa0];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (/\p{Cf}/u.test(String.fromCodePoint(c))) invisible.push(c);
    }
    assert.ok(invisible.length > 150, `${invisible.length} caractères`);
    assert.ok(invisible.includes(0xe0041) && invisible.includes(0xe007f) && invisible.includes(0xfeff));
    for (const c of invisible) {
      const x = String.fromCodePoint(c);
      const input = `a${x}b`;
      const hex = c.toString(16);
      if (c === 0x200c || c === 0x200d) {
        // Liants : conservés partout.
        assert.equal(cleanLine(input), input, hex);
        assert.equal(sanitizeText(input), input, hex);
        assert.equal(linkTitle(input), input, hex);
        continue;
      }
      assert.equal(cleanLine(input), 'ab', hex);
      assert.equal(cleanMultiline(input), 'ab', hex);
      assert.equal(sanitizeText(input), 'ab', hex);
      assert.equal(sanitizeText(input, Infinity, { multiline: true }), 'ab', hex);
      // Lien : les contrôles bidirectionnels sont refusés, les autres invisibles retirés.
      assert.equal(linkTitle(input), hasForbiddenChars(input) ? 'refus:chars' : 'ab', hex);
    }
    // Rien de légitime n'est retiré : lettres accentuées, ponctuation française, insécables, émojis, écritures.
    const legit = `Élève « ça » d\u00a0: 1\u202f000\u00a0€ ß ﬁ ħ ☕ ${String.fromCodePoint(0x2764, 0xfe0f)} 한국어 ㄱ 中文 हिन्दी العربية עברית`;
    assert.equal(cleanLine(legit), legit.normalize('NFC').replace(/\s+/g, ' '));
    assert.equal(sanitizeText(legit), legit.normalize('NFC'));
    // Le lien accepte ces textes tels quels (aucune marque bidi, 65 points de code).
    assert.equal(linkTitle(legit), legit.normalize('NFC'));
  });
});
