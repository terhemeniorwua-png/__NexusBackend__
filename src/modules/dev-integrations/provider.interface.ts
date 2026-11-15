import type { DevIntegrationProvider } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import type { DevExternalAccount, DevRepositorySummary, StartConnectionResult } from './dev-integration.types';

export interface DevProviderStateClaims {
  userId: string;
  workspaceId: string;
  provider: DevIntegrationProvider;
  nonce: string;
}

export interface DevConnectCallbackResult {
  externalAccount: DevExternalAccount;
  scopes: string[];
  /** Encrypted payload to store (already encrypted by provider/service using token-crypto). */
  encryptedCredentials: string;
}

export interface DevIntegrationProviderAdapter {
  readonly provider: DevIntegrationProvider;

  startConnect(input: {
    config: AppConfig;
    userId: string;
    workspaceId: string;
  }): Promise<StartConnectionResult>;

  verifyAndConsumeState(state: string): Promise<DevProviderStateClaims>;

  handleCallback(input: {
    config: AppConfig;
    query: Record<string, unknown>;
    claims: DevProviderStateClaims;
  }): Promise<DevConnectCallbackResult>;

  listAvailableRepositories(input: {
    config: AppConfig;
    encryptedCredentials: string;
  }): Promise<DevRepositorySummary[]>;

  /** Best-effort revocation/cleanup on disconnect. Must not throw for non-fatal provider errors. */
  disconnect(input: {
    config: AppConfig;
    encryptedCredentials: string;
  }): Promise<{ revoked: boolean; detail?: string }>;
}