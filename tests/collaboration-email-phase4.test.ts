import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { parseEnv } from '../src/config/env';
import {
  buildTeamInvitationUrl,
  collaborationEmailIdempotencyKey,
  createCollaborationEmailNotifier,
  teamInvitationEmailIdempotencyKey,
} from '../src/services/collaboration-email-notifier';
import type { EmailMessage } from '../src/services/email';
import { hashSecret } from '../src/utils/crypto';
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

function teamNotifierFixture(
  options: {
    suppressed?: boolean;
    failed?: boolean;
    invitation?: Record<string, unknown>;
    team?: Record<string, unknown> | null;
  } = {},
) {
  const deliveries: EmailMessage[] = [];
  const token = 'single-use-team-token';
  const invitation = {
    id: 'invitation-1',
    email: 'teammate@example.com',
    type: 'TEAM',
    status: 'PENDING',
    teamId: 'team-1',
    workspaceId: 'workspace-1',
    expiresAt: new Date(Date.now() + 86_400_000),
    forUserId: null,
    tokenHash: hashSecret(token),
    workspace: { id: 'workspace-1', name: 'Compiler', status: 'ACTIVE', deletedAt: null },
    invitedBy: { id: 'inviter-1', name: 'Ada Lovelace', status: 'ACTIVE', deletedAt: null },
    ...options.invitation,
  };
  const client = {
    invitation: { findUnique: async () => invitation },
    team: {
      findFirst: async () =>
        options.team === null ? null : (options.team ?? { id: 'team-1', name: 'Runtime' }),
    },
    user: { findFirst: async () => ({ id: 'bound-user' }) },
  } as unknown as PrismaClient;
  const notifier = createCollaborationEmailNotifier(config, {
    prisma: client,
    logger: new Logger('silent'),
    isSuppressed: async () => options.suppressed ?? false,
    send: async (message) => {
      deliveries.push(message);
      return options.failed
        ? { accepted: false, error: 'Delivery failed for teammate@example.com' }
        : { accepted: true, providerMessageId: 'delivery-1' };
    },
  });

  return { notifier, deliveries, token, invitation };
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
    workspaceName: 'Analytical Engines',
    projectName: 'Compiler',
  };

  const result = await notifier.notifyMeetingInvitation(invitation);
  assert.equal(result.status, 'queued');
  assert.equal(deliveries[0]?.to, 'invitee@example.com');
  assert.equal(deliveries[0]?.template, 'meeting_invitation');
  assert.match(deliveries[0]?.text ?? '', /Compiler review/);
  assert.match(deliveries[0]?.text ?? '', /Tue, 03 Nov 2026 10:00:00 GMT/);
  assert.match(deliveries[0]?.text ?? '', /Room 2/);
  assert.match(deliveries[0]?.text ?? '', /the Compiler project/);
  assert.match(deliveries[0]?.text ?? '', /the Analytical Engines workspace/);
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

test('meeting emails reject an invalid recipient or an invalid start time', async () => {
  const { notifier, deliveries } = notifierFixture();
  const invitation = {
    invitationId: 'invite-1',
    invitationStatus: 'PENDING' as const,
    inviteeId: 'invitee-1',
    inviteeEmail: 'not-an-address',
    inviteeName: 'Grace Hopper',
    organizerName: 'Ada Lovelace',
    meetingTitle: 'Compiler review',
    startsAt: new Date('2026-11-03T10:00:00.000Z'),
    meetingId: 'meeting-1',
  };

  assert.equal((await notifier.notifyMeetingInvitation(invitation)).status, 'ineligible');
  assert.equal(
    (
      await notifier.notifyMeetingInvitation({
        ...invitation,
        inviteeEmail: 'invitee@example.com',
        startsAt: new Date('not-a-date'),
      })
    ).status,
    'ineligible',
  );
  assert.equal(deliveries.length, 0);
});

