// Fichier de récupération de la clé et codes en attente (CDC §4, §7.5, §7.6, §7.7 ; D8).
//
// - Lecture d'un fichier de récupération : création de la campagne si elle est absente de ce
//   navigateur, ou ajout de la clé privée à la campagne existante de même identifiant ET de même clé
//   publique. Jamais d'écrasement : une campagne de même identifiant mais d'une autre clé est refusée.
// - Écriture : fichier protégé par mot de passe (ou non protégé, sur demande explicite).
// - Noms des fichiers téléchargés : la version non protégée d'un fichier de récupération et la sauvegarde
//   non chiffrée portent un marqueur en capitales (NON-PROTEGEE, EN-CLAIR). Elles ne remplacent jamais
//   la version protégée du même jour dans le dossier de téléchargement et ne se confondent pas avec elle.
// - Codes en attente : codes reçus par un lien d'import alors que la clé n'était pas là, gardés le
//   temps de la session (sessionStorage via src/ui/safe-storage.js), toujours chiffrés. Un code mal
//   formé (lien coupé par la messagerie) n'est jamais gardé : aucune clé ne pourrait le lire.
//
// Module sans DOM, exécutable sous node --test avec openStore({ forceMemory: true }).

import {
  BackupError, ENCRYPTED_FORMAT, RECOVERY_FORMAT, isEncryptedEnvelope, isRecoveryFile, unwrapPrivateKey, wrapPrivateKey,
} from '../crypto/backup.js';
import { extractCodes } from '../crypto/codes.js';
import { cleanLine } from '../engine/validate.js';
import { backupFilename } from '../export/json.js';
import { slugify, toDay } from '../export/registry.js';
import { BACKUP_FORMAT, BACKUP_VERSION, validateBackup } from '../storage/backup-format.js';
import { session } from '../ui/safe-storage.js';
import { isKeepableCode } from './import.js';

export const RECOVERY_EXTENSION = 'recensia-key';
/** Type MIME unique du fichier de récupération (son contenu est du JSON). */
export const RECOVERY_MIME = 'application/json';
/** Taille maximale d'un fichier de récupération (caractères). */
export const MAX_RECOVERY_CHARS = 1_000_000;
export const PENDING_KEY = 'pending_codes';
/** Nombre maximal de codes gardés en attente dans la session. */
export const PENDING_MAX = 500;

const DEFAULT_SETTINGS = Object.freeze({
  min_group_size: 5,
  department_required: false,
  comments_exportable: false,
  closes_on: null,
  group_by_department: false,
  channels: [],
});
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHANNEL_TYPE_RE = /^[a-z_]{1,32}$/;

/**
 * Erreur de récupération. code : 'format' (fichier illisible) · 'too_large' · 'backup_file' (c'est une
 * sauvegarde, pas un fichier de récupération) · 'version' · 'password_required' · 'wrong_password' ·
 * 'mismatch' (clé et campagne incohérentes) · 'conflict' (même identifiant, autre clé : rien n'est modifié) ·
 * 'no_key' (campagne sans clé privée) · 'not_found'.
 */
export class RecoveryError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message || RECOVERY_MESSAGES[code] || 'Fichier de récupération invalide.', cause ? { cause } : undefined);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

