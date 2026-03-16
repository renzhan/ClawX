/**
 * Item Provider Auto-Setup
 *
 * After IAM login, automatically:
 * 1. Call Item AI Gateway JWT endpoint to get an API key (using IAM userName)
 * 2. Create/update the "item" provider account with the JWT token
 * 3. Set Item as the default provider
 */

import { ITEM_GATEWAY_CONFIG } from '../../utils/config';
import { getProviderService } from '../providers/provider-service';
import type { ProviderAccount } from '../../shared/providers/types';
import { logger } from '../../utils/logger';

/** Fixed account ID for the auto-provisioned Item provider */
const ITEM_ACCOUNT_ID = 'item-iam-auto';

interface JwtResponse {
  code?: number;
  message?: string;
  token?: string;
  jwt?: string;
  data?: string | { token?: string };
  [key: string]: unknown;
}

/**
 * Fetch a JWT API key from the Item AI Gateway.
 */
async function fetchItemJwt(userName: string): Promise<string> {
  const { JWT_URL, API_KEY, AGENT_NAME, APP_CODE } = ITEM_GATEWAY_CONFIG;

  logger.info('[Item] Fetching JWT for user:', userName);

  const response = await fetch(JWT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: API_KEY,
      agentName: AGENT_NAME,
      appCode: APP_CODE,
      userName,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Item JWT request failed: HTTP ${response.status} ${text}`);
  }

  const data = (await response.json()) as JwtResponse;

  // Try multiple response shapes
  const token = data.token || data.jwt || (typeof data.data === 'string' ? data.data : data.data?.token);
  if (!token || typeof token !== 'string') {
    logger.error('[Item] Unexpected JWT response:', JSON.stringify(data));
    throw new Error('No token in Item JWT response');
  }

  logger.info('[Item] JWT obtained successfully');
  return token;
}

/**
 * Auto-provision the Item provider after IAM login.
 * Creates the provider account if it doesn't exist, updates the JWT key, and sets it as default.
 */
export async function setupItemProvider(userName: string): Promise<void> {
  try {
    const jwt = await fetchItemJwt(userName);
    const providerService = getProviderService();
    const now = new Date().toISOString();

    const existing = await providerService.getAccount(ITEM_ACCOUNT_ID);

    if (existing) {
      // Update existing account with fresh JWT
      await providerService.updateAccount(ITEM_ACCOUNT_ID, {
        updatedAt: now,
      }, jwt);
      logger.info('[Item] Updated existing Item provider with new JWT');
    } else {
      // Create new account
      const account: ProviderAccount = {
        id: ITEM_ACCOUNT_ID,
        vendorId: 'item',
        label: 'Item (IAM)',
        authMode: 'api_key',
        baseUrl: ITEM_GATEWAY_CONFIG.BASE_URL,
        apiProtocol: 'openai-completions',
        model: 'gpt-5.1',
        enabled: true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      };
      await providerService.createAccount(account, jwt);
      logger.info('[Item] Created Item provider account');
    }

    // Set as default
    await providerService.setDefaultAccount(ITEM_ACCOUNT_ID);
    logger.info('[Item] Set Item as default provider');
  } catch (error) {
    logger.error('[Item] Failed to auto-setup Item provider:', error);
    // Don't throw — login should still succeed even if provider setup fails
  }
}
