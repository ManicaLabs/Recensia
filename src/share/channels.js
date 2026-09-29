// Canaux de retour (données : data/channels.json) et validation des valeurs
// qui transitent par un lien ou un message : texte, adresse e-mail, numéro de
// téléphone, URL, code de réponse.
//
// Module feuille, sans aucun import : messages.js et urls.js s'appuient dessus,
// ce qui évite toute dépendance circulaire. urls.js réexporte sanitizeText et
// isValidEmail, qui y figurent au contrat d'architecture.

export const CHANNELS_MAX = 3;
export const SENDER_FLAGS = Object.freeze(['yes', 'depends', 'no']);
export const MODES = Object.freeze(['anonymous', 'open']);

const CODE_PREFIX = 'RCN1.';
const CODE_MAX = 32768;
const URL_MAX = 16384;

// C0 (sauf \n, traité à part), DEL et C1.
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
// Contrôles bidirectionnels (dont U+202A–U+202E et U+2066–U+2069) et marques de direction.
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
// Caractères invisibles qui pourraient masquer du texte.
const INVISIBLE_RE = /[\u200B\u2060\uFEFF\u00AD]/g;
// Espaces « larges » ramenés à une espace simple (les insécables sont conservées).
const SPACES_RE = /[ \u1680\u2000-\u200A\u205F\u3000]+/g;
// Paire de substitution compl\u00E8te (conserv\u00E9e) ou substitut isol\u00E9 (retir\u00E9). Sans assertion
// arri\u00E8re : Safari ant\u00E9rieur \u00E0 16.4 refuserait tout le module \u00E0 l'analyse.
const SURROGATES_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * Nettoie un texte avant de l'injecter dans un objet, un corps de message ou une URL.
 * Retire les caractères de contrôle C0/C1 (sauf \n si multiline), les contrôles
 * bidirectionnels et les caractères invisibles ; normalise (NFC, espaces, fins de ligne) ;
 * tronque à `max` unités UTF-16 sans couper de paire de substitution.
 */
export function sanitizeText(s, max = Infinity, { multiline = false } = {}) {
  if (s === null || s === undefined) return '';
  let t = String(s);
  t = typeof t.toWellFormed === 'function' ? t.toWellFormed() : t;
  t = t.replace(SURROGATES_RE, (m) => (m.length === 2 ? m : '')).replace(/\uFFFD/g, '');
  t = t.normalize('NFC');
  t = t.replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n').replace(/[\t\v\f]/g, ' ');
  t = t.replace(CONTROL_RE, '').replace(BIDI_RE, '').replace(INVISIBLE_RE, '');
  if (!multiline) t = t.replace(/\n/g, ' ');
  t = t.replace(SPACES_RE, ' ');
  if (multiline) {
    t = t.split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  }
  t = t.trim();
  if (Number.isFinite(max) && max >= 0 && t.length > max) {
    t = t.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
    t = t.trimEnd();
  }
  return t;
}

const LOCAL_RE = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TLD_RE = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;

/**
 * Validation stricte d'une adresse e-mail destinée à un lien mailto : ASCII,
 * 254 caractères au plus, aucune espace ni caractère de contrôle, aucun des
 * caractères ? & # % , ; ni guillemet, un seul @, domaine avec extension.
 */
export function isValidEmail(s) {
  if (typeof s !== 'string' || s.length < 6 || s.length > 254) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}

/**
 * Numéro de téléphone international (+33 6 12 34 56 78, 0033…, ou 33612345678 tel que
 * stocké dans le lien) : renvoie les chiffres seuls (7 à 15, premier chiffre non nul,
 * comme src/crypto/link.js), ou '' si invalide. Un numéro national (06…) est refusé.
 * Le préfixe national entre parenthèses de la forme « +33 (0)6… » est retiré.
 */
