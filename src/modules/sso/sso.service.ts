import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { Prisma, type PrismaClient, type WorkspaceRole, type WorkspaceSsoConfig } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { verifyOAuthState, type OAuthStateClaims } from '../integrations/oauth-state';
import { requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';
import { getPrismaClient } from '../../db/prisma';
import { encryptIntegrationToken } from '../integrations/token-crypto';
import { createNotification } from '../../services/notifications';
import { recordAuditEvent } from '../../services/audit';
import { generateSecureToken, hashSecret, safeCompare } from '../../utils/crypto';

export const SsoAuditAction = {
  ConfigCreated: 'workspace.sso_config_created',
  ConfigUpdated: 'workspace.sso_config_updated',
  ConfigEnabled: 'workspace.sso_config_enabled',
  ConfigDisabled: 'workspace.sso_config_disabled',
  RequireSsoEnabled: 'workspace.require_sso_enabled',
  RequireSsoDisabled: 'workspace.require_sso_disabled',
  DomainVerificationRequested: 'workspace.sso_domain_verification_requested',
  DomainVerified: 'workspace.sso_domain_verified',
  BreakGlassUsed: 'workspace.sso_break_glass_used',
  BreakGlassFailed: 'workspace.sso_break_glass_failed',
  JitProvisionBlocked: 'workspace.sso_jit_provision_blocked',
  SsoLoginSucceeded: 'workspace.sso_login_succeeded',
  SsoLoginFailed: 'workspace.sso_login_failed',
} as const;

export interface SsoConfigInput {
  providerType: 'OIDC' | 'SAML';
  providerName: string;
  issuer?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  metadataUrl?: string | null;
  certificate?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userInfoUrl?: string | null;
  redirectUri?: string | null;
  config?: Record<string, unknown> | null;
  isEnabled?: boolean;
  requireSso?: boolean;
  breakGlassEnabled?: boolean;
  jitProvisioningEnabled?: boolean;
}

export interface DomainVerificationRequest {
  domain: string;
}

export interface SsoIdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  exp: number;
  iat?: number;
  nonce?: string;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

function isSsoAdminRole(membership: { role: string; organizationRole?: string | null }): boolean {
  if (membership.role === 'OWNER') return true;
  const org = membership.organizationRole;
  return (
    org === 'COMPANY_OWNER' ||
    org === 'COMPANY_ADMIN' ||
    org === 'INSTITUTION_OWNER' ||
    org === 'INSTITUTION_ADMIN'
  );
}

async function requireOwnerAdmin(
  db: PrismaClient,
  userId: string | undefined,
  workspaceId: string,
): Promise<void> {
  if (!userId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  const access = await requireWorkspaceAccess(db, {
    userId,
    workspaceId,
    capability: WorkspaceCapability.UpdateWorkspace,
         context: (input as { context: WorkspaceAccessContext }).context,
      });
  if (!isSsoAdminRole(access.membership)) {
    throw new AppError(403, 'INSUFFICIENT_ROLE', 'Only workspace owners and administrators may manage SSO settings');
  }
}

function toPublicConfig(config: WorkspaceSsoConfig & { domains?: any[] }) {
  const { clientSecretCiphertext, breakGlassCodeHashes, ...rest } = config as any;
  return {
    ...rest,
    hasClientSecret: Boolean(clientSecretCiphertext),
    breakGlassCodeCount: Array.isArray(breakGlassCodeHashes) ? breakGlassCodeHashes.length : 0,
  };
}

export async function listSsoConfigs(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
) {
  await requireOwnerAdmin(db, userId, workspaceId);
  const configs = await db.workspaceSsoConfig.findMany({
    where: { workspaceId },
    include: { domains: true },
    orderBy: { createdAt: 'desc' },
  });
  return configs.map(toPublicConfig);
}

export async function getSsoConfig(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  configId: string,
) {
  await requireOwnerAdmin(db, userId, workspaceId);
  const config = await db.workspaceSsoConfig.findFirst({
    where: { id: configId, workspaceId },
    include: { domains: true },
  });
  if (!config) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found');
  return toPublicConfig(config);
}

export async function createSsoConfig(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  input: SsoConfigInput,
) {
  await requireOwnerAdmin(db, userId, workspaceId);

  if (input.requireSso) {
    throw new AppError(400, 'SSO_DOMAIN_NOT_VERIFIED', 'A verified domain is required before SSO can be required');
  }

  const created = await db.workspaceSsoConfig.create({
    data: {
      workspaceId,
      providerType: input.providerType,
      providerName: input.providerName,
      issuer: input.issuer ?? null,
      clientId: input.clientId ?? null,
      clientSecretCiphertext: input.clientSecret ? encryptIntegrationToken(input.clientSecret) : null,
      metadataUrl: input.metadataUrl ?? null,
      certificate: input.certificate ?? null,
      authorizationUrl: input.authorizationUrl ?? null,
      tokenUrl: input.tokenUrl ?? null,
      userInfoUrl: input.userInfoUrl ?? null,
      redirectUri: input.redirectUri ?? null,
      config: (input.config ?? undefined) as any,
      status: input.isEnabled ? 'ACTIVE' : 'DRAFT',
      isEnabled: Boolean(input.isEnabled),
      requireSso: false,
      breakGlassEnabled: Boolean(input.breakGlassEnabled),
      jitProvisioningEnabled: Boolean(input.jitProvisioningEnabled),
      createdById: userId,
    },
    include: { domains: true },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: SsoAuditAction.ConfigCreated,
    targetType: 'WorkspaceSsoConfig',
    targetId: created.id,
    metadata: { providerType: created.providerType, providerName: created.providerName },
  } as any);

  return toPublicConfig(created);
}

export async function updateSsoConfig(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  configId: string,
  input: SsoConfigInput,
) {
  await requireOwnerAdmin(db, userId, workspaceId);
  const existing = await db.workspaceSsoConfig.findFirst({ where: { id: configId, workspaceId }, include: { domains: true } });
  if (!existing) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found');

  if (input.requireSso) {
    const hasVerified = existing.domains.some((d) => d.verifiedAt);
    if (!hasVerified) {
      throw new AppError(400, 'SSO_DOMAIN_NOT_VERIFIED', 'A verified domain is required before SSO can be required');
    }
  }

  const updated = await db.workspaceSsoConfig.update({
    where: { id: configId },
    data: {
      providerType: input.providerType ?? existing.providerType,
      providerName: input.providerName ?? existing.providerName,
      issuer: input.issuer !== undefined ? input.issuer : existing.issuer,
      clientId: input.clientId !== undefined ? input.clientId : existing.clientId,
      clientSecretCiphertext: input.clientSecret !== undefined ? (input.clientSecret ? encryptIntegrationToken(input.clientSecret) : null) : existing.clientSecretCiphertext,
      metadataUrl: input.metadataUrl !== undefined ? input.metadataUrl : existing.metadataUrl,
      certificate: input.certificate !== undefined ? input.certificate : existing.certificate,
      authorizationUrl: input.authorizationUrl !== undefined ? input.authorizationUrl : existing.authorizationUrl,
      tokenUrl: input.tokenUrl !== undefined ? input.tokenUrl : existing.tokenUrl,
      userInfoUrl: input.userInfoUrl !== undefined ? input.userInfoUrl : existing.userInfoUrl,
      redirectUri: input.redirectUri !== undefined ? input.redirectUri : existing.redirectUri,
      config: input.config !== undefined ? (input.config as any) : (existing.config as any),
      isEnabled: input.isEnabled ?? existing.isEnabled,
      requireSso: input.requireSso ?? existing.requireSso,
      breakGlassEnabled: input.breakGlassEnabled ?? existing.breakGlassEnabled,
      jitProvisioningEnabled: (input as any).jitProvisioningEnabled ?? (existing as any).jitProvisioningEnabled,
      status: (input.isEnabled ?? existing.isEnabled) ? 'ACTIVE' : 'DRAFT',
    },
    include: { domains: true },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: SsoAuditAction.ConfigUpdated,
    targetType: 'WorkspaceSsoConfig',
    targetId: updated.id,
    metadata: {
      providerType: updated.providerType,
      isEnabled: updated.isEnabled,
      requireSso: updated.requireSso,
    },
  } as any);

  return toPublicConfig(updated);
}

export async function requestDomainVerification(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  configId: string,
  domainInput: string,
) {
  await requireOwnerAdmin(db, userId, workspaceId);
  const config = await db.workspaceSsoConfig.findFirst({ where: { id: configId, workspaceId } });
  if (!config) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found');

  const domain = normalizeDomain(domainInput);
  if (!domain || !domain.includes('.')) {
    throw new AppError(400, 'SSO_INVALID_DOMAIN', 'A valid domain is required');
  }
  const verificationToken = `nexus-sso-verification=${generateSecureToken(24)}`;
  const txtRecordName = `_nexus-sso-verification.${domain}`;

  const record = await db.workspaceSsoDomain.upsert({
    where: { workspaceId_domain: { workspaceId, domain } },
    update: {
      configId,
      verificationToken,
      txtRecordName,
      verifiedAt: null,
    },
    create: {
      workspaceId,
      configId,
      domain,
      verificationToken,
      txtRecordName,
    },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: SsoAuditAction.DomainVerificationRequested,
    targetType: 'WorkspaceSsoDomain',
    targetId: record.id,
    metadata: { domain },
  } as any);

  return record;
}

export async function verifyDomainDnsTxt(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  domainId: string,
) {
  await requireOwnerAdmin(db, userId, workspaceId);
  const record = await db.workspaceSsoDomain.findFirst({ where: { id: domainId, workspaceId } });
  if (!record) throw new AppError(404, 'SSO_DOMAIN_NOT_FOUND', 'Domain verification record not found');

  let verified = false;
  try {
    const txt = await dns.resolveTxt(record.txtRecordName);
    const flat = txt.flat().map((v) => v.trim());
    verified = flat.includes(record.verificationToken);
  } catch {
    verified = false;
  }

  if (!verified) {
    throw new AppError(400, 'SSO_DOMAIN_NOT_VERIFIED', 'DNS TXT verification record not found or does not match');
  }

  const updated = await db.workspaceSsoDomain.update({
    where: { id: record.id },
    data: { verifiedAt: new Date() },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: SsoAuditAction.DomainVerified,
    targetType: 'WorkspaceSsoDomain',
    targetId: updated.id,
    metadata: { domain: updated.domain },
  } as any);

  return updated;
}

export async function generateBreakGlassCodes(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  configId: string,
  count = 5,
) {
  await requireOwnerAdmin(db, userId, workspaceId);
  const config = await db.workspaceSsoConfig.findFirst({ where: { id: configId, workspaceId } });
  if (!config) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found');

  const codes = Array.from({ length: Math.max(1, Math.min(count, 10)) }, () => generateSecureToken(12));
  const hashes = codes.map((c) => hashSecret(c));
  await db.workspaceSsoConfig.update({
    where: { id: configId },
    data: { breakGlassCodeHashes: hashes as any, breakGlassEnabled: true },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: 'workspace.sso_break_glass_codes_generated',
    targetType: 'WorkspaceSsoConfig',
    targetId: configId,
    metadata: { count: codes.length },
  } as any);

  // Returned once to admin; never stored in plaintext
  return { codes };
}

export async function consumeBreakGlassCode(
  db: PrismaClient,
  workspaceId: string,
  code: string,
  actorUserId: string,
  context: { ip?: string; userAgent?: string } = {},
) {
  // Rate limiting should be enforced at route/middleware layer; this is a safety check hook point.
  const config = await db.workspaceSsoConfig.findFirst({
    where: { workspaceId, requireSso: true, breakGlassEnabled: true, isEnabled: true },
  });
  if (!config) {
    throw new AppError(403, 'SSO_BREAK_GLASS_UNAVAILABLE', 'Break-glass access is not available');
  }

  const hashes = Array.isArray(config.breakGlassCodeHashes) ? (config.breakGlassCodeHashes as string[]) : [];
  const idx = hashes.findIndex((h) => safeCompare(h, hashSecret(code)));
  if (idx === -1) {
    await recordAuditEvent(db, {
      workspaceId,
      actorId: actorUserId,
      action: SsoAuditAction.BreakGlassFailed,
      targetType: 'WorkspaceSsoConfig',
      targetId: config.id,
      metadata: { reason: 'invalid_code' },
      ip: context.ip,
      userAgent: context.userAgent,
    } as any);
    throw new AppError(403, 'SSO_BREAK_GLASS_INVALID', 'Invalid break-glass code');
  }

  // One-time use: remove consumed hash
  hashes.splice(idx, 1);
  await db.workspaceSsoConfig.update({
    where: { id: config.id },
    data: { breakGlassCodeHashes: hashes as any },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: actorUserId,
    action: SsoAuditAction.BreakGlassUsed,
    targetType: 'WorkspaceSsoConfig',
    targetId: config.id,
    metadata: { remainingCodes: hashes.length },
    ip: context.ip,
    userAgent: context.userAgent,
  } as any);

  // Notify other owners
  try {
    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, ownerId: true } });
    const ownerMembers = await db.workspaceMembership.findMany({
      where: {
        workspaceId,
        status: 'ACTIVE',
        OR: [
          { role: 'OWNER' },
          { organizationRole: { in: ['COMPANY_OWNER', 'INSTITUTION_OWNER'] } },
        ],
      },
      select: { userId: true },
    });
    const ownerIds = new Set<string>(ownerMembers.map((m) => m.userId));
    if (workspace?.ownerId) ownerIds.add(workspace.ownerId);
    ownerIds.delete(actorUserId);
    for (const ownerId of ownerIds) {
      await createNotification(db, {
        userId: ownerId,
        type: 'SECURITY_ALERT' as any,
        title: 'SSO break-glass access used',
        body: `A break-glass recovery code was used to access workspace${workspace?.name ? ` "${workspace.name}"` : ''}.`,
        data: { workspaceId, actorUserId, configId: config.id },
      }).catch(() => undefined);
    }
  } catch {
    // notification failure must not block audited break-glass use
  }

  return { ok: true, remainingCodes: hashes.length };
}

