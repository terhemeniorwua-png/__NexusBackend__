import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  Automation,
  AutomationRun,
  NotificationType,
  Prisma,
  PrismaClient,
  TaskPriority,
  WorkspaceRole,
} from '@prisma/client';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { ProjectCapability, requireProjectAccess } from '../authorization/project.policy';
import { generateTaskKey } from '../tasks/task.service';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';

/**
 * Automation execution engine.
 *
 * The engine is deliberately separate from the HTTP layer and from the event
 * publisher:
 *
 * - `automation.events.ts` writes queued runs when a domain event happens.
 * - This module executes those runs, applies conditions, enforces permissions
 *   again at execution time, and records the outcome.
 * - `automation.worker.ts` polls the queue and schedules periodic runs.
 *
 * Every action re-checks the automation owner's permissions. An automation is
 * created by a workspace member, but permissions can change before the action
 * runs. Executing an action with stale permissions would be a privilege
 * escalation, so a run fails when its owner no longer has the required access.
 */

const BATCH_SIZE = 25;
const STALE_RUNNING_MS = 5 * 60_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const MIN_BACKOFF_MS = 60_000;

const TASK_PRIORITIES: readonly TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export interface AutomationEngineDependencies {
  prisma: PrismaClient;
  logger?: Logger;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Override the SSRF guard in tests; production always uses the default. */
  resolveWebhookUrl?: (raw: string) => Promise<URL>;
  notificationType?: NotificationType;
}

export interface ProcessRunsResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  skipped: number;
}

export interface ScheduledRunsResult {
  queued: number;
}

function asStringRecord(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      record[key] = item;
    }
  }
  return record;
}

function asPayload(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * A condition is a flat key/value map. Every entry must match the event
 * payload exactly. An absent condition (or an empty one) always matches.
 */
export function conditionMatches(
  condition: Prisma.JsonValue | null | undefined,
  payload: Record<string, unknown>,
): boolean {
  const expected = asStringRecord(condition);
  return Object.entries(expected).every(
    ([key, value]) => payload[key] !== undefined && String(payload[key]) === value,
  );
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map((part) => Number(part));
    const [first, second] = octets;
    if (first === undefined || second === undefined) return true;
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first >= 224) return true;
    return false;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('::ffff:')) return isBlockedIp(normalized.slice(7));
    return false;
  }

  // Not an IP literal: refuse it rather than guessing.
  return true;
}

/**
 * Reject webhook targets that could be used to reach internal infrastructure
 * (SSRF). Only public HTTPS endpoints are allowed.
 */
export async function assertSafeWebhookUrl(
  raw: string,
  resolver: (host: string, options: { all: true }) => Promise<Array<{ address: string }>> = lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'AUTOMATION_INVALID_WEBHOOK_URL', 'The webhook URL is not valid');
  }

  if (url.protocol !== 'https:') {
    throw new AppError(400, 'AUTOMATION_INSECURE_WEBHOOK_URL', 'Webhook URLs must use HTTPS');
  }
  if (url.username || url.password) {
    throw new AppError(
      400,
      'AUTOMATION_INVALID_WEBHOOK_URL',
      'Webhook URLs must not contain credentials',
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new AppError(
      400,
      'AUTOMATION_PRIVATE_WEBHOOK_URL',
      'Webhook URLs must target a public endpoint',
    );
  }

  const literal = isIP(hostname);
  if (literal) {
    if (isBlockedIp(hostname)) {
      throw new AppError(
        400,
        'AUTOMATION_PRIVATE_WEBHOOK_URL',
        'Webhook URLs must target a public endpoint',
      );
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(hostname, { all: true });
  } catch {
    throw new AppError(
      400,
      'AUTOMATION_WEBHOOK_UNRESOLVABLE',
      'The webhook host could not be resolved',
    );
  }

  if (addresses.length === 0 || addresses.some((entry) => isBlockedIp(entry.address))) {
    throw new AppError(
      400,
      'AUTOMATION_PRIVATE_WEBHOOK_URL',
      'Webhook URLs must target a public endpoint',
    );
  }

  return url;
}

async function assertOwnerCanManage(
  prisma: PrismaClient,
  automation: Automation,
): Promise<WorkspaceRole> {
  const access = await requireWorkspaceAccess(prisma, {
    userId: automation.createdById,
    workspaceId: automation.workspaceId,
    capability: WorkspaceCapability.UpdateWorkspace,
  });
  return access.effectiveRole;
}

async function executeNotificationAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  payload: Record<string, unknown>,
  runId: string,
): Promise<void> {
  const config = asStringRecord(automation.actionConfig);
  const userIds = splitList(config.userIds ?? config.userId);
  const title = config.title?.trim();
  if (userIds.length === 0 || !title) {
    throw new AppError(
      400,
      'AUTOMATION_INVALID_ACTION_CONFIG',
      'SEND_NOTIFICATION requires userIds and title',
    );
  }

  const recipients = await deps.prisma.workspaceMembership.findMany({
    where: {
      workspaceId: automation.workspaceId,
      userId: { in: userIds },
      status: 'ACTIVE',
    },
    select: { userId: true },
  });

  if (recipients.length === 0) {
    throw new AppError(
      400,
      'AUTOMATION_NO_RECIPIENTS',
      'No active workspace member matches the notification recipients',
    );
  }

  for (const recipient of recipients) {
    await createNotification(deps.prisma, {
      userId: recipient.userId,
      type: deps.notificationType ?? 'PROJECT_UPDATE',
      title,
      body: config.body,
      link: config.link,
      data: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        automationRunId: runId,
        ...payload,
      },
    });
  }
}

