/**
 * Settings Auth Section
 * Displays user info when logged in, or a "Go to Login" prompt when not.
 * Only rendered when IAM is enabled.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, LogIn, User, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth';
import { useTranslation } from 'react-i18next';

export function AuthSection() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { isAuthenticated, user, logout } = useAuthStore();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      toast.success(t('auth.logoutSuccess'));
    } catch {
      toast.error(t('auth.logoutFailed'));
    } finally {
      setLoggingOut(false);
    }
  };

  const handleGoToLogin = () => {
    navigate('/login');
  };

  if (isAuthenticated && user) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
              <User className="h-5 w-5 text-foreground/70" />
            </div>
            <div>
              <Label className="text-[15px] font-medium text-foreground">
                {user.displayName || user.username}
              </Label>
              {user.email && (
                <p className="text-[13px] text-muted-foreground">{user.email}</p>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            disabled={loggingOut}
            className="rounded-full h-9 px-5 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
          >
            {loggingOut ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                {t('auth.loggingOut')}
              </>
            ) : (
              <>
                <LogOut className="h-3.5 w-3.5 mr-1.5" />
                {t('auth.logout')}
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  // Not logged in
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Label className="text-[15px] font-medium text-foreground">
            {t('auth.notLoggedIn')}
          </Label>
          <p className="text-[13px] text-muted-foreground mt-1">
            {t('auth.notLoggedInDesc')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleGoToLogin}
          className="rounded-full h-9 px-5 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
        >
          <LogIn className="h-3.5 w-3.5 mr-1.5" />
          {t('auth.goToLogin')}
        </Button>
      </div>
    </div>
  );
}
