import type { Prisma, PrismaClient, TaskStatus } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { createCacheService, type CacheService } from '../../services/cache/cache.service';
import { AppError } from '../../utils/errors';
import {
  ProjectCapability,
  requireProjectAccess,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from '../authorization';
import { projectVisibleToUser } from '../projects/project-visibility';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
];

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

  /**
   * Legacy workspace managers (OWNER / PROJECT_MANAGER without an organization
   * role) bypass the per-project visibility filter, exactly as the project
   * list and search services do. Organization-role managers do not: they only
   * see projects they own or are explicitly associated with.
   */
  function isUnrestrictedProjectManager(access: {
    effectiveRole: string;
    membership: { organizationRole: string | null };
  }): boolean {
    const manager =
      access.effectiveRole === 'OWNER' || access.effectiveRole === 'PROJECT_MANAGER';
    return manager && !access.membership.organizationRole;
  }

  async function resolveWorkspaceScope(input: {
    userId: string;
    workspaceId?: string | null;
  }): Promise<{
    workspaceIds: string[];
    singleWorkspace?: string;
    unrestrictedWorkspaceIds: string[];
  }> {
    if (input.workspaceId) {
      const access = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      return {
        workspaceIds: [input.workspaceId],
        singleWorkspace: input.workspaceId,
        unrestrictedWorkspaceIds: isUnrestrictedProjectManager(access)
          ? [input.workspaceId]
          : [],
      };
    }

    const memberships = await prisma.workspaceMembership.findMany({
      where: {
        userId: input.userId,
        status: 'ACTIVE',
        workspace: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { workspaceId: true, role: true, organizationRole: true },
    });

    const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))];
    const unrestrictedWorkspaceIds = [
      ...new Set(
        memberships
          .filter(
            (m) =>
              !m.organizationRole &&
              (m.role === 'OWNER' || m.role === 'PROJECT_MANAGER'),
          )
          .map((m) => m.workspaceId),
      ),
    ];

    return { workspaceIds, unrestrictedWorkspaceIds };
  }

  interface ScopedWorkspace {
    workspaceId: string;
    projectId: string | null;
    userId: string;
    /** True when the caller manages every project in the workspace. */
    unrestricted: boolean;
  }

  async function resolveScopedWorkspace(
    userId: string,
    workspaceId: string,
    projectId?: string | null,
  ): Promise<ScopedWorkspace> {
    const access = await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });

    if (projectId) {
      // Project access is a separate grant: workspace membership alone must
      // never expose a private or department/team-only project.
      await requireProjectAccess(prisma, {
        userId,
        workspaceId,
        projectId,
        workspaceRole: access.effectiveRole,
        capability: ProjectCapability.ViewProject,
      });
    }

    return {
      workspaceId,
      projectId: projectId ?? null,
      userId,
      unrestricted: isUnrestrictedProjectManager(access),
    };
  }

  function projectScopeWhere(scope: ScopedWorkspace): Prisma.ProjectWhereInput {
    return {
      workspaceId: scope.workspaceId,
      deletedAt: null,
      ...(scope.projectId ? { id: scope.projectId } : {}),
      ...(scope.unrestricted ? {} : { AND: [projectVisibleToUser(scope.userId)] }),
    };
  }

  function taskScopeWhere(scope: ScopedWorkspace): Prisma.TaskWhereInput {
    return {
      project: projectScopeWhere(scope),
      deletedAt: null,
    };
  }

  return {
    async getSnapshot(input): Promise<AnalyticsSnapshot> {
      const { range = '30d', startDate, endDate, workspaceId, userId, projectId } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });

      const scope = await resolveWorkspaceScope({ userId, workspaceId });
      if (workspaceId && projectId) {
        const access = await requireWorkspaceAccess(prisma, {
          userId,
          workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
        await requireProjectAccess(prisma, {
          userId,
          workspaceId,
          projectId,
          workspaceRole: access.effectiveRole,
          capability: ProjectCapability.ViewProject,
        });
      }
      const workspaceIdFilter = { in: scope.workspaceIds };

      const cacheKey = `analytics:${userId}:${[...scope.workspaceIds].sort().join(',')}:${projectId ?? 'all'}:${range}:${start.toISOString()}:${end.toISOString()}`;

      return cache.getOrSet(
        cacheKey,
        async () => {
          const workspaceWhere: Prisma.WorkspaceWhereInput = {
            id: workspaceIdFilter,
            deletedAt: null,
            status: 'ACTIVE',
          };

          // Project visibility is enforced independently of workspace
          // membership so private and department/team-only projects never leak
          // into workspace-wide aggregates.
          const projectWhere: Prisma.ProjectWhereInput = {
            workspaceId: workspaceIdFilter,
            deletedAt: null,
            ...(projectId ? { id: projectId } : {}),
            AND: [
              {
                OR: [
                  { workspaceId: { in: scope.unrestrictedWorkspaceIds } },
                  projectVisibleToUser(userId),
                ],
              },
            ],
          };

          const taskWhere: Prisma.TaskWhereInput = {
            project: projectWhere,
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
                where: projectWhere,
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
                  OR: [{ projectId: null }, { project: { is: projectWhere } }],
                },
              }),
              prisma.fileAttachment.aggregate({
                where: {
                  workspaceId: workspaceIdFilter,
                  deletedAt: null,
                  createdAt: { gte: start, lte: end },
                  OR: [{ projectId: null }, { project: { is: projectWhere } }],
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
      const { start, end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);

      const rows = await prisma.task.groupBy({
        by: ['status'],
        where: {
          ...taskScopeWhere(scope),
          archivedAt: null,
          createdAt: { gte: start, lte: end },
        },
        _count: { _all: true },
      });

      const counts = new Map<TaskStatus, number>(
        rows.map((row) => [row.status, row._count._all]),
      );
      const items: StatusCount[] = TASK_STATUS_ORDER.filter((status) =>
        counts.has(status),
      ).map((status) => ({ status, count: counts.get(status) ?? 0 }));
      for (const [status, count] of counts) {
        if (!TASK_STATUS_ORDER.includes(status)) items.push({ status, count });
      }

      return {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        rangeDays: days,
        items,
      };
    },

    async tasksByAssignee(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: Array<{ assigneeId: string | null; assigneeName: string | null; count: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);

      // Count assignment rows rather than loading every task, so a multi-assignee
      // task contributes once per assignee and large workspaces stay cheap.
      const [assignedRows, unassignedCount] = await Promise.all([
        prisma.taskAssignee.groupBy({
          by: ['userId'],
          where: {
            task: {
              ...taskScopeWhere(scope),
              archivedAt: null,
              createdAt: { gte: start, lte: end },
            },
          },
          _count: { _all: true },
        }),
        prisma.task.count({
          where: {
            ...taskScopeWhere(scope),
            archivedAt: null,
            createdAt: { gte: start, lte: end },
            assignees: { none: {} },
          },
        }),
      ]);

      const userIds = assignedRows.map((row) => row.userId);
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(users.map((user) => [user.id, user.name ?? null]));

      const items: Array<{ assigneeId: string | null; assigneeName: string | null; count: number }> =
        assignedRows.map((row) => ({
          assigneeId: row.userId,
          assigneeName: nameById.get(row.userId) ?? null,
          count: row._count._all,
        }));
      if (unassignedCount > 0) {
        items.push({ assigneeId: null, assigneeName: null, count: unassignedCount });
      }
      items.sort(
        (a, b) =>
          b.count - a.count ||
          (a.assigneeName ?? '').localeCompare(b.assigneeName ?? ''),
      );

      return {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        rangeDays: days,
        items,
      };
    },

    async tasksThroughput(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; created: number; completed: number; items: Array<{ date: string; created: number; completed: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);
      const where = taskScopeWhere(scope);

      const [createdRows, completedRows] = await Promise.all([
        prisma.task.findMany({
          where: { ...where, createdAt: { gte: start, lte: end } },
          select: { createdAt: true },
        }),
        prisma.task.findMany({
          where: { ...where, completedAt: { gte: start, lte: end } },
          select: { completedAt: true },
        }),
      ]);

      // Pre-fill every day in the window so charts render a continuous series
      // even when nothing happened on a given day.
      const byDate = new Map<string, { created: number; completed: number }>();
      const firstDay = Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      );
      for (let offset = 0; offset < days; offset += 1) {
        byDate.set(new Date(firstDay + offset * MS_PER_DAY).toISOString().slice(0, 10), {
          created: 0,
          completed: 0,
        });
      }

      for (const row of createdRows) {
        const date = row.createdAt.toISOString().slice(0, 10);
        const bucket = byDate.get(date) ?? { created: 0, completed: 0 };
        bucket.created += 1;
        byDate.set(date, bucket);
      }
      for (const row of completedRows) {
        if (!row.completedAt) continue;
        const date = row.completedAt.toISOString().slice(0, 10);
        const bucket = byDate.get(date) ?? { created: 0, completed: 0 };
        bucket.completed += 1;
        byDate.set(date, bucket);
      }

      const items = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, ...value }));

      return {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        rangeDays: days,
        created: createdRows.length,
        completed: completedRows.length,
        items,
      };
    },

    async tasksWorkload(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; items: Array<{ assigneeId: string | null; assigneeName: string | null; openTasks: number; overdueTasks: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);

      // Workload is a current-state measure, so the requested range only
      // labels the response. Archived and approved tasks are not outstanding.
      const openWhere: Prisma.TaskWhereInput = {
        ...taskScopeWhere(scope),
        archivedAt: null,
        status: { not: 'APPROVED' },
      };
      const currentTime = now();
      const overdueWhere: Prisma.TaskWhereInput = {
        ...openWhere,
        dueDate: { lt: currentTime },
      };

      const [openRows, overdueRows, unassignedOpen, unassignedOverdue] = await Promise.all([
        prisma.taskAssignee.groupBy({
          by: ['userId'],
          where: { task: openWhere },
          _count: { _all: true },
        }),
        prisma.taskAssignee.groupBy({
          by: ['userId'],
          where: { task: overdueWhere },
          _count: { _all: true },
        }),
        prisma.task.count({ where: { ...openWhere, assignees: { none: {} } } }),
        prisma.task.count({ where: { ...overdueWhere, assignees: { none: {} } } }),
      ]);

      const overdueByUser = new Map(overdueRows.map((row) => [row.userId, row._count._all]));
      const userIds = openRows.map((row) => row.userId);
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(users.map((user) => [user.id, user.name ?? null]));

      const items: Array<{ assigneeId: string | null; assigneeName: string | null; openTasks: number; overdueTasks: number }> =
        openRows.map((row) => ({
          assigneeId: row.userId,
          assigneeName: nameById.get(row.userId) ?? null,
          openTasks: row._count._all,
          overdueTasks: overdueByUser.get(row.userId) ?? 0,
        }));
      if (unassignedOpen > 0) {
        items.push({
          assigneeId: null,
          assigneeName: null,
          openTasks: unassignedOpen,
          overdueTasks: unassignedOverdue,
        });
      }
      items.sort((a, b) => b.openTasks - a.openTasks || b.overdueTasks - a.overdueTasks);

      return {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        rangeDays: days,
        items,
      };
    },

    async timeLogged(input): Promise<{ workspaceId: string; projectId: string | null; rangeDays: number; totalMinutes: number; items: Array<{ userId: string; userName: string | null; minutes: number }> }> {
      const { range = '30d', startDate, endDate } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });
      const scope = await resolveScopedWorkspace(input.userId, input.workspaceId, input.projectId);

      const rows = await prisma.taskTimeEntry.groupBy({
        by: ['userId'],
        where: {
          startedAt: { gte: start, lte: end },
          task: taskScopeWhere(scope),
        },
        _sum: { durationMinutes: true },
      });

      const userIds = rows.map((row) => row.userId);
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(users.map((user) => [user.id, user.name ?? null]));

      let totalMinutes = 0;
      const items = rows
        .map((row) => {
          const minutes = row._sum.durationMinutes ?? 0;
          totalMinutes += minutes;
          return {
            userId: row.userId,
            userName: nameById.get(row.userId) ?? null,
            minutes,
          };
        })
        .sort((a, b) => b.minutes - a.minutes);

      return {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        rangeDays: days,
        totalMinutes,
        items,
      };
    },
  };
}