export async function checkRequireSso(
  db: PrismaClient,
  workspaceId: string,
): Promise<{ required: boolean; breakGlassEnabled: boolean; configId?: string }> {
  const config = await db.workspaceSsoConfig.findFirst({
    where: { workspaceId, isEnabled: true, requireSso: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!config) return { required: false, breakGlassEnabled: false };
  // Ensure at least one verified domain exists
  const verified = await db.workspaceSsoDomain.count({ where: { workspaceId, verifiedAt: { not: null } } });
  if (verified === 0) return { required: false, breakGlassEnabled: false };
  return { required: true, breakGlassEnabled: Boolean(config.breakGlassEnabled), configId: config.id };
}

export function validateSsoIdTokenClaims(
  claims: SsoIdTokenClaims,
  expected: { issuer: string; audience: string; nonce?: string; now?: number },
): void {
  const now = expected.now ?? Date.now();
  if (claims.iss !== expected.issuer) {
    throw new AppError(401, 'SSO_INVALID_ISSUER', 'SSO token issuer is not trusted');
  }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(expected.audience)) {
    throw new AppError(401, 'SSO_INVALID_AUDIENCE', 'SSO token audience is invalid');
  }
  if (claims.exp * 1000 <= now) {
    throw new AppError(401, 'SSO_TOKEN_EXPIRED', 'SSO token has expired');
  }
  if (expected.nonce && claims.nonce !== expected.nonce) {
    throw new AppError(401, 'SSO_INVALID_NONCE', 'SSO token nonce is invalid');
  }
}

export async function jitProvisionByVerifiedEmail(
  db: PrismaClient,
  email: string,
  context: { workspaceId?: string; providerName?: string; actorId?: string } = {},
): Promise<{ mapped: boolean; userId?: string; reason?: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { mapped: false, reason: 'missing_email' };

  const user = await db.user.findUnique({
    where: { email: normalized },
    select: { id: true, emailVerifiedAt: true, status: true },
  });

  if (!user) {
    return { mapped: false, reason: 'user_not_found' };
  }
  if (!user.emailVerifiedAt) {
    await recordAuditEvent(db, {
      workspaceId: context.workspaceId ?? null,
      actorId: context.actorId ?? null,
      action: SsoAuditAction.JitProvisionBlocked,
      targetType: 'User',
      targetId: user.id,
      metadata: { reason: 'email_not_verified', emailDomain: normalized.split('@')[1] ?? null },
    } as any);
    return { mapped: false, userId: user.id, reason: 'email_not_verified' };
  }

  // Mapped to existing verified account only; never auto-link unverified or create shadow accounts here.
  return { mapped: true, userId: user.id };
}

export async function enforceVerifiedDomainForEmail(
  db: PrismaClient,
  workspaceId: string,
  email: string,
): Promise<void> {
  const domain = normalizeDomain(email.split('@')[1] ?? '');
  if (!domain) {
    throw new AppError(400, 'SSO_INVALID_EMAIL', 'SSO account email is invalid');
  }
  const verified = await db.workspaceSsoDomain.findFirst({
    where: { workspaceId, domain, verifiedAt: { not: null } },
  });
  if (!verified) {
    throw new AppError(403, 'SSO_DOMAIN_NOT_VERIFIED', 'Email domain is not verified for this workspace SSO configuration');
  }
}

export async function verifySsoState(
  provider: string,
  state: string,
): Promise<OAuthStateClaims> {
  return verifyOAuthState(provider, state);
}

// Session revocation hook for "SSO membership removed" - to be called by workspace/member removal flows.
// This is a best-effort helper; actual wiring depends on membership model semantics.
export async function revokeSsoSessionsForMember(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<number> {
  // In this codebase, sessions are per-user (not per-workspace) and SSO-issued sessions
  // should follow same session model. Without a direct SSO-session marker in schema,
  // we conservatively revoke active sessions for the user when SSO access is removed
  // from a workspace that requires SSO, to satisfy "revoked when SSO membership removed".
  const requirement = await checkRequireSso(db, workspaceId);
  if (!requirement.required) return 0;

  const result = await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'SSO_MEMBERSHIP_REMOVED' },
  });
  return result.count;
}

