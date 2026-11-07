import type { Prisma } from '@prisma/client';

/**
 * Single source of truth for "which projects can this user see".
 * Used by the project list, search, meetings and calendar so the rule can't drift.
 * Callers with an unrestricted legacy-manager role in a workspace must bypass this
 * filter for that workspace themselves.
 */
export function projectVisibleToUser(userId: string): Prisma.ProjectWhereInput {
  return {
    OR: [
      { visibility: 'WORKSPACE' },
      { ownerId: userId },
      { members: { some: { userId } } },
      {
        AND: [
          { visibility: 'DEPARTMENT_TEAM' },
          {
            team: {
              is: {
                status: 'ACTIVE',
                deletedAt: null,
                members: { some: { userId } },
              },
            },
          },
        ],
      },
      {
        AND: [
          { visibility: 'DEPARTMENT_TEAM' },
          { teamId: null },
          { department: { is: { members: { some: { userId } } } } },
        ],
      },
    ],
  };
}
