/**
 * Auto-Updater Module
 * Handles automatic application updates using electron-updater
 *
 * macOS: 绕过 Squirrel.Mac 签名校验，使用 shell 脚本解压替换安装
 * Windows/Linux: 走原生 electron-updater 安装流程
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { BrowserWindow, app, ipcMain } from 'electron';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { setQuitting } from './app-state';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

export interface UpdaterEvents {
  'status-changed': (status: UpdateStatus) => void;
  'checking-for-update': () => void;
  'update-available': (info: UpdateInfo) => void;
  'update-not-available': (info: UpdateInfo) => void;
  'download-progress': (progress: ProgressInfo) => void;
  'update-downloaded': (event: UpdateDownloadedEvent) => void;
  'error': (error: Error) => void;
}

/**
 * Detect the update channel from a semver version string.
 * e.g. "0.1.8-alpha.0" → "alpha", "1.0.0-beta.1" → "beta", "1.0.0" → "latest"
 */
function detectChannel(version: string): string {
  const match = version.match(/-([a-zA-Z]+)/);
  return match ? match[1] : 'latest';
}

export class AppUpdater extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private status: UpdateStatus = { status: 'idle' };
  private autoInstallTimer: NodeJS.Timeout | null = null;
  private autoInstallCountdown = 0;
  /** 保存下载完成的 zip 文件路径（macOS 手动安装用） */
  private downloadedFilePath: string | null = null;

  /** Delay (in seconds) before auto-installing a downloaded update. */
  private static readonly AUTO_INSTALL_DELAY_SECONDS = 5;

  constructor() {
    super();

    this.on('error', (error: Error) => {
      logger.error('[Updater] AppUpdater emitted error:', error);
    });

    autoUpdater.autoDownload = false;

    // macOS: 禁止 Squirrel.Mac 自动介入，由自定义逻辑处理安装
    // Windows/Linux: 走原生安装流程
    if (process.platform === 'darwin') {
      autoUpdater.autoInstallOnAppQuit = false;
    } else {
      autoUpdater.autoInstallOnAppQuit = true;
    }

    autoUpdater.logger = {
      info: (msg: string) => logger.info('[Updater]', msg),
      warn: (msg: string) => logger.warn('[Updater]', msg),
      error: (msg: string) => logger.error('[Updater]', msg),
      debug: (msg: string) => logger.debug('[Updater]', msg),
    };

    const version = app.getVersion();
    const channel = detectChannel(version);

    logger.info(`[Updater] Version: ${version}, channel: ${channel}`);

    autoUpdater.channel = channel;

    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://aiop-prod.item.com/bridgecenter/clawx/update/latest',
      useMultipleRangeRequest: false,
    });

    this.setupListeners();
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  private setupListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      this.updateStatus({ status: 'checking' });
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'available', info });
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'not-available', info });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateStatus({ status: 'downloading', progress });
      this.emit('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      // 保存下载的文件路径，macOS 手动安装时使用
      this.downloadedFilePath = (event as any).downloadedFile || null;
      logger.info(`[Updater] Update downloaded: ${this.downloadedFilePath}`);

      this.updateStatus({ status: 'downloaded', info: event });
      this.emit('update-downloaded', event);

      if (autoUpdater.autoDownload) {
        this.startAutoInstallCountdown();
      }
    });

    autoUpdater.on('error', (error: Error) => {
      this.updateStatus({ status: 'error', error: error.message });
      this.emit('error', error);
    });
  }

  private updateStatus(newStatus: Partial<UpdateStatus>): void {
    this.status = {
      status: newStatus.status ?? this.status.status,
      info: newStatus.info,
      progress: newStatus.progress,
      error: newStatus.error,
    };
    this.sendToRenderer('update:status-changed', this.status);
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      const result = await autoUpdater.checkForUpdates();

      if (result == null) {
        this.updateStatus({
          status: 'error',
          error: 'Update check skipped (dev mode – app is not packaged)',
        });
        return null;
      }

      if (this.status.status === 'checking' || this.status.status === 'idle') {
        this.updateStatus({ status: 'not-available' });
      }

      return result.updateInfo || null;
    } catch (error) {
      logger.error('[Updater] Check for updates failed:', error);
      this.updateStatus({ status: 'error', error: (error as Error).message || String(error) });
      throw error;
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logger.error('[Updater] Download update failed:', error);
      throw error;
    }
  }

  /**
   * 安装更新并重启
   * macOS: 绕过 Squirrel.Mac，使用 shell 脚本解压替换
   * Windows/Linux: 走原生 autoUpdater.quitAndInstall()
   */
  quitAndInstall(): void {
    logger.info('[Updater] quitAndInstall called');
    setQuitting();

    if (process.platform === 'darwin') {
      this.manualMacInstall();
    } else {
      autoUpdater.quitAndInstall();
    }
  }

  /**
   * macOS 手动安装：绕过 Squirrel.Mac 签名校验
   * 1. 找到 electron-updater 已下载的 zip
   * 2. 写一个 shell 脚本
   * 3. 启动 detached 脚本进程
   * 4. 退出当前 app
   * 5. 脚本等待旧进程退出后，解压 zip 替换 .app 并重启
   */
  private manualMacInstall(): void {
    // 查找下载的 zip 文件
    let zipPath = this.downloadedFilePath;

    // 如果 downloadedFilePath 为空，尝试从缓存目录查找
    if (!zipPath || !fs.existsSync(zipPath)) {
      zipPath = this.findUpdateZip();
    }

    if (!zipPath) {
      logger.error('[Updater] No zip file found, cannot install update');
      this.updateStatus({ status: 'error', error: '未找到更新文件' });
      return;
    }

    logger.info(`[Updater] Manual mac install from: ${zipPath}`);

    // 当前 app 的路径，如 /Applications/Item-ClawX.app
    const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '');
    const tempDir = path.join(app.getPath('temp'), `clawx-update-${Date.now()}`);
    const scriptPath = path.join(app.getPath('temp'), `clawx-update-${Date.now()}.sh`);

    const script = `#!/bin/bash
  # 等待当前 app 进程退出
  APP_PID=${process.pid}
  while kill -0 $APP_PID 2>/dev/null; do
    sleep 0.5
  done

  # 解压更新包
  mkdir -p "${tempDir}"
  ditto -xk "${zipPath}" "${tempDir}"

  # 找到解压出来的 .app
  NEW_APP=$(find "${tempDir}" -maxdepth 1 -name "*.app" | head -1)
  if [ -z "$NEW_APP" ]; then
    echo "[ClawX Updater] Error: No .app found in update zip" >&2
    rm -rf "${tempDir}"
    exit 1
  fi

  # 删除旧版本，替换为新版本
  rm -rf "${appPath}"
  mv "$NEW_APP" "${appPath}"

  # 去除 macOS 隔离属性，避免 Gatekeeper 拦截
  xattr -cr "${appPath}" 2>/dev/null

  # 重新启动新版本
  open "${appPath}"

  # 清理临时文件
  rm -rf "${tempDir}"
  rm -f "${scriptPath}"
  `;

    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    // 启动 detached 脚本进程（app 退出后继续运行）
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    logger.info('[Updater] Update script launched, quitting app...');
    app.quit();
  }

  /**
   * 从 electron-updater 缓存目录中查找已下载的 zip 文件
   */
  private findUpdateZip(): string | null {
    // electron-updater 的缓存目录
    const possibleDirs = [
      path.join(app.getPath('home'), 'Library', 'Caches', `${app.name}-updater`),
      path.join(app.getPath('home'), 'Library', 'Caches', app.name),
      path.join(app.getPath('userData'), 'pending'),
    ];

    for (const dir of possibleDirs) {
      const found = this.findZipInDir(dir);
      if (found) {
        logger.info(`[Updater] Found update zip in: ${dir}`);
        return found;
      }
    }

    logger.warn(`[Updater] No update zip found in any cache directory`);
    return null;
  }

  /**
   * 递归查找目录中的 zip 文件
   */
  private findZipInDir(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;

    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (item.endsWith('.zip') && stat.isFile()) {
          return fullPath;
        }
        if (stat.isDirectory()) {
          const found = this.findZipInDir(fullPath);
          if (found) return found;
        }
      }
    } catch (e) {
      logger.warn(`[Updater] Error scanning directory ${dir}: ${e}`);
    }

    return null;
  }

  private startAutoInstallCountdown(): void {
    this.clearAutoInstallTimer();
    this.autoInstallCountdown = AppUpdater.AUTO_INSTALL_DELAY_SECONDS;
    this.sendToRenderer('update:auto-install-countdown', { seconds: this.autoInstallCountdown });

    this.autoInstallTimer = setInterval(() => {
      this.autoInstallCountdown--;
      this.sendToRenderer('update:auto-install-countdown', { seconds: this.autoInstallCountdown });

      if (this.autoInstallCountdown <= 0) {
        this.clearAutoInstallTimer();
        this.quitAndInstall();
      }
    }, 1000);
  }

  cancelAutoInstall(): void {
    this.clearAutoInstallTimer();
    this.sendToRenderer('update:auto-install-countdown', { seconds: -1, cancelled: true });
  }

  private clearAutoInstallTimer(): void {
    if (this.autoInstallTimer) {
      clearInterval(this.autoInstallTimer);
      this.autoInstallTimer = null;
    }
  }

  setChannel(channel: 'stable' | 'beta' | 'dev'): void {
    autoUpdater.channel = channel;
  }

  setAutoDownload(enable: boolean): void {
    autoUpdater.autoDownload = enable;
  }

  getCurrentVersion(): string {
    return app.getVersion();
  }
}

/**
 * Register IPC handlers for update operations
 */
export function registerUpdateHandlers(
    updater: AppUpdater,
    mainWindow: BrowserWindow
): void {
  updater.setMainWindow(mainWindow);

  ipcMain.handle('update:status', () => {
    return updater.getStatus();
  });

  ipcMain.handle('update:version', () => {
    return updater.getCurrentVersion();
  });

  ipcMain.handle('update:check', async () => {
    try {
      await updater.checkForUpdates();
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      await updater.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('update:install', () => {
    updater.quitAndInstall();
    return { success: true };
  });

  ipcMain.handle('update:setChannel', (_, channel: 'stable' | 'beta' | 'dev') => {
    updater.setChannel(channel);
    return { success: true };
  });

  ipcMain.handle('update:setAutoDownload', (_, enable: boolean) => {
    updater.setAutoDownload(enable);
    return { success: true };
  });

  ipcMain.handle('update:cancelAutoInstall', () => {
    updater.cancelAutoInstall();
    return { success: true };
  });
}

// Export singleton instance
export const appUpdater = new AppUpdater();