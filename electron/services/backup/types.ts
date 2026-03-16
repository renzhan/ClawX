/**
 * Cloud Backup Types
 * Type definitions for cloud backup and restore functionality
 */

/**
 * Backup directory type
 */
export enum BackupDirectoryType {
  AGENT = 'agent',
  SKILL = 'skill',
  MEMORY = 'memory',
}

/**
 * Backup manifest metadata
 */
export interface BackupManifest {
  /** Backup type (agent/skill/memory) */
  type: BackupDirectoryType;
  /** Backup timestamp (ISO 8601) */
  timestamp: string;
  /** File count in backup */
  fileCount: number;
  /** Total size in bytes */
  totalSize: number;
  /** App version */
  appVersion: string;
  /** Platform (darwin/win32/linux) */
  platform: string;
}

/**
 * Backup file information
 */
export interface BackupFile {
  /** Backup ID */
  id: string;
  /** Backup type */
  type: BackupDirectoryType;
  /** Backup timestamp */
  timestamp: string;
  /** File size in bytes */
  size: number;
  /** Download URL */
  downloadUrl?: string;
}

/**
 * Backup status
 */
export enum BackupStatus {
  IDLE = 'idle',
  PREPARING = 'preparing',
  COMPRESSING = 'compressing',
  UPLOADING = 'uploading',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Backup progress information
 */
export interface BackupProgress {
  /** Current status */
  status: BackupStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current operation message */
  message: string;
  /** Current backup type being processed */
  currentType?: BackupDirectoryType;
}

/**
 * Backup state
 */
export interface BackupState {
  /** Whether backup is in progress */
  isBackingUp: boolean;
  /** Last backup timestamp (ISO 8601) */
  lastBackupTime: string | null;
  /** Next backup window start time (ISO 8601) */
  nextBackupWindow: string | null;
  /** Current progress */
  progress: BackupProgress | null;
}

/**
 * Backup service configuration
 */
export interface BackupConfig {
  /** Cloud backup API base URL */
  apiUrl: string;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Backup time window start (HH:mm format, e.g., "22:00") */
  windowStart: string;
  /** Backup time window end (HH:mm format, e.g., "04:00") */
  windowEnd: string;
  /** Idle time threshold in milliseconds before triggering backup */
  idleThreshold: number;
}

/**
 * Restore options
 */
export interface RestoreOptions {
  /** Backup ID to restore */
  backupId: string;
  /** Backup type */
  type: BackupDirectoryType;
  /** Whether to overwrite existing files */
  overwrite: boolean;
}

/**
 * Restore result
 */
export interface RestoreResult {
  /** Success flag */
  success: boolean;
  /** Number of files restored */
  filesRestored: number;
  /** Error message if failed */
  message?: string;
}

/**
 * Backup error types
 */
export enum BackupErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  COMPRESSION_ERROR = 'COMPRESSION_ERROR',
  UPLOAD_ERROR = 'UPLOAD_ERROR',
  DOWNLOAD_ERROR = 'DOWNLOAD_ERROR',
  EXTRACTION_ERROR = 'EXTRACTION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  SERVER_ERROR = 'SERVER_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Backup error class
 */
export class BackupError extends Error {
  constructor(
    public type: BackupErrorType,
    message: string,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'BackupError';
  }
}