async function executeCreateTaskAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  payload: Record<string, unknown>,
): Promise<void> {
  const config = asStringRecord(automation.actionConfig);
  const projectId = config.projectId;
  const title = config.title?.trim();
  if (!projectId || !title) {
    throw new AppError(
      400,
      'AUTOMATION_INVALID_ACTION_CONFIG',
      'CREATE_TASK requires projectId and title',
    );
  }

  const workspaceRole = await assertOwnerCanManage(deps.prisma, automation);
  const access = await requireProjectAccess(deps.prisma, {
    userId: automation.createdById,
    workspaceId: automation.workspaceId,
    projectId,
    workspaceRole,
    capability: ProjectCapability.CreateTask,
  });
  if (access.project.status === 'ARCHIVED') {
    throw new AppError(409, 'PROJECT_ARCHIVED', 'The target project is archived');
  }

  const requestedPriority = config.priority?.toUpperCase();
  const priority =
    requestedPriority && (TASK_PRIORITIES as readonly string[]).includes(requestedPriority)
      ? (requestedPriority as TaskPriority)
      : undefined;

  const assigneeIds = splitList(config.assigneeIds);
  const activeAssignees = assigneeIds.length
    ? await deps.prisma.workspaceMembership.findMany({
        where: {
          workspaceId: automation.workspaceId,
          userId: { in: assigneeIds },
          status: 'ACTIVE',
        },
        select: { userId: true },
      })
    : [];

  const created = await deps.prisma.$transaction(async (tx) => {
    const key = await generateTaskKey(tx, access.project.id, access.project.key);
    const task = await tx.task.create({
      data: {
        projectId: access.project.id,
        key,
        title,
        description: config.description ?? null,
        status: 'ASSIGNED',
        ...(priority ? { priority } : {}),
        creatorId: automation.createdById,
        ...(activeAssignees.length
          ? {
              assignees: {
                create: activeAssignees.map((member) => ({
                  userId: member.userId,
                  assignedBy: automation.createdById,
                })),
              },
            }
          : {}),
      },
      select: { id: true, key: true, title: true },
    });

    await recordAuditEvent(tx, {
      workspaceId: automation.workspaceId,
      actorId: automation.createdById,
      action: 'automation.task_created',
      targetType: 'Task',
      targetId: task.id,
      metadata: {
        automationId: automation.id,
        key: task.key,
        projectId: access.project.id,
        sourceEvent: payload.eventKey ?? null,
      },
    });

    return task;
  });

  deps.logger?.debug('automation_task_created', {
    automationId: automation.id,
    taskId: created.id,
    key: created.key,
  });
}

