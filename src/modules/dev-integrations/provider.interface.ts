import type { DevChangedFile, DevCommitDetail, DevCommitSummary, DevPullRequestDetail } from './dev-integration.types';
import type { DevIntegrationProvider } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import type {
  DevBranchSummary,
  DevExternalAccount,
  DevPullRequestSummary,
  DevRepositorySummary,
  StartConnectionResult,
} from './dev-integration.types';

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
    /** Optional: called when provider rotates credentials (e.g. OAuth refresh). */
    onCredentialsRefreshed?: (encryptedCredentials: string) => Promise<void> | void;
  }): Promise<DevRepositorySummary[]>;

  listRepositoryBranches(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    search?: string;
    page?: number;
    perPage?: number;
    onCredentialsRefreshed?: (encryptedCredentials: string) => Promise<void> | void;
  }): Promise<DevBranchSummary[]>;

  listRepositoryPullRequests(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    state?: 'open' | 'closed' | 'all';
    search?: string;
    page?: number;
    perPage?: number;
    onCredentialsRefreshed?: (encryptedCredentials: string) => Promise<void> | void;
  }): Promise<DevPullRequestSummary[]>;

  getPullRequest?(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    number: number;
  }): Promise<DevPullRequestDetail>;

  listPullRequestFiles?(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    number: number;
    page?: number;
    perPage?: number;
  }): Promise<DevChangedFile[]>;

  listPullRequestCommits?(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    number: number;
    page?: number;
    perPage?: number;
  }): Promise<DevCommitSummary[]>;

  getCommit?(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    sha: string;
  }): Promise<DevCommitDetail>;

  listBranchCommits?(input: {
    config: AppConfig;
    encryptedCredentials: string;
    repositoryFullName: string;
    branch?: string;
    page?: number;
    perPage?: number;
  }): Promise<DevCommitSummary[]>;

  /** Best-effort revocation/cleanup on disconnect. Must not throw for non-fatal provider errors. */
  disconnect(input: {
    config: AppConfig;
    encryptedCredentials: string;
  }): Promise<{ revoked: boolean; detail?: string }>;
}