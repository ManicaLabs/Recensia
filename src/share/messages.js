// Messages générés sans IA à partir des gabarits (data/messages.fr.json).
//
// Syntaxe des gabarits :
//   {jeton}      valeur publique (liste fermée : TOKENS) ;
//   ligne        disparaît si l'un de ses jetons n'a pas de valeur (pas de phrase orpheline) ;
//   [[A||B]]     A si tous les jetons de A ont une valeur, sinon B (B facultatif).
// Les valeurs sont insérées en une seule passe, après la mise en forme : un titre
// contenant « {link} » ou « [[ » reste du texte littéral.
//
// Seuls les champs publics du contexte sont lus (PUBLIC_CONTEXT_KEYS) : un objet
// campagne passé par erreur ne peut pas faire fuiter la clé privée.

import {
  MODES, sanitizeText, isSafeUrl, isResponseCode, isValidEmail,
  channelInfo, senderFlag, normalizeTarget,
} from './channels.js';

export const PUBLIC_CONTEXT_KEYS = Object.freeze([
  'title', 'org', 'link', 'closes_on', 'duration_min', 'mode', 'channels', 'fingerprint', 'codes', 'import_link',
]);

export const TOKENS = Object.freeze([
  'title', 'org', 'link', 'closes_on', 'duration', 'return_channel', 'anonymity_block',
  'fingerprint', 'import_link', 'codes', 'count',
]);

const TOKEN_RE = /\{([a-z_]+)\}/g;
const GROUP_RE = /\[\[([\s\S]*?)\]\]/g;
const DEFAULT_LIMITS = { subject_max: 180, body_max: 3000, short_max: 1400, title_max: 80, org_max: 80 };

export class MessageError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code} : ${detail}` : code);
    this.name = 'MessageError';
    this.code = code;
    this.detail = detail;
  }
}

function limitsOf(templates) {
  return { ...DEFAULT_LIMITS, ...(templates && templates.limits) };
}

// Sans data/channels.json, les canaux seraient ignorés : le bloc d'anonymat ne serait plus
// tiré de la configuration et le canal de retour disparaîtrait. On refuse plutôt que de
// produire en silence un message moins précis.
function requireChannelsData(channelsData) {
  const types = channelsData && channelsData.types;
  if (!types || typeof types !== 'object') throw new MessageError('missing_data', 'channelsData (data/channels.json)');
}

function templateOf(templateId, templates) {
  const all = templates && templates.templates;
  if (!all || typeof templateId !== 'string' || !Object.hasOwn(all, templateId)) {
    throw new MessageError('unknown_template', String(templateId));
  }
  return all[templateId];
}

/** Échappe & < > " ' pour un fragment HTML (presse-papiers riche). */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Empreinte affichable 'A1B2-C3D4' à partir de 'A1B2C3D4' (ou déjà formatée) ; '' si invalide. */
export function displayFingerprint(fp) {
  if (typeof fp !== 'string') return '';
  const hex = fp.trim().replace(/-/g, '').toUpperCase();
  return /^[0-9A-F]{8}$/.test(hex) ? `${hex.slice(0, 4)}-${hex.slice(4)}` : '';
}

function validDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? { y, m, d } : null;
}

function fill(str, vars) {
  return String(str).replace(TOKEN_RE, (match, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : match));
}

/** Date 'YYYY-MM-DD' en toutes lettres (« 1er octobre 2026 ») ; '' si invalide. */
export function formatDay(ymd, templates) {
  const parts = validDay(ymd);
  const date = templates && templates.date;
  if (!parts || !date || !Array.isArray(date.months) || date.months.length !== 12) return '';
  const day = parts.d === 1 && date.first_day ? date.first_day : String(parts.d);
  return fill(date.pattern || '{day} {month} {year}', { day, month: date.months[parts.m - 1], year: parts.y });
}

/** Durée estimée en minutes (« 5 minutes ») ; '' si absente ou invalide. */
export function formatDuration(minutes, templates) {
  const n = Number(minutes);
  const d = templates && templates.duration;
  if (!Number.isInteger(n) || n < 1 || n > 600 || !d) return '';
  return fill(n === 1 ? d.one : d.other, { n });
}

/** Nombre d'usages transmis (« 1 usage décrit », « 3 usages décrits ») ; '' si aucun. */
export function formatCount(n, templates) {
  const c = templates && templates.count;
  if (!Number.isInteger(n) || n < 1 || !c) return '';
  return fill(n === 1 ? c.one : c.other, { n });
}

function joinList(items, templates) {
  const sep = templates?.lists?.separator ?? ', ';
  const last = templates?.lists?.last_separator ?? ' ou ';
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(sep)}${last}${items[items.length - 1]}`;
}