async function executeWebhookAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  payload: Record<string, unknown>,
  runId: string,
): Promise<void> {
  const config = asStringRecord(automation.actionConfig);
  const rawUrl = config.url?.trim();
  if (!rawUrl) {
    throw new AppError(400, 'AUTOMATION_INVALID_ACTION_CONFIG', 'SEND_WEBHOOK requires a url');
  }

  const url = deps.resolveWebhookUrl
    ? await deps.resolveWebhookUrl(rawUrl)
    : await assertSafeWebhookUrl(rawUrl);

  const body = JSON.stringify({
    event: automation.trigger,
    automationId: automation.id,
    automationRunId: runId,
    workspaceId: automation.workspaceId,
    payload,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Nexus-Automation/1.0',
    'x-nexus-automation': automation.id,
  };
  if (config.secret) {
    headers['x-nexus-signature'] =
      `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  timeout.unref?.();
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      throw new AppError(
        502,
        'AUTOMATION_WEBHOOK_FAILED',
        `The webhook responded with HTTP ${response.status}`,
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      'AUTOMATION_WEBHOOK_FAILED',
      error instanceof Error ? error.message.slice(0, 300) : 'The webhook request failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeAutomationAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  payload: Record<string, unknown>,
  runId: string,
): Promise<void> {
  // Re-check permissions for every action before doing any work.
  await assertOwnerCanManage(deps.prisma, automation);

  switch (automation.action) {
    case 'SEND_NOTIFICATION':
      await executeNotificationAction(deps, automation, payload, runId);
      return;
    case 'CREATE_TASK':
      await executeCreateTaskAction(deps, automation, payload);
      return;
    case 'SEND_WEBHOOK':
      await executeWebhookAction(deps, automation, payload, runId);
      return;
    default:
      throw new AppError(400, 'AUTOMATION_UNKNOWN_ACTION', 'Unsupported automation action');
  }
}

function backoffFor(attempts: number): number {
  const delay = MIN_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Create one run per enabled scheduled automation for the current period. The
 * unique event key makes repeated calls safe.
 */
export async function enqueueScheduledRuns(
  deps: AutomationEngineDependencies,
  at?: Date,
): Promise<ScheduledRunsResult> {
  const now = at ?? deps.now?.() ?? new Date();
  const dailyKey = `schedule:daily:${now.toISOString().slice(0, 10)}`;
  const weeklyKey = `schedule:weekly:${isoWeekKey(now)}`;

  const automations = await deps.prisma.automation.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      trigger: { in: ['SCHEDULED_DAILY', 'SCHEDULED_WEEKLY'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: { id: true, workspaceId: true, trigger: true },
  });

  if (automations.length === 0) {
    return { queued: 0 };
  }

  const result = await deps.prisma.automationRun.createMany({
    data: automations.map((automation) => ({
      automationId: automation.id,
      eventKey: automation.trigger === 'SCHEDULED_DAILY' ? dailyKey : weeklyKey,
      payload: {
        workspaceId: automation.workspaceId,
        trigger: automation.trigger,
        scheduledFor: now.toISOString(),
      } as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  return { queued: result.count };
}

type ClaimedRun = AutomationRun & { automation: Automation };

/**
 * Claim and execute due runs.
 *
 * The claim uses `FOR UPDATE SKIP LOCKED`, so several API instances can run the
 * worker without executing the same run twice. A run that stays RUNNING for
 * longer than `STALE_RUNNING_MS` (for example because the process crashed) is
 * marked FAILED instead of being executed again: most actions are not exactly
 * once, and silently repeating a task creation or notification would be worse
 * than surfacing the failure.
 */
export async function processPendingRuns(
  deps: AutomationEngineDependencies,
  options: { limit?: number } = {},
): Promise<ProcessRunsResult> {
  const now = deps.now?.() ?? new Date();
  const limit = options.limit ?? BATCH_SIZE;
  const log = deps.logger ?? defaultLogger;

  await deps.prisma.automationRun.updateMany({
    where: {
      status: 'RUNNING',
      startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) },
    },
    data: {
      status: 'FAILED',
      completedAt: now,
      error: 'Execution did not finish before the stale-run timeout',
    },
  });

  const claimed = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "AutomationRun"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return [] as ClaimedRun[];
    }

    await tx.automationRun.updateMany({
      where: { id: { in: ids } },
      data: { status: 'RUNNING', startedAt: now },
    });

    return tx.automationRun.findMany({
      where: { id: { in: ids } },
      include: { automation: true },
    });
  });

  const result: ProcessRunsResult = {
    claimed: claimed.length,
    succeeded: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };

  for (const run of claimed) {
    const automation = run.automation;

    if (!automation.enabled || automation.deletedAt) {
      await deps.prisma.automationRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'SKIPPED', completedAt: now, error: null },
      });
      result.skipped += 1;
      continue;
    }

    const payload = asPayload(run.payload);
    if (!conditionMatches(automation.condition, payload)) {
      await deps.prisma.automationRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'SKIPPED', completedAt: now, error: null },
      });
      result.skipped += 1;
      continue;
    }

    try {
      await executeAutomationAction(deps, automation, payload, run.id);
      await deps.prisma.automationRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          completedAt: now,
          attempts: { increment: 1 },
          error: null,
        },
      });
      result.succeeded += 1;
    } catch (error) {
      const attempts = run.attempts + 1;
      const maxAttempts = Math.max(1, automation.maxRetries + 1);
      const message =
        error instanceof Error ? error.message.slice(0, 500) : 'The automation action failed';

      if (attempts >= maxAttempts) {
        await deps.prisma.automationRun.updateMany({
          where: { id: run.id, status: 'RUNNING' },
          data: { status: 'FAILED', completedAt: now, attempts, error: message },
        });
        result.failed += 1;
      } else {
        await deps.prisma.automationRun.updateMany({
          where: { id: run.id, status: 'RUNNING' },
          data: {
            status: 'PENDING',
            attempts,
            error: message,
            nextAttemptAt: new Date(now.getTime() + backoffFor(attempts)),
          },
        });
        result.retried += 1;
      }

      log.error('automation_run_failed', {
        automationId: automation.id,
        runId: run.id,
        action: automation.action,
        attempts,
        maxAttempts,
        error: message,
      });
    }
  }

  return result;
}
