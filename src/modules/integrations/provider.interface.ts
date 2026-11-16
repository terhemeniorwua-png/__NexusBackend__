import type { IntegrationProvider } from '@prisma/client';

export interface OAuthStateClaims {
  userId: string;
  workspaceId: string | null;
  nonce: string;
  codeVerifier?: string;
  createdAt: number;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  scopes?: string[];
  externalUserId?: string | null;
  externalEmail?: string | null;
}

export interface IntegrationProviderAdapter {
  provider: IntegrationProvider;
  /** True when this provider must be connected at workspace scope by admins. */
  workspaceScoped: boolean;
  /** True when OAuth must use PKCE (S256). */
  supportsPkce: boolean;
  buildAuthorizeUrl(input: {
    userId: string;
    workspaceId: string | null;
    state: string;
    codeChallenge?: string;
    redirectUri?: string;
  }): Promise<string> | string;
  exchangeCode(input: {
    code: string;
    stateClaims: OAuthStateClaims;
    redirectUri?: string;
  }): Promise<OAuthTokenResult>;
  refreshToken?(refreshToken: string): Promise<OAuthTokenResult | null>;
  revokeToken?(token: string): Promise<{ revoked: boolean; detail?: string }>;
  healthCheck?(input: { accessToken: string }): Promise<{ ok: boolean; detail?: string }>;
}
