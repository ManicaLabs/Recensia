// Sauvegarde JSON complète d'une campagne (CDC §7.6, §8.3).
// Sans mot de passe : JSON en clair SANS clé privée. Avec mot de passe : enveloppe chiffrée
// (PBKDF2 + AES-GCM, src/crypto/backup.js) qui inclut la clé privée.

import {
  BackupError, ENCRYPTED_FORMAT, decryptWithPassword, encryptWithPassword, isEncryptedEnvelope, isRecoveryFile,
} from '../crypto/backup.js';
import { StoreError, validateBackup } from '../storage/store.js';
import { exportFilename } from './registry.js';

export const JSON_MIME = 'application/json';
/** Taille maximale acceptée à l'import (caractères). */
export const MAX_IMPORT_CHARS = 50 * 1024 * 1024;

function hasPassword(password) {
  return typeof password === 'string' && password.length > 0;
}

function describeErrors(errors) {
  const shown = errors.slice(0, 5).map((e) => `${e.path || 'racine'} (${e.code})`).join(', ');
  return errors.length > 5 ? `${shown}…` : shown;
}

/**
 * Exporte une campagne en Blob JSON. Option `markBackup` (vrai par défaut) : inscrit la date
 * de sauvegarde dans campaign.last_backup_at (bandeau « dernière sauvegarde il y a X jours »).
 * La sauvegarde est contrôlée avec la validation de l'import avant d'être produite : une
 * sauvegarde qui ne pourrait pas être réimportée est refusée (StoreError 'invalid_backup').
 */
export async function exportJson(store, campaignId, { password, markBackup = true } = {}) {
  const encrypted = hasPassword(password);
  const data = await store.exportCampaignData(campaignId, { includePrivateKey: encrypted });
  const check = validateBackup(data);
  if (!check.ok) {
    throw new StoreError('invalid_backup',
      `Sauvegarde impossible : ces données ne pourraient pas être réimportées (${describeErrors(check.errors)}).`,
      { details: check.errors });
  }
  const payload = encrypted ? await encryptWithPassword(data, password) : data;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: JSON_MIME });
  if (markBackup) {
    try {
      const campaign = await store.getCampaign(campaignId);
      if (campaign) await store.putCampaign({ ...campaign, last_backup_at: new Date().toISOString() });
    } catch {
      // La sauvegarde est produite même si la date ne peut pas être inscrite.
    }
  }
  return blob;
}

/**
 * Importe une sauvegarde (texte JSON, ou Blob/File) : détecte l'enveloppe chiffrée ou le JSON
 * clair, déchiffre si besoin, valide puis importe. Option `overwrite` : remplace une campagne
 * existante (sinon erreur « conflict », à confirmer par l'utilisateur).
 * → { campaign_id, entries, assessments, actions, encrypted }
 * Erreurs (StoreError.code) : invalid_json, too_large, recovery_file, password_required,
 * wrong_password, invalid_backup, conflict, key_mismatch.
 */
export async function importJson(fileText, password, store, { overwrite = false } = {}) {
  let text = fileText;
  if (text && typeof text === 'object' && typeof text.text === 'function') {
    // Une unité UTF-16 occupe au plus 3 octets en UTF-8 : au-delà de 3 × la limite, le texte
    // la dépasserait forcément ; inutile de lire le fichier.
    if (Number(text.size) > MAX_IMPORT_CHARS * 3) {
      throw new StoreError('too_large', 'Fichier trop volumineux pour une sauvegarde Recensia.');
    }
    text = await text.text();
  }
  if (typeof text !== 'string') throw new StoreError('invalid_json', 'Fichier illisible.');
  if (text.length > MAX_IMPORT_CHARS) throw new StoreError('too_large', 'Fichier trop volumineux pour une sauvegarde Recensia.');

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new StoreError('invalid_json', "Ce fichier n'est pas un fichier JSON valide.");
  }

  if (isRecoveryFile(parsed)) {
    throw new StoreError('recovery_file',
      "Ce fichier est un fichier de récupération de clé, pas une sauvegarde : ouvrez-le depuis la liste des campagnes.");
  }

  let data = parsed;
  const encrypted = isEncryptedEnvelope(parsed) || parsed?.format === ENCRYPTED_FORMAT;
  if (encrypted) {
    if (!hasPassword(password)) {
      throw new StoreError('password_required', 'Cette sauvegarde est chiffrée : saisissez son mot de passe.');
    }
    try {
      data = await decryptWithPassword(parsed, password);
    } catch (e) {
      if (e instanceof BackupError && e.reason === 'password') {
        throw new StoreError('wrong_password', 'Mot de passe incorrect (ou fichier altéré).', { cause: e });
      }
      throw new StoreError('invalid_backup', e instanceof BackupError ? e.message : 'Sauvegarde chiffrée illisible.', { cause: e });
    }
  }

  const result = await store.importCampaignData(data, { overwrite });
  return { ...result, encrypted };
}

/** recensia-sauvegarde-<slug>-<AAAA-MM-JJ>.json */
export function backupFilename(campaign, today) {
  return exportFilename('sauvegarde', campaign, today, 'json');
}