/** Nettoie puis borne un champ affiché : coupe à un mot entier et ajoute « … » si besoin. */
export function clipText(value, max) {
  const text = sanitizeText(value);
  if (!Number.isFinite(max) || text.length <= max) return text;
  const cut = sanitizeText(text, Math.max(max - 1, 0));
  const space = cut.lastIndexOf(' ');
  const base = space >= max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.\u2013-]+$/, '')}\u2026`;
}

/** Canaux connus, dédoublonnés par type, cibles nettoyées : [{ type, target }]. */
function publicChannels(channels, channelsData) {
  if (!Array.isArray(channels)) return [];
  const seen = new Set();
  const out = [];
  for (const channel of channels) {
    const type = channel && typeof channel === 'object' ? channel.type : undefined;
    if (!channelInfo(type, channelsData) || seen.has(type)) continue;
    seen.add(type);
    out.push({ type, target: normalizeTarget(type, channel.target, channelsData) });
  }
  return out;
}

/**
 * Ne retient du contexte que les champs publics, nettoyés et bornés.
 * Toute autre clé (private_key_jwk, settings, id…) est ignorée.
 */
export function publicContext(ctx, templates, channelsData) {
  const src = ctx && typeof ctx === 'object' ? ctx : {};
  const pick = (key) => (Object.hasOwn(src, key) ? src[key] : undefined);
  const limits = limitsOf(templates);
  const link = pick('link');
  const importLink = pick('import_link');
  const codes = pick('codes');
  const codeList = codes === undefined || codes === null ? [] : Array.isArray(codes) ? codes : [codes];
  codeList.forEach((code) => {
    if (!isResponseCode(code)) throw new MessageError('invalid_code');
  });
  const duration = Number(pick('duration_min'));
  return {
    title: clipText(pick('title'), limits.title_max),
    org: clipText(pick('org'), limits.org_max),
    link: isSafeUrl(link) ? link : '',
    closes_on: validDay(pick('closes_on')) ? pick('closes_on') : null,
    duration_min: Number.isInteger(duration) && duration > 0 ? duration : null,
    mode: MODES.includes(pick('mode')) ? pick('mode') : null,
    channels: publicChannels(pick('channels'), channelsData),
    fingerprint: displayFingerprint(pick('fingerprint')).replace('-', '') || null,
    codes: codeList.slice(),
    import_link: isSafeUrl(importLink) && importLink.includes('#/i/') ? importLink : '',
  };
}

/** Contexte public d'un message à partir d'une campagne (§3.2), sans la clé privée. */
export function messageContextFromCampaign(campaign, { link, duration_min } = {}) {
  const c = campaign && typeof campaign === 'object' ? campaign : {};
  const settings = c.settings && typeof c.settings === 'object' ? c.settings : {};
  return {
    title: c.title,
    org: c.org_name,
    mode: c.mode,
    channels: Array.isArray(settings.channels) ? settings.channels.map((ch) => ({ type: ch?.type, target: ch?.target })) : [],
    closes_on: settings.closes_on ?? null,
    fingerprint: c.fingerprint,
    link,
    duration_min,
  };
}

/** Phrases « canal de retour » (une par canal connu). */
export function returnChannelItems(channels, templates, channelsData) {
  const phrases = templates && templates.return_channels;
  if (!phrases) return [];
  return publicChannels(channels, channelsData).map(({ type, target }) => {
    const p = Object.hasOwn(phrases, type) ? phrases[type] : null;
    if (!p) return '';
    const shown = channelInfo(type, channelsData).target === 'phone' ? `+${target}` : target;
    if (target && p.with_target) return fill(p.with_target, { target: shown });
    return p.without_target || '';
  }).filter(Boolean);
}

/** Canal de retour en une phrase (« par e-mail à x@y.fr ou par copier-coller »). */
export function returnChannelText(channels, templates, channelsData) {
  return joinList(returnChannelItems(channels, templates, channelsData), templates);
}

/**
 * Bloc verrouillé « mode, anonymat, canal », généré d'après la configuration.
 * En mode anonyme, il signale toujours la limite du canal : jamais de promesse
 * d'anonymat au-delà de ce que garantit le mode (CDC §7.4).
 */
export function anonymityBlock(mode, channels, templates, channelsData) {
  if (!MODES.includes(mode)) throw new MessageError('invalid_mode', String(mode));
  const blocks = templates && templates.anonymity_blocks;
  if (!blocks) throw new MessageError('missing_data', 'anonymity_blocks');
  if (mode === 'open') return sanitizeText(blocks.open);
  requireChannelsData(channelsData);
  const a = blocks.anonymous;
  const identifying = [];
  const depending = [];
  for (const { type } of publicChannels(channels, channelsData)) {
    const via = channelInfo(type, channelsData).via;
    const flag = senderFlag(type, channelsData);
    if (flag === 'yes') identifying.push(via);
    else if (flag === 'depends') depending.push(via);
  }
  const parts = [];
  if (identifying.length) parts.push(fill(a.yes, { via: joinList(identifying, templates) }));
  if (depending.length) parts.push(fill(a.depends, { via: joinList(depending, templates) }));
  if (!parts.length) parts.push(a.unknown);
  return sanitizeText(`${a.lead}${a.joiner}${parts.join(a.joiner)}${a.end}`);
}

function normalizeForCompare(s) {
  return sanitizeText(s)
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/ {2,}/g, ' ');
}

/** Le texte (éventuellement modifié par l'utilisateur) contient-il encore le bloc verrouillé ? */
export function hasLockedBlock(text, lockedBlock) {
  const locked = normalizeForCompare(lockedBlock ?? '');
  if (!locked) return true;
  return normalizeForCompare(text ?? '').includes(locked);
}

/** Gabarits disponibles : [{ id, label, audience, kind, has_subject }]. */
export function listTemplates(templates, { audience } = {}) {
  const all = (templates && templates.templates) || {};
  return Object.keys(all)
    .map((id) => ({
      id,
      label: all[id].label ?? id,
      audience: all[id].audience ?? 'respondents',
      kind: all[id].kind ?? 'email',
      has_subject: typeof all[id].subject === 'string' && all[id].subject.length > 0,
    }))
    .filter((t) => !audience || t.audience === audience);
}

function tokensOf(str) {
  return Array.from(String(str).matchAll(TOKEN_RE), (m) => m[1]);
}

function hasValue(values, key) {
  return Object.hasOwn(values, key) && typeof values[key] === 'string' && values[key] !== '';
}

/** Applique la syntaxe des gabarits (groupes, lignes facultatives) puis insère les valeurs. */
export function renderTemplate(src, values) {
  let out = String(src ?? '').replace(GROUP_RE, (match, inner) => {
    const alternatives = inner.split('||');
    const chosen = alternatives.find((alt) => tokensOf(alt).every((key) => hasValue(values, key)));
    return chosen ?? '';
  });
  out = out.split('\n').filter((line) => tokensOf(line).every((key) => hasValue(values, key))).join('\n');
  out = out.replace(TOKEN_RE, (match, key) => (hasValue(values, key) ? values[key] : ''));
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Longueur du texte hors lignes de lien et de code (mesure des limites). */
export function proseLength(text) {
  return String(text ?? '').split('\n')
    .filter((line) => !/^https?:\/\//.test(line) && !line.startsWith('RCN1.'))
    .join('\n').length;
}

/** Corps texte → fragment HTML échappé ; seuls les liens validés deviennent cliquables. */
function bodyToHtml(body, { links, emails }) {
  const linkSet = new Set(links);
  return body.split(/\n{2,}/).map((paragraph) => {
    const lines = paragraph.split('\n').map((line) => {
      if (linkSet.has(line)) return `<a href="${escapeHtml(line)}">${escapeHtml(line)}</a>`;
      let html = escapeHtml(line);
      for (const email of emails) {
        html = html.split(email).join(`<a href="mailto:${email}">${email}</a>`);
      }
      return html;
    });
    return `<p>${lines.join('<br>')}</p>`;
  }).join('\n');
}

/**
 * Rend un gabarit.
 * → { subject, body, html, locked_block }
 * `channelsData` (data/channels.json) est obligatoire : le bloc d'anonymat et le canal de
 * retour en dépendent. `options.compact` : utilise body_compact s'il existe (mailto trop long).
 */
export function renderMessage(templateId, ctx, templates, channelsData, { compact = false } = {}) {
  const tpl = templateOf(templateId, templates);
  requireChannelsData(channelsData);
  const pc = publicContext(ctx, templates, channelsData);
  const limits = limitsOf(templates);
  for (const field of tpl.requires || []) {
    const v = pc[field];
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) throw new MessageError('missing_field', field);
  }
  if (!pc.mode) throw new MessageError('invalid_mode', String(ctx && ctx.mode));
  const scope = Array.isArray(tpl.anonymity_scope) ? tpl.anonymity_scope.map((type) => ({ type })) : pc.channels;
  const locked = anonymityBlock(pc.mode, scope, templates, channelsData);
  const values = {
    title: pc.title,
    org: pc.org,
    link: pc.link,
    closes_on: pc.closes_on ? formatDay(pc.closes_on, templates) : '',
    duration: pc.duration_min ? formatDuration(pc.duration_min, templates) : '',
    return_channel: returnChannelText(pc.channels, templates, channelsData),
    anonymity_block: locked,
    fingerprint: displayFingerprint(pc.fingerprint ?? ''),
    import_link: pc.import_link,
    codes: pc.codes.join('\n'),
    count: formatCount(pc.codes.length, templates),
  };
  const bodySrc = compact && typeof tpl.body_compact === 'string' ? tpl.body_compact : tpl.body;
  const subject = tpl.subject ? sanitizeText(renderTemplate(tpl.subject, values), limits.subject_max) : '';
  const body = sanitizeText(renderTemplate(bodySrc, values), Infinity, { multiline: true });
  const emails = pc.channels.map((c) => c.target).filter((t) => t && isValidEmail(t));
  const html = bodyToHtml(body, { links: [pc.link, pc.import_link].filter(Boolean), emails });
  return { subject, body, html, locked_block: locked };
}

// Longueur cumulée des textes variables de la fiche (titre, organisation, canaux, date,
// bloc d'anonymat) au-delà de laquelle la mise en page se resserre pour tout faire tenir.
export const SHEET_DENSITY = Object.freeze({ dense: 480, compact: 720 });

/**
 * Textes de la fiche imprimable (sheet.js), sans DOM : testables sous Node.
 * Ne lit de la campagne que ses champs publics.
 * `density` : 'normal' | 'dense' | 'compact', selon la longueur des textes variables.
 */
export function sheetContent({ campaign, link, fingerprint, templates, channelsData }) {
  const s = templates && templates.sheet;
  if (!s) throw new MessageError('missing_data', 'sheet');
  requireChannelsData(channelsData);
  const pc = publicContext(
    { ...messageContextFromCampaign(campaign, { link }), fingerprint: fingerprint ?? campaign?.fingerprint },
    templates, channelsData,
  );
  if (!pc.link) throw new MessageError('missing_field', 'link');
  if (!pc.mode) throw new MessageError('invalid_mode', String(campaign && campaign.mode));
  const closes = pc.closes_on ? formatDay(pc.closes_on, templates) : '';
  const channels = returnChannelItems(pc.channels, templates, channelsData)
    .map((phrase) => phrase.charAt(0).toUpperCase() + phrase.slice(1));
  const block = anonymityBlock(pc.mode, pc.channels, templates, channelsData);
  const variable = [pc.title, pc.org, ...channels, closes, block].join('').length;
  const density = variable > SHEET_DENSITY.compact ? 'compact' : variable > SHEET_DENSITY.dense ? 'dense' : 'normal';
  return {
    locale: templates.locale || 'fr',
    title: pc.title,
    org: pc.org,
    lead: s.lead,
    steps_title: s.steps_title,
    steps: Array.isArray(s.steps) ? s.steps.slice(0, 3) : [],
    steps_slide: Array.isArray(s.steps_slide) ? s.steps_slide.slice(0, 3) : Array.isArray(s.steps) ? s.steps.slice(0, 3) : [],
    channel_title: s.channel_title,
    channels: channels.length ? channels : [s.channel_none],
    closes: closes ? fill(s.closes, { closes_on: closes }) : '',
    anonymity_block: block,
    fingerprint_label: s.fingerprint,
    fingerprint: displayFingerprint(pc.fingerprint ?? ''),
    fingerprint_help: s.fingerprint_help,
    link_title: s.link_title,
    link: pc.link,
    qr_label: fill(s.qr_label, { title: pc.title }),
    density,
  };
}