const RECOVERY_MESSAGES = {
  format: 'Ce fichier n’est pas un fichier de récupération Recensia lisible.',
  too_large: 'Fichier trop volumineux pour un fichier de récupération.',
  backup_file: 'Ce fichier est une sauvegarde de campagne, pas un fichier de récupération.',
  version: 'Version de fichier non prise en charge : mettez l’application à jour.',
  password_required: 'Ce fichier est protégé : mot de passe requis.',
  wrong_password: 'Mot de passe incorrect (ou fichier altéré).',
  mismatch: 'La clé du fichier ne correspond pas à sa campagne.',
  conflict: 'Une autre campagne portant le même identifiant existe déjà dans ce navigateur.',
  no_key: 'La clé privée de cette campagne n’est pas dans ce navigateur.',
  not_found: 'Campagne introuvable.',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toIso(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

// --- Lecture -----------------------------------------------------------------

/**
 * Analyse le texte (ou l'objet) d'un fichier choisi par l'utilisateur.
 * @returns {object} fichier de récupération (objet JSON)
 * @throws {RecoveryError} 'format' · 'too_large' · 'backup_file' · 'version'
 */
export function parseRecoveryFile(input) {
  let obj = input;
  if (typeof input === 'string') {
    if (input.length > MAX_RECOVERY_CHARS) throw new RecoveryError('too_large');
    try {
      obj = JSON.parse(input.replace(/^﻿/, ''));
    } catch {
      throw new RecoveryError('format');
    }
  }
  if (!isPlainObject(obj)) throw new RecoveryError('format');
  if (obj.format === BACKUP_FORMAT || obj.format === ENCRYPTED_FORMAT || isEncryptedEnvelope(obj)) {
    throw new RecoveryError('backup_file');
  }
  if (obj.format !== RECOVERY_FORMAT) throw new RecoveryError('format');
  if (!isRecoveryFile(obj)) throw new RecoveryError(Number.isInteger(obj.v) ? 'version' : 'format');
  return obj;
}

/**
 * Informations affichables avant la saisie du mot de passe (copie en clair, non authentifiée :
 * seule la copie chiffrée fait foi à l'import).
 * @returns {{ protected: boolean, campaign: { id, title, org_name, mode, fingerprint } }}
 */
export function inspectRecoveryFile(input) {
  const file = parseRecoveryFile(input);
  const c = isPlainObject(file.campaign) ? file.campaign : {};
  const str = (v, max) => (typeof v === 'string' ? cleanLine(v).slice(0, max) : '');
  return {
    protected: file.protected === true,
    campaign: {
      id: str(c.id, 64),
      title: str(c.title, 200),
      org_name: str(c.org_name, 200),
      mode: c.mode === 'open' ? 'open' : 'anonymous',
      fingerprint: /^[0-9A-F]{8}$/.test(String(c.fingerprint ?? '')) ? c.fingerprint : '',
    },
  };
}

/** Réglages d'une campagne restaurée : clés connues seulement, types vérifiés, valeurs par défaut sinon. */
export function normalizeSettings(settings) {
  const s = isPlainObject(settings) ? settings : {};
  const out = { ...DEFAULT_SETTINGS, channels: [] };
  if (Number.isInteger(s.min_group_size) && s.min_group_size >= 1 && s.min_group_size <= 1000) out.min_group_size = s.min_group_size;
  for (const k of ['department_required', 'comments_exportable', 'group_by_department']) {
    if (typeof s[k] === 'boolean') out[k] = s[k];
  }
  if (typeof s.closes_on === 'string' && DAY_RE.test(s.closes_on)) out.closes_on = s.closes_on;
  if (Array.isArray(s.channels)) {
    out.channels = s.channels.slice(0, 3)
      .filter((c) => isPlainObject(c) && typeof c.type === 'string' && CHANNEL_TYPE_RE.test(c.type))
      .map((c) => ({ type: c.type, target: typeof c.target === 'string' ? c.target.slice(0, 1000) : null }));
  }
  return out;
}

/**
 * Campagne (ARCHITECTURE §3.2) reconstruite depuis un fichier de récupération déchiffré (pur).
 * @param {{ campaign: object, private_key_jwk: object }} unwrapped résultat de unwrapPrivateKey
 */
export function campaignFromRecovery(unwrapped, { now = new Date() } = {}) {
  const c = unwrapped.campaign;
  const at = toIso(now);
  return {
    id: c.id,
    title: cleanLine(c.title ?? '').slice(0, 500),
    org_name: cleanLine(c.org_name ?? '').slice(0, 500),
    mode: c.mode,
    departments: (c.departments ?? []).filter((d) => typeof d === 'string').map((d) => cleanLine(d).slice(0, 200)).filter(Boolean),
    settings: normalizeSettings(c.settings),
    public_key: c.public_key,
    private_key_jwk: unwrapped.private_key_jwk,
    fingerprint: c.fingerprint,
    created_at: typeof c.created_at === 'string' && !Number.isNaN(Date.parse(c.created_at)) ? c.created_at : at,
    demo: false,
    last_backup_at: null,
    recovery_saved_at: at,
  };
}

function assertStorable(campaign) {
  const check = validateBackup({
    format: BACKUP_FORMAT, v: BACKUP_VERSION, exported_at: new Date().toISOString(), app_version: null,
    campaign, entries: [], assessments: [], actions: [],
  });
  if (!check.ok) throw new RecoveryError('format', 'Informations de campagne du fichier invalides.');
}

function mapBackupError(err, passphrase) {
  if (err instanceof BackupError) {
    if (err.reason === 'password') {
      return new RecoveryError(typeof passphrase === 'string' && passphrase !== '' ? 'wrong_password' : 'password_required', null, { cause: err });
    }
    if (err.reason === 'mismatch') return new RecoveryError('mismatch', null, { cause: err });
    if (err.reason === 'version') return new RecoveryError('version', null, { cause: err });
    return new RecoveryError('format', null, { cause: err });
  }
  return new RecoveryError('format', null, { cause: err });
}

/**
 * Importe un fichier de récupération dans le store.
 * - campagne absente : créée (§3.2) depuis le fichier, recovery_saved_at = maintenant ;
 * - campagne présente, même clé publique, sans clé privée : la clé est ajoutée (rien d'autre ne change) ;
 * - campagne présente avec sa clé : rien n'est modifié ('already_present') ;
 * - campagne présente avec une autre clé publique : RecoveryError('conflict'), rien n'est modifié.
 * @returns {Promise<{ status: 'created'|'key_added'|'already_present', campaign: object }>}
 * @throws {RecoveryError}
 */
export async function importRecovery({ store, file, passphrase = null, now = new Date() } = {}) {
  if (!store) throw new RecoveryError('not_found', 'Stockage local indisponible.');
  const parsed = parseRecoveryFile(file);
  if (parsed.protected === true && (typeof passphrase !== 'string' || passphrase === '')) {
    throw new RecoveryError('password_required');
  }
  let unwrapped;
  try {
    unwrapped = await unwrapPrivateKey(parsed, parsed.protected === true ? passphrase : null);
  } catch (err) {
    throw mapBackupError(err, passphrase);
  }

  const existing = await store.getCampaign(unwrapped.campaign.id);
  if (!existing) {
    const campaign = campaignFromRecovery(unwrapped, { now });
    assertStorable(campaign);
    await store.putCampaign(campaign);
    return { status: 'created', campaign };
  }
  if (existing.public_key !== unwrapped.campaign.public_key) {
    throw new RecoveryError('conflict',
      'Une campagne portant le même identifiant mais une autre clé existe déjà dans ce navigateur : rien n’a été modifié.');
  }
  if (existing.private_key_jwk) return { status: 'already_present', campaign: existing };
  // Relue juste avant l'écriture : aucun autre champ (last_backup_at, réglages…) n'est perdu.
  const fresh = (await store.getCampaign(existing.id)) ?? existing;
  const updated = {
    ...fresh,
    private_key_jwk: unwrapped.private_key_jwk,
    fingerprint: fresh.fingerprint ?? unwrapped.campaign.fingerprint,
    recovery_saved_at: fresh.recovery_saved_at ?? toIso(now),
  };
  await store.putCampaign(updated);
  return { status: 'key_added', campaign: updated };
}

// --- Écriture ----------------------------------------------------------------

const FINGERPRINT_RE = /^[0-9A-F]{8}$/;

/** Marqueur du nom d'un fichier de récupération non protégé (la clé privée y est en clair). */
export const UNPROTECTED_RECOVERY_MARK = 'NON-PROTEGEE';
/** Marqueur du nom d'une sauvegarde non chiffrée (les réponses y sont en clair). */
export const PLAIN_BACKUP_MARK = 'EN-CLAIR';

/**
 * Nom canonique du fichier de récupération (création de campagne comme paramètres) :
 * recensia-cle-<slug du titre>-<EMPREINTE>-<AAAA-MM-JJ>.recensia-key pour le fichier protégé,
 * recensia-cle-<slug du titre>-<EMPREINTE>-<AAAA-MM-JJ>-NON-PROTEGEE.recensia-key sinon.
 * L'empreinte distingue deux campagnes aux titres proches ; elle est omise si elle manque ou est invalide.
 * Par sécurité, seul protected: true donne le nom sans marqueur.
 * @param {{ protected?: boolean }} [options]
 */
export function recoveryFilename(campaign, today, { protected: isProtected = false } = {}) {
  const slug = slugify(campaign?.title || campaign?.org_name || campaign?.id);
  const fp = String(campaign?.fingerprint ?? '').toUpperCase();
  const parts = ['recensia-cle', slug, FINGERPRINT_RE.test(fp) ? fp : null, toDay(today),
    isProtected === true ? null : UNPROTECTED_RECOVERY_MARK];
  return `${parts.filter(Boolean).join('-')}.${RECOVERY_EXTENSION}`;
}

/**
 * Nom du fichier de sauvegarde téléchargé depuis l'onglet Paramètres :
 * recensia-sauvegarde-<slug>-<AAAA-MM-JJ>.json pour la sauvegarde chiffrée,
 * recensia-sauvegarde-<slug>-<AAAA-MM-JJ>-EN-CLAIR.json sinon (seul encrypted: true donne le nom sans marqueur).
 * @param {{ encrypted?: boolean }} [options]
 */
export function backupDownloadFilename(campaign, today, { encrypted = false } = {}) {
  const name = backupFilename(campaign, today);
  return encrypted === true ? name : name.replace(/\.json$/, `-${PLAIN_BACKUP_MARK}.json`);
}

/**
 * Construit le fichier de récupération d'une campagne.
 * @param {object} campaign campagne relue depuis le store (avec private_key_jwk)
 * @param {string|null} passphrase mot de passe, ou null EXPLICITE pour un fichier non protégé
 * @returns {Promise<{ text: string, filename: string, mime: string, protected: boolean }>}
 *   à télécharger tel quel : downloadText(file.text, file.filename, file.mime)
 */
export async function buildRecoveryFile(campaign, passphrase, { today, iterations } = {}) {
  if (!campaign?.private_key_jwk) throw new RecoveryError('no_key');
  if (passphrase !== null && (typeof passphrase !== 'string' || passphrase === '')) {
    throw new TypeError('buildRecoveryFile : mot de passe non vide, ou null explicite.');
  }
  const file = await wrapPrivateKey(campaign, passphrase, iterations ? { iterations } : {});
  return {
    text: `${JSON.stringify(file, null, 2)}\n`,
    filename: recoveryFilename(campaign, today, { protected: passphrase !== null }),
    mime: RECOVERY_MIME,
    protected: passphrase !== null,
  };
}

/** Inscrit la date d'enregistrement du fichier de récupération (campagne relue avant écriture). */
export async function markRecoverySaved(store, campaignId, { now = new Date() } = {}) {
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) throw new RecoveryError('not_found');
  const updated = { ...campaign, recovery_saved_at: toIso(now) };
  await store.putCampaign(updated);
  return updated;
}

// --- Codes en attente (session) ------------------------------------------------

/**
 * Codes en attente dans une zone de stockage (par défaut la session du navigateur).
 * Seuls les codes de forme valide (ou d'une version plus récente du format) sont gardés : un code tronqué
 * ou mal formé est écarté à l'ajout comme à la relecture (isKeepableCode, src/services/import.js).
 */
export function createPendingCodes(area = session) {
  const keepable = (list) => extractCodes(list.filter((c) => typeof c === 'string').join('\n')).filter(isKeepableCode);
  const read = () => {
    const raw = area.get(PENDING_KEY, []);
    if (!Array.isArray(raw)) return [];
    return keepable(raw).slice(0, PENDING_MAX);
  };
  const write = (codes) => {
    if (codes.length === 0) area.remove(PENDING_KEY);
    else area.set(PENDING_KEY, codes.slice(0, PENDING_MAX));
  };
  return Object.freeze({
    /** Codes en attente (ordre d'arrivée). */
    list: read,
    /** Ajoute des codes (ou du texte qui en contient) ; renvoie le nombre de codes nouveaux gardés. */
    add(input) {
      const incoming = keepable(Array.isArray(input) ? input : [input]);
      const current = read();
      const known = new Set(current);
      const fresh = incoming.filter((c) => !known.has(c));
      const room = Math.max(0, PENDING_MAX - current.length);
      write([...current, ...fresh.slice(0, room)]);
      return Math.min(fresh.length, room);
    },
    /** Retire les codes donnés ; renvoie le nombre de codes restants. */
    remove(codes) {
      const drop = new Set((codes ?? []).filter((c) => typeof c === 'string'));
      const next = read().filter((c) => !drop.has(c));
      write(next);
      return next.length;
    },
    clear() {
      area.remove(PENDING_KEY);
    },
  });
}

const pending = createPendingCodes();

export const listPendingCodes = () => pending.list();
export const addPendingCodes = (codes) => pending.add(codes);
export const removePendingCodes = (codes) => pending.remove(codes);
export const clearPendingCodes = () => pending.clear();
