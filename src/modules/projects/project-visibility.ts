import type { Prisma } from '@prisma/client';

/**
 * Single source of truth for "which projects can this user see".
 * Used by the project list, search, meetings and calendar so the rule can't drift.
 * Callers with an unrestricted legacy-manager role in a workspace must bypass this
 * filter for that workspace themselves.
 */
export function projectVisibleToUser(userId: string): Prisma.ProjectWhereInput {
  const teamMemberAccess: Prisma.ProjectWhereInput = {
    AND: [
      { visibility: 'DEPARTMENT_TEAM' },
      {
        OR: [
          {
            team: {
              is: {
                status: 'ACTIVE',
                deletedAt: null,
                members: { some: { userId } },
              },
            },
          },
          {
            projectTeams: {
              some: {
                team: {
                  is: {
                    status: 'ACTIVE',
                    deletedAt: null,
                    members: { some: { userId } },
                  },
                },
              },
            },
          },
        ],
      },
    ],
  };

  return {
    OR: [
      { visibility: 'WORKSPACE' },
      { ownerId: userId },
      { members: { some: { userId } } },
      teamMemberAccess,
      {
        AND: [
          { visibility: 'DEPARTMENT_TEAM' },
          { teamId: null },
          { projectTeams: { none: {} } },
          { department: { is: { members: { some: { userId } } } } },
        ],
      },
    ],
  };
}
