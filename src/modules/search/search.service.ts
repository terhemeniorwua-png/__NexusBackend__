import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { logger } from '../../utils/logger';
import {
  effectiveWorkspaceRole,
  isOrganizationRoleForWorkspace,
} from '../authorization/organization-role';
import { projectVisibleToUser } from '../projects/project-visibility';

/**
 * Central search service (Phase 18).
 *
 * Search is evaluated at query time against the authoritative tables. There is
 * no separate search index to fall out of sync: creating, editing, deleting or
 * changing the visibility of a resource is immediately reflected, and every
 * query is filtered by the caller's current membership. PostgreSQL trigram and
 * full-text indexes (see the Phase 18 migration) accelerate the text match.
 *
 * Permission model:
 * - Only workspaces with an ACTIVE membership and an ACTIVE, non-deleted
 *   workspace are in scope.
 * - Projects use the shared `projectVisibleToUser` rule.
 * - Messages/conversations inherit the channel visibility rule.
 * - People are only returned when the caller shares an active workspace.
 */

export type SearchCategory =
  | 'all'
  | 'people'
  | 'workspaces'
  | 'teams'
  | 'departments'
  | 'projects'
  | 'tasks'
  | 'messages'
  | 'conversations'
  | 'files'
  | 'documents'
  | 'meetings'
  | 'channels'
  | 'announcements';

export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  'all',
  'people',
  'workspaces',
  'teams',
  'departments',
  'projects',
  'tasks',
  'messages',
  'conversations',
  'files',
  'documents',
  'meetings',
  'channels',
  'announcements',
];

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  description: string | null;
  workspaceId: string;
  createdAt: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  query: string;
  category?: SearchCategory;
  workspaceId?: string;
  page?: number;
  limit?: number;
  sort?: 'relevance' | 'recent';
}

export interface SearchPage {
  results: SearchResult[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  category: SearchCategory;
}

export interface SearchSuggestion {
  id: string;
  type: string;
  title: string;
  workspaceId: string;
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

const PER_CATEGORY_LIMIT = 100;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 25;
const MAX_HISTORY = 20;

function snippet(value: string | null | undefined, length = 200): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= length) return trimmed;
  return `${trimmed.slice(0, length - 1)}…`;
}

function recencyScore(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
  return Math.max(0, 10 - ageDays / 30);
}

/**
 * Relevance: exact title, prefix and substring matches rank above description
 * matches, and newer resources receive a small tie-breaking bonus.
 */
