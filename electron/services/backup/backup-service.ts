/**
 * Backup Service
 * Core scheduling and state management for cloud backup.
 *
 * Responsibilities:
 * - Periodic scheduler that checks every 30 minutes
 * - Time window validation (22:00–04:00, handles midnight crossing)
 * - Daily backup limit (one per calendar day)
 * - IAM login state gating
 * - Backup state tracking and IPC status events
 *
 * Compression, upload, and restore are implemented in subsequent tasks (8.2–8.4).
 */

import { BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { getIAMAuthService } from '../iam/iam-auth-service';
import { getOpenClawConfigDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
import {
  BackupStatus,
  BackupDirectoryType,
  BackupError,
  BackupErrorType,
  type BackupConfig,
  type BackupState,
} from './types';
import { compressDirectory, type CompressResult } from './compress';
import { uploadAllBackups, type UploadConfig } from './upload';
import {
  listBackups as listBackupsApi,
  restoreBackupFull,
  type BackupListItem,
  type RestoreConfig,
} from './restore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Scheduler interval: check every 30 minutes */
const SCHEDULER_INTERVAL_MS = 30 * 60 * 1000;

/** Default backup configuration */
const DEFAULT_CONFIG: BackupConfig = {
  apiUrl: process.env.BACKUP_API_URL || '',
  timeout: parseInt(process.env.BACKUP_TIMEOUT || '60000', 10),
  windowStart: process.env.BACKUP_WINDOW_START || '22:00',
  windowEnd: process.env.BACKUP_WINDOW_END || '04:00',
  idleThreshold: 5 * 60 * 1000, // 5 minutes
};

// ---------------------------------------------------------------------------
// electron-store (lazy loaded)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let backupStoreInstance: any = null;

interface BackupStoreSchema {
  lastBackupDate: string | null; // YYYY-MM-DD
  lastBackupTime: string | null; // ISO 8601
}

async function getBackupStore() {
  if (!backupStoreInstance) {
    const Store = (await import('electron-store')).default;
    backupStoreInstance = new Store<BackupStoreSchema>({
      name: 'clawx-backup',
      defaults: {
        lastBackupDate: null,
        lastBackupTime: null,
      },
    });
  }
  return backupStoreInstance;
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse an "HH:mm" string into { hour, minute }.
 */
export function parseTime(timeStr: string): { hour: number; minute: number } {
  const [h, m] = timeStr.split(':').map(Number);
  return { hour: h, minute: m };
}

/**
 * Check whether a given Date falls inside the backup window.
 *
 * The window crosses midnight when `start > end` (e.g. 22:00 → 04:00).
 * In that case the valid range is [start, 24:00) ∪ [00:00, end).
 */
export function isWithinBackupWindow(
  date: Date,
  windowStart: string,
  windowEnd: string,
): boolean {
  const start = parseTime(windowStart);
  const end = parseTime(windowEnd);

  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g. 02:00 → 06:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Cross-midnight window (e.g. 22:00 → 04:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Get today's date string in YYYY-MM-DD format (local time).
 */
export function getTodayDateString(now?: Date): string {
  const d = now ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Return the absolute paths for the three backup directories.
 */
export function getBackupDirectories(): Record<BackupDirectoryType, string> {
  const configDir = getOpenClawConfigDir();
  return {
    [BackupDirectoryType.AGENT]: join(configDir, 'agents'),
    [BackupDirectoryType.SKILL]: join(configDir, 'skills'),
    [BackupDirectoryType.MEMORY]: join(configDir, 'memory'),
  };
}

// ---------------------------------------------------------------------------
// BackupService
// ---------------------------------------------------------------------------

export class BackupService {
  private config: BackupConfig;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private state: BackupState;
  private mainWindow: BrowserWindow | null = null;

  constructor(config?: Partial<BackupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      isBackingUp: false,
      lastBackupTime: null,
      nextBackupWindow: null,
      progress: null,
    };

    logger.debug('[Backup] Service created', {
      apiUrl: this.config.apiUrl ? '[CONFIGURED]' : '[NOT SET]',
      windowStart: this.config.windowStart,
      windowEnd: this.config.windowEnd,
      timeout: this.config.timeout,
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Attach the main BrowserWindow so we can push status events to the renderer.
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * Start the periodic scheduler.
   * The scheduler fires every 30 minutes and evaluates whether a backup
   * should run (login check → window check → daily-limit check).
   */
  async start(): Promise<void> {
    if (this.schedulerTimer) {
      logger.warn('[Backup] Scheduler already running');
      return;
    }

    // Hydrate lastBackupTime from store
    const store = await getBackupStore();
    this.state.lastBackupTime = store.get('lastBackupTime') ?? null;

    logger.info('[Backup] Starting scheduler', {
      interval: `${SCHEDULER_INTERVAL_MS / 60_000} min`,
      window: `${this.config.windowStart}–${this.config.windowEnd}`,
    });

    // Run an initial check immediately, then every interval
    void this.schedulerTick();

    this.schedulerTimer = setInterval(() => {
      void this.schedulerTick();
    }, SCHEDULER_INTERVAL_MS);
  }

  /**
   * Stop the scheduler and reset state.
   */
  stop(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
      logger.info('[Backup] Scheduler stopped');
    }
  }

  /**
   * Whether the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.schedulerTimer !== null;
  }

  // -----------------------------------------------------------------------
  // State accessors
  // -----------------------------------------------------------------------

  getState(): BackupState {
    return { ...this.state };
  }

  getConfig(): BackupConfig {
    return { ...this.config };
  }

  // -----------------------------------------------------------------------
  // Manual trigger
  // -----------------------------------------------------------------------

  /**
   * Manually trigger a backup (ignores time window, still checks login + daily limit).
   */
  async triggerManualBackup(): Promise<void> {
    const iamService = getIAMAuthService();
    const authState = await iamService.getAuthState();

    if (!authState.isAuthenticated) {
      logger.warn('[Backup] Manual backup skipped – user not logged in');
      return;
    }

    if (this.state.isBackingUp) {
      logger.warn('[Backup] Manual backup skipped – backup already in progress');
      return;
    }

    logger.info('[Backup] Manual backup triggered');
    await this.executeBackup();
  }

  // -----------------------------------------------------------------------
  // List & Restore (R7.1–R7.7)
  // -----------------------------------------------------------------------

  /**
   * Fetch the list of available cloud backups.
   */
  async listBackups(): Promise<BackupListItem[]> {
    const iamService = getIAMAuthService();
    const token = await iamService.getToken();

    if (!token) {
      logger.warn('[Backup] Cannot list backups – user not logged in');
      return [];
    }

    const restoreConfig: RestoreConfig = {
      apiUrl: this.config.apiUrl,
      timeout: this.config.timeout,
    };

    return listBackupsApi(token, restoreConfig);
  }

  /**
   * Restore a backup by ID and type.
   */
  async restoreBackup(
    backupId: string,
    type: BackupDirectoryType,
  ): Promise<import('./types').RestoreResult> {
    const iamService = getIAMAuthService();
    const token = await iamService.getToken();

    if (!token) {
      return { success: false, filesRestored: 0, message: 'Not authenticated' };
    }

    const dirs = getBackupDirectories();
    const targetDir = dirs[type];

    const restoreConfig: RestoreConfig = {
      apiUrl: this.config.apiUrl,
      timeout: this.config.timeout,
    };

    return restoreBackupFull(backupId, type, targetDir, token, restoreConfig);
  }


  // -----------------------------------------------------------------------
  // Scheduler internals
  // -----------------------------------------------------------------------

  /**
   * Single tick of the scheduler. Evaluates all preconditions and, if met,
   * triggers a backup.
   */
  private async schedulerTick(): Promise<void> {
    try {
      // 1. Check IAM login status (R4.1, R4.6)
      const iamService = getIAMAuthService();
      const authState = await iamService.getAuthState();

      if (!authState.isAuthenticated) {
        logger.debug('[Backup] Tick skipped – user not logged in');
        return;
      }

      // 2. Check time window (R4.2)
      const now = new Date();
      if (!isWithinBackupWindow(now, this.config.windowStart, this.config.windowEnd)) {
        logger.debug('[Backup] Tick skipped – outside backup window');
        return;
      }

      // 3. Check daily limit (R4.5)
      const alreadyDone = await this.hasBackedUpToday(now);
      if (alreadyDone) {
        logger.debug('[Backup] Tick skipped – already backed up today');
        return;
      }

      // 4. Check not already running
      if (this.state.isBackingUp) {
        logger.debug('[Backup] Tick skipped – backup in progress');
        return;
      }

      // All conditions met → execute backup (R4.3, R4.4)
      logger.info('[Backup] All conditions met, starting backup');
      await this.executeBackup();
    } catch (err) {
      logger.error('[Backup] Scheduler tick error', err);
    }
  }

  /**
   * Check whether a backup has already been completed today.
   */
  private async hasBackedUpToday(now?: Date): Promise<boolean> {
    const store = await getBackupStore();
    const lastDate: string | null = store.get('lastBackupDate');
    if (!lastDate) return false;
    return lastDate === getTodayDateString(now);
  }

  /**
   * Execute the backup process.
   *
   * Steps:
   * 1. PREPARING  – enumerate directories that exist
   * 2. COMPRESSING – compress each directory into a zip (Task 8.2)
   * 3. UPLOADING  – upload zips to cloud (Task 8.3 – stub for now)
   * 4. COMPLETED  – record backup date/time
   */
  private async executeBackup(): Promise<void> {
    const now = new Date();

    this.updateState({
      isBackingUp: true,
      progress: {
        status: BackupStatus.PREPARING,
        progress: 0,
        message: 'Preparing backup…',
      },
    });

    try {
      // 1. Verify directories exist
      const dirs = getBackupDirectories();
      const existingDirs = (
        Object.entries(dirs) as [BackupDirectoryType, string][]
      ).filter(([, p]) => existsSync(p));

      if (existingDirs.length === 0) {
        logger.warn('[Backup] No backup directories found, skipping');
        this.updateState({
          isBackingUp: false,
          progress: {
            status: BackupStatus.FAILED,
            progress: 0,
            message: 'No directories to backup',
          },
        });
        return;
      }

      logger.info('[Backup] Directories to backup:', existingDirs.map(([t]) => t));

      // 2. Compress each directory (R5.1–R5.6)
      this.updateState({
        progress: {
          status: BackupStatus.COMPRESSING,
          progress: 0,
          message: 'Compressing directories…',
        },
      });

      const compressResults: CompressResult[] = [];
      const total = existingDirs.length;

      for (let i = 0; i < total; i++) {
        const [type, dirPath] = existingDirs[i];
        const pct = Math.round(((i) / total) * 100);

        this.updateState({
          progress: {
            status: BackupStatus.COMPRESSING,
            progress: pct,
            message: `Compressing ${type}…`,
            currentType: type,
          },
        });

        const result = await compressDirectory(type, dirPath, undefined, now);
        compressResults.push(result);
      }

      logger.info('[Backup] All directories compressed', {
        count: compressResults.length,
        zips: compressResults.map((r) => r.zipPath),
      });

      // 3. Upload to cloud (R6.1–R6.7)
      this.updateState({
        progress: {
          status: BackupStatus.UPLOADING,
          progress: 80,
          message: 'Uploading backups…',
        },
      });

      const iamSvc = getIAMAuthService();
      const token = await iamSvc.getToken();
      const currentUser = await iamSvc.getCurrentUser();

      if (!token || !currentUser) {
        throw new BackupError(
          BackupErrorType.UNAUTHORIZED,
          'Lost authentication during backup – cannot upload',
        );
      }

      const uploadConfig: UploadConfig = {
        apiUrl: this.config.apiUrl,
        timeout: this.config.timeout,
      };

      const types = existingDirs.map(([t]) => t);

      const uploadResult = await uploadAllBackups(
        compressResults,
        types,
        token,
        currentUser.id,
        uploadConfig,
        (current, uploadTotal, type) => {
          const pct = 80 + Math.round((current / uploadTotal) * 18);
          this.updateState({
            progress: {
              status: BackupStatus.UPLOADING,
              progress: pct,
              message: `Uploading ${type}… (${current}/${uploadTotal})`,
              currentType: type,
            },
          });
        },
      );

      if (uploadResult.failureCount > 0) {
        logger.warn('[Backup] Some uploads failed', {
          successCount: uploadResult.successCount,
          failureCount: uploadResult.failureCount,
        });
      }

      if (uploadResult.successCount === 0) {
        throw new BackupError(
          BackupErrorType.UPLOAD_ERROR,
          `All ${uploadResult.failureCount} uploads failed`,
        );
      }

      // 4. Record completion
      const store = await getBackupStore();
      const isoTime = now.toISOString();
      store.set('lastBackupDate', getTodayDateString(now));
      store.set('lastBackupTime', isoTime);

      this.updateState({
        isBackingUp: false,
        lastBackupTime: isoTime,
        progress: {
          status: BackupStatus.COMPLETED,
          progress: 100,
          message: 'Backup completed',
        },
      });

      this.sendEvent('backup:completed', { success: true });
      logger.info('[Backup] Backup completed', { time: isoTime });
    } catch (err) {
      logger.error('[Backup] Backup failed', err);

      this.updateState({
        isBackingUp: false,
        progress: {
          status: BackupStatus.FAILED,
          progress: 0,
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      });

      this.sendEvent('backup:completed', {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // -----------------------------------------------------------------------
  // Public accessor for compress results (used by upload in task 8.3)
  // -----------------------------------------------------------------------

  /**
   * Compress all existing backup directories and return the results.
   * Exposed for testing and for the upload step.
   */
  async compressAllDirectories(now?: Date): Promise<CompressResult[]> {
    const timestamp = now ?? new Date();
    const dirs = getBackupDirectories();
    const existingDirs = (
      Object.entries(dirs) as [BackupDirectoryType, string][]
    ).filter(([, p]) => existsSync(p));

    const results: CompressResult[] = [];
    for (const [type, dirPath] of existingDirs) {
      const result = await compressDirectory(type, dirPath, undefined, timestamp);
      results.push(result);
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // State & IPC helpers
  // -----------------------------------------------------------------------

  private updateState(patch: Partial<BackupState>): void {
    Object.assign(this.state, patch);
    this.sendEvent('backup:statusChanged', this.getState());
  }

  private sendEvent(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let backupServiceInstance: BackupService | null = null;

/**
 * Get the BackupService singleton.
 */
export function getBackupService(): BackupService {
  if (!backupServiceInstance) {
    backupServiceInstance = new BackupService();
  }
  return backupServiceInstance;
}
