import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { createCacheService, type CacheService } from '../../services/cache/cache.service';
import { AppError } from '../../utils/errors';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WorkspaceSummary {
  id: string;
  name: string;
  type: string;
  memberCount: number;
  activeMemberCount: number;
}

export interface ActivityMetrics {
  membersJoined: number;
  tasksCreated: number;
  tasksCompleted: number;
  projectsCreated: number;
  meetingsHeld: number;
  filesUploaded: number;
  storageBytes: number;
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface ProjectProgress {
  byStatus: StatusCount[];
  overdueCount: number;
}

export interface TaskCompletion {
  byStatus: StatusCount[];
  completionRate: number;
}

export interface MemberActivity {
  byRole: StatusCount[];
  recentlyJoinedCount: number;
}

export interface MeetingStats {
  count: number;
  completedCount: number;
  upcomingCount: number;
}

export interface FileUsage {
  count: number;
  totalSizeBytes: number;
}

export interface SubscriptionInfo {
  plan: string | null;
  status: string | null;
  billableSeats: number | null;
  currentPeriodEnd: string | null;
}

export interface AnalyticsSnapshot {
  generatedAt: string;
  rangeDays: number;
  workspaces: WorkspaceSummary[];
  activity: ActivityMetrics;
  projects: ProjectProgress;
  tasks: TaskCompletion;
  members: MemberActivity;
  meetings: MeetingStats;
  files: FileUsage;
  subscription: SubscriptionInfo | null;
}

export interface ScopedAnalyticsInput {
  userId: string;
  workspaceId: string;
  projectId?: string | null;
  range?: '7d' | '30d' | '90d' | 'custom';
  startDate?: Date | null;
  endDate?: Date | null;
}

export interface AnalyticsService {
  getSnapshot(input: {
    userId: string;
    workspaceId?: string | null;
    projectId?: string | null;
    range?: '7d' | '30d' | '90d' | 'custom';
    startDate?: Date | null;
    endDate?: Date | null;
  }): Promise<AnalyticsSnapshot>;
  tasksByStatus(input: ScopedAnalyticsInput): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: StatusCount[] }>;
  tasksByAssignee(input: ScopedAnalyticsInput): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: Array<{ assigneeId: string | null; assigneeName: string | null; count: number }> }>;
  tasksThroughput(input: ScopedAnalyticsInput): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; created: number; completed: number; items: Array<{ date: string; created: number; completed: number }> }>;
  tasksWorkload(input: ScopedAnalyticsInput): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: Array<{ assigneeId: string | null; assigneeName: string | null; openTasks: number; overdueTasks: number }> }>;
  timeLogged(input: ScopedAnalyticsInput): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; totalMinutes: number; items: Array<{ userId: string; userName: string | null; minutes: number }> }>;
}

interface AnalyticsServiceDependencies {
  prisma?: PrismaClient;
  config: AppConfig;
  cache?: CacheService;
  now?: () => Date;
}

