/**
 * Application Configuration
 * Centralized configuration constants and helpers
 */

/**
 * Port configuration
 */
export const PORTS = {
  /** ClawX GUI development server port */
  CLAWX_DEV: 5173,
  
  /** ClawX GUI production port (for reference) */
  CLAWX_GUI: 23333,

  /** Local host API server port */
  CLAWX_HOST_API: 3210,
  
  /** OpenClaw Gateway port */
  OPENCLAW_GATEWAY: 18789,
} as const;

/**
 * Get port from environment or default
 */
export function getPort(key: keyof typeof PORTS): number {
  const envKey = `CLAWX_PORT_${key}`;
  const envValue = process.env[envKey];
  return envValue ? parseInt(envValue, 10) : PORTS[key];
}

/**
 * Application paths
 */
export const APP_PATHS = {
  /** OpenClaw configuration directory */
  OPENCLAW_CONFIG: '~/.openclaw',
  
  /** ClawX configuration directory */
  CLAWX_CONFIG: '~/.clawx',
  
  /** Log files directory */
  LOGS: '~/.clawx/logs',
} as const;

/**
 * Update channels
 */
export const UPDATE_CHANNELS = ['stable', 'beta', 'dev'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/**
 * Default update configuration
 */
export const UPDATE_CONFIG = {
  /** Check interval in milliseconds (6 hours) */
  CHECK_INTERVAL: 6 * 60 * 60 * 1000,
  
  /** Default update channel */
  DEFAULT_CHANNEL: 'stable' as UpdateChannel,
  
  /** Auto download updates */
  AUTO_DOWNLOAD: false,
  
  /** Show update notifications */
  SHOW_NOTIFICATION: true,
};

/**
 * Gateway configuration
 */
export const GATEWAY_CONFIG = {
  /** WebSocket reconnection delay (ms) */
  RECONNECT_DELAY: 5000,
  
  /** RPC call timeout (ms) */
  RPC_TIMEOUT: 30000,
  
  /** Health check interval (ms) */
  HEALTH_CHECK_INTERVAL: 30000,
  
  /** Maximum startup retries */
  MAX_STARTUP_RETRIES: 30,
  
  /** Startup retry interval (ms) */
  STARTUP_RETRY_INTERVAL: 1000,
};

/**
 * IAM Authentication configuration (OAuth2)
 * Environment variables override these defaults.
 */
export const IAM_CONFIG = {
  /** IAM server host URL */
  HOST: process.env.IAM_HOST || 'https://id-dev.item.pub',
  /** OAuth2 client ID */
  CLIENT_ID: process.env.IAM_CLIENT_ID || '325fa245-b086-4e70-b479-474944903f1c',
  /** OAuth2 client secret */
  CLIENT_SECRET: process.env.IAM_CLIENT_SECRET || 'a0cfca85-b2ee-4d40-b09f-c54e32d54fca',
  /** Base64 Authorization header */
  AUTHORIZATION: process.env.IAM_AUTHORIZATION || 'Basic MzI1ZmEyNDUtYjA4Ni00ZTcwLWI0NzktNDc0OTQ0OTAzZjFjOmEwY2ZjYTg1LWIyZWUtNGQ0MC1iMDlmLWM1NGUzMmQ1NGZjYQ==',
  /** OAuth2 token endpoint path */
  TOKEN_PATH: process.env.IAM_TOKEN_PATH || '/oauth2/token',
  /** OAuth2 authorization endpoint path */
  AUTHORIZE_PATH: process.env.IAM_AUTHORIZE_PATH || '/oauth2/authorize',
  /** User info endpoint path */
  USERINFO_PATH: process.env.IAM_USERINFO_PATH || '/user-info',
  /** Request timeout (ms) */
  TIMEOUT: parseInt(process.env.IAM_TIMEOUT || '30000', 10),
  /** Whether IAM is enabled */
  ENABLED: process.env.IAM_ENABLED !== 'false',
} as const;


/**
 * Item AI Gateway configuration (company LLM proxy)
 * Environment variables override these defaults.
 */
export const ITEM_GATEWAY_CONFIG = {
  /** JWT credential endpoint */
  JWT_URL: process.env.ITEM_JWT_URL || 'https://aiop-gateway.item.com/admin/api/credentials/jwt',
  /** OpenAI-compatible base URL */
  BASE_URL: process.env.ITEM_BASE_URL || 'https://aiop-gateway.item.com/proxy/openai/v1',
  /** Fixed API key for JWT request */
  API_KEY: process.env.ITEM_API_KEY || 'gw-Ai-Agent-prod-2000515341280743424',
  /** Agent name sent in JWT request */
  AGENT_NAME: process.env.ITEM_AGENT_NAME || 'openclaw',
  /** App code sent in JWT request */
  APP_CODE: process.env.ITEM_APP_CODE || 'clawbot',
} as const;
