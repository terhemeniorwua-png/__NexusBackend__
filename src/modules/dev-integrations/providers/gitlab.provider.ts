import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
import type { DevBranchSummary, DevExternalAccount, DevPullRequestSummary, DevRepositorySummary, StartConnectionResult } from '../dev-integration.types';

const STATE_TTL_SECONDS = 10 * 60;

interface GitLabCredentialsPayload {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  expiresAt?: number | null; // epoch ms
  scope?: string | null;
  account?: DevExternalAccount & { type?: string | null };
  baseUrl: string;
}

function baseUrl(config: AppConfig): string {
  const raw = (config.gitlabBaseUrl || process.env.GITLAB_BASE_URL || 'https://gitlab.com').trim().replace(/\/+$/, '');
  return raw || 'https://gitlab.com';
}

function requireGitLabConfig(config: AppConfig) {
  const clientId = config.gitlabClientId || process.env.GITLAB_CLIENT_ID || '';
  const clientSecret = config.gitlabClientSecret || process.env.GITLAB_CLIENT_SECRET || '';
  const callbackUrl = config.gitlabCallbackUrl || process.env.GITLAB_CALLBACK_URL || '';
  const scopes = config.gitlabScopes || process.env.GITLAB_SCOPES || 'read_api read_repository';
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new AppError(503, 'GITLAB_NOT_CONFIGURED', 'GitLab integration is not configured');
  }
  return { clientId, clientSecret, callbackUrl, scopes, baseUrl: baseUrl(config) };
}

function stateSigningKey(config: AppConfig): Buffer {
  const secret = config.jwtAccessSecret || process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
  return Buffer.from(secret, 'utf8');
}

function signState(body: string, config: AppConfig): string {
  return createHmac('sha256', stateSigningKey(config)).update(body).digest('base64url');
}

function encodeState(claims: Omit<DevProviderStateClaims, 'provider'> & { provider: 'GITLAB' }, config: AppConfig): string {
  const payload = { ...claims, exp: Date.now() + STATE_TTL_SECONDS * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signState(body, config)}`;
}

async function gitlabFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 10_000, ...rest } = init;
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

function parseCredentials(encryptedCredentials: string): GitLabCredentialsPayload {
  const plain = decryptIntegrationToken(encryptedCredentials);
  const parsed = JSON.parse(plain) as GitLabCredentialsPayload;
  if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.baseUrl) {
    throw new AppError(500, 'DEV_INTEGRATION_CREDENTIALS_INVALID', 'Stored integration credentials are invalid');
  }
  return parsed;
}

async function refreshAccessTokenIfNeeded(config: AppConfig, creds: GitLabCredentialsPayload): Promise<{ creds: GitLabCredentialsPayload; changed: boolean }> {
  const expiresAt = creds.expiresAt ?? null;
  if (!expiresAt || expiresAt - Date.now() > 60_000 || !creds.refreshToken) {
    return { creds, changed: false };
  }
  const { clientId, clientSecret, callbackUrl } = requireGitLabConfig(config);
  const res = await gitlabFetch(`${creds.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
    }).toString(),
  });
  if (!res.ok) {
    throw new AppError(502, 'GITLAB_TOKEN_REFRESH_FAILED', 'Failed to refresh GitLab access token');
  }
  const data = await res.json() as any;
  if (!data.access_token) throw new AppError(502, 'GITLAB_TOKEN_REFRESH_FAILED', 'GitLab token refresh response missing access token');
  const next: GitLabCredentialsPayload = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken ?? null,
    tokenType: data.token_type ?? creds.tokenType ?? null,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null,
    scope: data.scope ?? creds.scope ?? null,
  };
  return { creds: next, changed: true };
}

