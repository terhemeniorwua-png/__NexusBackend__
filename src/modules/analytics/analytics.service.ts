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

export interface AnalyticsService {
  getSnapshot(input: {
    userId: string;
    workspaceId?: string | null;
    range?: '7d' | '30d' | '90d' | 'custom';
    startDate?: Date | null;
    endDate?: Date | null;
  }): Promise<AnalyticsSnapshot>;
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

  return {
    async getSnapshot(input): Promise<AnalyticsSnapshot> {
      const { range = '30d', startDate, endDate, workspaceId, userId } = input;
      const { start, end, days } = rangeBounds({ range, startDate, endDate });

      const scope = await resolveWorkspaceScope({ userId, workspaceId });
      const workspaceIdFilter =
        scope.workspaceIds.length > 0
          ? { in: scope.workspaceIds }
          : { equals: null as unknown as string };

      const cacheKey = `analytics:${userId}:${scope.workspaceIds.sort().join(',')}:${range}:${start.toISOString()}:${end.toISOString()}`;

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
            project: { workspace: workspaceWhere },
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
  };
}