export function scoreResult(result: SearchResult, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return recencyScore(result.createdAt);
  const title = result.title.toLowerCase();
  let score = 10;
  if (title === needle) score = 100;
  else if (title.startsWith(needle)) score = 80;
  else if (title.includes(needle)) score = 60;
  if (result.description?.toLowerCase().includes(needle)) score += 15;
  return score + recencyScore(result.createdAt);
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
      (membership) =>
        membership.workspace.status === 'ACTIVE' &&
        membership.workspace.deletedAt === null &&
        (!membership.organizationRole ||
          isOrganizationRoleForWorkspace(membership.workspace.type, membership.organizationRole)),
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
      .filter(
        (m) =>
          effectiveWorkspaceRole(m.workspace.type, m.role, m.organizationRole) !== 'COLLABORATOR',
      )
      .map((m) => m.workspaceId);
    return {
      workspaceIds: activeRows.map((m) => m.workspaceId),
      unrestricted,
      managers,
      workspaceChannelIds,
    };
  }

  const visibleProject = (userId: string, scope: SearchScope): Prisma.ProjectWhereInput => ({
    OR: [{ workspaceId: { in: scope.unrestricted } }, projectVisibleToUser(userId)],
  });

  const visibleChannelWhere = (userId: string, scope: SearchScope): Prisma.ChannelWhereInput => ({
    workspaceId: { in: scope.workspaceIds },
    deletedAt: null,
    AND: [
      { OR: [{ archivedAt: null }, { workspaceId: { in: scope.managers } }] },
      {
        OR: [
          { type: 'WORKSPACE', workspaceId: { in: scope.workspaceChannelIds } },
          { type: 'PRIVATE', memberships: { some: { userId } } },
          {
            type: 'TEAM',
            OR: [
              { workspaceId: { in: scope.unrestricted } },
              {
                team: { is: { status: 'ACTIVE', deletedAt: null, members: { some: { userId } } } },
              },
            ],
            team: { is: { status: 'ACTIVE', deletedAt: null } },
          },
          {
            type: 'DEPARTMENT',
            OR: [
              { workspaceId: { in: scope.managers } },
              { department: { is: { members: { some: { userId } } } } },
            ],
          },
          {
            type: 'PROJECT',
            OR: [
              { workspaceId: { in: scope.unrestricted } },
              { project: { is: visibleProject(userId, scope) } },
            ],
            project: { is: { deletedAt: null, status: { not: 'ARCHIVED' } } },
          },
        ],
      },
    ],
  });

  async function searchPeople(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const memberships = await prisma.workspaceMembership.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        status: 'ACTIVE',
        user: {
          deletedAt: null,
          status: 'ACTIVE',
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
      take,
      select: {
        workspaceId: true,
        user: { select: { id: true, name: true, email: true, createdAt: true } },
      },
    });

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const membership of memberships) {
      const person = membership.user;
      if (seen.has(person.id)) continue;
      seen.add(person.id);
      results.push({
        id: person.id,
        type: 'person',
        title: person.name,
        description: person.email,
        workspaceId: membership.workspaceId,
        createdAt: person.createdAt.toISOString(),
      });
    }
    return results;
  }

  async function searchWorkspaces(
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await prisma.workspace.findMany({
      where: {
        id: { in: scope.workspaceIds },
        status: 'ACTIVE',
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { slug: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take,
      select: { id: true, name: true, description: true, createdAt: true },
    });
    return rows.map((w) => ({
      id: w.id,
      type: 'workspace',
      title: w.name,
      description: w.description,
      workspaceId: w.id,
      createdAt: w.createdAt.toISOString(),
    }));
  }

  async function searchTeams(q: string, scope: SearchScope, take: number): Promise<SearchResult[]> {
    const rows = await prisma.team.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        status: 'ACTIVE',
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take,
      select: { id: true, name: true, description: true, workspaceId: true, createdAt: true },
    });
    return rows.map((t) => ({
      id: t.id,
      type: 'team',
      title: t.name,
      description: t.description,
      workspaceId: t.workspaceId,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async function searchDepartments(
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await prisma.department.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        name: { contains: q, mode: 'insensitive' },
      },
      take,
      select: { id: true, name: true, workspaceId: true, createdAt: true },
    });
    return rows.map((d) => ({
      id: d.id,
      type: 'department',
      title: d.name,
      description: null,
      workspaceId: d.workspaceId,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  async function searchProjects(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
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
      take,
      select: { id: true, name: true, description: true, workspaceId: true, createdAt: true },
    });
    return projects.map((p) => ({
      id: p.id,
      type: 'project',
      title: p.name,
      description: p.description,
      workspaceId: p.workspaceId,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async function searchTasks(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
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
          { key: { contains: q, mode: 'insensitive' } },
        ],
      },
      take,
      select: {
        id: true,
        title: true,
        description: true,
        project: { select: { workspaceId: true } },
        createdAt: true,
      },
    });
    return tasks.map((t) => ({
      id: t.id,
      type: 'task',
      title: t.title,
      description: t.description,
      workspaceId: t.project.workspaceId,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async function searchMessages(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const messages = await prisma.message.findMany({
      where: {
        deletedAt: null,
        body: { contains: q, mode: 'insensitive' },
        channel: { is: visibleChannelWhere(userId, scope) },
      },
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        body: true,
        createdAt: true,
        channel: { select: { id: true, name: true, workspaceId: true } },
      },
    });
    return messages.map((m) => ({
      id: m.id,
      type: 'message',
      title: m.channel.name,
      description: snippet(m.body),
      workspaceId: m.channel.workspaceId,
      createdAt: m.createdAt.toISOString(),
      metadata: { channelId: m.channel.id },
    }));
  }

  async function searchConversations(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const channels = await prisma.channel.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        type: 'PRIVATE',
        deletedAt: null,
        archivedAt: null,
        memberships: { some: { userId } },
        name: { contains: q, mode: 'insensitive' },
      },
      take,
      select: { id: true, name: true, description: true, workspaceId: true, createdAt: true },
    });
    return channels.map((c) => ({
      id: c.id,
      type: 'conversation',
      title: c.name,
      description: c.description,
      workspaceId: c.workspaceId,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async function searchDocuments(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
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
      take,
      select: { id: true, title: true, content: true, workspaceId: true, createdAt: true },
    });
    return docs.map((d) => ({
      id: d.id,
      type: 'document',
      title: d.title,
      description: d.title.toLowerCase().includes(q.toLowerCase()) ? null : snippet(d.content),
      workspaceId: d.workspaceId,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  async function searchFiles(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const visible = visibleProject(userId, scope);
    const files = await prisma.fileAttachment.findMany({
      where: {
        workspaceId: { in: scope.workspaceIds },
        deletedAt: null,
        AND: [
          {
            OR: [
              { fileName: { contains: q, mode: 'insensitive' } },
              { extractedText: { contains: q, mode: 'insensitive' } },
            ],
          },
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
      take,
      select: { id: true, fileName: true, mimeType: true, workspaceId: true, createdAt: true },
    });
    return files.map((f) => ({
      id: f.id,
      type: 'file',
      title: f.fileName,
      description: f.mimeType,
      workspaceId: f.workspaceId,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  async function searchChannels(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
    const channels = await prisma.channel.findMany({
      where: {
        ...visibleChannelWhere(userId, scope),
        name: { contains: q, mode: 'insensitive' },
      },
      take,
      select: { id: true, name: true, workspaceId: true, createdAt: true },
    });
    return channels.map((c) => ({
      id: c.id,
      type: 'channel',
      title: c.name,
      description: null,
      workspaceId: c.workspaceId,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async function searchMeetings(
    userId: string,
    q: string,
    scope: SearchScope,
    take: number,
  ): Promise<SearchResult[]> {
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
      take,
      select: { id: true, title: true, description: true, workspaceId: true, createdAt: true },
    });
    return meetings.map((m) => ({
      id: m.id,
      type: 'meeting',
      title: m.title,
      description: m.description,
      workspaceId: m.workspaceId ?? '',
      createdAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Announcements do not have a dedicated model yet. Workspace announcements
   * are currently represented as WORKSPACE channels, so the category returns
   * no synthetic results rather than leaking an unimplemented feature.
   */
  async function searchAnnouncements(): Promise<SearchResult[]> {
    return [];
  }

  type Searcher = (uid: string, q: string, s: SearchScope, take: number) => Promise<SearchResult[]>;

  const searchers: Record<Exclude<SearchCategory, 'all'>, Searcher> = {
    people: searchPeople,
    workspaces: (_uid, q, s, take) => searchWorkspaces(q, s, take),
    teams: (_uid, q, s, take) => searchTeams(q, s, take),
    departments: (_uid, q, s, take) => searchDepartments(q, s, take),
    projects: searchProjects,
    tasks: searchTasks,
    messages: searchMessages,
    conversations: searchConversations,
    files: searchFiles,
    documents: searchDocuments,
    meetings: searchMeetings,
    channels: searchChannels,
    announcements: () => searchAnnouncements(),
  };

  async function scoped(userId: string, workspaceId?: string): Promise<SearchScope | null> {
    const full = await getUserScope(userId);
    const workspaceIds = workspaceId
      ? full.workspaceIds.includes(workspaceId)
        ? [workspaceId]
        : []
      : full.workspaceIds;
    if (workspaceIds.length === 0) return null;
    return {
      workspaceIds,
      unrestricted: full.unrestricted.filter((id) => workspaceIds.includes(id)),
      managers: full.managers.filter((id) => workspaceIds.includes(id)),
      workspaceChannelIds: full.workspaceChannelIds.filter((id) => workspaceIds.includes(id)),
    };
  }

  async function runSearch(userId: string, options: SearchOptions): Promise<SearchPage> {
    const query = options.query.trim();
    const category: SearchCategory = options.category ?? 'all';
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE)),
    );
    const sort = options.sort ?? 'relevance';
    const scope = await scoped(userId, options.workspaceId);
    if (!scope || !query) {
      return { results: [], total: 0, page, limit, hasMore: false, category };
    }

    const take = category === 'all' ? PER_CATEGORY_LIMIT : Math.min(200, page * limit + limit);

    const batches =
      category === 'all'
        ? await Promise.all(Object.values(searchers).map((fn) => fn(userId, query, scope, take)))
        : [await searchers[category](userId, query, scope, take)];

    const merged = batches
      .flat()
      .map((result) => ({ ...result, score: scoreResult(result, query) }));
    if (sort === 'recent') {
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else {
      merged.sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0) || b.createdAt.localeCompare(a.createdAt),
      );
    }

    const total = merged.length;
    const start = (page - 1) * limit;
    const results = merged.slice(start, start + limit);
    return { results, total, page, limit, hasMore: start + results.length < total, category };
  }

  async function recordHistory(userId: string, options: SearchOptions): Promise<void> {
    const query = options.query.trim();
    if (query.length < 2) return;
    try {
      await prisma.searchHistory.create({
        data: {
          userId,
          workspaceId: options.workspaceId ?? null,
          query: query.slice(0, 200),
          category: options.category ?? 'all',
        },
      });
      const stale = await prisma.searchHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: MAX_HISTORY,
        select: { id: true },
      });
      if (stale.length > 0) {
        await prisma.searchHistory.deleteMany({
          where: { id: { in: stale.map((row) => row.id) } },
        });
      }
    } catch (error) {
      // Search history is a convenience. A history write must never fail a search.
      logger.warn('search_history_write_failed', { userId, error });
    }
  }

  return {
    /** Backward-compatible array-returning search used by existing callers. */
    async search(
      userId: string,
      query: string,
      category: string,
      workspaceId?: string,
    ): Promise<SearchResult[]> {
      const page = await runSearch(userId, {
        query,
        category: (SEARCH_CATEGORIES.includes(category as SearchCategory)
          ? category
          : 'all') as SearchCategory,
        workspaceId,
      });
      return page.results;
    },

    async searchPage(userId: string, options: SearchOptions): Promise<SearchPage> {
      const page = await runSearch(userId, options);
      await recordHistory(userId, options);
      return page;
    },

    async suggestions(
      userId: string,
      query: string,
      workspaceId?: string,
    ): Promise<SearchSuggestion[]> {
      const page = await runSearch(userId, {
        query,
        category: 'all',
        workspaceId,
        limit: 8,
        sort: 'relevance',
      });
      return page.results.slice(0, 8).map((result) => ({
        id: result.id,
        type: result.type,
        title: result.title,
        workspaceId: result.workspaceId,
      }));
    },

    async recentSearches(
      userId: string,
      workspaceId?: string,
    ): Promise<
      {
        id: string;
        query: string;
        category: string | null;
        workspaceId: string | null;
        createdAt: string;
      }[]
    > {
      const rows = await prisma.searchHistory.findMany({
        where: { userId, ...(workspaceId ? { workspaceId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY,
      });
      const seen = new Set<string>();
      const unique: typeof rows = [];
      for (const row of rows) {
        const key = `${row.query.toLowerCase()}|${row.category ?? ''}|${row.workspaceId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      return unique.map((row) => ({
        id: row.id,
        query: row.query,
        category: row.category,
        workspaceId: row.workspaceId,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async clearRecentSearches(userId: string, workspaceId?: string): Promise<number> {
      const result = await prisma.searchHistory.deleteMany({
        where: { userId, ...(workspaceId ? { workspaceId } : {}) },
      });
      return result.count;
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
