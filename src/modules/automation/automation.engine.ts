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
  TaskStatus,
  WorkspaceRole,
} from '@prisma/client';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { ProjectCapability, requireProjectAccess } from '../authorization/project.policy';
import { generateTaskKey } from '../tasks/task.service';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { createAutomationRunQueue } from './automation.queue';
import { createMessageService } from '../messaging/message.service';
import type { SlackEventNotifier } from '../integrations/slack.events';

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
const TASK_STATUSES: readonly TaskStatus[] = [
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
];

export interface AutomationEngineDependencies {
  prisma: PrismaClient;
  logger?: Logger;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Override the SSRF guard in tests; production always uses the default. */
  resolveWebhookUrl?: (raw: string) => Promise<URL>;
  notificationType?: NotificationType;
  /** Backs the explicit `SEND_SLACK_MESSAGE` automation action. */
  slackNotifier?: SlackEventNotifier;
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

function resolveTargetTaskId(
  automation: Automation,
  payload: Record<string, unknown>,
): string | null {
  const config = asStringRecord(automation.actionConfig);
  const fromConfig = config.taskId;
  const fromPayload = typeof payload.taskId === 'string' ? payload.taskId : null;
  return fromConfig || fromPayload;
}

async function executeSetFieldAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  payload: Record<string, unknown>,
): Promise<void> {
  const config = asStringRecord(automation.actionConfig);
  const taskId = resolveTargetTaskId(automation, payload);
  const field = config.field?.trim();
  const rawValue = config.value;
  if (!taskId || !field || rawValue === undefined) {
    throw new AppError(
      400,
      'AUTOMATION_INVALID_ACTION_CONFIG',
      'SET_FIELD requires a taskId (in config or payload), field, and value',
    );
  }

  const workspaceRole = await assertOwnerCanManage(deps.prisma, automation);
  const task = await deps.prisma.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { workspaceId: automation.workspaceId } },
    select: { id: true, projectId: true, key: true, status: true },
  });
  if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Target task not found for automation action');

  await requireProjectAccess(deps.prisma, {
    userId: automation.createdById,
    workspaceId: automation.workspaceId,
    projectId: task.projectId,
    workspaceRole,
    capability: ProjectCapability.ManageTask,
  });

  const data: Prisma.TaskUpdateInput = {};
  switch (field) {
    case 'status': {
      // BE-7: a waiting clarification can only be resolved by answer/cancel.
      if (task.status === 'AWAITING_CLARIFICATION') {
        throw new AppError(
          409,
          'INVALID_CLARIFICATION_STATE',
          'A task awaiting clarification cannot be changed by automation',
        );
      }
      const status = rawValue.toUpperCase();
      if (!(TASK_STATUSES as readonly string[]).includes(status)) {
        throw new AppError(
          400,
          'AUTOMATION_INVALID_FIELD_VALUE',
          `"${rawValue}" is not a valid task status`,
        );
      }
      data.status = status as TaskStatus;
      // Keep the completion timestamp consistent with the tasks API. Without
      // this, reporting would count a task as open after automation approved it.
      data.completedAt = status === 'APPROVED' ? new Date() : null;
      break;
    }
    case 'priority': {
      const priority = rawValue.toUpperCase();
      if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
        throw new AppError(
          400,
          'AUTOMATION_INVALID_FIELD_VALUE',
          `"${rawValue}" is not a valid task priority`,
        );
      }
      data.priority = priority as TaskPriority;
      break;
    }
    case 'category':
      data.category = rawValue === '' || rawValue === 'null' ? null : rawValue;
      break;
    case 'title': {
      const title = rawValue.trim();
      if (!title) {
        throw new AppError(400, 'AUTOMATION_INVALID_FIELD_VALUE', 'A task title cannot be empty');
      }
      data.title = title.slice(0, 300);
      break;
    }
    case 'description':
      data.description = rawValue === 'null' ? null : rawValue;
      break;
    case 'dueDate':
    case 'startDate': {
      if (rawValue === '' || rawValue === 'null') {
        data[field] = null;
        break;
      }
      const date = new Date(rawValue);
      if (Number.isNaN(date.getTime())) {
        throw new AppError(
          400,
          'AUTOMATION_INVALID_FIELD_VALUE',
          `"${rawValue}" is not a valid date`,
        );
      }
      data[field] = date;
      break;
    }
    default:
      throw new AppError(
        400,
        'AUTOMATION_UNSUPPORTED_FIELD',
        `Field "${field}" cannot be set by automation`,
      );
  }

  await deps.prisma.task.update({ where: { id: task.id }, data });
  await recordAuditEvent(deps.prisma, {
    workspaceId: automation.workspaceId,
    actorId: automation.createdById,
    action: 'automation.task_field_set',
    targetType: 'Task',
    targetId: task.id,
    metadata: { automationId: automation.id, field, value: rawValue, key: task.key },
  });
}

