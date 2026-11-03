import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { InvitationType, PrismaClient, UserStatus } from '@prisma/client';
import { parseEnv, type AppConfig } from '../src/config/env';
import { createEmailDeliveryService, type EmailDeliveryService } from '../src/services/email';
import {
  buildProjectInvitationUrl,
  buildTeamInvitationUrl,
  createCollaborationEmailNotifier,
  projectInvitationEmailIdempotencyKey,
  teamInvitationEmailIdempotencyKey,
  type CollaborationEmailNotifier,
} from '../src/services/collaboration-email-notifier';
import type { EmailTransport } from '../src/services/providers/email';
import { generateSecureToken, hashSecret } from '../src/utils/crypto';
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 4.4 / 4.5 meeting, team and project invitation email integration tests.
 *
 * The real PostgreSQL schema and the real transactional outbox are used. A
 * fake transport only satisfies the delivery service contract: the tests never
 * contact a provider because no worker claims the queued rows.
 *
 * There is no meeting table in the schema and no team invitation creation or
 * acceptance workflow. The team and project invitation rows below are
 * persisted directly to exercise the notifier boundary that a future team or
 * project invitation workflow will call after it commits. The notifier never
 * creates or accepts an invitation, so the rows are unchanged by a successful
 * or failed send.
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
  provider: 'phase4.4-test',
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