/**
 * Returns true if the user is an active member of any workspace that requires SSO
 * (enabled, requireSso, and at least one verified domain).
 */
export async function userHasRequiredSsoWorkspace(
  db: PrismaClient,
  userId: string,
): Promise<{ required: boolean; workspaceId?: string }> {
  // Find active memberships and check if any of those workspaces require SSO.
  const memberships = await db.workspaceMembership.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { workspaceId: true },
  });
  if (memberships.length === 0) return { required: false };

  for (const m of memberships) {
    const req = await checkRequireSso(db, m.workspaceId);
    if (req.required) return { required: true, workspaceId: m.workspaceId };
  }
  return { required: false };
}

/**
 * Password login/reset/session creation paths must be refused when the workspace requires SSO.
 * This checks if the user belongs to any workspace with SSO required.
 */
export async function assertUserPasswordLoginAllowed(
  db: PrismaClient,
  userId: string,
): Promise<void> {
  const { required, workspaceId } = await userHasRequiredSsoWorkspace(db, userId);
  if (required) {
    throw new AppError(
      403,
      'SSO_REQUIRED',
      'This account must sign in using single sign-on (SSO).',
      workspaceId ? { details: { workspaceId } } : undefined,
    );
  }
}

export async function disableSsoConfig(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  configId: string,
): Promise<{ disabled: boolean; revokedSessions: number }> {
  await requireOwnerAdmin(db, userId, workspaceId);
  const config = await db.workspaceSsoConfig.findFirst({ where: { id: configId, workspaceId } });
  if (!config) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found');

  const wasRequiringSso = config.isEnabled && config.requireSso;

  await db.workspaceSsoConfig.update({
    where: { id: configId },
    data: { isEnabled: false, requireSso: false, status: 'DISABLED' },
  });

  let revokedSessions = 0;
  if (wasRequiringSso) {
    const members = await db.workspaceMembership.findMany({ where: { workspaceId, status: 'ACTIVE' }, select: { userId: true } });
    for (const m of members) {
      const result = await db.session.updateMany({
        where: { userId: m.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'SSO_CONFIG_REMOVED' },
      });
      revokedSessions += result.count;
    }
  }

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: SsoAuditAction.ConfigDisabled,
    targetType: 'WorkspaceSsoConfig',
    targetId: configId,
    metadata: { revokedSessions, wasRequiringSso },
  } as any);

  return { disabled: true, revokedSessions };
}

