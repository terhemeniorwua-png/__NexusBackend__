/**
 * Shared types for the centralized authorization module.
 *
 * Each scope (workspace, project, team) defines its own capability constants
 * and checks, but they all share the same structural contracts below.
 */

export type ScopeKind = 'workspace' | 'project' | 'team';

/**
 * Describes why an authorization check failed.  The error code is passed to
 * the HTTP response so the frontend can give a precise explanation.
 */
export interface AuthorizationFailure {
  status: number;
  code: string;
  message: string;
}
