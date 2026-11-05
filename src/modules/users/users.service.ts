import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { PrivateObjectStorage } from '../../services/storage/private-object-storage';
import { normalizeAvatarImage } from './avatar-image';
import type { UpdateProfileInput } from './users.schemas';

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

export interface UsersService {
  getProfile(userId: string): Promise<ProfileView>;
  updateProfile(userId: string, input: UpdateProfileInput): Promise<ProfileView>;
  uploadAvatar(
    userId: string,
    input: Buffer,
    limits: { maxDimension: number; maxPixels: number },
  ): Promise<ProfileView>;
  deleteAvatar(userId: string): Promise<ProfileView>;
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
        avatarUrl: user.profile?.avatarStorageKey
          ? '/api/v1/users/me/avatar'
          : (user.profile?.avatarUrl ?? null),
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

    async uploadAvatar(userId, input, limits) {
      const normalized = await normalizeAvatarImage(input, limits);
      const objectKey = `avatars/${userId}/${randomUUID()}.${normalized.format === 'jpeg' ? 'jpg' : normalized.format}`;
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
        await deleteStoredObject(objectKey);
        throw error;
      }
      if (previous?.avatarStorageKey) await deleteStoredObject(previous.avatarStorageKey);
      return loadProfile(userId);
    },

    async deleteAvatar(userId) {
      const profile = await client.userProfile.findUnique({
        where: { userId },
        select: { avatarStorageKey: true },
      });
      if (!profile) return loadProfile(userId);
      await client.userProfile.update({
        where: { userId },
        data: { avatarStorageKey: null, avatarUrl: null },
      });
      if (profile.avatarStorageKey) await deleteStoredObject(profile.avatarStorageKey);
      return loadProfile(userId);
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
