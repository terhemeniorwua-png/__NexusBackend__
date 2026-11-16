import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { PrivateObjectStorage } from '../../services/storage/private-object-storage';
import { normalizeAvatarImage } from './avatar-image';
import type { UpdateProfileInput } from './users.schemas';
import { recordSecurityEvent, SecurityAction } from '../auth/security-events';

/**
 * Profile reads and updates.
 *
 * The email address and the account status are deliberately not editable
 * here: changing an address requires a verified email-change flow.
 */

export interface ProfileView {
  user: {
    id: string;
    email: string;
    name: string;
    status: string;
    emailVerifiedAt: Date | null;
    createdAt: Date;
  };
  profile: {
    bio: string | null;
    jobTitle: string | null;
    avatarUrl: string | null;
    timeZone: string;
    locale: string;
  };
}

/** Minimal response shape returned by the avatar upload and delete endpoints. */
export interface AvatarResult {
  avatarUrl: string | null;
}

export interface UsersService {
  getProfile(userId: string): Promise<ProfileView>;
  updateProfile(userId: string, input: UpdateProfileInput): Promise<ProfileView>;
  uploadAvatar(
    userId: string,
    input: Buffer,
    limits: { maxDimension: number; maxPixels: number },
    context?: { ip?: string; userAgent?: string },
  ): Promise<AvatarResult>;
  deleteAvatar(
    userId: string,
    context?: { ip?: string; userAgent?: string },
  ): Promise<AvatarResult>;
  getAvatar(userId: string): Promise<{ body: Buffer; contentType: string }>;
}

export function createUsersService(
  prisma?: PrismaClient,
  storage?: PrivateObjectStorage,
): UsersService {
  const client = prisma ?? getPrismaClient();

  function requireStorage(): PrivateObjectStorage {
    if (!storage)
      throw new AppError(
        503,
        'OBJECT_STORAGE_UNAVAILABLE',
        'Private object storage is not configured',
      );
    return storage;
  }

  async function deleteStoredObject(key: string): Promise<void> {
    try {
      await requireStorage().delete(key);
    } catch (error) {
      logger.warn('avatar_object_delete_failed', { error });
    }
  }

  /**
   * Derives the avatarUrl value that the API returns to the client.
   *
   * If the user has an uploaded avatar (stored via object storage), the
   * response returns the backend-proxied path so that a signed request is
   * always required to read the image. The path never changes between uploads;
   * cache-busting is achieved by the random UUID embedded in the storage key.
   *
   * Legacy URL avatars (set before file-upload was introduced) are returned
   * as-is until the user uploads or removes their avatar.
   */
  function resolveAvatarUrl(profile: {
    avatarStorageKey: string | null;
    avatarUrl: string | null;
  } | null | undefined): string | null {
    if (profile?.avatarStorageKey) {
      return '/api/v1/users/me/avatar';
    }
    return profile?.avatarUrl ?? null;
  }

  async function loadProfile(userId: string): Promise<ProfileView> {
    const user = await client.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user || user.deletedAt) {
      throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
      },
      profile: {
        bio: user.profile?.bio ?? null,
        jobTitle: user.profile?.jobTitle ?? null,
        avatarUrl: resolveAvatarUrl(user.profile),
        timeZone: user.profile?.timeZone ?? 'UTC',
        locale: user.profile?.locale ?? 'en',
      },
    };
  }

  return {
    async getProfile(userId: string): Promise<ProfileView> {
      return loadProfile(userId);
    },

    async updateProfile(userId: string, input: UpdateProfileInput): Promise<ProfileView> {
      const existing = await client.user.findUnique({
        where: { id: userId },
        include: { profile: true },
      });

      if (!existing || existing.deletedAt) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      }

      const profileFields = {
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
        ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      };

      await client.$transaction(async (tx) => {
        if (input.name !== undefined) {
          await tx.user.update({
            where: { id: userId },
            data: { name: input.name },
          });
        }

        if (Object.keys(profileFields).length > 0) {
          await tx.userProfile.upsert({
            where: { userId },
            update: profileFields,
            create: { userId, ...profileFields },
          });
        }
      });

      return loadProfile(userId);
    },

    async uploadAvatar(userId, input, limits, context): Promise<AvatarResult> {
      // Normalise to WebP, strip EXIF, enforce dimension limits.
      const normalized = await normalizeAvatarImage(input, limits);

      // Always store as .webp — the normalizeAvatarImage function always
      // re-encodes to WebP regardless of input format.
      const objectKey = `avatars/${userId}/${randomUUID()}.webp`;

      const previous = await client.userProfile.findUnique({
        where: { userId },
        select: { avatarStorageKey: true },
      });

      await requireStorage().put({
        key: objectKey,
        body: normalized.body,
        contentType: normalized.contentType,
      });

      try {
        await client.userProfile.upsert({
          where: { userId },
          update: { avatarStorageKey: objectKey, avatarUrl: null },
          create: { userId, avatarStorageKey: objectKey },
        });
      } catch (error) {
        // Roll back the uploaded object so the bucket stays clean.
        await deleteStoredObject(objectKey);
        throw error;
      }

      // Best-effort: delete the previous avatar object after the DB row has
      // been committed. A failed delete must never fail the request.
      if (previous?.avatarStorageKey) {
        await deleteStoredObject(previous.avatarStorageKey);
      }

      // Record a best-effort audit event. Failures must not fail the request.
      await recordSecurityEvent(client, {
        action: SecurityAction.ProfileAvatarUploaded,
        targetType: 'User',
        targetId: userId,
        actorId: userId,
        ip: context?.ip,
        userAgent: context?.userAgent,
      });

      // Return the narrow shape the API contract specifies.
      return { avatarUrl: '/api/v1/users/me/avatar' };
    },

    async deleteAvatar(userId, context): Promise<AvatarResult> {
      const profile = await client.userProfile.findUnique({
        where: { userId },
        select: { avatarStorageKey: true },
      });

      if (!profile) return { avatarUrl: null };

      await client.userProfile.update({
        where: { userId },
        data: { avatarStorageKey: null, avatarUrl: null },
      });

      if (profile.avatarStorageKey) {
        await deleteStoredObject(profile.avatarStorageKey);
      }

      // Record a best-effort audit event.
      await recordSecurityEvent(client, {
        action: SecurityAction.ProfileAvatarDeleted,
        targetType: 'User',
        targetId: userId,
        actorId: userId,
        ip: context?.ip,
        userAgent: context?.userAgent,
      });

      return { avatarUrl: null };
    },

    async getAvatar(userId) {
      const profile = await client.userProfile.findUnique({
        where: { userId },
        select: { avatarStorageKey: true },
      });
      if (!profile?.avatarStorageKey)
        throw new AppError(404, 'AVATAR_NOT_FOUND', 'No profile image is available');
      return requireStorage().get(profile.avatarStorageKey);
    },
  };
}
