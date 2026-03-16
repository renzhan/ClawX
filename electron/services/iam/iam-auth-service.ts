/**
 * IAM Authentication Service (OAuth2 Authorization Code Flow)
 *
 * Flow:
 * 1. Start a temporary local HTTP server to receive the OAuth callback
 * 2. Open IAM authorization URL in system browser
 * 3. User logs in on IAM page → IAM redirects to localhost with authorization_code
 * 4. Exchange code for access_token + user info via IAM token endpoint
 * 5. Store token in electron-store, notify renderer
 */

import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { shell, BrowserWindow } from 'electron';
import type {
  IAMUser,
  IAMToken,
  IAMTokenResponse,
  IAMAuthState,
  IAMConfig,
} from './types';
import { IAMError, IAMErrorType } from './types';
import { IAM_CONFIG } from '../../utils/config';
import { logger } from '../../utils/logger';

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let iamStoreInstance: any = null;

interface IAMStoreSchema {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  user: IAMUser | null;
}

async function getIAMStore() {
  if (!iamStoreInstance) {
    const Store = (await import('electron-store')).default;
    iamStoreInstance = new Store<IAMStoreSchema>({
      name: 'iam-auth',
      defaults: {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        user: null,
      },
    });
  }
  return iamStoreInstance;
}

/**
 * Build the IAM config from centralized configuration (electron/utils/config.ts).
 */
function buildConfig(): IAMConfig {
  return {
    iamHost: IAM_CONFIG.HOST,
    tokenPath: IAM_CONFIG.TOKEN_PATH,
    authorizePath: IAM_CONFIG.AUTHORIZE_PATH,
    userInfoPath: IAM_CONFIG.USERINFO_PATH,
    clientId: IAM_CONFIG.CLIENT_ID,
    clientSecret: IAM_CONFIG.CLIENT_SECRET,
    authorization: IAM_CONFIG.AUTHORIZATION,
    redirectUri: process.env.IAM_REDIRECT_URI || '', // set dynamically
    timeout: IAM_CONFIG.TIMEOUT,
    enabled: IAM_CONFIG.ENABLED,
  };
}



/**
 * IAM Authentication Service
 */
export class IAMAuthService {
  private config: IAMConfig;
  private callbackServer: Server | null = null;
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    this.config = buildConfig();