export function createAnalyticsService({
  prisma: injectedPrisma,
  config,
  cache: injectedCache,
  now: injectedNow,
}: AnalyticsServiceDependencies): AnalyticsService {
  const prisma = injectedPrisma ?? getPrismaClient();
  const now = injectedNow ?? (() => new Date());
  const cache =
    injectedCache ??
    createCacheService({
      namespace: 'nexus-analytics',
      defaultTtlSeconds: config.analyticsCacheTtlSeconds,
    });

  function rangeBounds(input: {
    range: '7d' | '30d' | '90d' | 'custom';
    startDate?: Date | null;
    endDate?: Date | null;
  }): { start: Date; end: Date; days: number } {
    const end = input.endDate ?? now();
    const maxDays = config.analyticsMaxRangeDays;

    let start: Date;
    let days: number;

    if (input.range === 'custom' && input.startDate && input.endDate) {
      start = input.startDate;
      days = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
      if (days < 0) {
        throw new AppError(400, 'INVALID_DATE_RANGE', 'startDate must be before endDate');
      }
      if (days > maxDays) {
        throw new AppError(
          400,
          'DATE_RANGE_TOO_LARGE',
          `Date range must not exceed ${maxDays} days`,
        );
      }
    } else if (input.range === '7d') {
      start = new Date(end.getTime() - 7 * MS_PER_DAY);
      days = 7;
    } else if (input.range === '90d') {
      start = new Date(end.getTime() - 90 * MS_PER_DAY);
      days = 90;
    } else {
      // '30d' default
      start = new Date(end.getTime() - 30 * MS_PER_DAY);
      days = 30;
    }

    if (days > maxDays) {
      throw new AppError(400, 'DATE_RANGE_TOO_LARGE', `Date range must not exceed ${maxDays} days`);
    }

    return { start, end, days };
  }

  async function resolveWorkspaceScope(input: {
    userId: string;
    workspaceId?: string | null;
  }): Promise<{ workspaceIds: string[]; singleWorkspace?: string }> {
    if (input.workspaceId) {
      const membership = await prisma.workspaceMembership.findFirst({
        where: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          status: 'ACTIVE',
        },
        select: { workspaceId: true },
      });
      if (!membership) {
        throw new AppError(
          403,
          'WORKSPACE_ACCESS_DENIED',
          'You are not a member of this workspace',
        );
      }
      return { workspaceIds: [input.workspaceId], singleWorkspace: input.workspaceId };
    }

    const memberships = await prisma.workspaceMembership.findMany({
      where: { userId: input.userId, status: 'ACTIVE' },
      select: { workspaceId: true },
    });
    return {
      workspaceIds: memberships.map((m) => m.workspaceId),
    };
  }

  async function ensureProjectInWorkspace(userId: string, workspaceId: string, projectId: string): Promise<void> {
    await resolveWorkspaceScope({ userId, workspaceId });
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist in this workspace');
    }
  }

  async function resolveScopedWorkspace(userId: string, workspaceId: string, projectId?: string | null): Promise<{ workspaceId: string; projectId: string | null }> {
    await resolveWorkspaceScope({ userId, workspaceId });
    if (projectId) {
      await ensureProjectInWorkspace(userId, workspaceId, projectId);
      return { workspaceId, projectId };
    }
    return { workspaceId, projectId: null };
  }

  function taskScopeWhere(workspaceId: string, projectId?: string | null) {
    return {
      project: {
        workspaceId,
        deletedAt: null,
        ...(projectId ? { id: projectId } : {}),
      },
      deletedAt: null,
    };
  }

  return {
    async getSnapshot(input): Promise<AnalyticsSnapshot> {
      const { range = '30d', startDate, endDate, workspaceId, userId, projectId } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });

      const scope = await resolveWorkspaceScope({ userId, workspaceId });
      if (workspaceId && projectId) {
        await ensureProjectInWorkspace(userId, workspaceId, projectId);
      }
      const workspaceIdFilter =
        scope.workspaceIds.length > 0
          ? { in: scope.workspaceIds }
          : { equals: null as unknown as string };

      const cacheKey = `analytics:${userId}:${scope.workspaceIds.sort().join(',')}:${projectId ?? 'all'}:${range}:${start.toISOString()}:${end.toISOString()}`;

      return cache.getOrSet(
        cacheKey,
        async () => {
          const workspaceWhere = {
            id: workspaceIdFilter,
            deletedAt: null,
          };

          // Workspace summaries (only when a single workspace is requested, or
          // the list of accessible workspaces when none is requested).
          const workspaces = await prisma.workspace.findMany({
            where: workspaceWhere,
            select: {
              id: true,
              name: true,
              type: true,
              _count: {
                select: {
                  members: { where: { status: 'ACTIVE' } },
                },
              },
            },
            orderBy: { name: 'asc' },
          });

          const workspaceSummaries: WorkspaceSummary[] = workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            type: w.type,
            memberCount: w._count.members,
            activeMemberCount: w._count.members,
          }));

          const taskWhere = {
            project: { workspace: workspaceWhere, deletedAt: null, ...(projectId ? { id: projectId } : {}) },
            deletedAt: null,
          };

          const [tasksCreated, tasksCompleted, projects, memberships, meetings, files] =
            await Promise.all([
              prisma.task.count({
                where: {
                  ...taskWhere,
                  createdAt: { gte: start, lte: end },
                },
              }),
              prisma.task.count({
                where: {
                  ...taskWhere,
                  completedAt: { gte: start, lte: end },
                },
              }),
              prisma.project.findMany({
                where: {
                  workspace: workspaceWhere,
                  deletedAt: null,
                },
                select: {
                  id: true,
                  status: true,
                  dueDate: true,
                },
              }),
              prisma.workspaceMembership.count({
                where: {
                  workspaceId: workspaceIdFilter,
                  userId,
                  status: 'ACTIVE',
                  joinedAt: { gte: start, lte: end },
                },
              }),
              prisma.meeting.count({
                where: {
                  workspaceId: workspaceIdFilter,
                  deletedAt: null,
                  status: 'ENDED',
                  endedAt: { gte: start, lte: end },
                },
              }),
              prisma.fileAttachment.aggregate({
                where: {
                  workspaceId: workspaceIdFilter,
                  deletedAt: null,
                  createdAt: { gte: start, lte: end },
                },
                _sum: { sizeBytes: true },
                _count: true,
              }),
            ]);

          const projectStatusCounts = projects.reduce<Record<string, number>>((acc, p) => {
            acc[p.status] = (acc[p.status] ?? 0) + 1;
            return acc;
          }, {});
          const overdueCount = projects.filter(
            (p) =>
              p.dueDate && p.status !== 'COMPLETED' && p.status !== 'ARCHIVED' && p.dueDate < end,
          ).length;

          const taskStatusCounts = await prisma.task.groupBy({
            by: ['status'],
            where: {
              ...taskWhere,
              createdAt: { gte: start, lte: end },
            },
            _count: { status: true },
          });

          const taskByStatus: StatusCount[] = taskStatusCounts.map((t) => ({
            status: t.status,
            count: t._count.status,
          }));
          const completionRate =
            tasksCreated > 0 ? Math.round((tasksCompleted / tasksCreated) * 100) : 0;

          const membershipRoleCounts = await prisma.workspaceMembership.groupBy({
            by: ['role'],
            where: {
              workspaceId: workspaceIdFilter,
              status: 'ACTIVE',
            },
            _count: { role: true },
          });
          const memberByRole: StatusCount[] = membershipRoleCounts.map((m) => ({
            status: m.role,
            count: m._count.role,
          }));

          const upcomingCount = await prisma.meeting.count({
            where: {
              workspaceId: workspaceIdFilter,
              deletedAt: null,
              status: 'SCHEDULED',
              scheduledAt: { gte: end },
            },
          });

          const subscription = scope.singleWorkspace
            ? await prisma.subscription.findUnique({
                where: { workspaceId: scope.singleWorkspace },
                select: {
                  plan: true,
                  status: true,
                  billableSeats: true,
                  currentPeriodEnd: true,
                },
              })
            : null;

          return {
            generatedAt: now().toISOString(),
            rangeDays: days,
            workspaces: workspaceSummaries,
            activity: {
              membersJoined: memberships,
              tasksCreated,
              tasksCompleted,
              projectsCreated: projects.length,
              meetingsHeld: meetings,
              filesUploaded: files._count ?? 0,
              storageBytes: files._sum.sizeBytes ?? 0,
            },
            projects: {
              byStatus: Object.entries(projectStatusCounts).map(([status, count]) => ({
                status,
                count,
              })),
              overdueCount,
            },
            tasks: {
              byStatus: taskByStatus,
              completionRate,
            },
            members: {
              byRole: memberByRole,
              recentlyJoinedCount: memberships,
            },
            meetings: {
              count: meetings,
              completedCount: meetings,
              upcomingCount,
            },
            files: {
              count: files._count ?? 0,
              totalSizeBytes: files._sum.sizeBytes ?? 0,
            },
            subscription: subscription
              ? {
                  plan: subscription.plan,
                  status: subscription.status,
                  billableSeats: subscription.billableSeats,
                  currentPeriodEnd: subscription.currentPeriodEnd
                    ? subscription.currentPeriodEnd.toISOString()
                    : null,
                }
              : null,
          };
        },
        { ttlSeconds: config.analyticsCacheTtlSeconds },
      );
    },

    async tasksByStatus(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: StatusCount[] }> {
      const { range = '30d', startDate, endDate } = input;
      const { days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);
      const rows = await prisma.task.groupBy({
        by: ['status'],
        where: taskScopeWhere(scope.workspaceId, scope.projectId),
        _count: { status: true },
      });
      return {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        rangeDays: days,
        items: rows.map((r) => ({ status: r.status, count: r._count.status })),
      };
    },

    async tasksByAssignee(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: Array<{ assigneeId: string | null; assigneeName: string | null; count: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);
      const tasks = await prisma.task.findMany({
        where: taskScopeWhere(scope.workspaceId, scope.projectId),
        select: {
          assignees: { select: { userId: true, user: { select: { name: true } } } },
        },
      });
      const map = new Map<string | null, { name: string | null; count: number }>();
      for (const t of tasks) {
        if (!t.assignees.length) {
          const cur = map.get(null) ?? { name: null, count: 0 };
          cur.count += 1;
          map.set(null, cur);
          continue;
        }
        for (const a of t.assignees) {
          const cur = map.get(a.userId) ?? { name: a.user.name ?? null, count: 0 };
          cur.count += 1;
          map.set(a.userId, cur);
        }
      }
      const items = [...map.entries()].map(([assigneeId, v]) => ({ assigneeId, assigneeName: v.name, count: v.count }));
      items.sort((a, b) => b.count - a.count);
      return { workspaceId: scope.workspaceId, projectId: scope.projectId, rangeDays: days, items };
    },

    async tasksThroughput(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; created: number; completed: number; items: Array<{ date: string; created: number; completed: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);
      const where = taskScopeWhere(scope.workspaceId, scope.projectId);
      const [createdRows, completedRows] = await Promise.all([
        prisma.task.findMany({ where: { ...where, createdAt: { gte: start, lte: end } }, select: { createdAt: true } }),
        prisma.task.findMany({ where: { ...where, completedAt: { gte: start, lte: end } }, select: { completedAt: true } }),
      ]);
      const byDate = new Map<string, { created: number; completed: number }>();
      for (const r of createdRows) {
        const d = r.createdAt.toISOString().slice(0, 10);
        const cur = byDate.get(d) ?? { created: 0, completed: 0 };
        cur.created += 1;
        byDate.set(d, cur);
      }
      for (const r of completedRows) {
        if (!r.completedAt) continue;
        const d = r.completedAt.toISOString().slice(0, 10);
        const cur = byDate.get(d) ?? { created: 0, completed: 0 };
        cur.completed += 1;
        byDate.set(d, cur);
      }
      const items = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
      return { workspaceId: scope.workspaceId, projectId: scope.projectId, rangeDays: days, created: createdRows.length, completed: completedRows.length, items };
    },

    async tasksWorkload(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: Array<{ assigneeId: string | null; assigneeName: string | null; openTasks: number; overdueTasks: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);
      const tasks = await prisma.task.findMany({
        where: taskScopeWhere(scope.workspaceId, scope.projectId),
        select: {
          status: true,
          dueDate: true,
          assignees: { select: { userId: true, user: { select: { name: true } } } },
        },
      });
      const terminal = new Set(['APPROVED', 'ARCHIVED', 'COMPLETED']);
      const map = new Map<string | null, { name: string | null; openTasks: number; overdueTasks: number }>();
      for (const t of tasks) {
        const open = !terminal.has(t.status as string);
        if (!open) continue;
        const overdue = Boolean(t.dueDate && t.dueDate < end);
        const assignees = t.assignees.length ? t.assignees : [{ userId: null as string | null, user: { name: null as string | null } }];
        for (const a of assignees) {
          const key = a.userId;
          const cur = map.get(key) ?? { name: a.user?.name ?? null, openTasks: 0, overdueTasks: 0 };
          cur.openTasks += 1;
          if (overdue) cur.overdueTasks += 1;
          if (!cur.name && a.user?.name) cur.name = a.user.name;
          map.set(key, cur);
        }
      }
      const items = [...map.entries()].map(([assigneeId, v]) => ({ assigneeId, assigneeName: v.name, openTasks: v.openTasks, overdueTasks: v.overdueTasks })).sort((a, b) => b.openTasks - a.openTasks);
      return { workspaceId: scope.workspaceId, projectId: scope.projectId, rangeDays: days, items };
    },

    async timeLogged(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; totalMinutes: number; items: Array<{ userId: string; userName: string | null; minutes: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);
      const entries = await prisma.taskTimeEntry.findMany({
        where: {
          startedAt: { gte: start, lte: end },
          task: taskScopeWhere(scope.workspaceId, scope.projectId),
        },
        select: {
          userId: true,
          durationMinutes: true,
          user: { select: { name: true } },
        },
      });
      const map = new Map<string, { name: string | null; minutes: number }>();
      let total = 0;
      for (const e of entries) {
        total += e.durationMinutes;
        const cur = map.get(e.userId) ?? { name: e.user?.name ?? null, minutes: 0 };
        cur.minutes += e.durationMinutes;
        if (!cur.name && e.user?.name) cur.name = e.user.name;
        map.set(e.userId, cur);
      }
      const items = [...map.entries()].map(([userId, v]) => ({ userId, userName: v.name, minutes: v.minutes })).sort((a, b) => b.minutes - a.minutes);
      return { workspaceId: scope.workspaceId, projectId: scope.projectId, rangeDays: days, totalMinutes: total, items };
    },
  };
}
