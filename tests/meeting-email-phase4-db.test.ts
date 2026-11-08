import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { parseEnv } from '../src/config/env';
import { createMeetingService } from '../src/modules/meetings/meeting.service';
import {
  createCollaborationEmailNotifier,
  type CollaborationEmailNotifier,
} from '../src/services/collaboration-email-notifier';
import { createEmailDeliveryService, type EmailDeliveryService } from '../src/services/email';
import type { EmailTransport } from '../src/services/providers/email';
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE4_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE4_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_PHASE4_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}.${process.pid}.${counter}.${Date.now()}`;
}

const neverCalledTransport: EmailTransport = {
  provider: 'meeting-test',
  async send() {
    throw new Error('The test transport must not be called without a worker');
  },
  async verify(): Promise<void> {},
  async close(): Promise<void> {},
};

describe('Meeting invitation emails', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let delivery: EmailDeliveryService;
  let notifier: CollaborationEmailNotifier;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const emails: string[] = [];

  async function createUser(name: string) {
    const email = `${unique('meeting-user')}@example.com`;
    emails.push(email);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: 'not-used',
        name,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    userIds.push(user.id);
    return { id: user.id, email };
  }

  async function createFixture() {
    const owner = await createUser('Ada Lovelace');
    const guest = await createUser('Grace Hopper');
    const workspace = await prisma.workspace.create({
      data: { name: unique('Meetings'), slug: unique('meetings'), ownerId: owner.id },
    });
    workspaceIds.push(workspace.id);
    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
        { workspaceId: workspace.id, userId: guest.id, role: 'MEMBER' },
      ],
    });
    return { owner, guest, workspaceId: workspace.id };
  }

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = database.prisma;
    const config = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'https://app.example.com',
      JWT_ACCESS_SECRET: 'meeting-integration-test-access-secret-value',
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
    notifier = createCollaborationEmailNotifier(config, {
      prisma,
      logger: log,
      send: (message) => delivery.enqueue(message),
    });
  });

  after(async () => {
    if (!prisma) return;
    await prisma.emailDelivery.deleteMany({ where: { toAddress: { in: emails } } });
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  test('create emails each participant once when the meeting has a start time', async () => {
    const f = await createFixture();
    const service = createMeetingService(prisma, { meetingNotifier: notifier });

    await service.create({
      userId: f.owner.id,
      workspaceId: f.workspaceId,
      title: 'Compiler review',
      scheduledAt: '2026-12-01T10:00:00.000Z',
      participantIds: [f.guest.id],
    });

    const rows = await prisma.emailDelivery.findMany({ where: { toAddress: f.guest.email } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.template, 'meeting_invitation');
  });

  test('a meeting with no start time sends no email', async () => {
    const f = await createFixture();
    const service = createMeetingService(prisma, { meetingNotifier: notifier });

    await service.create({
      userId: f.owner.id,
      workspaceId: f.workspaceId,
      title: 'Unscheduled',
      participantIds: [f.guest.id],
    });

    assert.equal(await prisma.emailDelivery.count({ where: { toAddress: f.guest.email } }), 0);
  });

  test('the organizer is never emailed', async () => {
    const f = await createFixture();
    const service = createMeetingService(prisma, { meetingNotifier: notifier });

    await service.create({
      userId: f.owner.id,
      workspaceId: f.workspaceId,
      title: 'Solo',
      scheduledAt: '2026-12-01T10:00:00.000Z',
      participantIds: [f.owner.id],
    });

    assert.equal(await prisma.emailDelivery.count({ where: { toAddress: f.owner.email } }), 0);
  });

  test('adding the same participant twice leaves one email', async () => {
    const f = await createFixture();
    const service = createMeetingService(prisma, { meetingNotifier: notifier });
    const meeting = await service.create({
      userId: f.owner.id,
      workspaceId: f.workspaceId,
      title: 'Planning',
      scheduledAt: '2026-12-01T10:00:00.000Z',
    });

    for (let i = 0; i < 2; i += 1) {
      await service.addParticipant({
        userId: f.owner.id,
        workspaceId: f.workspaceId,
        meetingId: meeting.id,
        targetUserId: f.guest.id,
      });
    }

    assert.equal(await prisma.emailDelivery.count({ where: { toAddress: f.guest.email } }), 1);
  });
});
