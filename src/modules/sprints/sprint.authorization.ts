import type { PrismaClient, Sprint } from '@prisma/client';
import { AppError } from '../../utils/errors';
import {
  resolveProjectAuthorization,
  type ProjectActor,
  type ProjectAuthorization,
} from '../authorization/project.authorization';

export type SprintAuthorizationClient = Pick<PrismaClient, 'sprint'> & {
  project: PrismaClient['project'];
  workspaceMembership: PrismaClient['workspaceMembership'];
  team: PrismaClient['team'];
  teamMembership: PrismaClient['teamMembership'];
  department: PrismaClient['department'];
  departmentMembership: PrismaClient['departmentMembership'];
  projectMembership: PrismaClient['projectMembership'];
  task: PrismaClient['task'];
  taskAssignee: PrismaClient['taskAssignee'];
  comment: PrismaClient['comment'];
  fileAttachment: PrismaClient['fileAttachment'];
  projectTeam?: PrismaClient['projectTeam'];
};

export interface SprintAuthorization {
  sprint: Sprint;
  authorization: ProjectAuthorization;
}

export async function resolveSprintAuthorization(
  client: SprintAuthorizationClient,
  actor: ProjectActor,
  workspaceId: string,
  projectId: string,
  sprintId: string,
): Promise<SprintAuthorization> {
  const sprint = await client.sprint.findFirst({
    where: {
      id: sprintId,
      projectId,
      project: { workspaceId, deletedAt: null },
    },
  });

  if (!sprint) {
    throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
  }

  const authorization = await resolveProjectAuthorization(client, actor, projectId);
  return { sprint, authorization };
}
