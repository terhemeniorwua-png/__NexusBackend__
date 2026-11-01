import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { parseEnv } from '../src/config/env';
import {
  collaborationEmailIdempotencyKey,
  createCollaborationEmailNotifier,
} from '../src/services/collaboration-email-notifier';
import type { EmailMessage } from '../src/services/email';
import { Logger } from '../src/utils/logger';

const config = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
  REDIS_URL: 'redis://localhost:6379/15',
  FRONTEND_URL: 'https://app.example.com',
  JWT_ACCESS_SECRET: 'collaboration-email-test-access-secret-value',
});

function notifierFixture(options: { suppressed?: boolean; failed?: boolean } = {}) {
  const deliveries: EmailMessage[] = [];
  const comment = {
    id: 'comment-1',
    body: 'Hello @grace',
    deletedAt: null,
    authorId: 'author-1',
    author: { id: 'author-1', name: 'Ada Lovelace' },
    task: {
      id: 'task-1',
      title: 'Review parser',
      deletedAt: null,
      project: {
        id: 'project-1',
        deletedAt: null,
        workspace: { id: 'workspace-1', name: 'Compiler', status: 'ACTIVE', deletedAt: null },
      },
    },
  };
  const client = {
    comment: { findUnique: async () => comment },
    user: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'mentioned-1'
          ? { id: 'mentioned-1', name: 'Grace Hopper', email: 'grace@example.com' }
          : null,
    },
    workspaceMembership: { findUnique: async () => ({ id: 'membership-1' }) },
  } as unknown as PrismaClient;
  const notifier = createCollaborationEmailNotifier(config, {
    prisma: client,
    logger: new Logger('silent'),
    isSuppressed: async () => options.suppressed ?? false,
    send: async (message) => {
      deliveries.push(message);
      return options.failed
        ? { accepted: false, error: 'Delivery failed for grace@example.com' }
        : { accepted: true, providerMessageId: 'delivery-1' };
    },
  });
  return { notifier, deliveries };
}

test('comment mention emails resolve the mentioned member and use the existing template context', async () => {
  const { notifier, deliveries } = notifierFixture();
  const result = await notifier.notifyMention({
    commentId: 'comment-1',
    mentionedUserId: 'mentioned-1',
  });

  assert.equal(result.status, 'queued');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.to, 'grace@example.com');
  assert.equal(deliveries[0]?.template, 'mention');
  assert.match(deliveries[0]?.text ?? '', /Ada Lovelace mentioned you in Review parser/);
  assert.match(
    deliveries[0]?.text ?? '',
    /https:\/\/app\.example\.com\/projects\/project-1\/tasks\/task-1#comment-comment-1/,
  );
});

test('mention emails do not go to the author and retries reuse the same idempotency key', async () => {
  const { notifier, deliveries } = notifierFixture();
  const self = await notifier.notifyMention({
    commentId: 'comment-1',
    mentionedUserId: 'author-1',
  });
  assert.equal(self.status, 'ineligible');
  assert.equal(deliveries.length, 0);

  await notifier.notifyMention({ commentId: 'comment-1', mentionedUserId: 'mentioned-1' });
  await notifier.notifyMention({ commentId: 'comment-1', mentionedUserId: 'mentioned-1' });
  assert.equal(deliveries[0]?.idempotencyKey, deliveries[1]?.idempotencyKey);
  assert.equal(
    deliveries[0]?.idempotencyKey,
    collaborationEmailIdempotencyKey('mention', 'comment-1', 'mentioned-1'),
  );
});

test('suppression and delivery failures leave the collaboration event untouched', async () => {
  const suppressed = notifierFixture({ suppressed: true });
  assert.equal(
    (
      await suppressed.notifier.notifyMention({
        commentId: 'comment-1',
        mentionedUserId: 'mentioned-1',
      })
    ).status,
    'suppressed',
  );
  assert.equal(suppressed.deliveries.length, 0);

  const failed = notifierFixture({ failed: true });
  const result = await failed.notifier.notifyMention({
    commentId: 'comment-1',
    mentionedUserId: 'mentioned-1',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.accepted, false);
});

test('meeting emails are sent only for pending invitations with configured app links and stable keys', async () => {
  const { notifier, deliveries } = notifierFixture();
  const invitation = {
    invitationId: 'invite-1',
    invitationStatus: 'PENDING' as const,
    inviteeId: 'invitee-1',
    inviteeEmail: 'invitee@example.com',
    inviteeName: 'Grace Hopper',
    organizerName: 'Ada Lovelace',
    meetingTitle: 'Compiler review',
    startsAt: new Date('2026-11-03T10:00:00.000Z'),
    durationMinutes: 30,
    location: 'Room 2',
    meetingId: 'meeting-1',
  };

  const result = await notifier.notifyMeetingInvitation(invitation);
  assert.equal(result.status, 'queued');
  assert.equal(deliveries[0]?.to, 'invitee@example.com');
  assert.equal(deliveries[0]?.template, 'meeting_invitation');
  assert.match(deliveries[0]?.text ?? '', /Compiler review/);
  assert.match(deliveries[0]?.text ?? '', /Tue, 03 Nov 2026 10:00:00 GMT/);
  assert.match(deliveries[0]?.text ?? '', /Room 2/);
  assert.match(deliveries[0]?.text ?? '', /https:\/\/app\.example\.com\/meetings\/meeting-1/);
  assert.equal(
    deliveries[0]?.idempotencyKey,
    collaborationEmailIdempotencyKey('meeting-invitation', 'invite-1', 'invitee-1'),
  );

  const afterReschedule = await notifier.notifyMeetingInvitation({
    ...invitation,
    invitationStatus: 'ACCEPTED',
    startsAt: new Date('2026-11-04T10:00:00.000Z'),
  });
  assert.equal(afterReschedule.status, 'ineligible');
  assert.equal(deliveries.length, 1);
});