test('team invitations use the persisted team, inviter and configured acceptance link', async () => {
  const { notifier, deliveries, token, invitation } = teamNotifierFixture();

  const result = await notifier.notifyTeamInvitation({
    invitationId: 'invitation-1',
    token,
  });

  assert.equal(result.status, 'queued');
  assert.equal(result.accepted, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.to, 'teammate@example.com');
  assert.equal(deliveries[0]?.template, 'team_invitation');
  assert.match(deliveries[0]?.text ?? '', /Ada Lovelace invited you to join the team "Runtime"/);
  assert.match(deliveries[0]?.text ?? '', /Compiler/);
  assert.match(deliveries[0]?.text ?? '', /This invitation expires in/);
  assert.match(
    deliveries[0]?.text ?? '',
    /https:\/\/app\.example\.com\/teams\/invitations\/accept\?token=single-use-team-token/,
  );
  assert.equal(
    deliveries[0]?.idempotencyKey,
    teamInvitationEmailIdempotencyKey('invitation-1', invitation.tokenHash as string),
  );
  assert.doesNotMatch(deliveries[0]?.idempotencyKey ?? '', /single-use-team-token/);
  assert.equal(deliveries[0]?.metadata?.invitationId, 'invitation-1');
  assert.equal(deliveries[0]?.metadata?.teamId, 'team-1');
  assert.equal(deliveries[0]?.metadata?.workspaceId, 'workspace-1');
  assert.doesNotMatch(JSON.stringify(deliveries[0]?.metadata ?? {}), /single-use-team-token/);
  assert.equal(
    buildTeamInvitationUrl(config, 'token with space'),
    'https://app.example.com/teams/invitations/accept?token=token%20with%20space',
  );
});

test('team invitations are skipped when the persisted invitation is not valid', async () => {
  const pending = teamNotifierFixture();
  const expired = {
    ...pending.invitation,
    expiresAt: new Date(Date.now() - 60_000),
  };
  const accepted = teamNotifierFixture({ invitation: { status: 'ACCEPTED' } });
  const wrongType = teamNotifierFixture({ invitation: { type: 'WORKSPACE', teamId: null } });
  const expiredInvitation = teamNotifierFixture({ invitation: expired });
  const missingTeam = teamNotifierFixture({ team: null });

  assert.equal(
    (
      await accepted.notifier.notifyTeamInvitation({
        invitationId: 'invitation-1',
        token: accepted.token,
      })
    ).status,
    'ineligible',
  );
  assert.equal(
    (
      await wrongType.notifier.notifyTeamInvitation({
        invitationId: 'invitation-1',
        token: wrongType.token,
      })
    ).status,
    'not_found',
  );
  assert.equal(
    (
      await expiredInvitation.notifier.notifyTeamInvitation({
        invitationId: 'invitation-1',
        token: expiredInvitation.token,
      })
    ).status,
    'ineligible',
  );
  assert.equal(
    (
      await missingTeam.notifier.notifyTeamInvitation({
        invitationId: 'invitation-1',
        token: missingTeam.token,
      })
    ).status,
    'not_found',
  );
  assert.equal(accepted.deliveries.length, 0);
  assert.equal(wrongType.deliveries.length, 0);
  assert.equal(expiredInvitation.deliveries.length, 0);
  assert.equal(missingTeam.deliveries.length, 0);
});

test('a token that does not match the persisted invitation digest is not sent', async () => {
  const { notifier, deliveries } = teamNotifierFixture();

  const result = await notifier.notifyTeamInvitation({
    invitationId: 'invitation-1',
    token: 'a-different-token',
  });

  assert.equal(result.status, 'ineligible');
  assert.equal(deliveries.length, 0);
});

test('team invitation suppression, delivery failure and retries are handled without duplicates', async () => {
  const suppressed = teamNotifierFixture({ suppressed: true });
  assert.equal(
    (
      await suppressed.notifier.notifyTeamInvitation({
        invitationId: 'invitation-1',
        token: suppressed.token,
      })
    ).status,
    'suppressed',
  );
  assert.equal(suppressed.deliveries.length, 0);

  const failed = teamNotifierFixture({ failed: true });
  const failedResult = await failed.notifier.notifyTeamInvitation({
    invitationId: 'invitation-1',
    token: failed.token,
  });
  assert.equal(failedResult.status, 'failed');
  assert.equal(failedResult.accepted, false);

  const retried = teamNotifierFixture();
  await retried.notifier.notifyTeamInvitation({
    invitationId: 'invitation-1',
    token: retried.token,
  });
  await retried.notifier.notifyTeamInvitation({
    invitationId: 'invitation-1',
    token: retried.token,
  });
  assert.equal(retried.deliveries.length, 2);
  assert.equal(retried.deliveries[0]?.idempotencyKey, retried.deliveries[1]?.idempotencyKey);
});