describe(
  'Phase 4.4 meeting and team invitation email notifier',
  { skip: skipReason || false },
  () => {
    let prisma: PrismaClient;
    let config: AppConfig;
    let delivery: EmailDeliveryService;
    let notifier: CollaborationEmailNotifier;
    const workspaceIds: string[] = [];
    const projectIds: string[] = [];
    const teamIds: string[] = [];
    const invitationIds: string[] = [];
    const userIds: string[] = [];
    const emailAddresses: string[] = [];

    interface TeamFixture {
      workspaceId: string;
      workspaceName: string;
      teamId: string;
      teamName: string;
      inviterId: string;
      invitationId: string;
      inviteeEmail: string;
      token: string;
      tokenHash: string;
      expiresAt: Date;
    }

    async function createTeamFixture(
      options: {
        expiresAt?: Date;
        type?: InvitationType;
        inviterStatus?: UserStatus;
        email?: string;
      } = {},
    ): Promise<TeamFixture> {
      const now = new Date();
      const inviterEmail = uniqueEmail('team-inviter');
      const inviteeEmail = options.email ?? uniqueEmail('team-invitee');

      emailAddresses.push(inviterEmail, inviteeEmail);

      const inviter = await prisma.user.create({
        data: {
          email: inviterEmail,
          passwordHash: 'not-used',
          name: 'Ada Lovelace',
          status: options.inviterStatus ?? 'ACTIVE',
          emailVerifiedAt: now,
        },
      });
      userIds.push(inviter.id);

      const workspaceName = uniqueValue('Analytical Engines');
      const workspace = await prisma.workspace.create({
        data: {
          name: workspaceName,
          slug: uniqueValue('engines'),
          ownerId: inviter.id,
        },
      });
      workspaceIds.push(workspace.id);

      await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: inviter.id, role: 'OWNER' },
      });

      const teamName = uniqueValue('Runtime');
      const team = await prisma.team.create({
        data: { workspaceId: workspace.id, name: teamName, leadId: inviter.id },
      });
      teamIds.push(team.id);

      const token = generateSecureToken(24);
      const tokenHash = hashSecret(token);
      const expiresAt = options.expiresAt ?? new Date(Date.now() + 86_400_000);

      const invitation = await prisma.invitation.create({
        data: {
          workspaceId: workspace.id,
          teamId: team.id,
          email: inviteeEmail,
          type: options.type ?? 'TEAM',
          status: 'PENDING',
          tokenHash,
          invitedById: inviter.id,
          expiresAt,
        },
      });
      invitationIds.push(invitation.id);

      return {
        workspaceId: workspace.id,
        workspaceName,
        teamId: team.id,
        teamName,
        inviterId: inviter.id,
        invitationId: invitation.id,
        inviteeEmail,
        token,
        tokenHash,
        expiresAt,
      };
    }

    interface ProjectFixture {
      workspaceId: string;
      workspaceName: string;
      projectId: string;
      projectName: string;
      inviterId: string;
      invitationId: string;
      inviteeEmail: string;
      token: string;
      tokenHash: string;
      expiresAt: Date;
    }

    async function createProjectFixture(
      options: {
        expiresAt?: Date;
        type?: InvitationType;
        inviterStatus?: UserStatus;
        email?: string;
        projectStatus?: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
      } = {},
    ): Promise<ProjectFixture> {
      const now = new Date();
      const inviterEmail = uniqueEmail('project-inviter');
      const inviteeEmail = options.email ?? uniqueEmail('project-invitee');

      emailAddresses.push(inviterEmail, inviteeEmail);

      const inviter = await prisma.user.create({
        data: {
          email: inviterEmail,
          passwordHash: 'not-used',
          name: 'Ada Lovelace',
          status: options.inviterStatus ?? 'ACTIVE',
          emailVerifiedAt: now,
        },
      });
      userIds.push(inviter.id);

      const workspaceName = uniqueValue('Analytical Engines');
      const workspace = await prisma.workspace.create({
        data: {
          name: workspaceName,
          slug: uniqueValue('engines'),
          ownerId: inviter.id,
        },
      });
      workspaceIds.push(workspace.id);

      await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: inviter.id, role: 'OWNER' },
      });

      const projectName = uniqueValue('Compiler Runtime');
      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: projectName,
          key: uniqueValue('CR'),
          ownerId: inviter.id,
          status: options.projectStatus ?? 'ACTIVE',
        },
      });
      projectIds.push(project.id);

      const token = generateSecureToken(24);
      const tokenHash = hashSecret(token);
      const expiresAt = options.expiresAt ?? new Date(Date.now() + 86_400_000);

      const invitation = await prisma.invitation.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          email: inviteeEmail,
          type: options.type ?? 'PROJECT',
          status: 'PENDING',
          tokenHash,
          invitedById: inviter.id,
          expiresAt,
        },
      });
      invitationIds.push(invitation.id);

      return {
        workspaceId: workspace.id,
        workspaceName,
        projectId: project.id,
        projectName,
        inviterId: inviter.id,
        invitationId: invitation.id,
        inviteeEmail,
        token,
        tokenHash,
        expiresAt,
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
        EMAIL_APP_URL: 'https://app.example.com',
        JWT_ACCESS_SECRET: 'phase4.4-collaboration-integration-test-secret',
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
      if (prisma) {
        await prisma.emailDelivery.deleteMany({
          where: { toAddress: { in: emailAddresses } },
        });
        await prisma.emailSuppression.deleteMany({
          where: { emailAddress: { in: emailAddresses.map((email) => email.toLowerCase()) } },
        });

        if (invitationIds.length > 0) {
          await prisma.invitation.deleteMany({ where: { id: { in: invitationIds } } });
        }
        if (teamIds.length > 0) {
          await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
        }
        if (projectIds.length > 0) {
          await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
        }
        if (workspaceIds.length > 0) {
          await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
        }
        if (userIds.length > 0) {
          await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        }

        await prisma.$disconnect();
      }
    });

    test('queues the team invitation template with team, inviter, workspace, link and expiry', async () => {
      const fixture = await createTeamFixture();

      const result = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(result.status, 'queued');
      assert.equal(result.accepted, true);
      assert.ok(result.deliveryId);

      const row = await prisma.emailDelivery.findUnique({
        where: { id: result.deliveryId },
      });

      assert.ok(row);
      assert.equal(row.toAddress, fixture.inviteeEmail);
      assert.equal(row.template, 'team_invitation');
      assert.match(row.subject, /Ada Lovelace/);
      assert.match(
        row.subject,
        new RegExp(fixture.teamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.match(row.textBody, /Ada Lovelace invited you to join the team/);
      assert.match(
        row.textBody,
        new RegExp(fixture.workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.match(row.textBody, /This invitation expires in/);
      assert.ok(
        row.textBody.includes(
          buildTeamInvitationUrl(config, fixture.token).replace(/&/g, '&amp;'),
        ) || row.textBody.includes(buildTeamInvitationUrl(config, fixture.token)),
      );
      assert.equal(
        row.idempotencyKey,
        teamInvitationEmailIdempotencyKey(fixture.invitationId, fixture.tokenHash),
      );
      assert.doesNotMatch(row.idempotencyKey, new RegExp(fixture.token));

      const metadata = row.metadata as Record<string, unknown>;

      assert.equal(metadata.invitationId, fixture.invitationId);
      assert.equal(metadata.teamId, fixture.teamId);
      assert.equal(metadata.workspaceId, fixture.workspaceId);
      assert.equal(metadata.teamName, fixture.teamName);
      assert.doesNotMatch(JSON.stringify(metadata), new RegExp(fixture.token));

      // Sending never changes the persisted invitation, so acceptance keeps its
      // own validation, expiration and single-use rules.
      const persisted = await prisma.invitation.findUnique({ where: { id: fixture.invitationId } });

      assert.ok(persisted);
      assert.equal(persisted.status, 'PENDING');
      assert.equal(persisted.tokenHash, fixture.tokenHash);
      assert.equal(persisted.expiresAt.getTime(), fixture.expiresAt.getTime());
    });

    test('re-processing the same invitation and token creates one delivery', async () => {
      const fixture = await createTeamFixture();

      const first = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });
      const duplicate = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(first.status, 'queued');
      assert.equal(duplicate.status, 'queued');
      assert.equal(duplicate.deliveryId, first.deliveryId);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        1,
      );
    });

    test('a resend with a new token creates exactly one new delivery', async () => {
      const fixture = await createTeamFixture();

      const first = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });
      const nextToken = generateSecureToken(24);
      const nextTokenHash = hashSecret(nextToken);

      await prisma.invitation.update({
        where: { id: fixture.invitationId },
        data: { tokenHash: nextTokenHash },
      });

      const resent = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: nextToken,
      });

      assert.equal(first.status, 'queued');
      assert.equal(resent.status, 'queued');
      assert.notEqual(resent.deliveryId, first.deliveryId);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        2,
      );
    });

    test('expired, accepted, wrong-type and missing-team invitations are not emailed', async () => {
      const expired = await createTeamFixture({ expiresAt: new Date(Date.now() - 60_000) });
      const expiredResult = await notifier.notifyTeamInvitation({
        invitationId: expired.invitationId,
        token: expired.token,
      });

      assert.equal(expiredResult.status, 'ineligible');

      const expiredRow = await prisma.invitation.findUnique({
        where: { id: expired.invitationId },
      });
      assert.ok(expiredRow);
      assert.equal(expiredRow.status, 'PENDING');

      const accepted = await createTeamFixture();
      await prisma.invitation.update({
        where: { id: accepted.invitationId },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      assert.equal(
        (
          await notifier.notifyTeamInvitation({
            invitationId: accepted.invitationId,
            token: accepted.token,
          })
        ).status,
        'ineligible',
      );

      const wrongType = await createTeamFixture({ type: 'WORKSPACE' });
      assert.equal(
        (
          await notifier.notifyTeamInvitation({
            invitationId: wrongType.invitationId,
            token: wrongType.token,
          })
        ).status,
        'not_found',
      );

      const missingTeam = await createTeamFixture();
      await prisma.team.delete({ where: { id: missingTeam.teamId } });
      assert.equal(
        (
          await notifier.notifyTeamInvitation({
            invitationId: missingTeam.invitationId,
            token: missingTeam.token,
          })
        ).status,
        'not_found',
      );

      assert.equal(
        await prisma.emailDelivery.count({
          where: {
            toAddress: {
              in: [
                expired.inviteeEmail,
                accepted.inviteeEmail,
                wrongType.inviteeEmail,
                missingTeam.inviteeEmail,
              ],
            },
          },
        }),
        0,
      );
    });

    test('an invalid recipient, inactive inviter or mismatched token is not emailed', async () => {
      const invalidRecipient = await createTeamFixture({ email: 'not-an-address' });
      assert.equal(
        (
          await notifier.notifyTeamInvitation({
            invitationId: invalidRecipient.invitationId,
            token: invalidRecipient.token,
          })
        ).status,
        'ineligible',
      );

      const inactiveInviter = await createTeamFixture({ inviterStatus: 'SUSPENDED' });
      assert.equal(
        (
          await notifier.notifyTeamInvitation({
            invitationId: inactiveInviter.invitationId,
            token: inactiveInviter.token,
          })
        ).status,
        'not_found',
      );

      const fixture = await createTeamFixture();
      assert.equal(
        (
          await notifier.notifyTeamInvitation({
            invitationId: fixture.invitationId,
            token: 'a-different-token',
          })
        ).status,
        'ineligible',
      );
      assert.equal(
        await prisma.emailDelivery.count({
          where: {
            toAddress: {
              in: [
                invalidRecipient.inviteeEmail,
                inactiveInviter.inviteeEmail,
                fixture.inviteeEmail,
              ],
            },
          },
        }),
        0,
      );
    });

    test('a suppressed address is skipped before a delivery is created', async () => {
      const fixture = await createTeamFixture();

      await prisma.emailSuppression.create({
        data: {
          emailAddress: fixture.inviteeEmail.toLowerCase(),
          reason: 'HARD_BOUNCE',
        },
      });

      const result = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(result.status, 'suppressed');
      assert.equal(result.accepted, false);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        0,
      );
    });

    test('a team invitation delivery failure leaves the invitation intact', async () => {
      const fixture = await createTeamFixture();
      const failing = createCollaborationEmailNotifier(config, {
        prisma,
        logger: new Logger('silent'),
        send: async () => {
          throw new Error(`SMTP rejected ${fixture.inviteeEmail}`);
        },
      });

      const result = await failing.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.accepted, false);

      const persisted = await prisma.invitation.findUnique({ where: { id: fixture.invitationId } });

      assert.ok(persisted);
      assert.equal(persisted.status, 'PENDING');
      assert.equal(persisted.tokenHash, fixture.tokenHash);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        0,
      );

      // The invitation is still usable, so a retry after the provider recovers
      // can deliver the same mail.
      const retried = await notifier.notifyTeamInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(retried.status, 'queued');
    });

    test('meeting invitations include participant, time, context and configured link', async () => {
      const inviteeEmail = uniqueEmail('meeting-invitee');
      emailAddresses.push(inviteeEmail);

      const result = await notifier.notifyMeetingInvitation({
        invitationId: uniqueValue('meeting-invitation'),
        invitationStatus: 'PENDING',
        inviteeId: uniqueValue('meeting-invitee'),
        inviteeEmail,
        inviteeName: 'Grace Hopper',
        organizerName: 'Ada Lovelace',
        meetingTitle: 'Compiler review',
        startsAt: new Date('2026-11-03T10:00:00.000Z'),
        durationMinutes: 45,
        location: 'Room 2',
        meetingId: uniqueValue('meeting'),
        workspaceName: 'Analytical Engines',
        projectName: 'Compiler',
      });

      assert.equal(result.status, 'queued');
      assert.ok(result.deliveryId);

      const row = await prisma.emailDelivery.findUnique({ where: { id: result.deliveryId } });

      assert.ok(row);
      assert.equal(row.toAddress, inviteeEmail);
      assert.equal(row.template, 'meeting_invitation');
      assert.match(row.subject, /Invitation: Compiler review/);
      assert.match(row.textBody, /Ada Lovelace invited you to "Compiler review"/);
      assert.match(row.textBody, /Tue, 03 Nov 2026 10:00:00 GMT/);
      assert.match(row.textBody, /the Compiler project/);
      assert.match(row.textBody, /the Analytical Engines workspace/);
      assert.match(row.textBody, /Room 2/);
      assert.match(row.textBody, /https:\/\/app\.example\.com\/meetings\//);

      const metadata = row.metadata as Record<string, unknown>;

      assert.equal(metadata.workspaceName, 'Analytical Engines');
      assert.equal(metadata.projectName, 'Compiler');
    });

    test('meeting invitations are skipped for non-pending, suppressed or invalid recipients', async () => {
      const inviteeEmail = uniqueEmail('meeting-skipped');
      emailAddresses.push(inviteeEmail);

      const base = {
        invitationId: uniqueValue('meeting-invitation'),
        inviteeId: uniqueValue('meeting-invitee'),
        inviteeEmail,
        inviteeName: 'Grace Hopper',
        organizerName: 'Ada Lovelace',
        meetingTitle: 'Compiler review',
        startsAt: new Date('2026-11-03T10:00:00.000Z'),
        meetingId: uniqueValue('meeting'),
      };

      assert.equal(
        (
          await notifier.notifyMeetingInvitation({
            ...base,
            invitationStatus: 'REVOKED',
          })
        ).status,
        'ineligible',
      );
      assert.equal(
        (
          await notifier.notifyMeetingInvitation({
            ...base,
            inviteeEmail: 'not-an-address',
            invitationStatus: 'PENDING',
          })
        ).status,
        'ineligible',
      );

      await prisma.emailSuppression.create({
        data: { emailAddress: inviteeEmail.toLowerCase(), reason: 'COMPLAINT' },
      });

      assert.equal(
        (
          await notifier.notifyMeetingInvitation({
            ...base,
            invitationStatus: 'PENDING',
          })
        ).status,
        'suppressed',
      );
      assert.equal(await prisma.emailDelivery.count({ where: { toAddress: inviteeEmail } }), 0);
    });

    test('a meeting delivery failure is reported without throwing and does not queue mail', async () => {
      const inviteeEmail = uniqueEmail('meeting-failure');
      emailAddresses.push(inviteeEmail);

      const failing = createCollaborationEmailNotifier(config, {
        prisma,
        logger: new Logger('silent'),
        send: async () => {
          throw new Error(`Provider unavailable for ${inviteeEmail}`);
        },
      });

      const result = await failing.notifyMeetingInvitation({
        invitationId: uniqueValue('meeting-invitation'),
        invitationStatus: 'PENDING',
        inviteeId: uniqueValue('meeting-invitee'),
        inviteeEmail,
        inviteeName: 'Grace Hopper',
        organizerName: 'Ada Lovelace',
        meetingTitle: 'Compiler review',
        startsAt: new Date('2026-11-03T10:00:00.000Z'),
        meetingId: uniqueValue('meeting'),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.accepted, false);
      assert.equal(await prisma.emailDelivery.count({ where: { toAddress: inviteeEmail } }), 0);
    });

    test('queues the project invitation template with project, inviter, workspace, link and expiry', async () => {
      const fixture = await createProjectFixture();

      const result = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(result.status, 'queued');
      assert.equal(result.accepted, true);
      assert.ok(result.deliveryId);

      const row = await prisma.emailDelivery.findUnique({
        where: { id: result.deliveryId },
      });

      assert.ok(row);
      assert.equal(row.toAddress, fixture.inviteeEmail);
      assert.equal(row.template, 'project_invitation');
      assert.match(row.subject, /Ada Lovelace/);
      assert.match(
        row.subject,
        new RegExp(fixture.projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.match(
        row.textBody,
        new RegExp(`the project "${fixture.projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      );
      assert.match(
        row.textBody,
        new RegExp(fixture.workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.match(row.textBody, /This invitation expires in/);
      assert.ok(
        row.textBody.includes(
          buildProjectInvitationUrl(config, fixture.token).replace(/&/g, '&amp;'),
        ) || row.textBody.includes(buildProjectInvitationUrl(config, fixture.token)),
      );
      assert.equal(
        row.idempotencyKey,
        projectInvitationEmailIdempotencyKey(fixture.invitationId, fixture.tokenHash),
      );
      assert.doesNotMatch(row.idempotencyKey, new RegExp(fixture.token));

      const metadata = row.metadata as Record<string, unknown>;

      assert.equal(metadata.invitationId, fixture.invitationId);
      assert.equal(metadata.projectId, fixture.projectId);
      assert.equal(metadata.projectName, fixture.projectName);
      assert.equal(metadata.workspaceId, fixture.workspaceId);
      assert.equal(metadata.workspaceName, fixture.workspaceName);
      assert.doesNotMatch(JSON.stringify(metadata), new RegExp(fixture.token));

      // Sending never changes the persisted invitation, so acceptance keeps its
      // own validation, expiration and single-use rules.
      const persisted = await prisma.invitation.findUnique({
        where: { id: fixture.invitationId },
      });

      assert.ok(persisted);
      assert.equal(persisted.status, 'PENDING');
      assert.equal(persisted.tokenHash, fixture.tokenHash);
      assert.equal(persisted.expiresAt.getTime(), fixture.expiresAt.getTime());
    });

    test('re-processing the same project invitation and token creates one delivery', async () => {
      const fixture = await createProjectFixture();

      const first = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });
      const duplicate = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(first.status, 'queued');
      assert.equal(duplicate.status, 'queued');
      assert.equal(duplicate.deliveryId, first.deliveryId);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        1,
      );
    });

    test('a project invitation resend with a new token creates exactly one new delivery', async () => {
      const fixture = await createProjectFixture();

      const first = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });
      const nextToken = generateSecureToken(24);
      const nextTokenHash = hashSecret(nextToken);

      await prisma.invitation.update({
        where: { id: fixture.invitationId },
        data: { tokenHash: nextTokenHash },
      });

      const resent = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: nextToken,
      });

      assert.equal(first.status, 'queued');
      assert.equal(resent.status, 'queued');
      assert.notEqual(resent.deliveryId, first.deliveryId);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        2,
      );
    });

    test('expired, accepted, wrong-type, archived or missing-project invitations are not emailed', async () => {
      const expired = await createProjectFixture({ expiresAt: new Date(Date.now() - 60_000) });
      const expiredResult = await notifier.notifyProjectInvitation({
        invitationId: expired.invitationId,
        token: expired.token,
      });

      assert.equal(expiredResult.status, 'ineligible');

      const expiredRow = await prisma.invitation.findUnique({
        where: { id: expired.invitationId },
      });
      assert.ok(expiredRow);
      assert.equal(expiredRow.status, 'PENDING');

      const accepted = await createProjectFixture();
      await prisma.invitation.update({
        where: { id: accepted.invitationId },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: accepted.invitationId,
            token: accepted.token,
          })
        ).status,
        'ineligible',
      );

      const wrongType = await createProjectFixture({ type: 'TEAM' });
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: wrongType.invitationId,
            token: wrongType.token,
          })
        ).status,
        'not_found',
      );

      const archived = await createProjectFixture({ projectStatus: 'ARCHIVED' });
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: archived.invitationId,
            token: archived.token,
          })
        ).status,
        'not_found',
      );

      const missingProject = await createProjectFixture();
      await prisma.project.delete({ where: { id: missingProject.projectId } });
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: missingProject.invitationId,
            token: missingProject.token,
          })
        ).status,
        'not_found',
      );

      assert.equal(
        await prisma.emailDelivery.count({
          where: {
            toAddress: {
              in: [
                expired.inviteeEmail,
                accepted.inviteeEmail,
                wrongType.inviteeEmail,
                archived.inviteeEmail,
                missingProject.inviteeEmail,
              ],
            },
          },
        }),
        0,
      );
    });

    test('an invalid project recipient, inactive inviter or mismatched token is not emailed', async () => {
      const invalidRecipient = await createProjectFixture({ email: 'not-an-address' });
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: invalidRecipient.invitationId,
            token: invalidRecipient.token,
          })
        ).status,
        'ineligible',
      );

      const inactiveInviter = await createProjectFixture({ inviterStatus: 'SUSPENDED' });
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: inactiveInviter.invitationId,
            token: inactiveInviter.token,
          })
        ).status,
        'not_found',
      );

      const fixture = await createProjectFixture();
      assert.equal(
        (
          await notifier.notifyProjectInvitation({
            invitationId: fixture.invitationId,
            token: 'a-different-token',
          })
        ).status,
        'ineligible',
      );
      assert.equal(
        await prisma.emailDelivery.count({
          where: {
            toAddress: {
              in: [
                invalidRecipient.inviteeEmail,
                inactiveInviter.inviteeEmail,
                fixture.inviteeEmail,
              ],
            },
          },
        }),
        0,
      );
    });

    test('a suppressed project invitation address is skipped before a delivery is created', async () => {
      const fixture = await createProjectFixture();

      await prisma.emailSuppression.create({
        data: {
          emailAddress: fixture.inviteeEmail.toLowerCase(),
          reason: 'HARD_BOUNCE',
        },
      });

      const result = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(result.status, 'suppressed');
      assert.equal(result.accepted, false);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        0,
      );
    });

    test('a project invitation delivery failure leaves the invitation intact', async () => {
      const fixture = await createProjectFixture();
      const failing = createCollaborationEmailNotifier(config, {
        prisma,
        logger: new Logger('silent'),
        send: async () => {
          throw new Error(`SMTP rejected ${fixture.inviteeEmail}`);
        },
      });

      const result = await failing.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.accepted, false);

      const persisted = await prisma.invitation.findUnique({
        where: { id: fixture.invitationId },
      });

      assert.ok(persisted);
      assert.equal(persisted.status, 'PENDING');
      assert.equal(persisted.tokenHash, fixture.tokenHash);
      assert.equal(
        await prisma.emailDelivery.count({ where: { toAddress: fixture.inviteeEmail } }),
        0,
      );

      const retried = await notifier.notifyProjectInvitation({
        invitationId: fixture.invitationId,
        token: fixture.token,
      });

      assert.equal(retried.status, 'queued');
    });
  },
);
