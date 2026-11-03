import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient, UserStatus } from '@prisma/client';
import { parseEnv, type AppConfig } from '../src/config/env';
import { createEmailDeliveryService, type EmailDeliveryService } from '../src/services/email';
import {
  createMentionEmailNotifier,
  mentionEmailIdempotencyKey,
  type MentionEmailNotifier,
} from '../src/services/mention-email-notifier';
import type { EmailTransport } from '../src/services/providers/email';
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 4.3 mention email integration tests.
 *
 * The real PostgreSQL schema and the real transactional outbox are used. A
 * fake transport only satisfies the delivery service contract: the tests never
 * contact a provider because no worker claims the queued rows.
 */

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE4_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE4_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

let uniqueCounter = 0;

function uniqueValue(prefix: string): string {
  uniqueCounter += 1;

  return `${prefix}.${process.pid}.${uniqueCounter}.${Date.now()}`;
}

function uniqueEmail(prefix: string): string {
  return `${uniqueValue(prefix)}@example.com`;
}

const neverCalledTransport: EmailTransport = {
  provider: 'phase4.3-mention-test',
  async send() {
    throw new Error('The test transport must not be called without a worker');
  },
  async verify(): Promise<void> {
    // Nothing to verify.
  },
  async close(): Promise<void> {
    // Nothing to close.
  },
};