async function executeAssignAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  payload: Record<string, unknown>,
): Promise<void> {
  const config = asStringRecord(automation.actionConfig);
  const taskId = resolveTargetTaskId(automation, payload);
  const assigneeIds = splitList(config.userIds ?? config.userId ?? config.assigneeId);
  if (!taskId || assigneeIds.length === 0) {
    throw new AppError(
      400,
      'AUTOMATION_INVALID_ACTION_CONFIG',
      'ASSIGN requires a taskId (in config or payload) and userIds/userId/assigneeId',
    );
  }

  const workspaceRole = await assertOwnerCanManage(deps.prisma, automation);
  const task = await deps.prisma.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { workspaceId: automation.workspaceId } },
    select: { id: true, projectId: true, key: true, title: true },
  });
  if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Target task not found for automation action');

  await requireProjectAccess(deps.prisma, {
    userId: automation.createdById,
    workspaceId: automation.workspaceId,
    projectId: task.projectId,
    workspaceRole,
    capability: ProjectCapability.ManageTask,
  });

  const activeMembers = await deps.prisma.workspaceMembership.findMany({
    where: { workspaceId: automation.workspaceId, userId: { in: assigneeIds }, status: 'ACTIVE' },
    select: { userId: true },
  });
  if (activeMembers.length === 0) {
    throw new AppError(400, 'AUTOMATION_NO_RECIPIENTS', 'No active workspace member matches assignees');
  }

  await deps.prisma.$transaction(async (tx) => {
    for (const member of activeMembers) {
      await tx.taskAssignee.upsert({
        where: { taskId_userId: { taskId: task.id, userId: member.userId } },
        create: { taskId: task.id, userId: member.userId, assignedBy: automation.createdById },
        update: {},
      });

      // Mirror the normal assignment side effect. The engine does not emit a
      // task.assigned domain event, so an automation that assigns work cannot
      // recursively trigger itself.
      if (member.userId !== automation.createdById) {
        await createNotification(tx, {
          userId: member.userId,
          type: 'TASK_ASSIGNED',
          title: 'Task assigned to you',
          data: {
            workspaceId: automation.workspaceId,
            projectId: task.projectId,
            taskId: task.id,
            automationId: automation.id,
          },
        });
      }
    }
    await recordAuditEvent(tx, {
      workspaceId: automation.workspaceId,
      actorId: automation.createdById,
      action: 'automation.task_assigned',
      targetType: 'Task',
      targetId: task.id,
      metadata: {
        automationId: automation.id,
        assigneeIds: activeMembers.map((m) => m.userId),
        key: task.key,
        title: task.title,
      },
    });
  });
}

