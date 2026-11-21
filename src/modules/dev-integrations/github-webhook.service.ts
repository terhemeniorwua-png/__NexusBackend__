import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent, TaskAuditAction } from '../../services/audit';
import { encryptIntegrationToken } from '../integrations/token-crypto';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

export type GithubWebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'unverified' | 'invalid';

export function verifyGithubWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!secret || !signatureHeader) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  const digest = match?.[1];
  if (!digest) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(digest.toLowerCase(), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function safeString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function prState(payload: Record<string, unknown>, pr: Record<string, unknown>): string | null {
  const merged = pr.merged === true || pr.merged_at != null;
  if (merged) return 'merged';
  if (pr.draft === true) return 'draft';
  const state = typeof pr.state === 'string' ? pr.state : null;
  return state;
}

export async function processGithubWebhook(input: {
  prisma?: PrismaClient;
  rawBody: Buffer;
  signature: string | undefined;
  secret: string;
  deliveryId: string | undefined;
  event: string | undefined;
  logger?: Logger;
}): Promise<GithubWebhookOutcome> {
  const prisma = input.prisma ?? getPrismaClient();
  const log = input.logger ?? defaultLogger;

  if (!input.secret) {
    return 'unverified';
  }
  if (!verifyGithubWebhookSignature(input.rawBody, input.signature, input.secret)) {
    return 'unverified';
  }

  const deliveryId = safeString(input.deliveryId, 200);
  const event = safeString(input.event, 100);
  if (!deliveryId || !event) {
    return 'invalid';
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    return 'invalid';
  }
  const root = asRecord(payload);
  if (!root) return 'invalid';

  const installation = asRecord(root.installation);
  const repository = asRecord(root.repository);
  const installationId = installation && (typeof installation.id === 'number' || typeof installation.id === 'string') ? String(installation.id) : null;
  const repositoryFullName = repository && typeof repository.full_name === 'string' ? repository.full_name : null;

  // Idempotency claim
  try {
    await prisma.gitHubWebhookDelivery.create({
      data: {
        provider: 'GITHUB',
        deliveryId,
        event,
        installationId,
        repositoryFullName,
        status: 'RECEIVED',
      },
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
    if (code === 'P2002') {
      return 'duplicate';
    }
    throw error;
  }

  let outcome: GithubWebhookOutcome = 'ignored';
  let errorMessage: string | null = null;

  try {
    if (event === 'pull_request') {
      const pr = asRecord(root.pull_request);
      if (pr) {
        const externalId = pr.id != null ? String(pr.id) : null;
        if (externalId) {
          const head = asRecord(pr.head);
          const base = asRecord(pr.base);
          const prStateVal = prState(root, pr);
          const data = {
            externalNumber: typeof pr.number === 'number' ? pr.number : null,
            title: typeof pr.title === 'string' ? pr.title.slice(0, 500) : null,
            url: typeof pr.html_url === 'string' ? pr.html_url : null,
            ref: head && typeof head.ref === 'string' ? head.ref : null,
            headRef: head && typeof head.ref === 'string' ? head.ref : null,
            baseRef: base && typeof base.ref === 'string' ? base.ref : null,
            state: prStateVal,
          };
          const links = await prisma.taskDevLink.findMany({
            where: { provider: 'GITHUB', externalType: 'PULL_REQUEST', externalId },
            include: {
              task: {
                select: {
                  id: true,
                  status: true,
                  key: true,
                  projectId: true,
                  project: { select: { workspaceId: true } },
                },
              },
            },
          });
          if (links.length === 0) {
            outcome = 'ignored';
          } else {
            const isMerged = prStateVal === 'merged';
            for (const link of links) {
              await prisma.$transaction(async (tx) => {
                const linkUpdate: Record<string, unknown> = { ...data };
                if (isMerged) {
                  linkUpdate.mergedAt = new Date();
                }
                await tx.taskDevLink.update({ where: { id: link.id }, data: linkUpdate });
                if (isMerged) {
                  const task = link.task;
                  if (task.status === 'IN_PROGRESS' || task.status === 'CHANGES_REQUESTED') {
                    const updatedTask = await tx.task.updateMany({
                      where: { id: task.id, status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
                      data: {
                        status: 'SUBMITTED',
                        submittedAt: new Date(),
                        submittedById: null,
                        submissionSummary: null,
                        reviewFeedback: null,
                        reviewedAt: null,
                        reviewedById: null,
                      },
                    });
                    if (updatedTask.count > 0) {
                      await recordAuditEvent(tx, {
                        workspaceId: task.project.workspaceId,
                        actorId: undefined,
                        action: TaskAuditAction.TaskGithubPrMerged,
                        targetType: 'Task',
                        targetId: task.id,
                        metadata: {
                          source: 'GITHUB_WEBHOOK',
                          deliveryId,
                          event,
                          prNumber: data.externalNumber ?? null,
                          repositoryFullName,
                          fromStatus: task.status,
                          toStatus: 'SUBMITTED',
                          linkId: link.id,
                          externalId,
                        },
                      });
                    }
                  }
                }
              });
            }
            outcome = 'processed';
          }
        }
      }
    } else if (event === 'pull_request_review') {
      const action = typeof root.action === 'string' ? root.action : '';
      const review = asRecord(root.review);
      const pr = asRecord(root.pull_request);
      if (review && pr) {
        const externalId = pr.id != null ? String(pr.id) : null;
        if (externalId) {
          const links = await prisma.taskDevLink.findMany({
            where: { provider: 'GITHUB', externalType: 'PULL_REQUEST', externalId },
            include: { task: { select: { id: true, projectId: true, project: { select: { workspaceId: true } } } } },
          });
          if (links.length === 0) {
            outcome = 'ignored';
          } else {
            const user = asRecord(review.user);
            const reviewerLogin = user && typeof user.login === 'string' ? user.login.slice(0, 255) : null;
            const submittedAtStr = typeof review.submitted_at === 'string' ? review.submitted_at : null;
            const incomingReviewedAt = submittedAtStr ? new Date(submittedAtStr) : new Date();
            const reviewStateRaw = typeof review.state === 'string' ? review.state.toUpperCase() : null;
            let newReviewState: string | null = null;
            if (action === 'dismissed') {
              newReviewState = null;
            } else if (reviewStateRaw === 'APPROVED' || reviewStateRaw === 'CHANGES_REQUESTED' || reviewStateRaw === 'COMMENTED') {
              newReviewState = reviewStateRaw;
            } else if (reviewStateRaw === 'DISMISSED') {
              newReviewState = null;
            } else {
              newReviewState = null;
            }
            for (const link of links) {
              await prisma.$transaction(async (tx) => {
                const existing = await tx.taskDevLink.findUnique({ where: { id: link.id }, select: { reviewedAt: true } });
                if (existing?.reviewedAt && existing.reviewedAt.getTime() > incomingReviewedAt.getTime()) {
                  // out of order: ignore
                  return;
                }
                await tx.taskDevLink.update({
                  where: { id: link.id },
                  data: {
                    reviewState: newReviewState,
                    reviewerLogin: newReviewState ? reviewerLogin : null,
                    reviewedAt: newReviewState ? incomingReviewedAt : null,
                  },
                });
                await recordAuditEvent(tx, {
                  workspaceId: link.task.project.workspaceId,
                  actorId: undefined,
                  action: TaskAuditAction.TaskGithubReviewSynced,
                  targetType: 'TaskDevLink',
                  targetId: link.id,
                  metadata: {
                    source: 'GITHUB_WEBHOOK',
                    deliveryId,
                    event,
                    action,
                    prNumber: typeof pr.number === 'number' ? pr.number : null,
                    repositoryFullName,
                    reviewState: newReviewState,
                    reviewerLogin: newReviewState ? reviewerLogin : null,
                    taskId: link.taskId,
                  },
                });
              });
            }
            outcome = 'processed';
          }
        }
      } else {
        outcome = 'ignored';
      }
    } else if (event === 'installation') {
      const action = typeof root.action === 'string' ? root.action : '';
      if ((action === 'deleted' || action === 'suspend') && installationId) {
        const { decryptIntegrationToken } = await import('../integrations/token-crypto');
        const connections = await prisma.integrationConnection.findMany({
          where: { provider: 'GITHUB', status: { in: ['ACTIVE', 'PENDING', 'ERROR'] } },
          select: { id: true, encryptedCredentials: true },
        });
        let affected = 0;
        for (const conn of connections) {
          try {
            const plain = decryptIntegrationToken(conn.encryptedCredentials);
            const parsed = JSON.parse(plain) as { installationId?: number | string };
            if (String(parsed.installationId) === installationId) {
              const revokedMarker = encryptIntegrationToken(JSON.stringify({ revoked: true, reason: `installation_${action}`, at: new Date().toISOString() }));
              await prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { status: 'DISCONNECTED', revokedAt: new Date(), lastError: `GitHub installation ${action}`.slice(0, 500), encryptedCredentials: revokedMarker },
              });
              affected += 1;
            }
          } catch {
            // ignore unreadable credential payloads
          }
        }
        outcome = affected > 0 ? 'processed' : 'ignored';
      } else {
        outcome = 'ignored';
      }
    } else {
      outcome = 'ignored';
    }

    await prisma.gitHubWebhookDelivery.update({
      where: { provider_deliveryId: { provider: 'GITHUB', deliveryId } },
      data: { status: outcome.toUpperCase(), processedAt: new Date(), error: null },
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 500) : 'Processing failed';
    await prisma.gitHubWebhookDelivery.update({
      where: { provider_deliveryId: { provider: 'GITHUB', deliveryId } },
      data: { status: 'FAILED', processedAt: new Date(), error: errorMessage },
    }).catch(() => undefined);
    log.warn('github_webhook_processing_failed', { event, deliveryId, error });
    // Do not throw to avoid provider retries for handled-but-failed internal processing? Better to return processed-like ack after recording failure;
    // but to be safe we acknowledge (200) after recording failure so GitHub doesn't retry endlessly on our bug.
  }

  return outcome;
}
