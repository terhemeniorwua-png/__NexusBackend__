import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../../config/env';
import { getRedisClient } from '../../../db/redis';
import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { decryptIntegrationToken, encryptIntegrationToken } from '../../integrations/token-crypto';
import type {
  DevConnectCallbackResult,
  DevIntegrationProviderAdapter,
  DevProviderStateClaims,
} from '../provider.interface';
import type {
  DevBranchSummary,
  DevExternalAccount,
  DevPullRequestSummary,
  DevRepositorySummary,
  StartConnectionResult,
} from '../dev-integration.types';

const STATE_TTL_SECONDS = 10 * 60;
const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'nexus-backend',
};

interface GithubCredentialsPayload {
  installationId: number;
  account?: DevExternalAccount & { type?: string | null };
}

function requireGithubAppConfig(config: AppConfig): {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  callbackUrl: string;
  slug: string;
  installUrl: string;
} {
  const appId = config.githubAppId || process.env.GITHUB_APP_ID || '';
  const clientId = config.githubAppClientId || process.env.GITHUB_APP_CLIENT_ID || '';
  const clientSecret = config.githubAppClientSecret || process.env.GITHUB_APP_CLIENT_SECRET || '';
  const privateKey = (config.githubAppPrivateKey || process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const callbackUrl = config.githubAppCallbackUrl || process.env.GITHUB_APP_CALLBACK_URL || '';
  const slug = config.githubAppSlug || process.env.GITHUB_APP_SLUG || '';
  const installUrl = config.githubAppInstallUrl || process.env.GITHUB_APP_INSTALL_URL || '';
  if (!appId || !clientId || !clientSecret || !privateKey) {
    throw new AppError(503, 'GITHUB_APP_NOT_CONFIGURED', 'GitHub App integration is not configured');
  }
  return { appId, clientId, clientSecret, privateKey, callbackUrl, slug, installUrl };
}

function stateSigningKey(config: AppConfig): Buffer {
  const secret = config.jwtAccessSecret || process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
  return Buffer.from(secret, 'utf8');
}

function signState(body: string, config: AppConfig): string {
  return createHmac('sha256', stateSigningKey(config)).update(body).digest('base64url');
}

function encodeState(claims: Omit<DevProviderStateClaims, 'provider'> & { provider: 'GITHUB' }, config: AppConfig): string {
  const payload = { ...claims, exp: Date.now() + STATE_TTL_SECONDS * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signState(body, config)}`;
}

async function githubFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 10_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(privateKey).toString('base64url');
  return `${unsigned}.${sig}`;
}

async function getInstallationAccessToken(config: AppConfig, installationId: number): Promise<string> {
  const { appId, privateKey } = requireGithubAppConfig(config);
  const jwt = createAppJwt(appId, privateKey);
  const res = await githubFetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn('github_app_token_request_failed', { status: res.status, body: text.slice(0, 200) });
    throw new AppError(502, 'GITHUB_APP_TOKEN_FAILED', `Failed to obtain installation access token (${res.status})`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new AppError(502, 'GITHUB_APP_TOKEN_FAILED', 'Installation access token missing from GitHub response');
  return data.token;
}

async function getInstallation(config: AppConfig, installationId: number): Promise<{ id: number; account?: { id: number; login: string; type: string; name?: string | null } | null; permissions?: Record<string, string> }> {
  const { appId, privateKey } = requireGithubAppConfig(config);
  const jwt = createAppJwt(appId, privateKey);
  const res = await githubFetch(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new AppError(502, 'GITHUB_APP_INSTALLATION_FAILED', `Failed to fetch GitHub installation (${res.status})`);
  }
  return (await res.json()) as { id: number; account?: { id: number; login: string; type: string; name?: string | null } | null; permissions?: Record<string, string> };
}

function parseCredentials(encryptedCredentials: string): GithubCredentialsPayload {
  const plain = decryptIntegrationToken(encryptedCredentials);
  const parsed = JSON.parse(plain) as GithubCredentialsPayload;
  if (!parsed || typeof parsed.installationId !== 'number') {
    throw new AppError(500, 'DEV_INTEGRATION_CREDENTIALS_INVALID', 'Stored integration credentials are invalid');
  }
  return parsed;
}

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PATCH_CHARS = 20_000;

async function githubRepoGet<T>(input: {
  config: AppConfig;
  encryptedCredentials: string;
  repositoryFullName: string;
  path: string;
  params?: Record<string, string>;
  soft?: boolean;
}): Promise<T | null> {
  if (!REPO_NAME_RE.test(input.repositoryFullName)) {
    throw new AppError(400, 'INVALID_REPOSITORY_NAME', 'Invalid repository name');
  }
  const creds = parseCredentials(input.encryptedCredentials);
  const token = await getInstallationAccessToken(input.config, creds.installationId);
  const url = new URL(`${GITHUB_API}/repos/${input.repositoryFullName}${input.path}`);
  for (const [k, v] of Object.entries(input.params ?? {})) url.searchParams.set(k, v);
  const res = await githubFetch(url.toString(), {
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (input.soft) return null;
    throw new AppError(
      502,
      'GITHUB_RESOURCE_UNAVAILABLE',
      res.status === 404 ? 'That item was not found in the repository' : `GitHub request failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

function pageParams(page?: number, perPage?: number): Record<string, string> {
  return {
    per_page: String(Math.min(Math.max(perPage ?? 30, 1), 100)),
    page: String(Math.min(Math.max(page ?? 1, 1), 10)),
  };
}

type GithubCommitRow = {
  sha: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
};

function toCommitSummary(c: GithubCommitRow) {
  return {
    sha: c.sha,
    message: (c.commit?.message ?? '').slice(0, 2000),
    authorName: c.commit?.author?.name ?? null,
    authorLogin: c.author?.login ?? null,
    date: c.commit?.author?.date ?? null,
    url: c.html_url ?? null,
  };
}

export const githubAppProvider: DevIntegrationProviderAdapter = {
  provider: 'GITHUB',

  async startConnect(input): Promise<StartConnectionResult> {
    const { slug, installUrl } = requireGithubAppConfig(input.config);
    const nonce = randomBytes(16).toString('hex');
    await getRedisClient().set(
      `devint:github:state:${nonce}`,
      JSON.stringify({ userId: input.userId, workspaceId: input.workspaceId }),
      { EX: STATE_TTL_SECONDS },
    );
    const state = encodeState(
      { userId: input.userId, workspaceId: input.workspaceId, provider: 'GITHUB', nonce },
      input.config,
    );
    const base = (installUrl || (slug ? `https://github.com/apps/${slug}/installations/new` : '')).trim();
    if (!base) {
      throw new AppError(503, 'GITHUB_APP_NOT_CONFIGURED', 'GitHub App installation URL is not configured');
    }
    const url = new URL(base);
    url.searchParams.set('state', state);
    return { url: url.toString() };
  },

  async verifyAndConsumeState(state: string): Promise<DevProviderStateClaims> {
    // config not passed here; use env secret for verification same as encoding
    const config = { jwtAccessSecret: process.env.JWT_ACCESS_SECRET } as AppConfig;
    const [body, sig, extra] = state.split('.');
    const bad = () => new AppError(400, 'GITHUB_STATE_INVALID', 'The GitHub authorization state is invalid or expired');
    if (!body || !sig || extra !== undefined) throw bad();
    const expected = Buffer.from(signState(body, config));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
    let claims: { userId?: string; workspaceId?: string; provider?: string; nonce?: string; exp?: number };
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw bad();
    }
    if (
      claims.provider !== 'GITHUB' ||
      typeof claims.userId !== 'string' ||
      typeof claims.workspaceId !== 'string' ||
      typeof claims.nonce !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp < Date.now() ||
      !/^[0-9a-f]{32}$/.test(claims.nonce)
    ) {
      throw bad();
    }
    const redis = getRedisClient();
    const key = `devint:github:state:${claims.nonce}`;
    const stored = await redis.get(key);
    const consumed = await redis.del(key);
    if (consumed !== 1 || !stored) throw bad();
    try {
      const parsed = JSON.parse(stored) as { userId: string; workspaceId: string };
      if (parsed.userId !== claims.userId || parsed.workspaceId !== claims.workspaceId) throw bad();
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw bad();
    }
    return { userId: claims.userId, workspaceId: claims.workspaceId, provider: 'GITHUB', nonce: claims.nonce };
  },

  async handleCallback(input): Promise<DevConnectCallbackResult> {
    const { config, query } = input;
    const installationIdRaw = query.installation_id;
    const installationId = typeof installationIdRaw === 'string' || typeof installationIdRaw === 'number' ? Number(installationIdRaw) : NaN;
    if (!Number.isFinite(installationId) || installationId <= 0) {
      throw new AppError(400, 'GITHUB_INSTALLATION_REQUIRED', 'A GitHub App installation is required to complete the connection');
    }
    const installation = await getInstallation(config, installationId);
    const account = installation.account;
    const externalAccount: DevExternalAccount = {
      id: account?.id != null ? String(account.id) : String(installation.id),
      login: account?.login ?? null,
      name: (account?.name ?? account?.login) ?? null,
      type: account?.type ?? null,
    };
    const scopes = installation.permissions ? Object.keys(installation.permissions) : [];
    const payload: GithubCredentialsPayload = { installationId, account: externalAccount };
    const encryptedCredentials = encryptIntegrationToken(JSON.stringify(payload));
    return { externalAccount, scopes, encryptedCredentials };
  },

  async listAvailableRepositories(input): Promise<DevRepositorySummary[]> {
    const { config, encryptedCredentials } = input;
    const creds = parseCredentials(encryptedCredentials);
    const token = await getInstallationAccessToken(config, creds.installationId);
    const repos: DevRepositorySummary[] = [];
    let page = 1;
    // Paginate; cap to avoid unbounded fetch
    while (page <= 10) {
      const url = new URL(`${GITHUB_API}/installation/repositories`);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const res = await githubFetch(url.toString(), {
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          throw new AppError(502, 'GITHUB_REPOS_UNAVAILABLE', 'Unable to list repositories for this GitHub installation');
        }
        throw new AppError(502, 'GITHUB_REPOS_UNAVAILABLE', `Failed to list repositories (${res.status})`);
      }
      const data = (await res.json()) as { repositories?: Array<{ id: number; full_name: string; name: string; default_branch?: string | null; private?: boolean; html_url?: string; owner?: { login?: string } }> ; total_count?: number };
      const batch = data.repositories ?? [];
      for (const r of batch) {
        repos.push({
          externalRepoId: String(r.id),
          fullName: r.full_name,
          name: r.name,
          ownerLogin: r.owner?.login ?? null,
          defaultBranch: r.default_branch ?? null,
          private: r.private,
          htmlUrl: r.html_url ?? null,
        });
      }
      if (batch.length < 100) break;
      page += 1;
    }
    return repos;
  },

  async listRepositoryBranches(input): Promise<DevBranchSummary[]> {
    const { config, encryptedCredentials, repositoryFullName, search, page = 1, perPage = 30 } = input;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
      throw new AppError(400, 'INVALID_REPOSITORY_NAME', 'Invalid repository name');
    }
    const creds = parseCredentials(encryptedCredentials);
    const token = await getInstallationAccessToken(config, creds.installationId);
    const [owner, repo] = repositoryFullName.split('/');
    const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/branches`);
    url.searchParams.set('per_page', String(Math.min(Math.max(perPage, 1), 100)));
    url.searchParams.set('page', String(Math.min(Math.max(page, 1), 10)));
    const res = await githubFetch(url.toString(), {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 403 || res.status === 401) {
        throw new AppError(502, 'GITHUB_RESOURCE_UNAVAILABLE', 'Unable to list branches for this repository');
      }
      throw new AppError(502, 'GITHUB_RESOURCE_UNAVAILABLE', `Failed to list branches (${res.status})`);
    }
    const data = (await res.json()) as Array<{ name: string; commit?: { sha?: string; url?: string }; protected?: boolean }>;
    let branches = data.map((b) => ({
      name: b.name,
      commitSha: b.commit?.sha ?? null,
      protected: b.protected ?? false,
      url: `https://github.com/${repositoryFullName}/tree/${encodeURIComponent(b.name)}`,
    }));
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      branches = branches.filter((b) => b.name.toLowerCase().includes(q));
    }
    return branches;
  },

  async listRepositoryPullRequests(input): Promise<DevPullRequestSummary[]> {
    const { config, encryptedCredentials, repositoryFullName, state = 'open', search, page = 1, perPage = 30 } = input;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
      throw new AppError(400, 'INVALID_REPOSITORY_NAME', 'Invalid repository name');
    }
    const creds = parseCredentials(encryptedCredentials);
    const token = await getInstallationAccessToken(config, creds.installationId);
    const [owner, repo] = repositoryFullName.split('/');
    const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/pulls`);
    url.searchParams.set('state', state);
    url.searchParams.set('per_page', String(Math.min(Math.max(perPage, 1), 100)));
    url.searchParams.set('page', String(Math.min(Math.max(page, 1), 10)));
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    const res = await githubFetch(url.toString(), {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 403 || res.status === 401) {
        throw new AppError(502, 'GITHUB_RESOURCE_UNAVAILABLE', 'Unable to list pull requests for this repository');
      }
      throw new AppError(502, 'GITHUB_RESOURCE_UNAVAILABLE', `Failed to list pull requests (${res.status})`);
    }
    const data = (await res.json()) as Array<{
      id: number;
      number: number;
      title: string;
      state: string;
      html_url?: string;
      head?: { ref?: string };
      base?: { ref?: string };
      user?: { login?: string };
      updated_at?: string;
      merged_at?: string | null;
      draft?: boolean;
    }>;
    let prs = data.map((pr) => ({
      externalId: String(pr.id),
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.draft ? 'draft' : pr.state,
      url: pr.html_url ?? null,
      headRef: pr.head?.ref ?? null,
      baseRef: pr.base?.ref ?? null,
      authorLogin: pr.user?.login ?? null,
      updatedAt: pr.updated_at ?? null,
    }));
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      prs = prs.filter((p) => p.title.toLowerCase().includes(q) || String(p.number).includes(q) || (p.headRef ?? '').toLowerCase().includes(q));
    }
    return prs;
  },

  async getPullRequest(input) {
    const base = {
      config: input.config,
      encryptedCredentials: input.encryptedCredentials,
      repositoryFullName: input.repositoryFullName,
    };
    const pr = (await githubRepoGet<{
      number: number;
      title: string;
      body?: string | null;
      state: string;
      html_url?: string;
      head?: { ref?: string; sha?: string };
      base?: { ref?: string };
      user?: { login?: string } | null;
      created_at?: string;
      updated_at?: string;
      merged_at?: string | null;
      merged?: boolean;
      draft?: boolean;
      mergeable?: boolean | null;
      additions?: number;
      deletions?: number;
      changed_files?: number;
      commits?: number;
      comments?: number;
      review_comments?: number;
    }>({ ...base, path: `/pulls/${input.number}` }))!;
    const sha = pr.head?.sha ?? null;
    let checks: { total: number; passed: number; failed: number; pending: number } | null = null;
    if (sha) {
      const cr = await githubRepoGet<{ check_runs?: Array<{ status: string; conclusion: string | null }> }>({
        ...base,
        path: `/commits/${sha}/check-runs`,
        params: { per_page: '100' },
        soft: true,
      });
      if (cr?.check_runs) {
        const runs = cr.check_runs;
        const pending = runs.filter((r) => r.status !== 'completed').length;
        const passed = runs.filter(
          (r) => r.status === 'completed' && ['success', 'neutral', 'skipped'].includes(r.conclusion ?? ''),
        ).length;
        checks = { total: runs.length, passed, failed: runs.length - pending - passed, pending };
      }
    }
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? null,
      state: pr.merged_at ? 'merged' : pr.draft ? 'draft' : pr.state,
      url: pr.html_url ?? null,
      headRef: pr.head?.ref ?? null,
      baseRef: pr.base?.ref ?? null,
      headSha: sha,
      authorLogin: pr.user?.login ?? null,
      createdAt: pr.created_at ?? null,
      updatedAt: pr.updated_at ?? null,
      mergedAt: pr.merged_at ?? null,
      merged: Boolean(pr.merged),
      draft: Boolean(pr.draft),
      mergeable: pr.mergeable ?? null,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changed_files ?? 0,
      commits: pr.commits ?? 0,
      comments: pr.comments ?? 0,
      reviewComments: pr.review_comments ?? 0,
      checks,
    };
  },

  async listPullRequestFiles(input) {
    const rows = (await githubRepoGet<Array<{
      filename: string;
      previous_filename?: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>>({
      config: input.config,
      encryptedCredentials: input.encryptedCredentials,
      repositoryFullName: input.repositoryFullName,
      path: `/pulls/${input.number}/files`,
      params: pageParams(input.page, input.perPage),
    }))!;
    return rows.map((f) => ({
      filename: f.filename,
      previousFilename: f.previous_filename ?? null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch ? f.patch.slice(0, MAX_PATCH_CHARS) : null,
      patchTruncated: Boolean(f.patch && f.patch.length > MAX_PATCH_CHARS),
    }));
  },

  async listPullRequestCommits(input) {
    const rows = (await githubRepoGet<GithubCommitRow[]>({
      config: input.config,
      encryptedCredentials: input.encryptedCredentials,
      repositoryFullName: input.repositoryFullName,
      path: `/pulls/${input.number}/commits`,
      params: pageParams(input.page, input.perPage),
    }))!;
    return rows.map(toCommitSummary);
  },

  async getCommit(input) {
    const c = (await githubRepoGet<{
      sha: string;
      html_url?: string;
      commit: { message: string; author?: { name?: string; date?: string } | null };
      author?: { login?: string } | null;
      parents?: Array<{ sha: string }>;
      stats?: { additions: number; deletions: number; total: number };
      files?: Array<{
        filename: string;
        previous_filename?: string;
        status: string;
        additions: number;
        deletions: number;
        changes: number;
        patch?: string;
      }>;
    }>({
      config: input.config,
      encryptedCredentials: input.encryptedCredentials,
      repositoryFullName: input.repositoryFullName,
      path: `/commits/${input.sha}`,
    }))!;
    return {
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author?.name ?? null,
      authorLogin: c.author?.login ?? null,
      date: c.commit.author?.date ?? null,
      url: c.html_url ?? null,
      additions: c.stats?.additions ?? 0,
      deletions: c.stats?.deletions ?? 0,
      total: c.stats?.total ?? 0,
      parents: (c.parents ?? []).map((x) => x.sha),
      files: (c.files ?? []).map((f) => ({
        filename: f.filename,
        previousFilename: f.previous_filename ?? null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch ? f.patch.slice(0, MAX_PATCH_CHARS) : null,
        patchTruncated: Boolean(f.patch && f.patch.length > MAX_PATCH_CHARS),
      })),
    };
  },

  async listBranchCommits(input) {
    const params = pageParams(input.page, input.perPage);
    if (input.branch) params.sha = input.branch;
    const rows = (await githubRepoGet<GithubCommitRow[]>({
      config: input.config,
      encryptedCredentials: input.encryptedCredentials,
      repositoryFullName: input.repositoryFullName,
      path: '/commits',
      params,
    }))!;
    return rows.map(toCommitSummary);
  },

  async disconnect(input): Promise<{ revoked: boolean; detail?: string }> {
    // Installation access tokens are short-lived and generated on demand; we do not persist them.
    // Deleting stored credentials (installation binding) is performed by the service.
    // Best-effort: nothing to revoke remotely here without broader app management permissions.
    try {
      const creds = parseCredentials(input.encryptedCredentials);
      // validate parseable
      void creds.installationId;
      return { revoked: true, detail: 'Stored GitHub installation credentials removed' };
    } catch (error) {
      logger.warn('github_app_disconnect_cleanup_failed', { error });
      return { revoked: false, detail: 'Stored credentials removed; provider cleanup could not be verified' };
    }
  },
};
