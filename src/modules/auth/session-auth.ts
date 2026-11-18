import type { SessionAuthMethod as DbAuthMethod } from '@prisma/client';
import { AppError } from '../../utils/errors';

export type AuthMethod = 'password' | 'social' | 'sso' | 'break_glass';

// Record<...> makes tsc fail if the Prisma enum and these maps ever drift apart.
const FROM_DB: Record<DbAuthMethod, AuthMethod> = {
  PASSWORD: 'password',
  SOCIAL: 'social',
  SSO: 'sso',
  BREAK_GLASS: 'break_glass',
};

export const TO_DB: Record<AuthMethod, DbAuthMethod> = {
  password: 'PASSWORD',
  social: 'SOCIAL',
  sso: 'SSO',
  break_glass: 'BREAK_GLASS',
};

export function resolveSessionAuth(session: {
  authMethod: DbAuthMethod;
  authMethodExpiresAt: Date | null;
}) {
  const authMethod = FROM_DB[session.authMethod];

  // Break-glass sessions are time-limited by authMethodExpiresAt in addition to normal session expiry.
  if (
    authMethod === 'break_glass' &&
    session.authMethodExpiresAt &&
    session.authMethodExpiresAt.getTime() <= Date.now()
  ) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your break-glass session has expired. Please sign in again.');
  }

  return { authMethod, authMethodExpiresAt: session.authMethodExpiresAt };
}

export type { DbAuthMethod };

export function fromDbAuthMethod(method: DbAuthMethod | null | undefined): AuthMethod {
  return method ? FROM_DB[method] : 'password';
}