    logger.debug('[IAM] Service initialized', {
      enabled: this.config.enabled,
      iamHost: this.config.iamHost ? '[CONFIGURED]' : '[NOT SET]',
      clientId: this.config.clientId ? '[CONFIGURED]' : '[NOT SET]',
      timeout: this.config.timeout,
    });
  }

  /**
   * Attach the main BrowserWindow for sending IPC events
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * Check if IAM feature is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get current configuration (sensitive fields masked)
   */
  getConfig(): IAMConfig {
    return { ...this.config };
  }

  // ---------------------------------------------------------------------------
  // OAuth2 Login Flow
  // ---------------------------------------------------------------------------

  /**
   * Start the OAuth2 login flow:
   * 1. Start a local HTTP server to receive the callback
   * 2. Open the IAM authorization URL in the system browser
   * 3. Wait for the callback with the authorization code
   * 4. Exchange the code for a token
   * 5. Store the token and user info
   */
  async startOAuthLogin(): Promise<IAMAuthState> {
    if (!this.config.enabled) {
      throw new IAMError(IAMErrorType.UNAUTHORIZED, 'IAM authentication is not enabled');
    }

    if (!this.config.iamHost) {
      throw new IAMError(IAMErrorType.SERVER_ERROR, 'IAM host is not configured');
    }

    if (!this.config.authorization) {
      throw new IAMError(IAMErrorType.SERVER_ERROR, 'IAM client credentials are not configured');
    }

    logger.info('[IAM] Starting OAuth2 login flow');

    // Stop any existing callback server
    await this.stopCallbackServer();

    try {
      // 1. Start local callback server and get the port
      const { port, codePromise } = await this.startCallbackServer();
      const redirectUri = `http://localhost:${port}/callback`;

      logger.debug('[IAM] Callback server started', { port });

      // 2. Build and open the authorization URL
      const authUrl = this.buildAuthorizationUrl(redirectUri);
      logger.info('[IAM] Opening authorization URL in browser');
      await shell.openExternal(authUrl);

      // Notify renderer that browser was opened
      this.sendEvent('iam:oauthStarted', { url: authUrl });

      // 3. Wait for the authorization code (with timeout)
      const code = await Promise.race([
        codePromise,
        this.createTimeout(120_000, 'OAuth login timed out — no callback received within 2 minutes'),
      ]);

      logger.info('[IAM] Authorization code received');

      // 4. Exchange code for token
      const authState = await this.exchangeCodeForToken(code, redirectUri);

      logger.info('[IAM] OAuth2 login successful', {
        userId: authState.user?.id,
        username: authState.user?.username,
      });

      // Notify renderer
      this.sendEvent('iam:loginSuccess', {
        user: authState.user,
      });

      return authState;
    } catch (error) {
      logger.error('[IAM] OAuth2 login failed:', error);

      this.sendEvent('iam:loginError', {
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    } finally {
      await this.stopCallbackServer();
    }
  }

  /**
   * Cancel an in-progress OAuth login
   */
  async cancelOAuthLogin(): Promise<void> {
    logger.info('[IAM] OAuth login cancelled');
    await this.stopCallbackServer();
  }

  // ---------------------------------------------------------------------------
  // Token Exchange
  // ---------------------------------------------------------------------------

  /**
   * Exchange authorization_code for access_token via IAM token endpoint
   */
  private async exchangeCodeForToken(code: string, redirectUri: string): Promise<IAMAuthState> {
    const tokenUrl = `${this.config.iamHost}${this.config.tokenPath}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Authorization': this.config.authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 401) {
          throw new IAMError(IAMErrorType.INVALID_CREDENTIALS, 'Invalid authorization code');
        }
        throw new IAMError(
          IAMErrorType.SERVER_ERROR,
          `Token exchange failed: HTTP ${response.status}${errorText ? ` - ${errorText}` : ''}`,
        );
      }

      const data = await response.json() as IAMTokenResponse;

      // Parse response — handle both nested and flat formats
      let accessToken: string;
      let refreshToken: string | undefined;
      let userId: string;
      let userName: string;
      let companyCode: string | undefined;
      let expiresInSec: number;

      if (data.data) {
        // Nested format: { success: true, data: { accessToken, ... } }
        accessToken = data.data.accessToken;
        refreshToken = data.data.refreshToken;
        userId = data.data.userId;
        userName = data.data.userName;
        companyCode = data.data.companyCode;
        expiresInSec = typeof data.data.expiresIn === 'string'
          ? parseInt(data.data.expiresIn, 10)
          : (data.data.expiresIn || 86400);
      } else if (data.access_token) {
        // Flat OAuth2 format: { access_token, refresh_token, expires_in }
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
        expiresInSec = data.expires_in || 86400;
        // Need to fetch user info separately
        userId = '';
        userName = '';
      } else {
        throw new IAMError(IAMErrorType.SERVER_ERROR, 'Invalid token response from IAM server');
      }

      if (!accessToken) {
        throw new IAMError(IAMErrorType.SERVER_ERROR, 'No access token in IAM response');
      }

      const expiresAt = Date.now() + expiresInSec * 1000;

      // If we didn't get user info from token response, fetch it
      if (!userId) {
        const userInfo = await this.fetchUserInfo(accessToken);
        userId = userInfo.id;
        userName = userInfo.username;
        companyCode = userInfo.companyCode;
      }

      const token: IAMToken = { accessToken, refreshToken, expiresAt };
      const user: IAMUser = {
        id: userId,
        username: userName,
        companyCode,
      };

      await this.saveAuthState(token, user);

      return { isAuthenticated: true, user, token };
    } catch (error) {
      if (error instanceof IAMError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new IAMError(IAMErrorType.TIMEOUT_ERROR, 'Token exchange timed out', error);
      }

      throw new IAMError(
        IAMErrorType.NETWORK_ERROR,
        `Network error during token exchange: ${error instanceof Error ? error.message : 'Unknown'}`,
        error,
      );
    }
  }

  /**
   * Fetch user info from IAM using access token
   */
  private async fetchUserInfo(accessToken: string): Promise<IAMUser> {
    const url = `${this.config.iamHost}${this.config.userInfoPath}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new IAMError(IAMErrorType.SERVER_ERROR, `Failed to fetch user info: HTTP ${response.status}`);
    }

    const result = await response.json() as {
      code?: number;
      success?: boolean;
      data?: { id: string; email?: string; userName: string; companyCode?: string };
    };

    const userData = result.data;
    if (!userData) {
      throw new IAMError(IAMErrorType.SERVER_ERROR, 'Invalid user info response');
    }

    return {
      id: String(userData.id),
      username: userData.userName,
      email: userData.email,
      companyCode: userData.companyCode,
    };
  }

  // ---------------------------------------------------------------------------
  // Token Verification & State
  // ---------------------------------------------------------------------------

  /**
   * Verify if current token is valid (not expired)
   */
  async verifyToken(): Promise<boolean> {
    if (!this.config.enabled) return false;

    const store = await getIAMStore();
    const accessToken = store.get('accessToken');
    const expiresAt = store.get('expiresAt');

    if (!accessToken || !expiresAt) return false;

    if (Date.now() >= expiresAt) {
      logger.info('[IAM] Token expired');
      await this.clearAuthState();
      return false;
    }

    return true;
  }

  /**
   * Get current authentication state
   */
  async getAuthState(): Promise<IAMAuthState> {
    if (!this.config.enabled) {
      return { isAuthenticated: false, user: null, token: null };
    }

    const isValid = await this.verifyToken();
    if (!isValid) {
      return { isAuthenticated: false, user: null, token: null };
    }

    const store = await getIAMStore();
    const accessToken = store.get('accessToken') as string | null;
    const refreshToken = store.get('refreshToken') as string | null;
    const expiresAt = store.get('expiresAt') as number | null;
    const user = store.get('user') as IAMUser | null;

    return {
      isAuthenticated: true,
      user,
      token: accessToken && expiresAt
        ? { accessToken, refreshToken: refreshToken || undefined, expiresAt }
        : null,
    };
  }

  /**
   * Get current user
   */
  async getCurrentUser(): Promise<IAMUser | null> {
    const state = await this.getAuthState();
    return state.user;
  }

  /**
   * Get current access token (null if expired or not logged in)
   */
  async getToken(): Promise<string | null> {
    const state = await this.getAuthState();
    return state.token?.accessToken || null;
  }

  /**
   * Logout and clear authentication state
   */
  async logout(): Promise<void> {
    logger.info('[IAM] Logout');
    await this.stopCallbackServer();
    await this.clearAuthState();
  }

  // ---------------------------------------------------------------------------
  // Local Callback Server
  // ---------------------------------------------------------------------------

  /**
   * Start a temporary local HTTP server to receive the OAuth callback.
   * Returns the port and a promise that resolves with the authorization code.
   */
  private startCallbackServer(): Promise<{ port: number; codePromise: Promise<string> }> {
    return new Promise((resolveSetup, rejectSetup) => {
      let resolveCode: (code: string) => void;
      let rejectCode: (err: Error) => void;

      const codePromise = new Promise<string>((res, rej) => {
        resolveCode = res;
        rejectCode = rej;
      });

      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url || '/', `http://localhost`);

          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              const desc = url.searchParams.get('error_description') || error;
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.buildCallbackHtml(false, desc));
              rejectCode(new IAMError(IAMErrorType.OAUTH_ERROR, `OAuth error: ${desc}`));
              return;
            }

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.buildCallbackHtml(true));
              resolveCode(code);
              return;
            }

            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing authorization code');
            return;
          }

          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error');
          rejectCode(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // Listen on a random available port
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          rejectSetup(new Error('Failed to get callback server address'));
          return;
        }
        this.callbackServer = server;
        resolveSetup({ port: addr.port, codePromise });
      });

      server.on('error', (err) => {
        rejectSetup(err);
      });
    });
  }

  /**
   * Stop the callback server if running
   */
  private async stopCallbackServer(): Promise<void> {
    if (this.callbackServer) {
      return new Promise((resolve) => {
        this.callbackServer!.close(() => {
          this.callbackServer = null;
          resolve();
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the IAM OAuth2 authorization URL
   */
  private buildAuthorizationUrl(redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
    });

    // Add scope if configured
    const scope = process.env.IAM_SCOPE;
    if (scope) {
      params.set('scope', scope);
    }

    return `${this.config.iamHost}${this.config.authorizePath}?${params.toString()}`;
  }

  /**
   * Build the HTML page shown after OAuth callback
   */
  private buildCallbackHtml(success: boolean, errorMessage?: string): string {
    const title = success ? '登录成功' : '登录失败';
    const message = success
      ? '认证成功，请返回 ClawX 应用。此页面可以关闭。'
      : `认证失败: ${errorMessage || '未知错误'}`;
    const color = success ? '#22c55e' : '#ef4444';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{text-align:center;padding:40px;border-radius:12px;background:#1e293b;max-width:400px}
h1{color:${color};margin-bottom:16px}p{color:#94a3b8;line-height:1.6}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div>
<script>setTimeout(()=>window.close(),3000)</script></body></html>`;
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new IAMError(IAMErrorType.TIMEOUT_ERROR, message)), ms);
    });
  }

  /**
   * Save authentication state to store
   */
  private async saveAuthState(token: IAMToken, user: IAMUser): Promise<void> {
    const store = await getIAMStore();
    store.set('accessToken', token.accessToken);
    store.set('refreshToken', token.refreshToken || null);
    store.set('expiresAt', token.expiresAt);
    store.set('user', user);
  }

  /**
   * Clear authentication state from store
   */
  private async clearAuthState(): Promise<void> {
    const store = await getIAMStore();
    store.set('accessToken', null);
    store.set('refreshToken', null);
    store.set('expiresAt', null);
    store.set('user', null);
  }

  /**
   * Send IPC event to renderer
   */
  private sendEvent(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

// Singleton instance
let iamAuthServiceInstance: IAMAuthService | null = null;

export function getIAMAuthService(): IAMAuthService {
  if (!iamAuthServiceInstance) {
    iamAuthServiceInstance = new IAMAuthService();
  }
  return iamAuthServiceInstance;
}