async function authedGitLabGet(
  config: AppConfig,
  encryptedCredentials: string,
  path: string,
  query?: Record<string, string | number | undefined>,
  onCredentialsRefreshed?: (encryptedCredentials: string) => Promise<void> | void,
) {
  const original = parseCredentials(encryptedCredentials);
  const { creds, changed } = await refreshAccessTokenIfNeeded(config, original);
  if (changed && onCredentialsRefreshed) {
    await onCredentialsRefreshed(encryptIntegrationToken(JSON.stringify(creds)));
  }
  const url = new URL(`${creds.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await gitlabFetch(url.toString(), {
    headers: { Authorization: `Bearer ${creds.accessToken}`, Accept: 'application/json' },
  });
  return { res, creds };
}

function mapMrState(mr: any): string {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed') return 'closed';
  if (mr.work_in_progress || mr.draft) return 'draft';
  if (mr.state === 'opened' || mr.state === 'open') return 'open';
  return mr.state || 'open';
}

export const gitlabProvider: DevIntegrationProviderAdapter = {
  provider: 'GITLAB',

  async startConnect(input): Promise<StartConnectionResult> {
    const cfg = requireGitLabConfig(input.config);
    const nonce = randomBytes(16).toString('hex');
    await getRedisClient().set(
      `devint:gitlab:state:${nonce}`,
      JSON.stringify({ userId: input.userId, workspaceId: input.workspaceId }),
      { EX: STATE_TTL_SECONDS },
    );
    const state = encodeState({ userId: input.userId, workspaceId: input.workspaceId, provider: 'GITLAB', nonce }, input.config);
    const url = new URL(`${cfg.baseUrl}/oauth/authorize`);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('scope', cfg.scopes);
    return { url: url.toString() };
  },

  async verifyAndConsumeState(state: string): Promise<DevProviderStateClaims> {
    const config = { jwtAccessSecret: process.env.JWT_ACCESS_SECRET } as AppConfig;
    const [body, sig, extra] = state.split('.');
    const bad = () => new AppError(400, 'GITLAB_STATE_INVALID', 'The GitLab authorization state is invalid or expired');
    if (!body || !sig || extra !== undefined) throw bad();
    const expected = Buffer.from(signState(body, config));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
    let claims: { userId?: string; workspaceId?: string; provider?: string; nonce?: string; exp?: number };
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw bad(); }
    if (
      claims.provider !== 'GITLAB' || typeof claims.userId !== 'string' || typeof claims.workspaceId !== 'string' ||
      typeof claims.nonce !== 'string' || typeof claims.exp !== 'number' || claims.exp < Date.now() || !/^[0-9a-f]{32}$/.test(claims.nonce)
    ) throw bad();
    const redis = getRedisClient();
    const key = `devint:gitlab:state:${claims.nonce}`;
    const stored = await redis.get(key);
    const consumed = await redis.del(key);
    if (consumed !== 1 || !stored) throw bad();
    try {
      const parsed = JSON.parse(stored) as { userId: string; workspaceId: string };
      if (parsed.userId !== claims.userId || parsed.workspaceId !== claims.workspaceId) throw bad();
    } catch (e) { if (e instanceof AppError) throw e; throw bad(); }
    return { userId: claims.userId, workspaceId: claims.workspaceId, provider: 'GITLAB', nonce: claims.nonce };
  },

  async handleCallback(input): Promise<DevConnectCallbackResult> {
    const { config, query } = input;
    const code = typeof query.code === 'string' ? query.code : null;
    if (!code) throw new AppError(400, 'GITLAB_CODE_REQUIRED', 'GitLab authorization code is required');
    const cfg = requireGitLabConfig(config);
    const tokenRes = await gitlabFetch(`${cfg.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: cfg.callbackUrl,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      logger.warn('gitlab_token_exchange_failed', { status: tokenRes.status, body: text.slice(0, 200) });
      throw new AppError(502, 'GITLAB_TOKEN_EXCHANGE_FAILED', 'Failed to complete GitLab authorization');
    }
    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) throw new AppError(502, 'GITLAB_TOKEN_EXCHANGE_FAILED', 'GitLab token response missing access token');

    const userRes = await gitlabFetch(`${cfg.baseUrl}/api/v4/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    if (!userRes.ok) throw new AppError(502, 'GITLAB_USER_FETCH_FAILED', 'Failed to fetch GitLab account');
    const user = await userRes.json() as any;
    const externalAccount: DevExternalAccount = {
      id: user.id != null ? String(user.id) : null,
      login: user.username ?? null,
      name: user.name ?? user.username ?? null,
      type: user.bot ? 'bot' : 'user',
    };
    const scopes = typeof tokenData.scope === 'string' ? tokenData.scope.split(/\s+/).filter(Boolean) : cfg.scopes.split(/\s+/).filter(Boolean);
    const payload: GitLabCredentialsPayload = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      tokenType: tokenData.token_type ?? null,
      expiresAt: typeof tokenData.expires_in === 'number' ? Date.now() + tokenData.expires_in * 1000 : null,
      scope: tokenData.scope ?? null,
      account: externalAccount,
      baseUrl: cfg.baseUrl,
    };
    return { externalAccount, scopes, encryptedCredentials: encryptIntegrationToken(JSON.stringify(payload)) };
  },

  async listAvailableRepositories(input): Promise<DevRepositorySummary[]> {
    const { config, encryptedCredentials, onCredentialsRefreshed } = input;
    const repos: DevRepositorySummary[] = [];
    let page = 1;
    let currentCreds = encryptedCredentials;
    while (page <= 10) {
      const { res, creds } = await authedGitLabGet(
        config,
        currentCreds,
        '/api/v4/projects',
        { membership: 'true', per_page: 100, page, simple: 'true', order_by: 'last_activity_at', sort: 'desc' },
        onCredentialsRefreshed,
      );
      currentCreds = encryptIntegrationToken(JSON.stringify(creds));
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new AppError(502, 'GITLAB_REPOS_UNAVAILABLE', 'Unable to list GitLab projects for this connection');
        throw new AppError(502, 'GITLAB_REPOS_UNAVAILABLE', `Failed to list GitLab projects (${res.status})`);
      }
      const batch = await res.json() as any[];
      for (const p of batch) {
        repos.push({
          externalRepoId: String(p.id),
          fullName: p.path_with_namespace ?? p.name ?? String(p.id),
          name: p.name ?? p.path ?? null,
          ownerLogin: p.namespace?.path ?? null,
          defaultBranch: p.default_branch ?? null,
          private: p.visibility ? p.visibility !== 'public' : undefined,
          htmlUrl: p.web_url ?? null,
        });
      }
      if (!Array.isArray(batch) || batch.length < 100) break;
      page += 1;
    }
    return repos;
  },

  async listRepositoryBranches(input): Promise<DevBranchSummary[]> {
    const { config, encryptedCredentials, repositoryFullName, search, page = 1, perPage = 30, onCredentialsRefreshed } = input;
    const encoded = encodeURIComponent(repositoryFullName);
    const { res } = await authedGitLabGet(
      config,
      encryptedCredentials,
      `/api/v4/projects/${encoded}/repository/branches`,
      { per_page: Math.min(Math.max(perPage, 1), 100), page: Math.min(Math.max(page, 1), 10), ...(search ? { search } : {}) },
      onCredentialsRefreshed,
    );
    if (!res.ok) throw new AppError(502, 'GITLAB_RESOURCE_UNAVAILABLE', 'Unable to list branches for this GitLab project');
    const data = await res.json() as any[];
    return (Array.isArray(data) ? data : []).map((b) => ({
      name: b.name,
      commitSha: b.commit?.id ?? null,
      protected: !!b.protected,
      url: b.web_url ?? null,
    }));
  },

  async listRepositoryPullRequests(input): Promise<DevPullRequestSummary[]> {
    const { config, encryptedCredentials, repositoryFullName, state = 'open', search, page = 1, perPage = 30, onCredentialsRefreshed } = input;
    const gitlabState = state === 'open' ? 'opened' : state === 'all' ? 'all' : state === 'closed' ? 'closed' : state;
    const encoded = encodeURIComponent(repositoryFullName);
    const query: Record<string, any> = { per_page: Math.min(Math.max(perPage, 1), 100), page: Math.min(Math.max(page, 1), 10), order_by: 'updated_at', sort: 'desc' };
    if (gitlabState && gitlabState !== 'all') query.state = gitlabState;
    if (search) query.search = search;
    const { res } = await authedGitLabGet(config, encryptedCredentials, `/api/v4/projects/${encoded}/merge_requests`, query, onCredentialsRefreshed);
    if (!res.ok) throw new AppError(502, 'GITLAB_RESOURCE_UNAVAILABLE', 'Unable to list merge requests for this GitLab project');
    const data = await res.json() as any[];
    return (Array.isArray(data) ? data : []).map((mr) => ({
      externalId: String(mr.id),
      number: mr.iid ?? mr.id,
      title: mr.title ?? '',
      state: mapMrState(mr),
      url: mr.web_url ?? null,
      headRef: mr.source_branch ?? null,
      baseRef: mr.target_branch ?? null,
      authorLogin: mr.author?.username ?? null,
      updatedAt: mr.updated_at ?? null,
    }));
  },

  async disconnect(input): Promise<{ revoked: boolean; detail?: string }> {
    try {
      const creds = parseCredentials(input.encryptedCredentials);
      const { clientId, clientSecret } = requireGitLabConfig(input.config);
      // Best-effort revoke
      await gitlabFetch(`${creds.baseUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: creds.accessToken }).toString(),
      }).catch(() => undefined);
      return { revoked: true, detail: 'Stored GitLab credentials removed' };
    } catch (error) {
      logger.warn('gitlab_disconnect_cleanup_failed', { error });
      return { revoked: false, detail: 'Stored credentials removed; provider cleanup could not be verified' };
    }
  },
};
