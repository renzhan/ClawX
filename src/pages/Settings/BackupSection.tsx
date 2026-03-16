/**
 * Settings Backup Section
 * Shows backup status, manual trigger, progress, and restore dialog.
 * Hidden when user is not logged in.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  CloudUpload,
  CloudDownload,
  Loader2,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth';
import {
  getBackupStatus,
  triggerBackup,
  listBackups,
  restoreBackup,
  type BackupState,
  type BackupListItem,
} from '@/lib/host-api';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

function formatTime(isoString: string | null, neverLabel: string): string {
  if (!isoString) return neverLabel;
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BackupSection() {
  const { t } = useTranslation('settings');
  const { isAuthenticated, iamEnabled } = useAuthStore();

  const [status, setStatus] = useState<BackupState | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const shouldHide = iamEnabled && !isAuthenticated;

  const fetchStatus = useCallback(async () => {
    if (shouldHide) return;
    try {
      const s = await getBackupStatus();
      setStatus(s);
    } catch {
      // Silently fail - backup service may not be running
    }
  }, [shouldHide]);

  // Fetch backup status on mount and listen for IPC events
  useEffect(() => {
    if (shouldHide) return;

    fetchStatus();

    // Listen for real-time backup status updates
    const unsubStatus = window.electron.ipcRenderer.on(
      'backup:statusChanged',
      (...args: unknown[]) => {
        const newStatus = args[0] as BackupState;
        if (newStatus) setStatus(newStatus);
      },
    );

    const unsubCompleted = window.electron.ipcRenderer.on(
      'backup:completed',
      (...args: unknown[]) => {
        const success = args[0] as boolean;
        if (success) {
          toast.success(t('backup.backupSuccess'));
        } else {
          const errorMsg = args[1] as string | undefined;
          toast.error(`${t('backup.backupFailed')}${errorMsg ? `: ${errorMsg}` : ''}`);
        }
        fetchStatus();
      },
    );

    // Poll status every 30s as fallback
    const interval = setInterval(fetchStatus, 30_000);

    return () => {
      unsubStatus?.();
      unsubCompleted?.();
      clearInterval(interval);
    };
  }, [shouldHide, fetchStatus, t]);

  // Don't render if IAM is enabled but user is not authenticated
  if (shouldHide) {
    return null;
  }

  const handleTriggerBackup = async () => {
    setTriggering(true);
    try {
      await triggerBackup();
      // Status will be updated via IPC events
      await fetchStatus();
    } catch (err) {
      toast.error(`${t('backup.backupFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTriggering(false);
    }
  };

  const handleOpenRestore = async () => {
    setShowRestoreDialog(true);
    setLoadingBackups(true);
    try {
      const list = await listBackups();
      setBackups(list);
    } catch {
      toast.error(t('backup.loadBackupsFailed'));
      setBackups([]);
    } finally {
      setLoadingBackups(false);
    }
  };

  const handleRestore = async (backup: BackupListItem) => {
    setRestoringId(backup.id);
    try {
      await restoreBackup(backup.id, backup.type);
      toast.success(t('backup.restoreSuccess'));
      setShowRestoreDialog(false);
    } catch (err) {
      toast.error(`${t('backup.restoreFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRestoringId(null);
    }
  };

  const isBackingUp = status?.isBackingUp || triggering;

  return (
    <>
      <div className="space-y-6">
        {/* Status info */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="text-[15px] font-medium text-foreground">
                  {t('backup.lastBackup')}
                </Label>
                <span className="text-[13px] text-muted-foreground">
                  {formatTime(status?.lastBackupTime ?? null, t('backup.lastBackupNever'))}
                </span>
              </div>
              {status?.nextBackupWindow && (
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[13px] text-muted-foreground">
                    {t('backup.nextWindow')}: {status.nextBackupWindow}
                  </span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTriggerBackup}
                disabled={isBackingUp}
                className="rounded-full h-9 px-5 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
              >
                {isBackingUp ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    {t('backup.backingUp')}
                  </>
                ) : (
                  <>
                    <CloudUpload className="h-3.5 w-3.5 mr-1.5" />
                    {t('backup.backupNow')}
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenRestore}
                disabled={isBackingUp}
                className="rounded-full h-9 px-5 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
              >
                <CloudDownload className="h-3.5 w-3.5 mr-1.5" />
                {t('backup.restoreFromCloud')}
              </Button>
            </div>
          </div>

          {/* Backup progress */}
          {status?.progress && status.isBackingUp && (
            <div className="p-4 rounded-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground">
                  {status.progress.message}
                </span>
                {status.progress.currentType && (
                  <Badge
                    variant="secondary"
                    className="rounded-full px-3 py-0.5 bg-white dark:bg-card border border-black/5 dark:border-white/5 text-[12px]"
                  >
                    {t(`backup.backupType.${status.progress.currentType}` as const, status.progress.currentType)}
                  </Badge>
                )}
              </div>
              <Progress value={status.progress.progress} className="h-2" />
            </div>
          )}
        </div>
      </div>

      {/* Restore Dialog */}
      {showRestoreDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-dialog-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !restoringId) setShowRestoreDialog(false);
          }}
        >
          <div className="mx-4 w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 id="restore-dialog-title" className="text-lg font-semibold">
              {t('backup.restoreTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('backup.restoreDesc')}
            </p>

            <div className="mt-4 max-h-80 overflow-y-auto space-y-2">
              {loadingBackups ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  {t('backup.loadingBackups')}
                </div>
              ) : backups.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm font-medium text-foreground">{t('backup.noBackups')}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t('backup.noBackupsDesc')}</p>
                </div>
              ) : (
                backups.map((backup) => (
                  <div
                    key={backup.id}
                    className={cn(
                      'flex items-center justify-between rounded-xl border border-black/5 dark:border-white/5 p-3',
                      'bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className="rounded-full px-2 py-0 text-[11px] bg-white dark:bg-card border border-black/5 dark:border-white/5"
                        >
                          {t(`backup.backupType.${backup.type}` as const, backup.type)}
                        </Badge>
                        <span className="text-[13px] text-foreground">
                          {formatTime(backup.createdAt, '')}
                        </span>
                      </div>
                      <p className="text-[12px] text-muted-foreground mt-0.5">
                        {formatSize(backup.size)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRestore(backup)}
                      disabled={restoringId !== null}
                      className="rounded-full h-8 px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 ml-3"
                    >
                      {restoringId === backup.id ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          {t('backup.restoring')}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                          {t('backup.restoreConfirm')}
                        </>
                      )}
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                variant="outline"
                onClick={() => setShowRestoreDialog(false)}
                disabled={restoringId !== null}
              >
                {t('backup.restoreCancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
