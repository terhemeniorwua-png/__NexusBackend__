import type { PrismaClient } from '@prisma/client';

/**
 * A record returned by the mocked `ssoOidcState.findUnique`.
 */
export interface SsoOidcStateRecord {
  id: string;
  workspaceId: string;
  configId: string | null;
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  browserBindingHash: string;
  redirectUri: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Builds a typed PrismaClient mock whose `ssoOidcState` create/findUnique/
 * updateMany behaviour is driven by the caller. Used by the SSO OIDC unit
 * tests in place of untyped `as any` database mocks.
 */
export function createSsoOidcStateDbMock(input: {
  create?: () => Promise<unknown>;
  findUnique: () => Promise<SsoOidcStateRecord | null>;
  updateMany: (args: {
    where: { id: string; consumedAt: Date | null };
  }) => Promise<{ count: number }>;
}): PrismaClient {
  return {
    ssoOidcState: {
      create: input.create,
      findUnique: input.findUnique,
      updateMany: input.updateMany,
    },
  } as unknown as PrismaClient;
}
