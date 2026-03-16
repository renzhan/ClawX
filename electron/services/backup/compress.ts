/**
 * Directory Compression Utility
 *
 * Compresses a directory into a zip file with a manifest.json,
 * excluding temporary/cache files and .git directories.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { createWriteStream } from 'fs';
import { readdir, stat, readFile } from 'fs/promises';
import { join, relative, basename } from 'path';
import { tmpdir } from 'os';
import { app } from 'electron';
import archiver from 'archiver';
import { BackupDirectoryType, BackupError, BackupErrorType } from './types';
import type { BackupManifest } from './types';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Exclude patterns (R5.5)
// ---------------------------------------------------------------------------

/** Directories to exclude entirely */
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.cache',
]);

/** File extensions to exclude */
const EXCLUDED_EXTENSIONS = new Set([
  '.tmp',
  '.log',
  '.swp',
  '.swo',
]);

/** Specific file name patterns to exclude */
const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/**
 * Check whether a file/directory name should be excluded from the backup.
 */
export function shouldExclude(entryName: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return EXCLUDED_DIRS.has(entryName);
  }

  if (EXCLUDED_FILES.has(entryName)) {
    return true;
  }

  const ext = entryName.lastIndexOf('.') >= 0
    ? entryName.slice(entryName.lastIndexOf('.')).toLowerCase()
    : '';

  return EXCLUDED_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files in a directory, respecting exclude rules.
 * Returns paths relative to `rootDir`.
 */
export async function collectFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (shouldExclude(entry.name, entry.isDirectory())) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(relative(rootDir, fullPath));
      }
    }
  }

  await walk(rootDir);
  return results;
}

// ---------------------------------------------------------------------------
// Zip filename generation (R5.4)
// ---------------------------------------------------------------------------

/**
 * Generate a backup zip filename in the format `{type}-YYYY-MM-DD-HHmmss.zip`.
 */
export function generateZipFilename(type: BackupDirectoryType, now?: Date): string {
  const d = now ?? new Date();
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${type}-${yyyy}-${MM}-${dd}-${HH}${mm}${ss}.zip`;
}

// ---------------------------------------------------------------------------
// Manifest generation (R5.2, R5.3)
// ---------------------------------------------------------------------------

/**
 * Build a BackupManifest for the given directory.
 */
export async function buildManifest(
  type: BackupDirectoryType,
  dirPath: string,
  files: string[],
  timestamp: Date,
): Promise<BackupManifest> {
  let totalSize = 0;

  for (const relPath of files) {
    try {
      const s = await stat(join(dirPath, relPath));
      totalSize += s.size;
    } catch {
      // File may have been removed between enumeration and stat — skip
    }
  }

  return {
    type,
    timestamp: timestamp.toISOString(),
    fileCount: files.length,
    totalSize,
    appVersion: app.getVersion(),
    platform: process.platform,
  };
}

// ---------------------------------------------------------------------------
// Compression (R5.1)
// ---------------------------------------------------------------------------

export interface CompressResult {
  /** Absolute path to the generated zip file */
  zipPath: string;
  /** The manifest embedded in the zip */
  manifest: BackupManifest;
}

/**
 * Compress a single backup directory into a zip file.
 *
 * The zip contains:
 * - All files from the directory (excluding patterns per R5.5)
 * - A `manifest.json` with metadata (R5.2, R5.3)
 *
 * The zip is written to `os.tmpdir()` with the naming convention
 * `{type}-YYYY-MM-DD-HHmmss.zip` (R5.4).
 *
 * After writing, the zip is verified for integrity (R5.6).
 */
export async function compressDirectory(
  type: BackupDirectoryType,
  dirPath: string,
  outputDir?: string,
  now?: Date,
): Promise<CompressResult> {
  const timestamp = now ?? new Date();
  const destDir = outputDir ?? tmpdir();
  const zipName = generateZipFilename(type, timestamp);
  const zipPath = join(destDir, zipName);

  logger.info('[Backup] Compressing directory', {
    type,
    dirPath,
    zipPath,
  });

  // 1. Collect files (R5.5 — excludes applied)
  const files = await collectFiles(dirPath);

  if (files.length === 0) {
    logger.warn('[Backup] Directory is empty or all files excluded', { type, dirPath });
  }

  // 2. Build manifest (R5.2, R5.3)
  const manifest = await buildManifest(type, dirPath, files, timestamp);

  // 3. Create zip archive (R5.1)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve());
    archive.on('error', (err: Error) =>
      reject(
        new BackupError(
          BackupErrorType.COMPRESSION_ERROR,
          `Compression failed for ${type}: ${err.message}`,
          err,
        ),
      ),
    );
    archive.on('warning', (err: Error) => {
      logger.warn('[Backup] Archiver warning', { type, message: err.message });
    });

    archive.pipe(output);

    // Add manifest.json first
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Add directory contents (respecting excludes via the collected file list)
    for (const relPath of files) {
      const absPath = join(dirPath, relPath);
      archive.file(absPath, { name: relPath });
    }

    void archive.finalize();
  });

  // 4. Verify zip integrity (R5.6)
  await verifyZipIntegrity(zipPath);

  logger.info('[Backup] Compression complete', {
    type,
    fileCount: manifest.fileCount,
    totalSize: manifest.totalSize,
    zipPath,
  });

  return { zipPath, manifest };
}

// ---------------------------------------------------------------------------
// Zip integrity verification (R5.6)
// ---------------------------------------------------------------------------

/**
 * Verify that a zip file is valid by reading its central directory.
 *
 * A valid zip file ends with an End-of-Central-Directory (EOCD) record
 * whose signature is 0x06054b50. We also check that the file is non-empty.
 */
export async function verifyZipIntegrity(zipPath: string): Promise<void> {
  try {
    const buf = await readFile(zipPath);

    if (buf.length < 22) {
      throw new Error('File too small to be a valid zip');
    }

    // Search for EOCD signature (0x06054b50) from the end of the file.
    // The EOCD record is at least 22 bytes and at most 22 + 65535 bytes
    // from the end (when a zip comment is present).
    const searchStart = Math.max(0, buf.length - 22 - 65535);
    let found = false;

    for (let i = buf.length - 22; i >= searchStart; i--) {
      if (
        buf[i] === 0x50 &&
        buf[i + 1] === 0x4b &&
        buf[i + 2] === 0x05 &&
        buf[i + 3] === 0x06
      ) {
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error('Missing End-of-Central-Directory signature');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown verification error';
    throw new BackupError(
      BackupErrorType.COMPRESSION_ERROR,
      `Zip integrity check failed for ${basename(zipPath)}: ${message}`,
      err,
    );
  }
}