describe('Phase 4.3 mention email notifier', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let config: AppConfig;
  let delivery: EmailDeliveryService;
  let notifier: MentionEmailNotifier;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const emailAddresses: string[] = [];

  interface Fixture {
    workspaceId: string;
    projectId: string;
    taskId: string;
    commentId: string;
    authorId: string;
    authorEmail: string;
    mentionedUserId: string;
    mentionedEmail: string;
    notificationId: string;
  }

  async function createFixture(options: { mentionedStatus?: UserStatus } = {}): Promise<Fixture> {
    const now = new Date();
    const authorEmail = uniqueEmail('mention-author');
    const mentionedEmail = uniqueEmail('mention-recipient');

    emailAddresses.push(authorEmail, mentionedEmail);

    const author = await prisma.user.create({
      data: {
        email: authorEmail,
        passwordHash: 'not-used',
        name: 'Ada Lovelace',
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    const mentioned = await prisma.user.create({
      data: {
        email: mentionedEmail,
        passwordHash: 'not-used',
        name: 'Grace Hopper',
        status: options.mentionedStatus ?? 'ACTIVE',
        emailVerifiedAt: now,
      },
    });

    userIds.push(author.id, mentioned.id);

    const workspace = await prisma.workspace.create({
      data: {
        name: uniqueValue('Analytical Engines'),
        slug: uniqueValue('engines'),
        ownerId: author.id,
      },
    });

    workspaceIds.push(workspace.id);

    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId: workspace.id, userId: author.id, role: 'OWNER' },
        { workspaceId: workspace.id, userId: mentioned.id, role: 'MEMBER' },
      ],
    });

    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Compiler',
        key: uniqueValue('ENG'),
        ownerId: author.id,
        visibility: 'WORKSPACE',
      },
    });

    await prisma.projectMembership.create({
      data: { projectId: project.id, userId: mentioned.id, role: 'MEMBER' },
    });

    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        key: uniqueValue('ENG-TASK'),
        title: 'Review parser',
        creatorId: author.id,
      },
    });

    const comment = await prisma.comment.create({
      data: {
        taskId: task.id,
        authorId: author.id,
        body: 'Hi @Grace, please review the parser.',
      },
    });

    const notification = await prisma.notification.create({
      data: {
        userId: mentioned.id,
        type: 'MENTION',
        title: 'Ada Lovelace mentioned you',
        link: `/projects/${project.id}/tasks/${task.id}#comment-${comment.id}`,
      },
    });

    return {
      workspaceId: workspace.id,
      projectId: project.id,
      taskId: task.id,
      commentId: comment.id,
      authorId: author.id,
      authorEmail,
      mentionedUserId: mentioned.id,
      mentionedEmail,
      notificationId: notification.id,
    };
  }

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = database.prisma;
    config = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'https://app.example.com',
      JWT_ACCESS_SECRET: 'phase4.3-mention-integration-test-access-secret',
      BCRYPT_SALT_ROUNDS: '4',
      EMAIL_PROVIDER: 'disabled',
      EMAIL_FROM_ADDRESS: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'Nexus',
    });

    const log = new Logger('silent');

    delivery = createEmailDeliveryService({
      prisma,
      transport: neverCalledTransport,
      config,
      logger: log,
    });

    notifier = createMentionEmailNotifier(config, {
      prisma,
      logger: log,
      send: (message) => delivery.enqueue(message),
    });
  });

  after(async () => {
    if (prisma) {
      await prisma.emailDelivery.deleteMany({
        where: { toAddress: { in: emailAddresses } },
      });
      await prisma.emailSuppression.deleteMany({
        where: { emailAddress: { in: emailAddresses.map((email) => email.toLowerCase()) } },
      });

      if (workspaceIds.length > 0) {
        await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      }

      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }

      await prisma.$disconnect();
    }
  });

  test('queues the mention template to the mentioned project member', async () => {
    const fixture = await createFixture();
    const result = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    assert.equal(result.status, 'queued');
    assert.equal(result.accepted, true);
    assert.ok(result.deliveryId);

    const row = await prisma.emailDelivery.findUnique({
      where: { id: result.deliveryId },
    });

    assert.ok(row);
    assert.equal(row.toAddress, fixture.mentionedEmail);
    assert.equal(row.template, 'mention');
    assert.match(row.subject, /Ada Lovelace mentioned you in Review parser/);
    assert.match(row.textBody, /Hi Grace Hopper/);
    assert.match(row.textBody, /Ada Lovelace mentioned you in Review parser/);
    assert.match(
      row.textBody,
      new RegExp(
        `https://app\\.example\\.com/projects/${fixture.projectId}/tasks/${fixture.taskId}#comment-${fixture.commentId}`,
      ),
    );
    assert.equal(
      row.idempotencyKey,
      mentionEmailIdempotencyKey(fixture.commentId, fixture.mentionedUserId),
    );
    const metadata = row.metadata as Record<string, unknown>;

    assert.equal(metadata.commentId, fixture.commentId);
    assert.equal(metadata.taskId, fixture.taskId);
    assert.equal(metadata.projectId, fixture.projectId);
    assert.equal(metadata.workspaceId, fixture.workspaceId);
  });

  test('re-processing the same mention event creates one delivery', async () => {
    const fixture = await createFixture();
    const first = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });
    const duplicate = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    assert.equal(first.status, 'queued');
    assert.equal(duplicate.status, 'queued');
    assert.equal(duplicate.deliveryId, first.deliveryId);

    const rows = await prisma.emailDelivery.findMany({
      where: { toAddress: fixture.mentionedEmail },
    });

    assert.equal(rows.length, 1);
  });

  test('an edited comment does not enqueue a second email for the same mention', async () => {
    const fixture = await createFixture();
    const first = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    await prisma.comment.update({
      where: { id: fixture.commentId },
      data: { body: 'Edited: Hi @Grace, please review the parser again.', editedAt: new Date() },
    });

    const afterEdit = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    assert.equal(afterEdit.status, 'queued');
    assert.equal(afterEdit.deliveryId, first.deliveryId);
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.mentionedEmail } }),
      1,
    );
  });

  test('the author is never sent an email for mentioning themselves', async () => {
    const fixture = await createFixture();
    const result = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.authorId,
    });

    assert.equal(result.status, 'ineligible');
    assert.equal(result.accepted, false);
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.authorEmail } }),
      0,
    );
  });

  test('an unresolved comment or user is not emailed', async () => {
    const fixture = await createFixture();

    const missingComment = await notifier.notify({
      commentId: 'missing-comment',
      mentionedUserId: fixture.mentionedUserId,
    });
    const missingUser = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: 'missing-user',
    });

    assert.equal(missingComment.status, 'not_found');
    assert.equal(missingUser.status, 'ineligible');
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.mentionedEmail } }),
      0,
    );
  });

  test('a deleted comment or inactive recipient is not emailed', async () => {
    const deleted = await createFixture();
    await prisma.comment.update({
      where: { id: deleted.commentId },
      data: { deletedAt: new Date() },
    });

    const deletedResult = await notifier.notify({
      commentId: deleted.commentId,
      mentionedUserId: deleted.mentionedUserId,
    });
    assert.equal(deletedResult.status, 'not_found');

    const inactive = await createFixture({ mentionedStatus: 'SUSPENDED' });
    const inactiveResult = await notifier.notify({
      commentId: inactive.commentId,
      mentionedUserId: inactive.mentionedUserId,
    });
    assert.equal(inactiveResult.status, 'ineligible');

    assert.equal(
      await prisma.emailDelivery.count({
        where: { toAddress: { in: [deleted.mentionedEmail, inactive.mentionedEmail] } },
      }),
      0,
    );
  });

  test('a user outside the workspace is not emailed', async () => {
    const fixture = await createFixture();
    const outsiderEmail = uniqueEmail('mention-outsider');
    emailAddresses.push(outsiderEmail);

    const outsider = await prisma.user.create({
      data: {
        email: outsiderEmail,
        passwordHash: 'not-used',
        name: 'Outside User',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    userIds.push(outsider.id);

    const result = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: outsider.id,
    });

    assert.equal(result.status, 'ineligible');
    assert.equal(await prisma.emailDelivery.count({ where: { toAddress: outsiderEmail } }), 0);
  });

  test('a suppressed address is skipped before a delivery is created', async () => {
    const fixture = await createFixture();

    await prisma.emailSuppression.create({
      data: {
        emailAddress: fixture.mentionedEmail.toLowerCase(),
        reason: 'HARD_BOUNCE',
      },
    });

    const result = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    assert.equal(result.status, 'suppressed');
    assert.equal(result.accepted, false);
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.mentionedEmail } }),
      0,
    );
  });

  test('a delivery failure leaves the comment and in-app notification intact', async () => {
    const fixture = await createFixture();
    const failing = createMentionEmailNotifier(config, {
      prisma,
      logger: new Logger('silent'),
      send: async () => {
        throw new Error(`SMTP rejected ${fixture.mentionedEmail}`);
      },
    });

    const result = await failing.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.accepted, false);

    const comment = await prisma.comment.findUnique({ where: { id: fixture.commentId } });
    const notification = await prisma.notification.findUnique({
      where: { id: fixture.notificationId },
    });

    assert.ok(comment);
    assert.equal(comment.deletedAt, null);
    assert.ok(notification);
    assert.equal(notification.readAt, null);
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.mentionedEmail } }),
      0,
    );
  });

  test('a successful mention email does not remove the existing in-app notification', async () => {
    const fixture = await createFixture();
    const result = await notifier.notify({
      commentId: fixture.commentId,
      mentionedUserId: fixture.mentionedUserId,
    });

    assert.equal(result.status, 'queued');
    assert.ok(await prisma.notification.findUnique({ where: { id: fixture.notificationId } }));
  });
});
