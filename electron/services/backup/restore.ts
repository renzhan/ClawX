/**
 * Backup Restore Module
 *
 * Handles listing, downloading, and extracting cloud backups.
 * Downloads to a temp directory first, then extracts to the target,
 * preserving the original directory on failure.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import { mkdir, rm, writeFile, rename, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import { logger } from '../../utils/logger';
import {
  BackupError,
  BackupErrorType,
  BackupDirectoryType,
  type RestoreResult,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single backup entry from the list API (R7.2, R7.3) */
export interface BackupListItem {
  id: string;
  userId: string;
  type: string;
  createdAt: string;
  size: number;
}

/** Configuration for restore operations */
export interface RestoreConfig {
  /** Backup API base URL */
  apiUrl: string;
  /** Request timeout in milliseconds */
  timeout: number;
}

/** Server response for list endpoint */
interface ListApiResponse {
  success: boolean;
  backups?: BackupListItem[];
  message?: string;
}

// ---------------------------------------------------------------------------
// List backups (R7.2, R7.3)
// ---------------------------------------------------------------------------

/**
 * Fetch the list of available cloud backups from the Backup API.
 *
 * @param token - IAM access token
 * @param config - API configuration
 * @returns Array of backup list items
 */
export async function listBackups(
  token: string,
  config: RestoreConfig,
): Promise<BackupListItem[]> {
  if (!config.apiUrl) {
    throw new BackupError(
      BackupErrorType.DOWNLOAD_ERROR,
      'Backup API URL is not configured',
    );
  }

  logger.info('[Backup] Fetching backup list');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(`${config.apiUrl}/api/v1/backup/list`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new BackupError(
          BackupErrorType.UNAUTHORIZED,
          'Unauthorized: invalid or expired token',
        );
      }
      throw new BackupError(
        BackupErrorType.DOWNLOAD_ERROR,
        `Failed to fetch backup list: HTTP ${response.status}${errorBody ? ` - ${errorBody}` : ''}`,
      );
    }

    const data = (await response.json()) as ListApiResponse;

    if (!data.success) {
      throw new BackupError(
        BackupErrorType.DOWNLOAD_ERROR,
        `Server error fetching backup list: ${data.message || 'Unknown'}`,
      );
    }

    const backups = data.backups ?? [];
    logger.info('[Backup] Backup list fetched', { count: backups.length });
    return backups;
  } catch (err) {
    if (err instanceof BackupError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new BackupError(
        BackupErrorType.TIMEOUT_ERROR,
        'Backup list request timed out',
        err,
      );
    }

    throw new BackupError(
      BackupErrorType.NETWORK_ERROR,
      `Network error fetching backup list: ${err instanceof Error ? err.message : 'Unknown'}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Download backup (R7.4)
// ---------------------------------------------------------------------------

/**
 * Download a backup zip file from the Backup API to a temp directory.
 *
 * @param backupId - The backup ID to download
 * @param token - IAM access token
 * @param config - API configuration
 * @returns Absolute path to the downloaded zip file
 */
export async function downloadBackup(
  backupId: string,
  token: string,
  config: RestoreConfig,
): Promise<string> {
  if (!config.apiUrl) {
    throw new BackupError(
      BackupErrorType.DOWNLOAD_ERROR,
      'Backup API URL is not configured',
    );
  }

  logger.info('[Backup] Downloading backup', { backupId });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(
      `${config.apiUrl}/api/v1/backup/download/${backupId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        throw new BackupError(
          BackupErrorType.DOWNLOAD_ERROR,
          `Backup not found: ${backupId}`,
        );
      }
      if (response.status === 401) {
        throw new BackupError(
          BackupErrorType.UNAUTHORIZED,
          'Unauthorized: invalid or expired token',
        );
      }
      const errorBody = await response.text().catch(() => '');
      throw new BackupError(
        BackupErrorType.DOWNLOAD_ERROR,
        `Download failed: HTTP ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Write to temp directory
    const tempDir = join(tmpdir(), 'clawx-restore');
    await mkdir(tempDir, { recursive: true });
    const zipPath = join(tempDir, `${backupId}.zip`);
    await writeFile(zipPath, buffer);

    logger.info('[Backup] Download complete', {
      backupId,
      zipPath,
      size: buffer.length,
    });

    return zipPath;
  } catch (err) {
    if (err instanceof BackupError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new BackupError(
        BackupErrorType.TIMEOUT_ERROR,
        `Download timed out for backup ${backupId}`,
        err,
      );
    }

    throw new BackupError(
      BackupErrorType.NETWORK_ERROR,
      `Network error downloading backup ${backupId}: ${err instanceof Error ? err.message : 'Unknown'}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Extract backup (R7.5)
// ---------------------------------------------------------------------------

/**
 * Extract a backup zip file to the target directory.
 *
 * Strategy for rollback safety (R7.7):
 * 1. Extract to a temp staging directory first
 * 2. If the target directory exists, rename it to a backup suffix
 * 3. Rename the staging directory to the target
 * 4. On success, remove the old backup
 * 5. On failure, restore the old backup and remove staging
 *
 * @param zipPath - Path to the downloaded zip file
 * @param targetDir - Target directory to extract into (e.g. ~/.openclaw/agents)
 * @returns Restore result with file count
 */
export async function extractBackup(
  zipPath: string,
  targetDir: string,
): Promise<RestoreResult> {
  const stagingDir = `${targetDir}.restore-staging`;
  const backupDir = `${targetDir}.restore-backup`;

  logger.info('[Backup] Extracting backup', { zipPath, targetDir });

  try {
    // 1. Extract to staging directory
    await mkdir(stagingDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(stagingDir, true);

    // Count extracted files (excluding manifest.json)
    const filesRestored = await countFiles(stagingDir);

    // 2. If target exists, move it to backup
    if (existsSync(targetDir)) {
      // Remove any leftover backup from a previous failed attempt
      if (existsSync(backupDir)) {
        await rm(backupDir, { recursive: true, force: true });
      }
      await rename(targetDir, backupDir);
    }

    // 3. Move staging to target
    await rename(stagingDir, targetDir);

    // 4. Clean up old backup on success
    if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true, force: true });
    }

    logger.info('[Backup] Extraction complete', {
      targetDir,
      filesRestored,
    });

    return {
      success: true,
      filesRestored,
      message: 'Restore completed successfully. Please restart the application.',
    };
  } catch (err) {
    logger.error('[Backup] Extraction failed, rolling back', {
      targetDir,
      error: err instanceof Error ? err.message : 'Unknown',
    });

    // R7.7 — Rollback: restore original directory
    try {
      // Remove failed staging
      if (existsSync(stagingDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      }

      // Restore original from backup
      if (existsSync(backupDir) && !existsSync(targetDir)) {
        await rename(backupDir, targetDir);
        logger.info('[Backup] Rollback successful, original directory restored');
      }
    } catch (rollbackErr) {
      logger.error('[Backup] Rollback also failed', {
        error: rollbackErr instanceof Error ? rollbackErr.message : 'Unknown',
      });
    }

    if (err instanceof BackupError) throw err;

    throw new BackupError(
      BackupErrorType.EXTRACTION_ERROR,
      `Failed to extract backup to ${targetDir}: ${err instanceof Error ? err.message : 'Unknown'}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Full restore flow
// ---------------------------------------------------------------------------

/**
 * Execute a full restore: download → extract → cleanup.
 *
 * @param backupId - The backup ID to restore
 * @param type - The backup directory type (agent/skill/memory)
 * @param targetDir - The target directory to restore into
 * @param token - IAM access token
 * @param config - API configuration
 * @returns Restore result
 */
export async function restoreBackupFull(
  backupId: string,
  type: BackupDirectoryType,
  targetDir: string,
  token: string,
  config: RestoreConfig,
): Promise<RestoreResult> {
  logger.info('[Backup] Starting full restore', { backupId, type, targetDir });

  // 1. Download
  const zipPath = await downloadBackup(backupId, token, config);

  try {
    // 2. Extract with rollback safety
    const result = await extractBackup(zipPath, targetDir);

    // 3. Clean up downloaded zip
    try {
      await rm(zipPath, { force: true });
    } catch {
      // Non-fatal
    }

    return result;
  } catch (err) {
    // Keep the downloaded zip for debugging on failure
    logger.warn('[Backup] Restore failed, keeping downloaded zip', { zipPath });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively count files in a directory.
 */
async function countFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
  } catch {
    // Directory might not exist or be unreadable
  }
  return count;
}
