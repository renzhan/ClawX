/**
 * Login Page
 * IAM OAuth2 authentication — opens browser for IAM login
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader2, AlertCircle, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import { useTranslation } from 'react-i18next';
import clawxIcon from '@/assets/logo.svg';

export function Login() {
  const { t } = useTranslation(['login', 'common']);
  const navigate = useNavigate();

  const {
    login,
    cancelLogin,
    isLoading,
    error,
    clearError,
    isAuthenticated,
  } = useAuthStore();

  // Navigate to main app when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  const handleLogin = async () => {
    clearError();
    await login();
  };

  const handleCancel = async () => {
    await cancelLogin();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        {/* Logo and Title */}
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <img src={clawxIcon} alt="ClawX" className="h-16 w-16" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t('login:title', 'Welcome to ClawX')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('login:subtitle', 'Sign in with IAM to access cloud features')}
          </p>
        </div>

        {/* Login Card */}
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="space-y-4">
            {/* Error Message */}
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              >
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </motion.div>
            )}

            {/* Loading state — waiting for browser callback */}
            {isLoading && (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground text-center">
                  {t('login:waitingForBrowser', 'Waiting for IAM login in browser...')}
                </p>
                <p className="text-xs text-muted-foreground text-center">
                  {t('login:browserHint', 'Complete the login in your browser, then return here')}
                </p>
              </div>
            )}

            {/* IAM Login Button */}
            {!isLoading && (
              <Button
                className="w-full"
                onClick={handleLogin}
                disabled={isLoading}
              >
                <LogIn className="mr-2 h-4 w-4" />
                {t('login:loginButton', 'Sign in with IAM')}
              </Button>
            )}

            {/* Cancel Button (shown during loading) */}
            {isLoading && (
              <Button
                variant="outline"
                className="w-full"
                onClick={handleCancel}
              >
                {t('login:cancelLogin', 'Cancel')}
              </Button>
            )}

          </div>
        </div>
      </motion.div>
    </div>
  );
}
