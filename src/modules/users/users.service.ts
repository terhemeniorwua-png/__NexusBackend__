import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
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
}

export function createUsersService(prisma?: PrismaClient): UsersService {
  const client = prisma ?? getPrismaClient();

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
        avatarUrl: user.profile?.avatarUrl ?? null,
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
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
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
  };
}