export async function deleteSsoConfig(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  configId: string,
): Promise<{ deleted: boolean; revokedSessions: number }> {
  await requireOwnerAdmin(db, userId, workspaceId);
  const config = await db.workspaceSsoConfig.findFirst({ where: { id: configId, workspaceId } });
  if (!config) throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found');

  const wasRequiringSso = config.isEnabled && config.requireSso;

  let revokedSessions = 0;
  if (wasRequiringSso) {
    const members = await db.workspaceMembership.findMany({ where: { workspaceId, status: 'ACTIVE' }, select: { userId: true } });
    for (const m of members) {
      const result = await db.session.updateMany({
        where: { userId: m.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'SSO_CONFIG_REMOVED' },
      });
      revokedSessions += result.count;
    }
  }

  await db.workspaceSsoConfig.delete({ where: { id: configId } });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: userId,
    action: SsoAuditAction.ConfigDisabled,
    targetType: 'WorkspaceSsoConfig',
    targetId: configId,
    metadata: { revokedSessions, wasRequiringSso, deleted: true },
  } as any);

  return { deleted: true, revokedSessions };
}



/**
 * True if the user's verified email domain belongs to any workspace that requires SSO
 * and has that domain verified. Used to block password/social login paths when SSO is required.
 */
export async function isEmailDomainInRequireSsoWorkspace(
  db: PrismaClient,
  email: string,
): Promise<{ required: boolean; workspaceId?: string }> {
  const domain = normalizeDomain((email || '').split('@')[1] || '');
  if (!domain) return { required: false };

  const domains = await db.workspaceSsoDomain.findMany({
    where: { domain, verifiedAt: { not: null } },
    select: { workspaceId: true },
  });
  for (const d of domains) {
    const req = await checkRequireSso(db, d.workspaceId);
    if (req.required) return { required: true, workspaceId: d.workspaceId };
  }
  return { required: false };
}

