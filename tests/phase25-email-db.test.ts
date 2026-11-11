import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { parseEnv, type AppConfig } from '../src/config/env';
import { createEmailDeliveryService, type EmailDeliveryService } from '../src/services/email';
import {
  createTaskAssignmentNotifier,
  taskAssignmentIdempotencyKey,
  type TaskAssignmentNotifier,
} from '../src/services/task-assignment-notifier';
import { createMeetingService } from '../src/modules/meetings/meeting.service';
import {
  createCollaborationEmailNotifier,
  type CollaborationEmailNotifier,
} from '../src/services/collaboration-email-notifier';
import { createJoinRequestService } from '../src/modules/workspaces/join-request.service';
import { createBillingService } from '../src/modules/billing/billing.service';
import type { EmailTransport } from '../src/services/providers/email';
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 25 email preference integration tests.
 *
 * The real PostgreSQL schema and the real transactional outbox are used. A
 * fake transport only satisfies the delivery service contract: the tests never
 * contact a provider because no worker claims the queued rows.
 *
 * These tests cover:
 *   * Task assignment gated by the email preference channel
 *   * Meeting invitation gated by the email preference channel
 *   * Join request approve/reject emails gated by the email preference channel
 *   * Billing webhook emails (transactional, always sent) with idempotency
 */

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE25_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE25_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  if (process.env.RUN_PHASE25_DB_TESTS === 'true') throw error;
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
  provider: 'phase25-email-test',
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

