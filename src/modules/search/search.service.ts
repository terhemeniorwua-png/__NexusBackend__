import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  description: string | null;
  workspaceId: string;
  createdAt: string;
}

export function createSearchService(prisma: PrismaClient = getPrismaClient()) {
  async function getUserWorkspaceIds(userId: string): Promise<string[]> {
    const memberships = await prisma.workspaceMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { workspaceId: true },
    });
    return memberships.map((m) => m.workspaceId);
  }

  async function searchProjects(userId: string, q: string, workspaceIds: string[]): Promise<SearchResult[]> {
    const projects = await prisma.project.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { key: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: { id: true, name: true, description: true, workspaceId: true, createdAt: true },
    });
    return projects.map((p) => ({ id: p.id, type: 'project', title: p.name, description: p.description, workspaceId: p.workspaceId, createdAt: p.createdAt.toISOString() }));
  }

  async function searchTasks(userId: string, q: string, workspaceIds: string[]): Promise<SearchResult[]> {
    const tasks = await prisma.task.findMany({
      where: {
        project: { workspaceId: { in: workspaceIds }, deletedAt: null },
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

  async function searchDocuments(userId: string, q: string, workspaceIds: string[]): Promise<SearchResult[]> {
    const docs = await prisma.document.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
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

  async function searchFiles(userId: string, q: string, workspaceIds: string[]): Promise<SearchResult[]> {
    const files = await prisma.fileAttachment.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        fileName: { contains: q, mode: 'insensitive' },
      },
      take: 10,
      select: { id: true, fileName: true, workspaceId: true, createdAt: true },
    });
    return files.map((f) => ({ id: f.id, type: 'file', title: f.fileName, description: null, workspaceId: f.workspaceId, createdAt: f.createdAt.toISOString() }));
  }

  async function searchChannels(userId: string, q: string, workspaceIds: string[]): Promise<SearchResult[]> {
    const channels = await prisma.channel.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        name: { contains: q, mode: 'insensitive' },
      },
      take: 10,
      select: { id: true, name: true, workspaceId: true, createdAt: true },
    });
    return channels.map((c) => ({ id: c.id, type: 'channel', title: c.name, description: null, workspaceId: c.workspaceId, createdAt: c.createdAt.toISOString() }));
  }

  async function searchMeetings(userId: string, q: string, workspaceIds: string[]): Promise<SearchResult[]> {
    const meetings = await prisma.meeting.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: { id: true, title: true, description: true, workspaceId: true, createdAt: true },
    });
    return meetings.map((m) => ({ id: m.id, type: 'meeting', title: m.title, description: m.description, workspaceId: m.workspaceId ?? '', createdAt: m.createdAt.toISOString() }));
  }

  return {
    async search(userId: string, query: string, category: string, workspaceId?: string): Promise<SearchResult[]> {
      const allWorkspaceIds = await getUserWorkspaceIds(userId);
      const workspaceIds = workspaceId ? (allWorkspaceIds.includes(workspaceId) ? [workspaceId] : []) : allWorkspaceIds;
      if (workspaceIds.length === 0) return [];

      const searchers: Record<string, (uid: string, q: string, ws: string[]) => Promise<SearchResult[]>> = {
        projects: searchProjects,
        tasks: searchTasks,
        documents: searchDocuments,
        files: searchFiles,
        channels: searchChannels,
        meetings: searchMeetings,
      };

      if (category !== 'all' && searchers[category]) {
        return searchers[category](userId, query, workspaceIds);
      }

      const results = await Promise.all(Object.values(searchers).map((fn) => fn(userId, query, workspaceIds)));
      const merged = results.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return merged.slice(0, 25);
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
