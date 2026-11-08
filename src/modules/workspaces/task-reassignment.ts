import type { Prisma } from '@prisma/client';
import {
  ProjectCapability,
  projectRoleCan,
  workspaceRoleCanOnProject,
} from '../authorization/project.policy';
import { WorkspaceCapability, workspaceRoleCan } from '../authorization/workspace.policy';
import { recordAuditEvent, WorkspaceAuditAction } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';

export interface TaskAssignmentNotice {
  taskId: string;
  assigneeId: string;
}

export interface ReassignedTasksResult {
  taskCount: number;
  notices: TaskAssignmentNotice[];
}

/**
 * Moves active task assignments before a workspace membership is removed.
 * The task rows and project relationships remain in place; the audit event
 * records who held the assignment before and after the move.
 */
export async function reassignOpenTasksBeforeMemberRemoval(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorId: string;
    memberId: string;
    reassignToUserId?: string | undefined;
  },
): Promise<ReassignedTasksResult> {
  const assignments = await tx.taskAssignee.findMany({
    where: {
      userId: input.memberId,
      task: {
        deletedAt: null,
        status: { not: 'APPROVED' },
        project: {
          workspaceId: input.workspaceId,
          deletedAt: null,
          status: { notIn: ['COMPLETED', 'ARCHIVED'] },
        },
      },
    },
    select: {
      id: true,
      taskId: true,
      task: {
        select: {
          id: true,
          title: true,
          projectId: true,
          project: { select: { ownerId: true } },
        },
      },
    },
    orderBy: { taskId: 'asc' },
  });

  if (assignments.length === 0) {
    return { taskCount: 0, notices: [] };
  }

  if (!input.reassignToUserId) {
    throw new AppError(
      409,
      'TASK_REASSIGNMENT_REQUIRED',
      'Choose an eligible workspace member to receive this member’s active tasks before removing them',
      { details: { taskCount: assignments.length } },
    );
  }

  if (input.reassignToUserId === input.memberId) {
    throw new AppError(
      400,
      'INVALID_TASK_REASSIGNEE',
      'The member being removed cannot remain assigned to their tasks',
    );
  }

  const [actorMembership, replacementMembership] = await Promise.all([
    tx.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorId },
      },
      select: { role: true, status: true },
    }),
    tx.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.reassignToUserId,
        },
      },
      select: {
        role: true,
        status: true,
        user: { select: { status: true, deletedAt: true } },
      },
    }),
  ]);

  if (
    !actorMembership ||
    actorMembership.status !== 'ACTIVE' ||
    !workspaceRoleCan(actorMembership.role, WorkspaceCapability.ManageMembers)
  ) {
    throw new AppError(
      403,
      'WORKSPACE_ACCESS_DENIED',
      'You cannot remove members from this workspace',
    );
  }

  if (
    !replacementMembership ||
    replacementMembership.status !== 'ACTIVE' ||
    replacementMembership.user.status !== 'ACTIVE' ||
    replacementMembership.user.deletedAt
  ) {
    throw new AppError(
      403,
      'TASK_REASSIGNEE_NOT_ACTIVE_WORKSPACE_MEMBER',
      'The replacement assignee must be an active member of this workspace',
    );
  }

  const projectIds = [...new Set(assignments.map((assignment) => assignment.task.projectId))];
  const projects = await tx.project.findMany({
    where: {
      id: { in: projectIds },
      workspaceId: input.workspaceId,
      deletedAt: null,
      status: { notIn: ['COMPLETED', 'ARCHIVED'] },
    },
    select: { id: true, ownerId: true },
  });
  const projectMemberships = await tx.projectMembership.findMany({
    where: {
      projectId: { in: projects.map((project) => project.id) },
      userId: { in: [input.actorId, input.reassignToUserId] },
    },
    select: { projectId: true, userId: true, role: true },
  });
  const projectMembershipByUser = new Map(
    projectMemberships.map((membership) => [
      `${membership.projectId}:${membership.userId}`,
      membership,
    ]),
  );
  const projectById = new Map(projects.map((project) => [project.id, project]));

  for (const projectId of projectIds) {
    const project = projectById.get(projectId);
    if (!project) {
      throw new AppError(
        409,
        'TASK_PROJECT_UNAVAILABLE',
        'An affected task project is unavailable',
      );
    }

    const actorProjectMembership = projectMembershipByUser.get(`${projectId}:${input.actorId}`);
    const actorCanManageTasks =
      workspaceRoleCanOnProject(actorMembership.role, ProjectCapability.ManageTask) ||
      Boolean(
        actorProjectMembership &&
        projectRoleCan(actorProjectMembership.role, ProjectCapability.ManageTask),
      );

    if (!actorCanManageTasks) {
      throw new AppError(
        403,
        'TASK_REASSIGNMENT_FORBIDDEN',
        'You cannot reassign tasks in one of the affected projects',
      );
    }

    const replacementProjectMembership = projectMembershipByUser.get(
      `${projectId}:${input.reassignToUserId}`,
    );
    const replacementCanAccessProject =
      workspaceRoleCanOnProject(replacementMembership.role, ProjectCapability.ViewTasks) ||
      project.ownerId === input.reassignToUserId ||
      Boolean(
        replacementProjectMembership &&
        projectRoleCan(replacementProjectMembership.role, ProjectCapability.ViewTasks),
      );

    if (!replacementCanAccessProject) {
      throw new AppError(
        403,
        'TASK_REASSIGNEE_CANNOT_ACCESS_PROJECT',
        'The replacement assignee must have access to every affected project',
      );
    }
  }

  const notices: TaskAssignmentNotice[] = [];

  for (const assignment of assignments) {
    const removed = await tx.taskAssignee.deleteMany({
      where: { id: assignment.id, userId: input.memberId },
    });

    if (removed.count !== 1) {
      throw new AppError(
        409,
        'TASK_ASSIGNMENT_CHANGED',
        'An affected task assignment changed before the member could be removed',
      );
    }

    const created = await tx.taskAssignee.createMany({
      data: [
        {
          taskId: assignment.taskId,
          userId: input.reassignToUserId,
          assignedBy: input.actorId,
        },
      ],
      skipDuplicates: true,
    });

    await recordAuditEvent(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: WorkspaceAuditAction.TaskReassigned,
      targetType: 'Task',
      targetId: assignment.task.id,
      metadata: {
        projectId: assignment.task.projectId,
        previousAssigneeId: input.memberId,
        assigneeId: input.reassignToUserId,
        reason: 'workspace_member_removed',
        assigneeWasAlreadyAssigned: created.count === 0,
      },
    });

    if (created.count === 1) {
      await createNotification(tx, {
        userId: input.reassignToUserId,
        type: 'TASK_REASSIGNED',
        title: 'A task was reassigned to you',
        body: assignment.task.title,
        data: {
          workspaceId: input.workspaceId,
          projectId: assignment.task.projectId,
          taskId: assignment.task.id,
          previousAssigneeId: input.memberId,
        },
      });
      notices.push({ taskId: assignment.task.id, assigneeId: input.reassignToUserId });
    }
  }

  return { taskCount: assignments.length, notices };
}