export async function assertEmailNotInRequireSsoWorkspace(
  db: PrismaClient,
  email: string,
): Promise<void> {
  const { required, workspaceId } = await isEmailDomainInRequireSsoWorkspace(db, email);
  if (required) {
    throw new AppError(
      403,
      'SSO_REQUIRED',
      'This account must sign in using single sign-on (SSO).',
      workspaceId ? { details: { workspaceId } } : undefined,
    );
  }
}



export async function consumeBreakGlassCodeForLogin(
  db: PrismaClient,
  workspaceId: string,
  code: string,
  actorUserId: string,
  context: { ip?: string; userAgent?: string } = {},
): Promise<{ configId: string; remainingCodes: number }> {
  const config = await db.workspaceSsoConfig.findFirst({
    where: { workspaceId, requireSso: true, breakGlassEnabled: true, isEnabled: true },
  });
  if (!config) {
    throw new AppError(403, 'SSO_BREAK_GLASS_UNAVAILABLE', 'Break-glass access is not available');
  }

  const hashes = Array.isArray(config.breakGlassCodeHashes) ? (config.breakGlassCodeHashes as string[]) : [];
  const idx = hashes.findIndex((h) => safeCompare(h, hashSecret(code)));
  if (idx === -1) {
    await recordAuditEvent(db, {
      workspaceId,
      actorId: actorUserId,
      action: SsoAuditAction.BreakGlassFailed,
      targetType: 'WorkspaceSsoConfig',
      targetId: config.id,
      metadata: { reason: 'invalid_code' },
      ip: context.ip,
      userAgent: context.userAgent,
    } as any);
    throw new AppError(403, 'SSO_BREAK_GLASS_INVALID', 'Invalid break-glass code');
  }

  // One-time use: remove consumed hash
  hashes.splice(idx, 1);
  await db.workspaceSsoConfig.update({
    where: { id: config.id },
    data: { breakGlassCodeHashes: hashes as any },
  });

  await recordAuditEvent(db, {
    workspaceId,
    actorId: actorUserId,
    action: SsoAuditAction.BreakGlassUsed,
    targetType: 'WorkspaceSsoConfig',
    targetId: config.id,
    metadata: { remainingCodes: hashes.length, login: true },
    ip: context.ip,
    userAgent: context.userAgent,
  } as any);

  // Notify other owners
  try {
    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, ownerId: true } });
    const ownerMembers = await db.workspaceMembership.findMany({
      where: {
        workspaceId,
        status: 'ACTIVE',
        OR: [
          { role: 'OWNER' },
          { organizationRole: { in: ['COMPANY_OWNER', 'INSTITUTION_OWNER'] } },
        ],
      },
      select: { userId: true },
    });
    const ownerIds = new Set<string>(ownerMembers.map((m) => m.userId));
    if (workspace?.ownerId) ownerIds.add(workspace.ownerId);
    ownerIds.delete(actorUserId);
    for (const ownerId of ownerIds) {
      await createNotification(db, {
        userId: ownerId,
        type: 'SECURITY_ALERT' as any,
        title: 'SSO break-glass access used',
        body: `A break-glass recovery code was used to access workspace${workspace?.name ? ` "${workspace.name}"` : ''}.`,
        data: { workspaceId, actorUserId, configId: config.id },
      }).catch(() => undefined);
    }
  } catch {
    // notification failure must not block audited break-glass use
  }

  return { configId: config.id, remainingCodes: hashes.length };
}
