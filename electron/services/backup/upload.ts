/**
 * Backup Upload Module
 *
 * Uploads compressed backup zip files to the cloud Backup API.
 * Uses IAM Token for authentication and handles timeout/errors gracefully.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import { readFile, unlink, stat } from 'fs/promises';
import { basename } from 'path';
import { logger } from '../../utils/logger';
import {
  BackupError,
  BackupErrorType,
  type BackupDirectoryType,
} from './types';
import type { CompressResult } from './compress';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single file upload */
export interface UploadResult {
  /** Whether the upload succeeded */
  success: boolean;
  /** Backup ID returned by the server */
  backupId?: string;
  /** Storage path on the server */
  storagePath?: string;
  /** Error message if upload failed */
  error?: string;
}

/** Upload configuration */
export interface UploadConfig {
  /** Backup API base URL */
  apiUrl: string;
  /** Request timeout in milliseconds (default 60000) */
  timeout: number;
}

/** Server response shape for upload endpoint */
interface UploadApiResponse {
  success: boolean;
  backupId?: string;
  storagePath?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Upload single file
// ---------------------------------------------------------------------------

/**
 * Upload a single backup zip file to the Backup API.
 *
 * - Sends a multipart/form-data POST to `/api/v1/backup/upload`
 * - Includes `Authorization: Bearer {token}` header (R6.1)
 * - Includes userId, timestamp, and type metadata (R6.3)
 * - Respects timeout via AbortController (R6.6)
 */
export async function uploadBackupFile(
  compressResult: CompressResult,
  type: BackupDirectoryType,
  token: string,
  userId: string,
  config: UploadConfig,
): Promise<UploadResult> {
  const { zipPath, manifest } = compressResult;
  const fileName = basename(zipPath);

  logger.info('[Backup] Uploading backup file', {
    type,
    fileName,
    fileCount: manifest.fileCount,
    totalSize: manifest.totalSize,
  });

  // Validate config
  if (!config.apiUrl) {
    throw new BackupError(
      BackupErrorType.UPLOAD_ERROR,
      'Backup API URL is not configured',
    );
  }

  try {
    // Read the zip file into a buffer
    const fileBuffer = await readFile(zipPath);
    const fileStat = await stat(zipPath);

    // Build FormData with file + metadata (R6.3)
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'application/zip' });
    formData.append('file', blob, fileName);
    formData.append('userId', userId);
    formData.append('timestamp', manifest.timestamp);
    formData.append('type', type);

    // Set up timeout (R6.6 — 60s default)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    // Send upload request (R6.1 — Bearer token auth)
    const response = await fetch(`${config.apiUrl}/api/v1/backup/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const message = `Upload failed for ${fileName}: HTTP ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`;

      if (response.status === 401) {
        throw new BackupError(BackupErrorType.UNAUTHORIZED, message);
      } else if (response.status >= 500) {
        throw new BackupError(BackupErrorType.SERVER_ERROR, message);
      } else {
        throw new BackupError(BackupErrorType.UPLOAD_ERROR, message);
      }
    }

    const data = (await response.json()) as UploadApiResponse;

    if (!data.success) {
      throw new BackupError(
        BackupErrorType.UPLOAD_ERROR,
        `Server rejected upload for ${fileName}: ${data.message || 'Unknown reason'}`,
      );
    }

    logger.info('[Backup] Upload successful', {
      type,
      fileName,
      backupId: data.backupId,
      size: fileStat.size,
    });

    return {
      success: true,
      backupId: data.backupId,
      storagePath: data.storagePath,
    };
  } catch (err) {
    if (err instanceof BackupError) {
      throw err;
    }

    if (err instanceof Error && err.name === 'AbortError') {
      throw new BackupError(
        BackupErrorType.TIMEOUT_ERROR,
        `Upload timed out for ${fileName} (limit: ${config.timeout}ms)`,
        err,
      );
    }

    // Network errors (R6.7)
    throw new BackupError(
      BackupErrorType.NETWORK_ERROR,
      `Network error uploading ${fileName}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Upload all compressed backups
// ---------------------------------------------------------------------------

/** Result of uploading all backup files */
export interface UploadAllResult {
  /** Number of files successfully uploaded */
  successCount: number;
  /** Number of files that failed to upload */
  failureCount: number;
  /** Per-file results */
  results: Array<{
    type: BackupDirectoryType;
    zipPath: string;
    result: UploadResult;
  }>;
}

/**
 * Upload all compressed backup files sequentially (R6.2).
 *
 * - Uploads each zip one by one (agent → skill → memory)
 * - On success: deletes the local temp zip file (R6.4)
 * - On failure: keeps the local zip file and logs the error (R6.5, R6.7)
 *
 * @param compressResults - Array of compress results with zip paths and manifests
 * @param types - Corresponding directory types for each compress result
 * @param token - IAM access token for authentication
 * @param userId - Current user's ID
 * @param config - Upload configuration (apiUrl, timeout)
 * @param onProgress - Optional callback for progress updates
 */
export async function uploadAllBackups(
  compressResults: CompressResult[],
  types: BackupDirectoryType[],
  token: string,
  userId: string,
  config: UploadConfig,
  onProgress?: (current: number, total: number, type: BackupDirectoryType) => void,
): Promise<UploadAllResult> {
  const total = compressResults.length;
  let successCount = 0;
  let failureCount = 0;
  const results: UploadAllResult['results'] = [];

  for (let i = 0; i < total; i++) {
    const compressResult = compressResults[i];
    const type = types[i];

    onProgress?.(i + 1, total, type);

    try {
      const uploadResult = await uploadBackupFile(
        compressResult,
        type,
        token,
        userId,
        config,
      );

      results.push({ type, zipPath: compressResult.zipPath, result: uploadResult });

      // R6.4 — Delete temp zip on success
      try {
        await unlink(compressResult.zipPath);
        logger.debug('[Backup] Cleaned up temp file', { zipPath: compressResult.zipPath });
      } catch (unlinkErr) {
        // Non-fatal: log but don't fail the upload
        logger.warn('[Backup] Failed to clean up temp file', {
          zipPath: compressResult.zipPath,
          error: unlinkErr instanceof Error ? unlinkErr.message : 'Unknown',
        });
      }

      successCount++;
    } catch (err) {
      // R6.5 — Keep temp file on failure, log error
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error('[Backup] Upload failed, keeping temp file', {
        type,
        zipPath: compressResult.zipPath,
        error: errorMessage,
      });

      results.push({
        type,
        zipPath: compressResult.zipPath,
        result: { success: false, error: errorMessage },
      });

      failureCount++;
    }
  }

  logger.info('[Backup] Upload batch complete', {
    total,
    successCount,
    failureCount,
  });

  return { successCount, failureCount, results };
}
