// Validation structurelle d'une sauvegarde de campagne (format 'recensia-backup', v 1).
// Module pur. Les champs documentés (ARCHITECTURE §3) sont typés strictement ; les champs
// supplémentaires des enregistrements sont conservés s'ils restent des données JSON simples,
// pour ne pas rendre illisibles les sauvegardes d'une version ultérieure compatible.

export const BACKUP_FORMAT = 'recensia-backup';
export const BACKUP_VERSION = 1;

const ENVELOPE_KEYS = new Set(['format', 'v', 'exported_at', 'app_version', 'campaign', 'entries', 'assessments', 'actions']);
const AI_ACT_LEVELS = ['prohibited_suspected', 'high', 'to_qualify', 'limited', 'minimal'];
const VALIDATION_STATUSES = ['to_review', 'validated', 'to_revise'];
const ACTION_STATUSES = ['todo', 'in_progress', 'done', 'rejected'];
const PRIORITIES = ['high', 'medium', 'low'];
const ENTRY_SOURCES = ['code', 'manual', 'demo'];

const MAX_RECORDS = 100000;
const MAX_DEPTH = 16;
const MAX_TEXT = 20000;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isValidDay(s) {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isValidIso(s) {
  return typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/** Décodage base64url strict (sans remplissage) ; null si invalide. */
export function decodeB64url(s) {
  if (typeof s !== 'string' || !B64URL_RE.test(s) || s.length % 4 === 1) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    buffer = (buffer << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Données JSON simples uniquement, profondeur bornée, sans clé dangereuse.
function checkPlainData(value, path, errors, depth = 0) {
  if (depth > MAX_DEPTH) { errors.push({ path, code: 'too_deep' }); return; }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push({ path, code: 'type' });
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) errors.push({ path, code: 'too_long' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkPlainData(v, `${path}[${i}]`, errors, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) { errors.push({ path, code: 'type' }); return; }
    for (const k of Object.keys(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        errors.push({ path: `${path}.${k}`, code: 'forbidden' });
        continue;
      }
      checkPlainData(value[k], `${path}.${k}`, errors, depth + 1);
    }
    return;
  }
  errors.push({ path, code: 'type' });
}

// Petit vérificateur de champs : chaque règle ajoute au plus une erreur.
function makeChecker(obj, base, errors) {
  const at = (k) => (base ? `${base}.${k}` : k);
  const present = (k) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined;
  return {
    present,
    string(k, { required = false, nullable = false, min = 0, max = MAX_TEXT, re = null, noControl = false } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      const v = obj[k];
      if (v === null) { if (!nullable) errors.push({ path: at(k), code: 'type' }); return; }
      if (typeof v !== 'string') { errors.push({ path: at(k), code: 'type' }); return; }
      if (v.length < min || v.length > max) { errors.push({ path: at(k), code: 'length' }); return; }
      if (re && !re.test(v)) { errors.push({ path: at(k), code: 'format' }); return; }
      if (noControl && CONTROL_RE.test(v)) errors.push({ path: at(k), code: 'format' });
    },
    oneOf(k, values, { required = false, nullable = false } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      const v = obj[k];
      if (v === null && nullable) return;
      if (!values.includes(v)) errors.push({ path: at(k), code: 'enum' });
    },
    bool(k, { required = false } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      if (typeof obj[k] !== 'boolean') errors.push({ path: at(k), code: 'type' });
    },
    int(k, { required = false, nullable = false, min = -Infinity, max = Infinity } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      const v = obj[k];
      if (v === null && nullable) return;
      if (!Number.isInteger(v) || v < min || v > max) errors.push({ path: at(k), code: 'type' });
    },
    day(k, { required = false, nullable = false } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      const v = obj[k];
      if (v === null && nullable) return;
      if (!isValidDay(v)) errors.push({ path: at(k), code: 'format' });
    },
    iso(k, { required = false, nullable = false } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      const v = obj[k];
      if (v === null && nullable) return;
      if (!isValidIso(v)) errors.push({ path: at(k), code: 'format' });
    },
    stringArray(k, { required = false, max = 1000, itemMax = 500 } = {}) {
      if (!present(k)) { if (required) errors.push({ path: at(k), code: 'required' }); return; }
      const v = obj[k];
      if (!Array.isArray(v) || v.length > max) { errors.push({ path: at(k), code: 'type' }); return; }
      if (v.some((x) => typeof x !== 'string' || x.length > itemMax)) errors.push({ path: at(k), code: 'type' });
    },
  };
}

function validateJwk(jwk, publicKey, path, errors) {
  if (!isObj(jwk)) { errors.push({ path, code: 'type' }); return; }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') { errors.push({ path, code: 'format' }); return; }
  const x = decodeB64url(jwk.x);
  const y = decodeB64url(jwk.y);
  const d = decodeB64url(jwk.d);
  if (!x || x.length !== 32 || !y || y.length !== 32 || !d || d.length !== 32) {
    errors.push({ path, code: 'format' });
    return;
  }
  // La clé privée doit correspondre à la clé publique de la campagne.
  if (typeof publicKey === 'string') {
    const raw = decodeB64url(publicKey);
    if (raw && raw.length === 65 && (!bytesEqual(raw.subarray(1, 33), x) || !bytesEqual(raw.subarray(33, 65), y))) {
      errors.push({ path, code: 'mismatch' });
    }
  }
}

function validateCampaign(c, errors) {
  const base = 'campaign';
  if (!isObj(c)) { errors.push({ path: base, code: 'type' }); return; }
  const k = makeChecker(c, base, errors);
  k.string('id', { required: true, re: ID_RE });
  k.string('title', { required: true, max: 500, noControl: true });
  k.string('org_name', { required: true, max: 500, noControl: true });
  k.oneOf('mode', ['anonymous', 'open'], { required: true });
  k.stringArray('departments', { required: true, max: 200, itemMax: 200 });
  if (!isObj(c.settings)) {
    errors.push({ path: `${base}.settings`, code: c.settings === undefined ? 'required' : 'type' });
  } else {
    const s = makeChecker(c.settings, `${base}.settings`, errors);
    s.int('min_group_size', { min: 1, max: 1000 });
    s.bool('department_required');
    s.bool('comments_exportable');
    s.bool('group_by_department');
    s.day('closes_on', { nullable: true });
    if (s.present('channels')) {
      const ch = c.settings.channels;
      if (!Array.isArray(ch) || ch.length > 3) {
        errors.push({ path: `${base}.settings.channels`, code: 'type' });
      } else {
        ch.forEach((item, i) => {
          if (!isObj(item)) { errors.push({ path: `${base}.settings.channels[${i}]`, code: 'type' }); return; }
          const cc = makeChecker(item, `${base}.settings.channels[${i}]`, errors);
          cc.string('type', { required: true, re: /^[a-z_]{1,32}$/ });
          cc.string('target', { nullable: true, max: 1000 });
        });
      }
    }
  }
  if (c.public_key !== null && c.public_key !== undefined) {
    const raw = decodeB64url(c.public_key);
    if (!raw || raw.length !== 65 || raw[0] !== 0x04) errors.push({ path: `${base}.public_key`, code: 'format' });
  }
  if (c.private_key_jwk !== null && c.private_key_jwk !== undefined) {
    if (typeof c.public_key !== 'string') errors.push({ path: `${base}.public_key`, code: 'required' });
    else validateJwk(c.private_key_jwk, c.public_key, `${base}.private_key_jwk`, errors);
  }
  k.string('fingerprint', { nullable: true, re: /^[0-9A-Fa-f]{8}$/ });
  k.iso('created_at', { required: true });
  k.bool('demo');
  k.iso('last_backup_at', { nullable: true });
  k.iso('recovery_saved_at', { nullable: true });
  checkPlainData(c, base, errors);
}

function validateUsageShape(u, path, errors) {
  if (!isObj(u)) { errors.push({ path, code: 'type' }); return; }
  const k = makeChecker(u, path, errors);
  k.string('usage_name', { required: true, max: 500 });
  k.string('tool', { required: true, re: /^[a-z0-9_]{1,64}$/ });
  k.stringArray('task_types', { required: true, max: 50, itemMax: 64 });
  k.stringArray('data_types', { required: true, max: 50, itemMax: 64 });
  for (const [key, v] of Object.entries(u)) {
    const ok = v === null || typeof v === 'string'
      || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) errors.push({ path: `${path}.${key}`, code: 'type' });
  }
}

function validateEntry(e, i, campaign, errors) {
  const base = `entries[${i}]`;
  if (!isObj(e)) { errors.push({ path: base, code: 'type' }); return; }
  const k = makeChecker(e, base, errors);
  if (e.campaign_id !== campaign?.id) errors.push({ path: `${base}.campaign_id`, code: 'mismatch' });
  k.string('entry_id', { required: true, re: ID_RE });
  k.int('rev', { required: true, min: 1, max: 1e6 });
  k.day('submitted_day', { required: true });
  k.iso('submitted_at', { nullable: true });
  if (e.respondent !== null && e.respondent !== undefined) {
    if (campaign?.mode === 'anonymous') {
      errors.push({ path: `${base}.respondent`, code: 'forbidden' });
    } else if (!isObj(e.respondent)) {
      errors.push({ path: `${base}.respondent`, code: 'type' });
    } else {
      const r = makeChecker(e.respondent, `${base}.respondent`, errors);
      r.string('first_name', { required: true, max: 200 });
      r.string('last_name', { required: true, max: 200 });
      r.string('email', { nullable: true, max: 320 });
    }
  }
  validateUsageShape(e.usage, `${base}.usage`, errors);
  k.int('schema_version', { required: true, min: 1, max: 1000 });
  k.string('code_hash', { nullable: true, re: /^[0-9a-f]{64}$/ });
  k.oneOf('source', ENTRY_SOURCES);
  k.iso('imported_at');
  k.bool('after_close');
  k.bool('excluded');
  // Chaîne vide admise : consolidate() la traite comme l'absence de regroupement manuel.
  k.string('group_override', { nullable: true, max: 2000 });
  checkPlainData(e, base, errors);
}

function validateAssessment(a, i, campaign, errors) {
  const base = `assessments[${i}]`;
  if (!isObj(a)) { errors.push({ path: base, code: 'type' }); return; }
  const k = makeChecker(a, base, errors);
  if (a.campaign_id !== campaign?.id) errors.push({ path: `${base}.campaign_id`, code: 'mismatch' });
  k.string('usage_key', { required: true, min: 1, max: 2000 });
  k.oneOf('override_ai_act_level', AI_ACT_LEVELS, { nullable: true });
  k.int('override_data_level', { nullable: true, min: 0, max: 3 });
  k.string('justification', { max: 5000 });
  k.string('owner', { max: 500 });
  k.oneOf('validation_status', VALIDATION_STATUSES);
  if (k.present('history') && (!Array.isArray(a.history) || a.history.some((h) => !isObj(h)))) {
    errors.push({ path: `${base}.history`, code: 'type' });
  }
  k.iso('updated_at', { nullable: true });
  checkPlainData(a, base, errors);
}

function validateAction(a, i, campaign, errors) {
  const base = `actions[${i}]`;
  if (!isObj(a)) { errors.push({ path: base, code: 'type' }); return; }
  const k = makeChecker(a, base, errors);
  k.string('id', { required: true, min: 1, max: 200, noControl: true });
  if (a.campaign_id !== campaign?.id) errors.push({ path: `${base}.campaign_id`, code: 'mismatch' });
  k.string('usage_key', { nullable: true, min: 1, max: 2000 });
  k.string('template_id', { nullable: true, min: 1, max: 100 });
  k.string('title', { required: true, max: 1000 });
  k.string('description', { max: MAX_TEXT });
  k.string('owner', { max: 500 });
  k.day('due_date', { nullable: true });
  k.oneOf('priority', PRIORITIES);
  k.oneOf('status', ACTION_STATUSES, { required: true });
  k.bool('suggested');
  k.string('suggested_role', { nullable: true, max: 100 });
  k.iso('created_at', { nullable: true });
  k.iso('updated_at', { nullable: true });
  checkPlainData(a, base, errors);
}

function checkUnique(list, keyFn, name, errors) {
  const seen = new Set();
  list.forEach((item, i) => {
    if (!isObj(item)) return;
    const key = keyFn(item);
    if (typeof key !== 'string') return;
    if (seen.has(key)) errors.push({ path: `${name}[${i}]`, code: 'duplicate' });
    seen.add(key);
  });
}

/**
 * Valide une sauvegarde. → { ok, errors: [{ path, code }] }
 * Codes : type, required, format, enum, length, mismatch, duplicate, forbidden, unknown, too_deep, too_long.
 */
export function validateBackup(obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: [{ path: '', code: 'type' }] };
  if (obj.format !== BACKUP_FORMAT) errors.push({ path: 'format', code: 'format' });
  if (obj.v !== BACKUP_VERSION) errors.push({ path: 'v', code: 'version' });
  for (const key of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(key)) errors.push({ path: key, code: 'unknown' });
  }
  if (errors.length) return { ok: false, errors };

  const top = makeChecker(obj, '', errors);
  top.iso('exported_at', { required: true });
  top.string('app_version', { nullable: true, max: 100 });
  validateCampaign(obj.campaign, errors);
  const campaign = isObj(obj.campaign) ? obj.campaign : null;

  for (const name of ['entries', 'assessments', 'actions']) {
    if (!Array.isArray(obj[name])) errors.push({ path: name, code: obj[name] === undefined ? 'required' : 'type' });
    else if (obj[name].length > MAX_RECORDS) errors.push({ path: name, code: 'too_long' });
  }
  if (errors.length) return { ok: false, errors };

  obj.entries.forEach((e, i) => validateEntry(e, i, campaign, errors));
  obj.assessments.forEach((a, i) => validateAssessment(a, i, campaign, errors));
  obj.actions.forEach((a, i) => validateAction(a, i, campaign, errors));
  checkUnique(obj.entries, (e) => e.entry_id, 'entries', errors);
  checkUnique(obj.assessments, (a) => a.usage_key, 'assessments', errors);
  checkUnique(obj.actions, (a) => a.id, 'actions', errors);

  return { ok: errors.length === 0, errors };
}
