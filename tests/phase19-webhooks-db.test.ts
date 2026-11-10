import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createWebhookService } from '../src/modules/webhooks/webhook.service';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const DB_FLAG = 'RUN_PHASE19_DB_TESTS';
let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE19_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl(DB_FLAG);
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env[DB_FLAG] === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

interface CapturedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

describe('Phase 19 outbound webhook database integration', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let service: ReturnType<typeof createWebhookService>;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let ownerId = '';
  let memberId = '';
  let workspaceId = '';
  let responseStatus = 200;
  const captured: CapturedRequest[] = [];

  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    captured.push({
      url: String(input),
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(responseStatus === 200 ? 'ok' : 'failed', { status: responseStatus });
  }) as typeof fetch;

  before(async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = database.prisma;
    service = createWebhookService(prisma, {
      fetchImpl,
      resolveWebhookUrl: async (raw) => new URL(raw),
    });
    const suffix = `${process.pid}-${Date.now()}`;

    const owner = await prisma.user.create({
      data: {
        email: `webhook-owner-${suffix}@example.test`,
        name: 'Webhook Owner',
        passwordHash: 'x',
        status: 'ACTIVE',
      },
    });
    const member = await prisma.user.create({
      data: {
        email: `webhook-member-${suffix}@example.test`,
        name: 'Webhook Member',
        passwordHash: 'x',
        status: 'ACTIVE',
      },
    });
    ownerId = owner.id;
    memberId = member.id;
    userIds.push(owner.id, member.id);

    const workspace = await prisma.workspace.create({
      data: { name: `Webhook ${suffix}`, slug: `webhook-${suffix}`, ownerId: owner.id },
    });
    workspaceId = workspace.id;
    workspaceIds.push(workspace.id);
    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
        { workspaceId, userId: member.id, role: 'MEMBER', status: 'ACTIVE' },
      ],
    });
  });

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  test('members cannot create a webhook and the secret is only returned once', async () => {
    await assert.rejects(() =>
      service.create({
        userId: memberId,
        workspaceId,
        url: 'https://example.test/hook',
        events: ['task.created'],
      }),
    );

    const created = await service.create({
      userId: ownerId,
      workspaceId,
      url: 'https://example.test/hook',
      events: ['task.created'],
      description: 'CI hook',
    });
    assert.ok(created.secret.length >= 32);
    const list = await service.list({ userId: ownerId, workspaceId });
    assert.equal(
      list.some((item) => item.id === created.id),
      true,
    );
    assert.equal(
      (list.find((item) => item.id === created.id) as unknown as { secret?: string }).secret,
      undefined,
    );
  });

  test('events are queued only for matching enabled subscriptions', async () => {
    const subscription = await prisma.webhookSubscription.findFirstOrThrow({
      where: { workspaceId },
    });
    const matched = await service.enqueueEvent({
      workspaceId,
      event: 'task.created',
      payload: { taskId: 'task-1', title: 'Build' },
    });
    assert.ok(matched >= 1);
    const unmatched = await service.enqueueEvent({
      workspaceId,
      event: 'member.joined',
      payload: { userId: 'user-1' },
    });
    assert.equal(unmatched, 0);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { subscriptionId: subscription.id },
    });
    assert.ok(deliveries.length >= 1);
    assert.ok(deliveries.every((delivery) => delivery.event === 'task.created'));
  });

  test('a successful delivery is signed and marks the subscription healthy', async () => {
    responseStatus = 200;
    captured.length = 0;
    const result = await service.processDeliveries({ limit: 10 });
    assert.ok(result.claimed >= 1);
    assert.ok(result.succeeded >= 1);
    assert.ok(captured.length >= 1);

    const request = captured[0]!;
    assert.equal(request.url, 'https://example.test/hook');
    const subscription = await prisma.webhookSubscription.findFirstOrThrow({
      where: { workspaceId },
    });
    const updated = await service.update({
      userId: ownerId,
      workspaceId,
      webhookId: subscription.id,
      secret: 'rotated-secret-value-123',
    });
    assert.ok('secret' in updated && typeof updated.secret === 'string');
    const secret = updated.secret;
    // The delivery above used the previous secret. Verify a fresh delivery with the rotated one.
    responseStatus = 200;
    captured.length = 0;
    await service.enqueueEvent({
      workspaceId,
      event: 'task.created',
      payload: { taskId: 'task-2' },
    });
    await service.processDeliveries({ limit: 10 });
    const fresh = captured[0]!;
    const expected = createHmac('sha256', secret).update(fresh.body).digest('hex');
    assert.equal(fresh.headers['x-nexus-signature'], `sha256=${expected}`);
    assert.equal(fresh.headers['x-nexus-event'], 'task.created');

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { subscriptionId: subscription.id, event: 'task.created' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(delivery.status, 'SUCCEEDED');
    assert.equal(delivery.responseStatus, 200);
    const refreshedSubscription = await prisma.webhookSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    assert.ok(refreshedSubscription.lastDeliveryAt);
  });

  test('a permanent failure is recorded and can be retried manually', async () => {
    responseStatus = 500;
    captured.length = 0;
    const subscription = await prisma.webhookSubscription.findFirstOrThrow({
      where: { workspaceId },
    });
    await service.enqueueEvent({
      workspaceId,
      event: 'task.created',
      payload: { taskId: 'task-fail' },
    });
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { maxRetries: 1 } });

    const result = await service.processDeliveries({ limit: 10 });
    assert.ok(result.failed >= 1);
    const failed = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.lastError ?? '', /HTTP 500/);
    const failedSubscription = await prisma.webhookSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    assert.match(failedSubscription.lastError ?? '', /HTTP 500/);

    responseStatus = 200;
    const retried = await service.retryDelivery({
      userId: ownerId,
      workspaceId,
      webhookId: subscription.id,
      deliveryId: delivery.id,
    });
    assert.equal(retried.status, 'PENDING');
    const retryResult = await service.processDeliveries({ limit: 10 });
    assert.ok(retryResult.succeeded >= 1);
    const succeeded = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    assert.equal(succeeded.status, 'SUCCEEDED');
  });

  test('disabling a subscription fails queued deliveries instead of sending them', async () => {
    responseStatus = 200;
    const subscription = await prisma.webhookSubscription.findFirstOrThrow({
      where: { workspaceId },
    });
    await service.enqueueEvent({
      workspaceId,
      event: 'task.created',
      payload: { taskId: 'task-disabled' },
    });
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { subscriptionId: subscription.id },
      orderBy: { createdAt: 'desc' },
    });
    await service.update({
      userId: ownerId,
      workspaceId,
      webhookId: subscription.id,
      enabled: false,
    });
    const result = await service.processDeliveries({ limit: 10 });
    assert.ok(result.failed >= 1);
    const failed = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.lastError ?? '', /disabled/);
    await service.update({
      userId: ownerId,
      workspaceId,
      webhookId: subscription.id,
      enabled: true,
    });
  });

  test('deleting a subscription removes its delivery history', async () => {
    const subscription = await prisma.webhookSubscription.findFirstOrThrow({
      where: { workspaceId },
    });
    await service.delete({ userId: ownerId, workspaceId, webhookId: subscription.id });
    assert.equal(await prisma.webhookSubscription.count({ where: { id: subscription.id } }), 0);
    assert.equal(
      await prisma.webhookDelivery.count({ where: { subscriptionId: subscription.id } }),
      0,
    );
  });
});
