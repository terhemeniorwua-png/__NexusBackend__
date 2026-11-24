export interface DevActivityIdentityInput {
  providerLogin: string | null | undefined;
  /** Active workspace members with a verified (active) integration connection external login. */
  candidates: Array<{
    userId: string;
    name: string | null;
    externalAccountLogin: string | null;
  }>;
}

export type DevActivityResolvedDeveloper =
  | { type: 'workspace_user'; user: { id: string; name: string | null }; providerLogin: string }
  | { type: 'unmapped'; user: null; providerLogin: string | null; displayName: string };

function normalizeLogin(login: string | null | undefined): string | null {
  if (typeof login !== 'string') return null;
  const trimmed = login.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

/**
 * Pure identity resolver for dev-activity ingestion/reporting.
 *
 * Maps a provider login to a workspace user ONLY via verified
 * IntegrationConnection.externalAccountLogin of workspace members.
 * No name or email matching. No DB access.
 */
export function resolveDevActivityDeveloper(
  input: DevActivityIdentityInput,
): DevActivityResolvedDeveloper {
  const login = typeof input.providerLogin === 'string' ? input.providerLogin.trim() : '';
  const normalized = normalizeLogin(login);

  if (!normalized) {
    return { type: 'unmapped', user: null, providerLogin: null, displayName: 'Unknown author' };
  }

  const matches = input.candidates.filter(
    (candidate) => normalizeLogin(candidate.externalAccountLogin) === normalized,
  );

  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      type: 'workspace_user',
      user: { id: match.userId, name: match.name },
      providerLogin: login,
    };
  }

  return {
    type: 'unmapped',
    user: null,
    providerLogin: login,
    displayName: login,
  };
}
