import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { effectiveWorkspaceRole, isOrganizationRoleForWorkspace } from '../authorization/organization-role';
import { projectVisibleToUser } from '../projects/project-visibility';

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  description: string | null;
  workspaceId: string;
  createdAt: string;
}

interface SearchScope {
  workspaceIds: string[];
  /** Legacy workspace managers bypass private project membership checks. */
  unrestricted: string[];
  /** Effective managers can inspect archived channels while their parents remain active. */
  managers: string[];
  /** Collaborators cannot see workspace-wide channels. */
  workspaceChannelIds: string[];
}

export function createSearchService(prisma: PrismaClient = getPrismaClient()) {
  async function getUserScope(userId: string): Promise<SearchScope> {
    const rows = await prisma.workspaceMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: {
        workspaceId: true,
        role: true,
        organizationRole: true,
        workspace: { select: { type: true, status: true, deletedAt: true } },
      },
    });
    const activeRows = rows.filter(
      (membership) => membership.workspace.status === 'ACTIVE' && membership.workspace.deletedAt === null &&
        (!membership.organizationRole || isOrganizationRoleForWorkspace(membership.workspace.type, membership.organizationRole)),
    );
    const managers = activeRows
      .filter((m) => {
        const eff = effectiveWorkspaceRole(m.workspace.type, m.role, m.organizationRole);
        return eff === 'OWNER' || eff === 'PROJECT_MANAGER';
      })
      .map((m) => m.workspaceId);
    const unrestricted = activeRows
      .filter((m) => managers.includes(m.workspaceId) && !m.organizationRole)
      .map((m) => m.workspaceId);
    const workspaceChannelIds = activeRows
      .filter((m) => effectiveWorkspaceRole(m.workspace.type, m.role, m.organizationRole) !== 'COLLABORATOR')
      .map((m) => m.workspaceId);
    return { workspaceIds: activeRows.map((m) => m.workspaceId), unrestricted, managers, workspaceChannelIds };
  }

  const visibleProject = (userId: string, scope: SearchScope): Prisma.ProjectWhereInput => ({
    OR: [{ workspaceId: { in: scope.unrestricted } }, projectVisibleToUser(userId)],
  });

  async function searchProjects(userId: string, q: string, scope: SearchScope): Promise<SearchResult[]> {
    const projects = await prisma.project.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        AND: [
          visibleProject(userId, scope),
          {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
              { key: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: 10,
      select: { id: true, name: true, description: true, workspaceId: true, createdAt: true },
    });
    return projects.map((p) => ({ id: p.id, type: 'project', title: p.name, description: p.description, workspaceId: p.workspaceId, createdAt: p.createdAt.toISOString() }));
  }

  async function searchTasks(userId: string, q: string, scope: SearchScope): Promise<SearchResult[]> {
    const tasks = await prisma.task.findMany({
      where: {
        project: {
          is: {
            workspaceId: { in: scope.workspaceIds },
            deletedAt: null,
            AND: [visibleProject(userId, scope)],
          },
        },
        deletedAt: null,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: { id: true, title: true, description: true, project: { select: { workspaceId: true } }, createdAt: true },
    });
    return tasks.map((t) => ({ id: t.id, type: 'task', title: t.title, description: t.description, workspaceId: t.project.workspaceId, createdAt: t.createdAt.toISOString() }));
  }

  async function searchDocuments(userId: string, q: string, scope: SearchScope): Promise<SearchResult[]> {
    const visible = visibleProject(userId, scope);
    const docs = await prisma.document.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        AND: [
          { OR: [{ projectId: null }, { project: { is: visible } }] },
          { OR: [{ taskId: null }, { task: { is: { project: { is: visible } } } }] },
        ],
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { content: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: { id: true, title: true, workspaceId: true, createdAt: true },
    });
    return docs.map((d) => ({ id: d.id, type: 'document', title: d.title, description: null, workspaceId: d.workspaceId, createdAt: d.createdAt.toISOString() }));
  }

  async function searchFiles(userId: string, q: string, scope: SearchScope): Promise<SearchResult[]> {
    const visible = visibleProject(userId, scope);
    const files = await prisma.fileAttachment.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        fileName: { contains: q, mode: 'insensitive' },
        AND: [
          {
            OR: [
              { projectId: null, taskId: null, commentId: null },
              { project: { is: visible } },
              { task: { is: { project: { is: visible } } } },
              { comment: { is: { task: { is: { project: { is: visible } } } } } },
            ],
          },
        ],
      },
      take: 10,
      select: { id: true, fileName: true, workspaceId: true, createdAt: true },
    });
    return files.map((f) => ({ id: f.id, type: 'file', title: f.fileName, description: null, workspaceId: f.workspaceId, createdAt: f.createdAt.toISOString() }));
  }

  async function searchChannels(userId: string, q: string, scope: SearchScope): Promise<SearchResult[]> {
    const managers = scope.managers;
    const channels = await prisma.channel.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        AND: [
          { OR: [{ archivedAt: null }, { workspaceId: { in: managers } }] },
          { OR: [
            { type: 'WORKSPACE', workspaceId: { in: scope.workspaceChannelIds } },
            { type: 'PRIVATE', memberships: { some: { userId } } },
            { type: 'TEAM', OR: [
              { workspaceId: { in: scope.unrestricted } },
              { team: { is: { status: 'ACTIVE', deletedAt: null, members: { some: { userId } } } } },
            ], team: { is: { status: 'ACTIVE', deletedAt: null } } },
            { type: 'DEPARTMENT', OR: [
              { workspaceId: { in: managers } },
              { department: { is: { members: { some: { userId } } } } },
            ] },
            { type: 'PROJECT', OR: [
              { workspaceId: { in: scope.unrestricted } },
              { project: { is: visibleProject(userId, scope) } },
            ], project: { is: { deletedAt: null, status: { not: 'ARCHIVED' } } } },
          ] },
        ],
        name: { contains: q, mode: 'insensitive' },
      },
      take: 10,
      select: { id: true, name: true, workspaceId: true, createdAt: true },
    });
    return channels.map((c) => ({ id: c.id, type: 'channel', title: c.name, description: null, workspaceId: c.workspaceId, createdAt: c.createdAt.toISOString() }));
  }

  async function searchMeetings(userId: string, q: string, scope: SearchScope): Promise<SearchResult[]> {
    const meetings = await prisma.meeting.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        AND: [
          { OR: [{ projectId: null }, { project: { is: visibleProject(userId, scope) } }] },
          {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: 10,
      select: { id: true, title: true, description: true, workspaceId: true, createdAt: true },
    });
    return meetings.map((m) => ({ id: m.id, type: 'meeting', title: m.title, description: m.description, workspaceId: m.workspaceId ?? '', createdAt: m.createdAt.toISOString() }));
  }

  return {
    async search(userId: string, query: string, category: string, workspaceId?: string): Promise<SearchResult[]> {
      const full = await getUserScope(userId);
      const workspaceIds = workspaceId ? (full.workspaceIds.includes(workspaceId) ? [workspaceId] : []) : full.workspaceIds;
      if (workspaceIds.length === 0) return [];
      const scope: SearchScope = {
        workspaceIds,
        unrestricted: full.unrestricted.filter((id) => workspaceIds.includes(id)),
        managers: full.managers.filter((id) => workspaceIds.includes(id)),
        workspaceChannelIds: full.workspaceChannelIds.filter((id) => workspaceIds.includes(id)),
      };

      const searchers: Record<string, (uid: string, q: string, s: SearchScope) => Promise<SearchResult[]>> = {
        projects: searchProjects,
        tasks: searchTasks,
        documents: searchDocuments,
        files: searchFiles,
        channels: searchChannels,
        meetings: searchMeetings,
      };

      if (category !== 'all' && searchers[category]) {
        return searchers[category](userId, query, scope);
      }

      const results = await Promise.all(Object.values(searchers).map((fn) => fn(userId, query, scope)));
      const merged = results.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return merged.slice(0, 25);
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
