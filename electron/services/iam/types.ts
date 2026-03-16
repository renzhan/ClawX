/**
 * IAM Authentication Types
 * Type definitions for IAM OAuth2 authentication
 */

/**
 * IAM user information
 */
export interface IAMUser {
  /** User ID */
  id: string;
  /** Username */
  username: string;
  /** User email (optional) */
  email?: string;
  /** Display name (optional) */
  displayName?: string;
  /** Company/tenant code */
  companyCode?: string;
}

/**
 * IAM authentication token with expiry
 */
export interface IAMToken {
  /** Access token */
  accessToken: string;
  /** Refresh token (optional) */
  refreshToken?: string;
  /** Token expiry timestamp (milliseconds since epoch) */
  expiresAt: number;
}

/**
 * IAM OAuth2 token response from IAM server
 */
export interface IAMTokenResponse {
  success?: boolean;
  data?: {
    accessToken: string;
    refreshToken?: string;
    userId: string;
    userName: string;
    companyCode?: string;
    expiresIn: string | number;
  };
  /** Alternative flat format */
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * IAM authentication state
 */
export interface IAMAuthState {
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Current user (null if not authenticated) */
  user: IAMUser | null;
  /** Token information (null if not authenticated) */
  token: IAMToken | null;
}

/**
 * IAM service configuration (OAuth2)
 */
export interface IAMConfig {
  /** IAM host URL (e.g. https://id-dev.item.pub) */
  iamHost: string;
  /** OAuth2 token endpoint path */
  tokenPath: string;
  /** OAuth2 authorization endpoint path */
  authorizePath: string;
  /** User info endpoint path */
  userInfoPath: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret */
  clientSecret: string;
  /** Base64 encoded Authorization header (clientId:clientSecret) */
  authorization: string;
  /** OAuth2 redirect URI (will be set dynamically with local server port) */
  redirectUri: string;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Whether IAM feature is enabled */
  enabled: boolean;
}

/**
 * IAM error types
 */
export enum IAMErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  SERVER_ERROR = 'SERVER_ERROR',
  OAUTH_ERROR = 'OAUTH_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * IAM error class
 */
export class IAMError extends Error {
  constructor(
    public type: IAMErrorType,
    message: string,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'IAMError';
  }
}
