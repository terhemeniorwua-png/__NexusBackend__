import type { Prisma, PrismaClient, WorkspaceRole } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import {
  ProjectCapability,
  requireProjectAccess,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from '../authorization';
import { projectVisibleToUser } from '../projects/project-visibility';
import type { AiSourceReference } from '../../services/providers/ai';

/**
 * Authorised AI context preparation (Phase 21).
 *
 * The AI service never reads the Nexus database and never evaluates a
 * permission. Express resolves the caller's membership, applies project
 * visibility and produces a bounded set of source excerpts. Only those
 * excerpts are sent to the AI service.
 *
 * If a resource is not visible to the caller, it is treated as if it did not
 * exist: the caller gets a 404 rather than a hint that the identifier is
 * valid.
 */

export interface AiContextInput {
  userId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  documentId?: string | null;
  meetingId?: string | null;
  query?: string | null;
}

export interface AiContextResult {
  workspaceId: string | null;
  sources: AiSourceReference[];
  /** Labelled plain-text context, already capped at `aiMaxContextChars`. */
  text: string;
}

const MAX_SOURCE_SNIPPET = 2_000;
const MAX_SOURCES = 20;

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function label(value: string): string {
  return value.replace(/[_-]/g, ' ').toLowerCase();
}

export function createAiContextService(
  config: Pick<AppConfig, 'aiMaxContextChars'>,
  prisma: PrismaClient = getPrismaClient(),
) {
  async function personalSources(userId: string): Promise<AiSourceReference[]> {
    const memberships = await prisma.workspaceMembership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        workspace: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        role: true,
        organizationRole: true,
        workspace: { select: { id: true, name: true, type: true } },
      },
      take: 20,
    });

    return memberships.map((membership) => ({
      type: 'workspace',
      id: membership.workspace.id,
      title: membership.workspace.name,
      workspaceId: membership.workspace.id,
      snippet: `Workspace type: ${label(membership.workspace.type)}. Your role: ${label(
        membership.role,
      )}.`,
    }));
  }

  return {
    async build(input: AiContextInput): Promise<AiContextResult> {
      const sources: AiSourceReference[] = [];
      const add = (source: AiSourceReference) => {
        if (sources.length < MAX_SOURCES) sources.push(source);
      };

      if (!input.workspaceId) {
        for (const source of await personalSources(input.userId)) add(source);
        return {
          workspaceId: null,
          sources,
          text: renderContext(sources, config.aiMaxContextChars),
        };
      }

      const access = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const unrestricted =
        !access.membership.organizationRole &&
        (access.effectiveRole === 'OWNER' || access.effectiveRole === 'PROJECT_MANAGER');

      add({
        type: 'workspace',
        id: access.workspace.id,
        title: access.workspace.name,
        workspaceId: access.workspace.id,
        snippet: [
          `Workspace type: ${label(access.workspace.type)}.`,
          `Your role: ${label(access.effectiveRole)}.`,
          access.workspace.description
            ? `Description: ${truncate(access.workspace.description, 500)}`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      });

      const visibleProjectWhere = (): Prisma.ProjectWhereInput => ({
        workspaceId: access.workspace.id,
        deletedAt: null,
        ...(unrestricted ? {} : { AND: [{ OR: [projectVisibleToUser(input.userId)] }] }),
      });

      const scopedProjectId = input.projectId ?? null;
      let scopedProject: { id: string; name: string; key: string } | null = null;

      if (scopedProjectId) {
        const projectAccess = await requireProjectAccess(prisma, {
          userId: input.userId,
          workspaceId: access.workspace.id,
          projectId: scopedProjectId,
          workspaceRole: access.effectiveRole,
          capability: ProjectCapability.ViewProject,
        });
        scopedProject = {
          id: projectAccess.project.id,
          name: projectAccess.project.name,
          key: projectAccess.project.key,
        };
      }

      const projects = await prisma.project.findMany({
        where: scopedProjectId ? { id: scopedProjectId, deletedAt: null } : visibleProjectWhere(),
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          status: true,
          visibility: true,
          dueDate: true,
          _count: { select: { tasks: true, documents: true, meetings: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: scopedProjectId ? 1 : 10,
      });

      for (const project of projects) {
        add({
          type: 'project',
          id: project.id,
          title: project.name,
          workspaceId: access.workspace.id,
          projectId: project.id,
          snippet: [
            `Project key: ${project.key}. Status: ${label(project.status)}.`,
            `Visibility: ${label(project.visibility)}.`,
            `Tasks: ${project._count.tasks}. Documents: ${project._count.documents}. Meetings: ${project._count.meetings}.`,
            project.dueDate ? `Due: ${project.dueDate.toISOString().slice(0, 10)}.` : '',
            project.description ? `Description: ${truncate(project.description, 700)}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }

      if (input.taskId) {
        if (!scopedProject) {
          throw new AppError(
            400,
            'AI_CONTEXT_PROJECT_REQUIRED',
            'A projectId is required when a taskId is supplied',
          );
        }
        const task = await prisma.task.findFirst({
          where: { id: input.taskId, projectId: scopedProject.id, deletedAt: null },
          select: {
            id: true,
            key: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            dueDate: true,
            assignees: { select: { user: { select: { name: true } } } },
            comments: {
              where: { deletedAt: null },
              select: { body: true, author: { select: { name: true } } },
              orderBy: { createdAt: 'desc' },
              take: 5,
            },
          },
        });
        if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

        add({
          type: 'task',
          id: task.id,
          title: `${task.key} ${task.title}`,
          workspaceId: access.workspace.id,
          projectId: scopedProject.id,
          snippet: [
            `Status: ${label(task.status)}. Priority: ${label(task.priority)}.`,
            task.dueDate ? `Due: ${task.dueDate.toISOString().slice(0, 10)}.` : '',
            task.assignees.length
              ? `Assignees: ${task.assignees.map((a) => a.user.name).join(', ')}.`
              : 'Unassigned.',
            task.description ? `Description: ${truncate(task.description, 1_200)}` : '',
            task.comments.length
              ? `Recent comments: ${task.comments
                  .map((comment) => `${comment.author.name}: ${truncate(comment.body, 200)}`)
                  .join(' | ')}`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      } else if (scopedProjectId) {
        const tasks = await prisma.task.findMany({
          where: { projectId: scopedProjectId, deletedAt: null },
          select: { id: true, key: true, title: true, status: true, priority: true, dueDate: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 10,
        });
        for (const task of tasks) {
          add({
            type: 'task',
            id: task.id,
            title: `${task.key} ${task.title}`,
            workspaceId: access.workspace.id,
            projectId: scopedProjectId,
            snippet: `Status: ${label(task.status)}. Priority: ${label(task.priority)}.${
              task.dueDate ? ` Due: ${task.dueDate.toISOString().slice(0, 10)}.` : ''
            }`,
          });
        }
      }

      if (input.documentId) {
        const document = await prisma.document.findFirst({
          where: {
            id: input.documentId,
            workspaceId: access.workspace.id,
            deletedAt: null,
          },
          select: {
            id: true,
            title: true,
            content: true,
            projectId: true,
            taskId: true,
            author: { select: { name: true } },
          },
        });
        if (!document)
          throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'That document does not exist');

        if (document.projectId) {
          await requireProjectAccess(prisma, {
            userId: input.userId,
            workspaceId: access.workspace.id,
            projectId: document.projectId,
            workspaceRole: access.effectiveRole,
            capability: ProjectCapability.ViewProject,
          });
        }

        add({
          type: 'document',
          id: document.id,
          title: document.title,
          workspaceId: access.workspace.id,
          projectId: document.projectId ?? undefined,
          snippet: `Author: ${document.author.name}. Content: ${truncate(
            document.content,
            MAX_SOURCE_SNIPPET,
          )}`,
        });
      }

      if (input.meetingId) {
        const meeting = await prisma.meeting.findFirst({
          where: {
            id: input.meetingId,
            workspaceId: access.workspace.id,
            deletedAt: null,
          },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            scheduledAt: true,
            createdById: true,
            projectId: true,
            participants: { select: { userId: true, user: { select: { name: true } } } },
          },
        });
        if (!meeting) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');

        const isParticipant = meeting.participants.some(
          (participant) => participant.userId === input.userId,
        );
        if (!unrestricted && !isParticipant && meeting.createdById !== input.userId) {
          throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
        }
        if (meeting.projectId) {
          await requireProjectAccess(prisma, {
            userId: input.userId,
            workspaceId: access.workspace.id,
            projectId: meeting.projectId,
            workspaceRole: access.effectiveRole,
            capability: ProjectCapability.ViewProject,
          });
        }

        add({
          type: 'meeting',
          id: meeting.id,
          title: meeting.title,
          workspaceId: access.workspace.id,
          projectId: meeting.projectId ?? undefined,
          snippet: [
            `Status: ${label(meeting.status)}.`,
            meeting.scheduledAt ? `Scheduled: ${meeting.scheduledAt.toISOString()}.` : '',
            `Participants: ${meeting.participants.map((p) => p.user.name).join(', ') || 'none'}.`,
            meeting.description ? `Description: ${truncate(meeting.description, 1_000)}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }

      if (input.query?.trim()) {
        const needle = input.query.trim().slice(0, 200);

        const [taskMatches, documentMatches] = await Promise.all([
          prisma.task.findMany({
            where: {
              deletedAt: null,
              project: {
                workspaceId: access.workspace.id,
                deletedAt: null,
                ...(unrestricted ? {} : { AND: [{ OR: [projectVisibleToUser(input.userId)] }] }),
              },
              OR: [
                { title: { contains: needle, mode: 'insensitive' } },
                { description: { contains: needle, mode: 'insensitive' } },
              ],
            },
            select: {
              id: true,
              key: true,
              title: true,
              status: true,
              description: true,
              projectId: true,
            },
            take: 5,
          }),
          prisma.document.findMany({
            where: {
              workspaceId: access.workspace.id,
              deletedAt: null,
              OR: [
                { title: { contains: needle, mode: 'insensitive' } },
                { content: { contains: needle, mode: 'insensitive' } },
              ],
              AND: [
                unrestricted
                  ? {}
                  : {
                      OR: [
                        { projectId: null },
                        {
                          project: {
                            deletedAt: null,
                            AND: [{ OR: [projectVisibleToUser(input.userId)] }],
                          },
                        },
                      ],
                    },
              ],
            },
            select: { id: true, title: true, content: true, projectId: true },
            take: 5,
          }),
        ]);

        for (const task of taskMatches) {
          add({
            type: 'task',
            id: task.id,
            title: `${task.key} ${task.title}`,
            workspaceId: access.workspace.id,
            projectId: task.projectId,
            snippet: `Status: ${label(task.status)}. ${truncate(task.description, 500)}`,
          });
        }

        for (const document of documentMatches) {
          add({
            type: 'document',
            id: document.id,
            title: document.title,
            workspaceId: access.workspace.id,
            projectId: document.projectId ?? undefined,
            snippet: truncate(document.content, 800),
          });
        }
      }

      return {
        workspaceId: access.workspace.id,
        sources,
        text: renderContext(sources, config.aiMaxContextChars),
      };
    },
  };
}

export function renderContext(sources: AiSourceReference[], maxChars: number): string {
  const lines = sources.map(
    (source) =>
      `[${source.type}:${source.id}] ${source.title}\n${truncate(source.snippet, MAX_SOURCE_SNIPPET)}`,
  );
  const joined = lines.join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

/** Exported for tests that need a stable role label. */
export function describeRole(role: WorkspaceRole): string {
  return label(role);
}
