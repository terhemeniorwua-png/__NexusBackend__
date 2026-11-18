/**
 * SCIM 2.0 provisioning types.
 *
 * SCIM is authenticated with per-workspace bearer tokens stored in
 * `ScimToken`. A token is scoped to exactly one workspace, so every SCIM
 * operation is implicitly workspace-scoped. SCIM users map to Nexus users
 * within that workspace (via `WorkspaceMembership`); SCIM groups map to
 * Nexus teams.
 */

import type {
  ScimToken,
  ScimTokenStatus,
  WorkspaceRole,
} from '@prisma/client';

export interface ScimAuthContext {
  tokenId: string;
  workspaceId: string;
  userId: string;
  scopes: string[];
}

/** Minimal view of a SCIM token — never returns the plaintext token or its hash. */
export interface ScimTokenView {
  id: string;
  name: string;
  scopes: string[];
  status: ScimTokenStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Input for creating a SCIM bearer token. */
export interface CreateScimTokenInput {
  workspaceId: string;
  userId: string;
  name: string;
  scopes?: string[];
  expiresAt?: Date | null;
}

/** Input for provisioning a SCIM user (Nexus user + workspace membership). */
export interface ProvisionScimUserInput {
  workspaceId: string;
  userName: string; // email address used as the SCIM user name
  externalId?: string | null;
  name?: { givenName?: string | null; familyName?: string | null; formatted?: string | null } | null;
  displayName?: string | null;
  emails?: Array<{ value: string; type?: string | null; primary?: boolean } | null>;
  active?: boolean;
  password?: string | null;
  role?: WorkspaceRole;
}

/** A SCIM user resource. */
export interface ScimUser {
  id: string;
  externalId: string | null;
  userName: string;
  displayName: string | null;
  name: { givenName: string | null; familyName: string | null; formatted: string | null } | null;
  emails: Array<{ value: string; type: string | null; primary: boolean }>;
  active: boolean;
  groups: Array<{ value: string; display: string | null }>;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for patching a SCIM user. */
export interface PatchScimUserInput {
  externalId?: string | null;
  displayName?: string | null;
  active?: boolean;
  emails?: Array<{ value: string; type?: string | null; primary?: boolean } | null>;
}

/** Input for provisioning a SCIM group (mapped to a Nexus team). */
export interface ProvisionScimGroupInput {
  workspaceId: string;
  displayName: string;
  externalId?: string | null;
  teamId?: string | null;
  members?: Array<{ userId: string } | null>;
}

/** A SCIM group resource. */
export interface ScimGroupResource {
  id: string;
  externalId: string | null;
  displayName: string;
  members: Array<{ value: string; display: string | null }>;
  workspaceId: string;
  teamId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** SCIM list response. */
export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimService {
  // ------------------------------------------------------------------
  // Tokens
  // ------------------------------------------------------------------
  createToken(input: CreateScimTokenInput): Promise<{ token: string; scimToken: ScimTokenView }>;
  listTokens(input: { workspaceId: string; userId: string }): Promise<ScimTokenView[]>;
  revokeToken(input: { workspaceId: string; tokenId: string }): Promise<void>;

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------
  listUsers(input: {
    workspaceId: string;
    startIndex?: number;
    count?: number;
    filter?: string | null;
  }): Promise<ScimListResponse<ScimUser>>;
  createUser(input: ProvisionScimUserInput): Promise<ScimUser>;
  getUser(input: { workspaceId: string; scimUserId: string }): Promise<ScimUser>;
  updateUser(input: {
    workspaceId: string;
    scimUserId: string;
    patch: PatchScimUserInput;
  }): Promise<ScimUser>;
  deactivateUser(input: {
    workspaceId: string;
    scimUserId: string;
    hardDelete?: boolean;
  }): Promise<void>;

  // ------------------------------------------------------------------
  // Groups
  // ------------------------------------------------------------------
  listGroups(input: {
    workspaceId: string;
    startIndex?: number;
    count?: number;
  }): Promise<ScimListResponse<ScimGroupResource>>;
  createGroup(input: ProvisionScimGroupInput): Promise<ScimGroupResource>;
  getGroup(input: {
    workspaceId: string;
    scimGroupId: string;
  }): Promise<ScimGroupResource>;
  updateGroup(input: {
    workspaceId: string;
    scimGroupId: string;
    patch: { displayName?: string | null; externalId?: string | null; members?: Array<{ userId: string }> | null };
  }): Promise<ScimGroupResource>;
  deleteGroup(input: { workspaceId: string; scimGroupId: string }): Promise<void>;
}

export type { ScimToken };