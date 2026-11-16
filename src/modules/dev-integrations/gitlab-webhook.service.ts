/* eslint-disable @typescript-eslint/no-explicit-any */ // TODO(types): replace any with real types
import { timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

export type GitlabWebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'unverified' | 'invalid';

export function verifyGitlabWebhookToken(headerToken: string | undefined, secret: string): boolean {
  if (!secret || !headerToken) return false;
  const a = Buffer.from(headerToken);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

function mrState(attrs: Record<string, unknown>): string | null {
  const state = typeof attrs.state === 'string' ? attrs.state : null;
  const action = typeof attrs.action === 'string' ? attrs.action : null;
  if (state === 'merged' || action === 'merge') return 'merged';
  if (state === 'closed' || action === 'close') return 'closed';
  if (attrs.work_in_progress === true || attrs.draft === true) return 'draft';
  if (state === 'opened' || state === 'open' || action === 'open' || action === 'reopen') return 'open';
  return state;
}

export async function processGitlabWebhook(input: {
  prisma?: PrismaClient;
  rawBody: Buffer;
  token: string | undefined;
  secret: string;
  event: string | undefined;
  eventUuid?: string | undefined;
  logger?: Logger;
}): Promise<GitlabWebhookOutcome> {
  const prisma = input.prisma ?? getPrismaClient();
  const log = input.logger ?? defaultLogger;

  if (!input.secret) return 'unverified';
  if (!verifyGitlabWebhookToken(input.token, input.secret)) return 'unverified';

  let payload: unknown;
  try { payload = JSON.parse(input.rawBody.toString('utf8')); } catch { return 'invalid'; }
  const root = asRecord(payload);
  if (!root) return 'invalid';

  const event = safeString(input.event, 100) || safeString(root.event_type, 100) || safeString(root.object_kind, 100) || 'unknown';
  const deliveryId = safeString(input.eventUuid, 200) || safeString((root as any).event_uuid, 200) || safeString(root.object_kind ? `${root.object_kind}:${(root.object_attributes as any)?.id ?? (root.object_attributes as any)?.iid ?? ''}:${(root.object_attributes as any)?.updated_at ?? ''}` : null, 200);
  if (!deliveryId) return 'invalid';

  const project = asRecord(root.project);
  const projectIdExternal = project && project.id != null ? String(project.id) : (root.project_id != null ? String(root.project_id) : null);

  try {
    await prisma.gitLabWebhookDelivery.create({
      data: { provider: 'GITLAB', deliveryId, event, projectIdExternal, status: 'RECEIVED' },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') return 'duplicate';
    throw error;
  }

  let outcome: GitlabWebhookOutcome = 'ignored';
  try {
    const objectKind = safeString(root.object_kind, 50);
    if (objectKind === 'merge_request') {
      const attrs = asRecord(root.object_attributes);
      if (attrs) {
        const externalId = attrs.id != null ? String(attrs.id) : null;
        if (externalId) {
          const data = {
            externalNumber: typeof attrs.iid === 'number' ? attrs.iid : (typeof attrs.iid === 'string' ? Number(attrs.iid) || null : null),
            title: typeof attrs.title === 'string' ? attrs.title.slice(0, 500) : null,
            url: typeof attrs.url === 'string' ? attrs.url : null,
            ref: typeof attrs.source_branch === 'string' ? attrs.source_branch : null,
            headRef: typeof attrs.source_branch === 'string' ? attrs.source_branch : null,
            baseRef: typeof attrs.target_branch === 'string' ? attrs.target_branch : null,
            state: mrState(attrs),
          };
          const updated = await prisma.taskDevLink.updateMany({
            where: { provider: 'GITLAB', externalType: 'PULL_REQUEST', externalId },
            data,
          });
          outcome = updated.count > 0 ? 'processed' : 'ignored';
        }
      }
    } else {
      outcome = 'ignored';
    }

    await prisma.gitLabWebhookDelivery.update({
      where: { provider_deliveryId: { provider: 'GITLAB', deliveryId } },
      data: { status: outcome.toUpperCase(), processedAt: new Date(), error: null },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message.slice(0, 500) : 'Processing failed';
    await prisma.gitLabWebhookDelivery.update({
      where: { provider_deliveryId: { provider: 'GITLAB', deliveryId } },
      data: { status: 'FAILED', processedAt: new Date(), error: msg },
    }).catch(() => undefined);
    log.warn('gitlab_webhook_processing_failed', { event, deliveryId, error });
  }

  return outcome;
}