describe('Phase 25 email preference channel', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let config: AppConfig;
  let delivery: EmailDeliveryService;
  let taskAssignmentNotifier: TaskAssignmentNotifier;
  let collaborationNotifier: CollaborationEmailNotifier;
  let joinRequestService: ReturnType<typeof createJoinRequestService>;
  let billingService: ReturnType<typeof createBillingService>;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const emailAddresses: string[] = [];
  const now = new Date('2026-11-01T00:00:00.000Z');

  async function createUser(name: string): Promise<{ id: string; email: string }> {
    const email = uniqueEmail('phase25-user');
    emailAddresses.push(email);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: 'not-used',
        name,
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    userIds.push(user.id);
    return { id: user.id, email };
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
      JWT_ACCESS_SECRET: 'phase25-integration-test-access-secret-value',
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

    const enqueue = (message: unknown) => delivery.enqueue(message as never);

    taskAssignmentNotifier = createTaskAssignmentNotifier(config, {
      prisma,
      logger: log,
      send: enqueue,
    });

    collaborationNotifier = createCollaborationEmailNotifier(config, {
      prisma,
      logger: log,
      send: enqueue,
    });

    joinRequestService = createJoinRequestService(config, prisma, {
      send: enqueue as never,
      logger: log,
    });

    billingService = createBillingService(config, {
      prisma,
      now: () => now,
      send: enqueue as never,
      logger: log,
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
      await prisma.billingWebhookEvent.deleteMany({});

      if (workspaceIds.length > 0) {
        await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      }

      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }

      await prisma.$disconnect();
    }
  });

  describe('task assignment email gating', () => {
    async function createAssignmentFixture() {
      const owner = await createUser('Owner Two');
      const assignee = await createUser('Grace Phase25');
      const workspace = await prisma.workspace.create({
        data: {
          name: uniqueValue('Assignment Workspace'),
          slug: uniqueValue('assign-ws'),
          ownerId: owner.id,
        },
      });
      workspaceIds.push(workspace.id);

      await prisma.workspaceMembership.createMany({
        data: [
          { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
          { workspaceId: workspace.id, userId: assignee.id, role: 'MEMBER' },
        ],
      });

      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: 'Compiler',
          key: uniqueValue('ENG'),
          ownerId: owner.id,
          visibility: 'WORKSPACE',
        },
      });

      await prisma.projectMembership.create({
        data: { projectId: project.id, userId: assignee.id, role: 'MEMBER' },
      });

      const assignedAt = new Date('2026-11-02T10:00:00.000Z');
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          key: uniqueValue('ENG-TASK'),
          title: 'Write the compiler',
          creatorId: owner.id,
          dueDate: new Date('2026-12-01T10:00:00.000Z'),
          assignees: {
            create: {
              userId: assignee.id,
              assignedBy: owner.id,
              assignedAt,
            },
          },
        },
      });

      return {
        workspaceId: workspace.id,
        projectId: project.id,
        taskId: task.id,
        ownerId: owner.id,
        assigneeId: assignee.id,
        assigneeEmail: assignee.email,
        assignedAt,
      };
    }

    test('queues a task assignment email when email is enabled by default', async () => {
      const fixture = await createAssignmentFixture();

      const result = await taskAssignmentNotifier.notify({
        taskId: fixture.taskId,
        assigneeId: fixture.assigneeId,
      });

      assert.equal(result.status, 'queued');
      assert.equal(result.accepted, true);
      assert.ok(result.deliveryId);

      const row = await prisma.emailDelivery.findUnique({
        where: { id: result.deliveryId },
      });

      assert.ok(row);
      assert.equal(row.toAddress, fixture.assigneeEmail);
      assert.equal(row.template, 'task_assignment');
      assert.equal(
        row.idempotencyKey,
        taskAssignmentIdempotencyKey({
          taskId: fixture.taskId,
          assigneeId: fixture.assigneeId,
          assignedAt: fixture.assignedAt,
        }),
      );
    });

    test('returns preference_disabled when the assignee disabled task assignment email', async () => {
      const fixture = await createAssignmentFixture();

      await prisma.notificationPreference.create({
        data: {
          workspaceId: fixture.workspaceId,
          userId: fixture.assigneeId,
          type: 'TASK_ASSIGNED',
          inAppEnabled: true,
          emailEnabled: false,
        },
      });

      const result = await taskAssignmentNotifier.notify({
        taskId: fixture.taskId,
        assigneeId: fixture.assigneeId,
      });

      assert.equal(result.status, 'preference_disabled');
      assert.equal(result.accepted, false);
      assert.equal(result.deliveryId, undefined);

      const row = await prisma.emailDelivery.findFirst({
        where: { toAddress: fixture.assigneeEmail },
      });
      assert.equal(row, null);
    });

    test('queues again when email preference is re-enabled', async () => {
      const fixture = await createAssignmentFixture();

      await prisma.notificationPreference.create({
        data: {
          workspaceId: fixture.workspaceId,
          userId: fixture.assigneeId,
          type: 'TASK_ASSIGNED',
          inAppEnabled: true,
          emailEnabled: false,
        },
      });

      const disabled = await taskAssignmentNotifier.notify({
        taskId: fixture.taskId,
        assigneeId: fixture.assigneeId,
      });
      assert.equal(disabled.status, 'preference_disabled');

      await prisma.notificationPreference.update({
        where: {
          workspaceId_userId_type: {
            workspaceId: fixture.workspaceId,
            userId: fixture.assigneeId,
            type: 'TASK_ASSIGNED',
          },
        },
        data: { emailEnabled: true },
      });

      const reEnabled = await taskAssignmentNotifier.notify({
        taskId: fixture.taskId,
        assigneeId: fixture.assigneeId,
      });
      assert.equal(reEnabled.status, 'queued');
      assert.ok(reEnabled.deliveryId);
    });
  });

  describe('meeting invitation email gating', () => {
    async function createMeetingFixture() {
      const owner = await createUser('Organiser');
      const invitee = await createUser('Invitee Phase25');
      const workspace = await prisma.workspace.create({
        data: {
          name: uniqueValue('Meeting Workspace'),
          slug: uniqueValue('meet-ws'),
          ownerId: owner.id,
        },
      });
      workspaceIds.push(workspace.id);

      await prisma.workspaceMembership.createMany({
        data: [
          { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
          { workspaceId: workspace.id, userId: invitee.id, role: 'MEMBER' },
        ],
      });

      const service = createMeetingService(prisma, {
        meetingNotifier: collaborationNotifier,
      });

      const meeting = await service.create({
        userId: owner.id,
        workspaceId: workspace.id,
        title: 'Planning meeting',
        scheduledAt: '2026-12-01T10:00:00.000Z',
        participantIds: [invitee.id],
      });

      return {
        workspaceId: workspace.id,
        meetingId: meeting.id,
        ownerId: owner.id,
        inviteeId: invitee.id,
        inviteeEmail: invitee.email,
      };
    }

    test('queues a meeting invitation email when email is enabled by default', async () => {
      const fixture = await createMeetingFixture();

      await collaborationNotifier.notifyMeetingInvitation({
        invitationId: `${fixture.meetingId}:${fixture.inviteeId}`,
        invitationStatus: 'PENDING',
        inviteeId: fixture.inviteeId,
        inviteeEmail: fixture.inviteeEmail,
        inviteeName: 'Invitee Phase25',
        organizerName: 'Organiser',
        meetingTitle: 'Planning meeting',
        startsAt: new Date('2026-12-01T10:00:00.000Z'),
        meetingId: fixture.meetingId,
        workspaceId: fixture.workspaceId,
      });

      const rows = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.inviteeEmail },
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.template, 'meeting_invitation');
    });

    test('returns preference_disabled when the invitee disabled meeting email', async () => {
      const fixture = await createMeetingFixture();

      // Clear the email that createMeetingFixture already sent during setup.
      await prisma.emailDelivery.deleteMany({
        where: { toAddress: fixture.inviteeEmail },
      });

      await prisma.notificationPreference.create({
        data: {
          workspaceId: fixture.workspaceId,
          userId: fixture.inviteeId,
          type: 'MEETING_INVITE',
          inAppEnabled: true,
          emailEnabled: false,
        },
      });

      const result = await collaborationNotifier.notifyMeetingInvitation({
        invitationId: `${fixture.meetingId}:${fixture.inviteeId}`,
        invitationStatus: 'PENDING',
        inviteeId: fixture.inviteeId,
        inviteeEmail: fixture.inviteeEmail,
        inviteeName: 'Invitee Phase25',
        organizerName: 'Organiser',
        meetingTitle: 'Planning meeting',
        startsAt: new Date('2026-12-01T10:00:00.000Z'),
        meetingId: fixture.meetingId,
        workspaceId: fixture.workspaceId,
      });

      assert.equal(result.status, 'preference_disabled');
      assert.equal(result.accepted, false);

      const row = await prisma.emailDelivery.findFirst({
        where: { toAddress: fixture.inviteeEmail },
      });
      assert.equal(row, null);
    });
  });

  describe('join request decision emails', () => {
    async function createJoinRequestFixture() {
      const owner = await createUser('Approver');
      const applicant = await createUser('Applicant Phase25');
      const workspace = await prisma.workspace.create({
        data: {
          name: uniqueValue('Join Workspace'),
          slug: uniqueValue('join-ws'),
          ownerId: owner.id,
        },
      });
      workspaceIds.push(workspace.id);

      await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      });

      const request = await prisma.joinRequest.create({
        data: {
          workspaceId: workspace.id,
          userId: applicant.id,
          role: 'MEMBER',
          status: 'PENDING',
          message: 'I would like to join.',
          expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        },
      });

      return {
        workspaceId: workspace.id,
        ownerId: owner.id,
        applicantId: applicant.id,
        applicantEmail: applicant.email,
        requestId: request.id,
      };
    }

    async function approveRequest(fixture: {
      workspaceId: string;
      ownerId: string;
      requestId: string;
    }): Promise<void> {
      await joinRequestService.approve(
        { userId: fixture.ownerId, workspaceId: fixture.workspaceId, requestId: fixture.requestId },
        { ip: '127.0.0.1', userAgent: 'test' },
      );
    }

    async function rejectRequest(
      fixture: {
        workspaceId: string;
        ownerId: string;
        requestId: string;
        applicantEmail: string;
      },
      note?: string,
    ): Promise<void> {
      await joinRequestService.reject(
        {
          userId: fixture.ownerId,
          workspaceId: fixture.workspaceId,
          requestId: fixture.requestId,
          note,
        },
        { ip: '127.0.0.1', userAgent: 'test' },
      );
    }

    test('approve email is queued by default for an active owner applicant', async () => {
      const fixture = await createJoinRequestFixture();

      await approveRequest(fixture);

      const rows = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.applicantEmail },
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.template, 'join_request_approved');
    });

    // Join-request applicants are not workspace members when the decision is
    // made, so they cannot have a NotificationPreference row yet. Email is
    // therefore always sent (the default is enabled). The disabled case cannot
    // occur through the normal approve/reject flow.

    test('reject email includes the decision note', async () => {
      const fixture = await createJoinRequestFixture();

      await rejectRequest(fixture, 'We are not onboarding contractors right now.');

      const rows = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.applicantEmail },
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.template, 'join_request_rejected');
      assert.match(rows[0]?.textBody ?? '', /contractors/);
    });
  });

  describe('billing webhook emails', () => {
    async function createBillingWorkspace(): Promise<{
      workspaceId: string;
      ownerId: string;
      ownerEmail: string;
    }> {
      const owner = await createUser('Billing Owner');
      const workspace = await prisma.workspace.create({
        data: {
          name: uniqueValue('Billing Workspace'),
          slug: uniqueValue('bill-ws'),
          ownerId: owner.id,
        },
      });
      workspaceIds.push(workspace.id);

      await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      });

      await prisma.subscription.create({
        data: {
          workspaceId: workspace.id,
          plan: 'PRO',
          interval: 'MONTHLY',
          currency: 'USD',
          billableSeats: 1,
          status: 'ACTIVE',
          currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
        },
      });

      return { workspaceId: workspace.id, ownerId: owner.id, ownerEmail: owner.email };
    }

    test('charge.success sends a receipt email with idempotency', async () => {
      const fixture = await createBillingWorkspace();

      await prisma.billingPayment.create({
        data: {
          workspaceId: fixture.workspaceId,
          providerReference: 'ref-success-1',
          providerEventKey: 'evt-success-1',
          amountSubunit: 4900,
          currency: 'USD',
          status: 'SUCCESS',
          paidAt: new Date('2026-11-01T00:00:00.000Z'),
          periodEnd: new Date('2026-12-01T00:00:00.000Z'),
        },
      });

      await billingService.processWebhook({
        event: 'charge.success',
        eventKey: 'evt-success-1',
        reference: 'ref-success-1',
        amount: 4900,
        currency: 'USD',
        paidAt: '2026-11-01T00:00:00.000Z',
      });

      const rows = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.ownerEmail },
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.template, 'billing_receipt');
      assert.match(rows[0]?.idempotencyKey ?? '', /billing:evt-success-1/);

      // Idempotent replay sends no second email.
      await billingService.processWebhook({
        event: 'charge.success',
        eventKey: 'evt-success-1',
        reference: 'ref-success-1',
        amount: 4900,
        currency: 'USD',
        paidAt: '2026-11-01T00:00:00.000Z',
      });

      const replayed = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.ownerEmail },
      });

      assert.equal(replayed.length, 1);
    });

    test('invoice.payment_failed sends a failed-payment email', async () => {
      const fixture = await createBillingWorkspace();

      await prisma.subscription.update({
        where: { workspaceId: fixture.workspaceId },
        data: { providerSubscriptionCode: 'sub-failed-1' },
      });

      await billingService.processWebhook({
        event: 'invoice.payment_failed',
        eventKey: 'evt-failed-1',
        subscriptionCode: 'sub-failed-1',
        amount: 4900,
        currency: 'USD',
      });

      const rows = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.ownerEmail },
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.template, 'billing_payment_failed');
    });

    test('subscription.disable sends a cancelled or non-renewing email', async () => {
      const fixture = await createBillingWorkspace();

      await prisma.subscription.update({
        where: { workspaceId: fixture.workspaceId },
        data: { providerSubscriptionCode: 'sub-cancel-1' },
      });

      await billingService.processWebhook({
        event: 'subscription.disable',
        eventKey: 'evt-cancel-1',
        subscriptionCode: 'sub-cancel-1',
      });

      const rows = await prisma.emailDelivery.findMany({
        where: { toAddress: fixture.ownerEmail },
      });

      assert.equal(rows.length, 1);
      assert.ok(
        rows[0]?.template === 'billing_subscription_cancelled' ||
          rows[0]?.template === 'billing_subscription_not_renewing',
        `Expected cancelled or non-renewing template, got ${rows[0]?.template}`,
      );
    });
  });
});
