import type { DevIntegrationProvider, IntegrationConnectionStatus } from '@prisma/client';

export type DevProvider = DevIntegrationProvider; // 'GITHUB' | 'GITLAB'

export interface DevExternalAccount {
  id: string | null;
  login: string | null;
  name: string | null;
  type?: string | null;
}

export interface DevConnectionSummary {
  id: string;
  provider: DevIntegrationProvider;
  workspaceId: string;
  status: IntegrationConnectionStatus;
  externalAccount: DevExternalAccount;
  scopes: string[];
  createdById: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevRepositorySummary {
  externalRepoId: string;
  fullName: string;
  name?: string;
  ownerLogin?: string | null;
  defaultBranch: string | null;
  private?: boolean;
  htmlUrl?: string | null;
}

export interface LinkedProjectRepository {
  id: string;
  projectId: string;
  connectionId: string;
  provider: DevIntegrationProvider;
  externalRepoId: string;
  fullName: string;
  defaultBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevBranchSummary {
  name: string;
  commitSha?: string | null;
  protected?: boolean;
  url?: string | null;
}

export interface DevPullRequestSummary {
  externalId: string;
  number: number;
  title: string;
  state: string;
  url: string | null;
  headRef: string | null;
  baseRef: string | null;
  authorLogin?: string | null;
  updatedAt?: string | null;
}

export type TaskDevLinkExternalType = 'BRANCH' | 'PULL_REQUEST' | 'COMMIT';

export interface TaskDevLinkSummary {
  id: string;
  taskId: string;
  projectId: string;
  projectRepositoryId: string | null;
  provider: DevIntegrationProvider;
  externalType: TaskDevLinkExternalType;
  externalId: string;
  externalNumber: number | null;
  title: string | null;
  url: string | null;
  ref: string | null;
  headRef: string | null;
  baseRef: string | null;
  state: string | null;
  repositoryFullName: string | null;
  linkedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartConnectionResult {
  url: string;
}

export interface GithubAppCallbackParams {
  code?: string;
  installation_id?: string;
  setup_action?: string;
  state: string;
}
export interface DevPullRequestDetail {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  authorLogin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  checks: { total: number; passed: number; failed: number; pending: number } | null;
}

export interface DevChangedFile {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  patchTruncated: boolean;
}

export interface DevCommitSummary {
  sha: string;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  date: string | null;
  url: string | null;
}
