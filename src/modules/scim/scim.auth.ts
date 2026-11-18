import type { RequestHandler } from 'express';
import { getPrismaClient } from '../../db/prisma';
import { hashSecret } from '../../utils/crypto';
import { AppError } from '../../utils/errors';

/**
 * SCIM bearer-token authentication.
 *
 * SCIM provisioning is authenticated with per-workspace bearer tokens stored
 * in `ScimToken`. Only the token hash is persisted; the plaintext bearer
 * token is shown once at creation and never again. A token is scoped to
 * exactly one workspace, so every authenticated SCIM request is implicitly
 * workspace-scoped.
 *
 * The middleware resolves the token, checks that it is active and unexpired,
 * updates `lastUsedAt`, and attaches a `scim` context to the request. It does
 * not create or touch Nexus sessions.
 */

export interface ScimRequestContext {
  tokenId: string;
  workspaceId: string;
  userId: string;
  scopes: string[];
}

interface AuthenticatedRequest extends Request {
  scim?: ScimRequestContext;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

export function createScimAuth(): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = extractBearerToken(req.header('authorization'));
      if (!token) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'A SCIM bearer token is required');
      }

      const tokenHash = hashSecret(token);
      const scimToken = await getPrismaClient().scimToken.findUnique({
        where: { tokenHash },
        include: { workspace: true },
      });

      if (!scimToken) {
        throw new AppError(401, 'SCIM_TOKEN_INVALID', 'The SCIM token is not valid');
      }
      if (scimToken.status === 'REVOKED') {
        throw new AppError(401, 'SCIM_TOKEN_REVOKED', 'The SCIM token has been revoked');
      }
      if (
        scimToken.expiresAt !== null &&
        scimToken.expiresAt.getTime() <= Date.now()
      ) {
        throw new AppError(401, 'SCIM_TOKEN_EXPIRED', 'The SCIM token has expired');
      }
      if (!scimToken.workspace || scimToken.workspace.deletedAt) {
        throw new AppError(401, 'SCIM_WORKSPACE_UNAVAILABLE', 'The token workspace is unavailable');
      }

      await getPrismaClient().scimToken.update({
        where: { id: scimToken.id },
        data: { lastUsedAt: new Date() },
      });

      (req as unknown as AuthenticatedRequest).scim = {
        tokenId: scimToken.id,
        workspaceId: scimToken.workspaceId,
        userId: scimToken.userId,
        scopes: scimToken.scopes,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}