export function normalizePhone(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  const raw = sanitizeText(String(s), 32);
  if (!/^(?:\+|00)?[0-9(][0-9 .()\-]*$/.test(raw)) return '';
  let rest = raw.replace(/^(?:\+|00)/, '');
  if (rest !== raw) rest = rest.replace(/\(\s*0\s*\)/g, '');
  const digits = rest.replace(/[^0-9]/g, '');
  return /^[1-9][0-9]{6,14}$/.test(digits) ? digits : '';
}

const SAFE_URL_RE = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** URL http(s) absolue, sans espace, guillemet ni chevron. */
export function isSafeUrl(s, max = URL_MAX) {
  if (typeof s !== 'string' || s.length > max || !SAFE_URL_RE.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Code de réponse RCN1.<base64url> (voir src/crypto/codes.js). */
export function isResponseCode(s) {
  return typeof s === 'string'
    && s.length > CODE_PREFIX.length + 16
    && s.length <= CODE_MAX
    && s.startsWith(CODE_PREFIX)
    && /^[A-Za-z0-9_-]+$/.test(s.slice(CODE_PREFIX.length));
}

function typeDef(type, channelsData) {
  const types = channelsData && channelsData.types;
  if (!types || typeof type !== 'string' || !Object.hasOwn(types, type)) return null;
  const def = types[type];
  return def && typeof def === 'object' ? def : null;
}

/** Drapeau « identifie l'expéditeur ». Type inconnu : 'yes' (hypothèse la plus prudente). */
export function senderFlag(type, channelsData) {
  const def = typeDef(type, channelsData);
  return def && SENDER_FLAGS.includes(def.identifies_sender) ? def.identifies_sender : 'yes';
}

/** Description d'un type de canal, ou null s'il est inconnu. */
export function channelInfo(type, channelsData) {
  const def = typeDef(type, channelsData);
  if (!def) return null;
  const flag = senderFlag(type, channelsData);
  const target = ['email', 'instruction', 'phone'].includes(def.target) ? def.target : null;
  return {
    type,
    label: def.label ?? type,
    button_label: def.button_label ?? def.label ?? type,
    identifies_sender: flag,
    identifies_sender_label: channelsData.sender_labels?.[flag] ?? '',
    via: def.via ?? '',
    target,
    target_required: Boolean(target && def.target_required),
    target_max: target ? (Number.isInteger(def.target_max) ? def.target_max : 200) : 0,
    target_label: def.target_label ?? '',
    target_placeholder: def.target_placeholder ?? '',
    runtime_detection: def.runtime_detection ?? null,
    service: def.service ?? null,
    help: def.help ?? '',
  };
}

/** Tous les types de canaux décrits dans les données, dans l'ordre du fichier. */
export function listChannelTypes(channelsData) {
  const types = channelsData && channelsData.types ? Object.keys(channelsData.types) : [];
  return types.map((type) => channelInfo(type, channelsData)).filter(Boolean);
}

/**
 * Avertissement d'anonymat à afficher au répondant avant l'envoi par un canal donné,
 * ou null. Un type inconnu est traité comme identifiant l'expéditeur.
 */
export function anonymityWarning(mode, type, channelsData) {
  if (!MODES.includes(mode)) throw new TypeError(`Mode inconnu : ${String(mode)}`);
  const flag = senderFlag(type, channelsData);
  const text = channelsData?.warnings?.[mode]?.[flag];
  if (typeof text !== 'string' || !text) return null;
  const via = typeDef(type, channelsData)?.via || 'par ce canal';
  return text.replace(/\{via\}/g, via);
}

/**
 * Cible d'un canal nettoyée selon son type, au format du lien de collecte ;
 * '' si absente ou invalide. Téléphone : chiffres seuls, sans « + ».
 */
export function normalizeTarget(type, target, channelsData) {
  const info = channelInfo(type, channelsData);
  if (!info || !info.target || target === null || target === undefined) return '';
  if (info.target === 'email') {
    const email = sanitizeText(target, 254);
    return isValidEmail(email) ? email : '';
  }
  if (info.target === 'phone') return normalizePhone(target);
  return sanitizeText(target, info.target_max);
}

/**
 * Valide une liste de canaux { type, target? } (configuration de campagne ou lien).
 * → { ok, errors: [{ index, code }], value } ; value ne contient que les canaux valides.
 */
export function validateChannels(channels, channelsData, { max = CHANNELS_MAX } = {}) {
  const errors = [];
  const value = [];
  if (!Array.isArray(channels)) return { ok: false, errors: [{ index: -1, code: 'not_array' }], value };
  if (channels.length > max) errors.push({ index: -1, code: 'too_many' });
  const seen = new Set();
  channels.slice(0, max).forEach((channel, index) => {
    const type = channel && typeof channel === 'object' ? channel.type : undefined;
    const info = channelInfo(type, channelsData);
    if (!info) { errors.push({ index, code: 'unknown_type' }); return; }
    if (seen.has(type)) { errors.push({ index, code: 'duplicate_type' }); return; }
    seen.add(type);
    const raw = channel.target;
    const hasRaw = raw !== undefined && raw !== null && String(raw).trim() !== '';
    if (!info.target) {
      if (hasRaw) { errors.push({ index, code: 'unexpected_target' }); return; }
      value.push({ type });
      return;
    }
    if (!hasRaw) {
      if (info.target_required) { errors.push({ index, code: 'target_required' }); return; }
      value.push({ type });
      return;
    }
    if (info.target === 'instruction' && sanitizeText(raw).length > info.target_max) {
      errors.push({ index, code: 'target_too_long' });
      return;
    }
    const target = normalizeTarget(type, raw, channelsData);
    if (!target) {
      errors.push({ index, code: info.target === 'email' ? 'invalid_email' : info.target === 'phone' ? 'invalid_phone' : 'invalid_target' });
      return;
    }
    value.push({ type, target });
  });
  return { ok: errors.length === 0, errors, value };
}

/**
 * Le canal est-il utilisable dans cet environnement ? Seul « share » dépend
 * du navigateur (Web Share, détecté à l'exécution).
 */
export function isChannelAvailable(type, channelsData, env = globalThis) {
  const info = channelInfo(type, channelsData);
  if (!info) return false;
  if (info.runtime_detection === 'web_share') {
    const nav = env && env.navigator;
    return Boolean(nav && typeof nav.share === 'function');
  }
  return true;
}