async function executePostMessageAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  _payload: Record<string, unknown>,
): Promise<void> {
  const config = asStringRecord(automation.actionConfig);
  const channelId = config.channelId?.trim();
  const body = (config.body ?? config.message ?? '').trim();
  if (!channelId || !body) {
    throw new AppError(
      400,
      'AUTOMATION_INVALID_ACTION_CONFIG',
      'POST_MESSAGE requires channelId and body/message',
    );
  }

  await assertOwnerCanManage(deps.prisma, automation);
  const channel = await deps.prisma.channel.findFirst({
    where: { id: channelId, workspaceId: automation.workspaceId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!channel) {
    throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Target channel not found for automation action');
  }

  const messageService = createMessageService(deps.prisma);
  await messageService.send({
    userId: automation.createdById,
    workspaceId: automation.workspaceId,
    channelId: channel.id,
    body,
  });
}

async function executeSlackMessageAction(
  deps: AutomationEngineDependencies,
  automation: Automation,
  runId: string,
): Promise<void> {
  await assertOwnerCanManage(deps.prisma, automation);
  if (!deps.slackNotifier) {
    throw new AppError(
      503,
      'SLACK_NOTIFIER_UNAVAILABLE',
      'Slack notifications are not available in this deployment',
    );
  }

  const result = await deps.slackNotifier.automationAction({
    workspaceId: automation.workspaceId,
    automationId: automation.id,
    automationName: automation.name,
    runId,
    trigger: automation.trigger,
  });

  // `duplicate` means this run already queued its message and `disabled` means
  // the workspace turned Slack notifications off; both are successful no-ops.
  // A missing integration or channel is a real misconfiguration and must be
  // visible instead of silently doing nothing.
  if (!result.queued && result.reason === 'not_configured') {
    throw new AppError(
      409,
      'SLACK_NOT_CONFIGURED',
      'Connect Slack and choose a notification channel before running this automation',
    );
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
    case 'SET_FIELD':
      await executeSetFieldAction(deps, automation, payload);
      return;
    case 'ASSIGN':
      await executeAssignAction(deps, automation, payload);
      return;
    case 'POST_MESSAGE':
      await executePostMessageAction(deps, automation, payload);
      return;
    case 'SEND_SLACK_MESSAGE':
      await executeSlackMessageAction(deps, automation, runId);
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

  if (result.count > 0) {
    // Push the newly created runs onto the Redis queue. The periodic database
    // poll remains a fallback, but the normal path should not wait for it.
    try {
      const runs = await deps.prisma.automationRun.findMany({
        where: {
          automationId: { in: automations.map((automation) => automation.id) },
          eventKey: { in: [dailyKey, weeklyKey] },
          status: 'PENDING',
        },
        select: { id: true },
      });
      if (runs.length > 0) {
        await createAutomationRunQueue({ logger: deps.logger ?? defaultLogger }).enqueueMany(
          runs.map((run) => run.id),
        );
      }
    } catch (error) {
      // Queue dispatch is best effort; the DB polling fallback will pick these up.
      (deps.logger ?? defaultLogger).warn('automation_schedule_queue_dispatch_failed', {
        error,
        queued: result.count,
      });
    }
  }

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


async function recoverStaleRuns(deps: AutomationEngineDependencies, now: Date): Promise<void> {
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
}

/**
 * Claim and execute a specific queued run by ID (used by Redis job queue consumers).
 */
export async function processAutomationRunById(
  deps: AutomationEngineDependencies,
  runId: string,
): Promise<ProcessRunsResult> {
  const now = deps.now?.() ?? new Date();
  await recoverStaleRuns(deps, now);

  const claimed = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "AutomationRun"
      WHERE "id" = ${runId}::uuid AND "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [] as ClaimedRun[];
    await tx.automationRun.updateMany({
      where: { id: runId },
      data: { status: 'RUNNING', startedAt: now },
    });
    return tx.automationRun.findMany({
      where: { id: runId },
      include: { automation: true },
    });
  });

  return executeClaimedRuns(deps, claimed, now);
}

/**
 * Claim and execute due runs (DB polling fallback / maintenance).
 */
export async function processPendingRuns(
  deps: AutomationEngineDependencies,
  options: { limit?: number } = {},
): Promise<ProcessRunsResult> {
  const now = deps.now?.() ?? new Date();
  const limit = options.limit ?? BATCH_SIZE;

  await recoverStaleRuns(deps, now);

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

  return executeClaimedRuns(deps, claimed, now);
}

/**
 * Execute a set of runs that the caller has already claimed.
 *
 * Claiming is separate from execution so the Redis consumer can claim one run
 * by id while the polling fallback claims a batch. Both paths share exactly the
 * same permission checks, retry policy and run-history semantics.
 */
async function executeClaimedRuns(
  deps: AutomationEngineDependencies,
  claimed: ClaimedRun[],
  now: Date,
): Promise<ProcessRunsResult> {
  const log = deps.logger ?? defaultLogger;
  const result: ProcessRunsResult = {
    claimed: claimed.length,
    succeeded: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };

  for (const run of claimed) {
    const automation = run.automation;

    // The automation may have been disabled or deleted while the run waited in
    // the queue. Never execute work the workspace has since switched off.
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
        error instanceof AppError
          ? `${error.code}: ${error.message}`.slice(0, 500)
          : error instanceof Error
            ? error.message.slice(0, 500)
            : 'The automation action failed';

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
