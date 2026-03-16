/**
 * Auth State Store
 * Manages IAM OAuth2 authentication state
 */
import { create } from 'zustand';
import { invokeIpc } from '@/lib/api-client';

interface IAMUser {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  companyCode?: string;
}

interface IAMToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface IAMAuthState {
  isAuthenticated: boolean;
  user: IAMUser | null;
  token: IAMToken | null;
}

interface AuthState extends IAMAuthState {
  /** Loading during login flow */
  isLoading: boolean;
  /** Loading during initial auth check */
  isCheckingAuth: boolean;
  /** Error message */
  error: string | null;
  /** Whether IAM feature is enabled */
  iamEnabled: boolean;

  // Actions
  checkIAMEnabled: () => Promise<boolean>;
  login: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  token: null,
  isLoading: false,
  isCheckingAuth: false,
  error: null,
  iamEnabled: false,

  checkIAMEnabled: async () => {
    try {
      const result = await invokeIpc<{ success: boolean; enabled?: boolean }>('iam:isEnabled');
      if (result.success && result.enabled !== undefined) {
        set({ iamEnabled: result.enabled });
        return result.enabled;
      }
      return false;
    } catch (error) {
      console.error('[Auth] Failed to check IAM enabled:', error);
      return false;
    }
  },

  /**
   * Start OAuth2 login flow — opens browser for IAM authorization
   */
  login: async () => {
    set({ isLoading: true, error: null });

    try {
      const result = await invokeIpc<{ success: boolean; data?: IAMAuthState; error?: string }>('iam:login');

      if (result.success && result.data) {
        set({
          isAuthenticated: result.data.isAuthenticated,
          user: result.data.user,
          token: result.data.token,
          isLoading: false,
          error: null,
        });
      } else {
        set({
          isLoading: false,
          error: result.error || 'Login failed',
        });
      }
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
    }
  },

  /**
   * Cancel in-progress OAuth login
   */
  cancelLogin: async () => {
    try {
      await invokeIpc('iam:cancelLogin');
    } catch {
      // ignore
    }
    set({ isLoading: false, error: null });
  },

  logout: async () => {
    set({ isLoading: true, error: null });

    try {
      const result = await invokeIpc<{ success: boolean; error?: string }>('iam:logout');

      if (result.success) {
        set({
          isAuthenticated: false,
          user: null,
          token: null,
          isLoading: false,
          error: null,
        });
      } else {
        set({ isLoading: false, error: result.error || 'Logout failed' });
      }
    } catch (error) {
      // Even if logout fails, clear local state
      set({
        isAuthenticated: false,
        user: null,
        token: null,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Logout failed',
      });
    }
  },

  checkAuth: async () => {
    set({ isCheckingAuth: true, error: null });

    try {
      const result = await invokeIpc<{ success: boolean; data?: IAMAuthState; error?: string }>('iam:checkAuth');

      if (result.success && result.data) {
        set({
          isAuthenticated: result.data.isAuthenticated,
          user: result.data.user,
          token: result.data.token,
          isCheckingAuth: false,
          error: null,
        });
      } else {
        set({
          isAuthenticated: false,
          user: null,
          token: null,
          isCheckingAuth: false,
          error: null,
        });
      }
    } catch {
      set({
        isAuthenticated: false,
        user: null,
        token: null,
        isCheckingAuth: false,
        error: null,
      });
    }
  },

  clearError: () => set({ error: null }),
}));
