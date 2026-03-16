/**
 * Route Guard Component
 * Protects routes based on IAM authentication status.
 * - If IAM is disabled, renders children directly (no protection).
 * - /setup is always accessible (initial app setup).
 * - /login is accessible only when NOT authenticated.
 * - All other routes require authentication — unauthenticated users are redirected to /login.
 * - Authenticated users visiting /login are redirected to /.
 */
import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';

interface RouteGuardProps {
  children: React.ReactNode;
}

export function RouteGuard({ children }: RouteGuardProps) {
  const location = useLocation();
  const iamEnabled = useAuthStore((s) => s.iamEnabled);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isCheckingAuth = useAuthStore((s) => s.isCheckingAuth);
  const checkIAMEnabled = useAuthStore((s) => s.checkIAMEnabled);
  const checkAuth = useAuthStore((s) => s.checkAuth);

  // Check IAM enabled status and auth on mount
  useEffect(() => {
    checkIAMEnabled();
    checkAuth();
  }, [checkIAMEnabled, checkAuth]);

  // IAM not enabled — no protection needed
  if (!iamEnabled) {
    return <>{children}</>;
  }

  // /setup is always accessible (initial app configuration)
  if (location.pathname.startsWith('/setup')) {
    return <>{children}</>;
  }

  // Still checking auth — show loading spinner
  if (isCheckingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // /login page handling
  if (location.pathname.startsWith('/login')) {
    // Already authenticated — redirect away from login
    if (isAuthenticated) {
      return <Navigate to="/" replace />;
    }
    // Not authenticated — show login page
    return <>{children}</>;
  }

  // All other routes: require authentication
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Authenticated — render children
  return <>{children}</>;
}
