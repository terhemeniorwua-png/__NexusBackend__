import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { setEmailSender } from '../src/services/email';
import type { EmailMessage } from '../src/services/email';
import { hashPassword } from '../src/services/password';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import {
  jsonRequest,
  startServer,
  type JsonResponse,
  type RunningServer,
} from './helpers/test-server';

/**
 * Phase 5 integration tests.
 *
 * The suite runs against a real PostgreSQL database and drives the real HTTP
 * application. It covers the workspace lifecycle, the membership rules and
 * the invitation flow, including the states an invitation can be in.
 *
 * It only runs when the database is explicitly marked as a test database,
 * because it creates accounts, workspaces and invitations.
 */

const PASSWORD = 'Correct-Horse-9';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE5_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE5_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  if (process.env.RUN_PHASE5_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

let uniqueCounter = 0;

function uniqueSuffix(): string {
  uniqueCounter += 1;

  return `${process.pid}.${uniqueCounter}.${Date.now()}`;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${uniqueSuffix()}@example.com`;
}

describe('Phase 5 workspaces, memberships and invitations', { skip: skipReason || false }, () => {
  let app: Express;
  let server: RunningServer;
  let prisma: ReturnType<typeof getPrismaClient>;
  let config: AppConfig;
  let baseUrl: string;
  let sent: EmailMessage[] = [];
  // The suite removes exactly the rows it created, so it never touches the
  // data of another suite that runs against the same database.
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdEmails: string[] = [];

  function buildConfig(overrides: Record<string, string> = {}): AppConfig {
    return parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'info',
      JWT_ACCESS_SECRET: 'phase5-integration-test-access-secret-value',
      BCRYPT_SALT_ROUNDS: '4',
      RATE_LIMIT_MAX: '100000',
      RATE_LIMIT_NAMESPACE: `nexus-phase5-${process.pid}-${Date.now()}`,
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      AUTH_LOGIN_RATE_LIMIT_MAX: '1000',
      AUTH_VERIFICATION_RATE_LIMIT_MAX: '1000',
      AUTH_PASSWORD_RATE_LIMIT_MAX: '1000',
      EMAIL_PROVIDER: 'console',
      EMAIL_FROM_ADDRESS: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'Nexus',
      WORKSPACE_INVITATION_TTL_SECONDS: '3600',
      ...overrides,
    });
  }

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = getPrismaClient(database.url);
    config = buildConfig();

    await connectRedis({ redisUrl: 'redis://localhost:6379/15' });

    // The invitation mail is captured instead of sent, so the content can be
    // asserted on.
    sent = [];
    setEmailSender({
      async send(message: EmailMessage) {
        sent.push(message);

        return { accepted: true, providerMessageId: `phase5-${sent.length}` };
      },
    });

    app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    await server?.close();

    await prisma?.invitation.deleteMany({
      where: {
        OR: [{ email: { in: createdEmails } }, { invitedById: { in: createdUserIds } }],
      },
    });
    await prisma?.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma?.workspace.deleteMany({
      where: {
        OR: [
          { id: { in: createdWorkspaceIds } },
          { ownerId: { in: createdUserIds }, isPersonal: true },
        ],
      },
    });
    await prisma?.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await disconnectRedis();
    await prisma?.$disconnect();
  });

  async function createUser(name: string, email: string): Promise<{ id: string; email: string }> {
    const passwordHash = await hashPassword(PASSWORD, 4);

    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        profile: { create: {} },
      },
      select: { id: true, email: true },
    });

    createdUserIds.push(user.id);
    createdEmails.push(user.email);

    return user;
  }

  async function login(email: string): Promise<string> {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    return (response.body.data as { accessToken: string }).accessToken;
  }

  function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function api<T = unknown>(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
    } = {},
  ): Promise<{ status: number; body: JsonResponse<T>['body'] }> {
    const response = await jsonRequest<T>(`${baseUrl}/api/v1${path}`, {
      method: options.method ?? 'GET',
      ...(options.token ? { headers: bearer(options.token) } : {}),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    return { status: response.status, body: response.body };
  }

  async function createWorkspace(token: string, name = `Test Workspace ${uniqueSuffix()}`) {
    const response = await api('/workspaces', {
      method: 'POST',
      token,
      body: { name },
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));

    createdWorkspaceIds.push((response.body.data as { id: string }).id);

    return response.body.data as {
      id: string;
      name: string;
      slug: string;
      role: string;
      memberCount: number;
    };
  }

  function lastEmail(template: string): EmailMessage {
    const matching = sent.filter((message) => message.template === template);
    const message = matching[matching.length - 1];

    assert.ok(message, `Expected a ${template} email to be sent`);

    return message;
  }

  function lastInvitationEmail(): EmailMessage {
    return lastEmail('workspace_invitation');
  }

  function tokenFromEmail(message: EmailMessage): string {
    const match = message.text.match(/token=([A-Za-z0-9_-]+)/);

    assert.ok(match?.[1], `Expected an acceptance link in the invitation email: ${message.text}`);

    return match[1];
  }

  test('a new workspace makes the creator its owner', async () => {
    const email = uniqueEmail('owner');
    const user = await createUser('Workspace Owner', email);
    const token = await login(email);

    const workspace = await createWorkspace(token, 'Acme Rockets');

    assert.equal(workspace.role, 'OWNER');
    assert.equal(workspace.slug, 'acme-rockets');
    assert.equal(workspace.memberCount, 1);

    const membership = await prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    });

    assert.equal(membership?.role, 'OWNER');

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: 'workspace.created' },
    });

    assert.ok(audit, 'The creation of the workspace has to be recorded');
    assert.equal(audit?.actorId, user.id);
  });

  test('the list of workspaces only holds the ones the caller belongs to', async () => {
    const ownerEmail = uniqueEmail('list-owner');
    const otherEmail = uniqueEmail('list-other');

    await createUser('List Owner', ownerEmail);
    await createUser('List Other', otherEmail);

    const ownerToken = await login(ownerEmail);
    const otherToken = await login(otherEmail);

    const workspace = await createWorkspace(ownerToken);

    const mine = await api('/workspaces', { token: ownerToken });
    const theirs = await api('/workspaces', { token: otherToken });

    assert.equal(mine.status, 200);
    assert.ok((mine.body.data as Array<{ id: string }>).some((entry) => entry.id === workspace.id));
    assert.ok(
      !(theirs.body.data as Array<{ id: string }>).some((entry) => entry.id === workspace.id),
    );
  });

  test('a person outside the workspace cannot read it', async () => {
    const ownerEmail = uniqueEmail('deny-owner');
    const otherEmail = uniqueEmail('deny-other');

    await createUser('Deny Owner', ownerEmail);
    await createUser('Deny Other', otherEmail);

    const ownerToken = await login(ownerEmail);
    const otherToken = await login(otherEmail);

    const workspace = await createWorkspace(ownerToken);

    const denied = await api(`/workspaces/${workspace.id}`, { token: otherToken });

    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.code, 'WORKSPACE_ACCESS_DENIED');

    const missing = await api('/workspaces/8f0b6f6c-2f43-4a1a-9d3f-2a5b6c7d8e9f', {
      token: otherToken,
    });

    assert.equal(missing.status, 404);
    assert.equal(missing.body.error?.code, 'WORKSPACE_NOT_FOUND');
  });

  test('an invitation mail carries the workspace, the inviter, the role and the expiry', async () => {
    const ownerEmail = uniqueEmail('invite-owner');

    await createUser('Invite Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken, 'Acme Rockets');

    const inviteeEmail = uniqueEmail('invitee');

    sent = [];

    const created = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail, role: 'PROJECT_MANAGER' },
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(
      (created.body.data as { invitation: { status: string } }).invitation.status,
      'PENDING',
    );
    assert.equal(
      (created.body.data as { invitation: { role: string } }).invitation.role,
      'PROJECT_MANAGER',
    );
    assert.equal((created.body.data as { emailSent: boolean }).emailSent, true);

    const message = lastInvitationEmail();

    assert.equal(message.template, 'workspace_invitation');
    assert.equal(message.to, inviteeEmail);
    assert.match(message.subject, /Acme Rockets/);
    assert.match(message.text, /Acme Rockets/);
    assert.match(message.text, /Invite Owner/);
    assert.match(message.text, /project manager/i);
    assert.match(message.text, /expires/i);
    assert.match(message.text, /token=/);
    assert.match(message.html ?? '', /<a href="[^"]*token=/i);
  });

  test('the invited person registers and accepts the invitation', async () => {
    const ownerEmail = uniqueEmail('accept-owner');

    await createUser('Accept Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('accept-invitee');

    sent = [];

    await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail, role: 'MEMBER' },
    });

    const token = tokenFromEmail(lastInvitationEmail());

    // The person registers after the invitation was sent to them.
    const registered = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email: inviteeEmail, name: 'Late Invitee', password: PASSWORD }),
    });

    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const registeredUser = await prisma.user.findUnique({
      where: { email: inviteeEmail },
      select: { id: true, email: true },
    });

    if (registeredUser) {
      createdUserIds.push(registeredUser.id);
      createdEmails.push(registeredUser.email);
    }

    // The new account verifies its address, so it can hold a membership.
    const verificationCode = /\b(\d{6})\b/.exec(lastEmail('account_verification').text)?.[1];

    assert.ok(verificationCode, 'Expected a six-digit code in the verification email');

    const verified = await api('/auth/email/verify', {
      method: 'POST',
      body: { email: inviteeEmail, code: verificationCode },
    });

    assert.equal(verified.status, 200, JSON.stringify(verified.body));

    const bound = await prisma.invitation.findFirst({
      where: { email: inviteeEmail, status: 'PENDING' },
    });

    assert.ok(bound?.forUserId, 'The invitation has to be bound to the new account');

    const inviteeToken = await login(inviteeEmail);

    const accepted = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((accepted.body.data as { status: string }).status, 'ACCEPTED');

    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: workspace.id,
          userId: (await prisma.user.findUnique({ where: { email: inviteeEmail } }))?.id ?? '',
        },
      },
    });

    assert.equal(membership?.role, 'MEMBER');

    // The inviter is told that the invitation was accepted.
    const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });

    const notification = await prisma.notification.findFirst({
      where: { userId: owner?.id, type: 'INVITATION_ACCEPTED' },
    });

    assert.ok(notification, 'The inviter has to be notified');

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: 'workspace.invitation_accepted' },
    });

    assert.ok(audit, 'The acceptance has to be recorded');
  });

  test('authenticated verification explains whether the caller can accept or decline', async () => {
    const ownerEmail = uniqueEmail('verify-owner');
    const inviteeEmail = uniqueEmail('verify-invitee');
    const strangerEmail = uniqueEmail('verify-stranger');
    await createUser('Verify Owner', ownerEmail);
    const invitee = await createUser('Verify Invitee', inviteeEmail);
    await createUser('Verify Stranger', strangerEmail);

    const ownerToken = await login(ownerEmail);
    const inviteeToken = await login(inviteeEmail);
    const strangerToken = await login(strangerEmail);
    const workspace = await createWorkspace(ownerToken);
    sent = [];

    const created = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail, role: 'MEMBER' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const token = tokenFromEmail(lastInvitationEmail());

    type VerificationData = {
      workspace: { id: string; name: string; slug: string };
      status: string;
      maskedEmail: string;
      boundToAccount: boolean;
      viewer: {
        userId: string;
        email: string;
        emailMatches: boolean;
        alreadyMember: boolean;
        membershipRole: string | null;
        canAccept: boolean;
        canDecline: boolean;
        reason: string | null;
      };
    };

    // Reading the public link validates it but must not accept it.
    const preview = await api(`/invitations/${token}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));

    const stored = await prisma.invitation.findFirst({ where: { email: inviteeEmail } });
    assert.equal(stored?.status, 'PENDING');
    assert.equal(stored?.acceptedAt, null);

    // Verification is an authenticated operation.
    const anonymous = await api(`/invitations/${token}/verify`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error?.code, 'AUTHENTICATION_REQUIRED');

    // A different signed-in account learns that it is not the recipient.
    const stranger = await api<VerificationData>(`/invitations/${token}/verify`, {
      token: strangerToken,
    });
    assert.equal(stranger.status, 200, JSON.stringify(stranger.body));
    const strangerData = stranger.body.data as VerificationData;
    assert.equal(strangerData.workspace.id, workspace.id);
    assert.equal(strangerData.viewer.emailMatches, false);
    assert.equal(strangerData.viewer.canAccept, false);
    assert.equal(strangerData.viewer.canDecline, false);
    assert.equal(strangerData.viewer.reason, 'EMAIL_MISMATCH');

    // The intended recipient can act on it.
    const intended = await api<VerificationData>(`/invitations/${token}/verify`, {
      token: inviteeToken,
    });
    assert.equal(intended.status, 200, JSON.stringify(intended.body));
    const intendedData = intended.body.data as VerificationData;
    assert.equal(intendedData.workspace.id, workspace.id);
    assert.equal(intendedData.status, 'PENDING');
    assert.equal(intendedData.viewer.userId, invitee.id);
    assert.equal(intendedData.viewer.email, inviteeEmail);
    assert.equal(intendedData.viewer.emailMatches, true);
    assert.equal(intendedData.viewer.alreadyMember, false);
    assert.equal(intendedData.viewer.membershipRole, null);
    assert.equal(intendedData.viewer.canAccept, true);
    assert.equal(intendedData.viewer.canDecline, true);
    assert.equal(intendedData.viewer.reason, null);

    // Verification does not consume the invitation.
    const accepted = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    // A spent invitation is reported, not hidden behind an error.
    const after = await api<VerificationData>(`/invitations/${token}/verify`, {
      token: inviteeToken,
    });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const afterData = after.body.data as VerificationData;
    assert.equal(afterData.status, 'ACCEPTED');
    assert.equal(afterData.viewer.alreadyMember, true);
    assert.equal(afterData.viewer.membershipRole, 'MEMBER');
    assert.equal(afterData.viewer.canAccept, false);
    assert.equal(afterData.viewer.canDecline, false);
    assert.equal(afterData.viewer.reason, 'ALREADY_ACCEPTED');
  });

  test('verification tells an existing member to open the workspace instead of accepting', async () => {
    const ownerEmail = uniqueEmail('verify-member-owner');
    const inviteeEmail = uniqueEmail('verify-member-invitee');
    await createUser('Verify Member Owner', ownerEmail);
    const invitee = await createUser('Verify Member Invitee', inviteeEmail);

    const ownerToken = await login(ownerEmail);
    const inviteeToken = await login(inviteeEmail);
    const workspace = await createWorkspace(ownerToken);
    sent = [];

    await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });
    const token = tokenFromEmail(lastInvitationEmail());

    // The account joins through another path while the invitation is pending.
    const added = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail, role: 'MEMBER' },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    type VerificationData = {
      status: string;
      viewer: {
        alreadyMember: boolean;
        membershipRole: string | null;
        canAccept: boolean;
        canDecline: boolean;
        reason: string | null;
      };
    };

    const verification = await api<VerificationData>(`/invitations/${token}/verify`, {
      token: inviteeToken,
    });
    assert.equal(verification.status, 200, JSON.stringify(verification.body));
    const data = verification.body.data as VerificationData;
    assert.equal(data.status, 'PENDING');
    assert.equal(data.viewer.alreadyMember, true);
    assert.equal(data.viewer.membershipRole, 'MEMBER');
    assert.equal(data.viewer.canAccept, false);
    assert.equal(data.viewer.canDecline, true);
    assert.equal(data.viewer.reason, 'ALREADY_A_MEMBER');

    // Declining clears the pending invitation without touching membership.
    const declined = await api(`/invitations/${token}/decline`, {
      method: 'POST',
      token: inviteeToken,
    });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));

    const membership = await prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id } },
    });
    assert.equal(membership?.role, 'MEMBER');

    const after = await api<VerificationData>(`/invitations/${token}/verify`, {
      token: inviteeToken,
    });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const afterData = after.body.data as VerificationData;
    assert.equal(afterData.status, 'DECLINED');
    assert.equal(afterData.viewer.canAccept, false);
    assert.equal(afterData.viewer.canDecline, false);
    assert.equal(afterData.viewer.reason, 'DECLINED');
  });

  test('the invited person can decline once without receiving membership', async () => {
    const ownerEmail = uniqueEmail('decline-owner');
    const inviteeEmail = uniqueEmail('decline-invitee');
    const otherEmail = uniqueEmail('decline-other');
    await createUser('Decline Owner', ownerEmail);
    const invitee = await createUser('Decline Invitee', inviteeEmail);
    await createUser('Other Account', otherEmail);

    const ownerToken = await login(ownerEmail);
    const inviteeToken = await login(inviteeEmail);
    const otherToken = await login(otherEmail);
    const workspace = await createWorkspace(ownerToken);
    sent = [];

    const created = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = tokenFromEmail(lastInvitationEmail());

    const wrongAccount = await api(`/invitations/${token}/decline`, {
      method: 'POST',
      token: otherToken,
    });
    assert.equal(wrongAccount.status, 403, JSON.stringify(wrongAccount.body));

    const declined = await api(`/invitations/${token}/decline`, {
      method: 'POST',
      token: inviteeToken,
    });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal((declined.body.data as { status: string }).status, 'DECLINED');
    assert.ok((declined.body.data as { declinedAt: string | null }).declinedAt);

    const membership = await prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id } },
    });
    assert.equal(membership, null);

    const repeated = await api(`/invitations/${token}/decline`, {
      method: 'POST',
      token: inviteeToken,
    });
    assert.equal(repeated.status, 409, JSON.stringify(repeated.body));

    const reinvited = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });
    assert.equal(reinvited.status, 201, JSON.stringify(reinvited.body));
  });

  test('an invitation can only be used once', async () => {
    const ownerEmail = uniqueEmail('single-owner');

    await createUser('Single Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('single-invitee');

    await createUser('Single Invitee', inviteeEmail);

    sent = [];

    await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    const token = tokenFromEmail(lastInvitationEmail());
    const inviteeToken = await login(inviteeEmail);

    const first = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.error?.code, 'INVITATION_ALREADY_ACCEPTED');
  });

  test('an expired invitation is rejected', async () => {
    const ownerEmail = uniqueEmail('expire-owner');

    await createUser('Expire Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('expire-invitee');

    await createUser('Expire Invitee', inviteeEmail);

    sent = [];

    await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    const token = tokenFromEmail(lastInvitationEmail());

    await prisma.invitation.updateMany({
      where: { email: inviteeEmail },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const inviteeToken = await login(inviteeEmail);

    const verification = await api<{
      status: string;
      viewer: { canAccept: boolean; canDecline: boolean; reason: string | null };
    }>(`/invitations/${token}/verify`, { token: inviteeToken });
    assert.equal(verification.status, 200, JSON.stringify(verification.body));
    const verificationData = verification.body.data as {
      status: string;
      viewer: { canAccept: boolean; canDecline: boolean; reason: string | null };
    };
    assert.equal(verificationData.status, 'EXPIRED');
    assert.equal(verificationData.viewer.canAccept, false);
    assert.equal(verificationData.viewer.canDecline, false);
    assert.equal(verificationData.viewer.reason, 'EXPIRED');

    const response = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(response.status, 410);
    assert.equal(response.body.error?.code, 'INVITATION_EXPIRED');

    const stored = await prisma.invitation.findFirst({ where: { email: inviteeEmail } });

    assert.equal(stored?.status, 'EXPIRED');
  });

  test('a revoked invitation is rejected', async () => {
    const ownerEmail = uniqueEmail('revoke-owner');

    await createUser('Revoke Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('revoke-invitee');

    await createUser('Revoke Invitee', inviteeEmail);

    sent = [];

    const created = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    const invitationId = (created.body.data as { invitation: { id: string } }).invitation.id;
    const token = tokenFromEmail(lastInvitationEmail());

    const revoked = await api(`/workspaces/${workspace.id}/invitations/${invitationId}`, {
      method: 'DELETE',
      token: ownerToken,
    });

    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal((revoked.body.data as { status: string }).status, 'REVOKED');

    const inviteeToken = await login(inviteeEmail);

    const verification = await api<{
      status: string;
      viewer: { canAccept: boolean; canDecline: boolean; reason: string | null };
    }>(`/invitations/${token}/verify`, { token: inviteeToken });
    assert.equal(verification.status, 200, JSON.stringify(verification.body));
    const verificationData = verification.body.data as {
      status: string;
      viewer: { canAccept: boolean; canDecline: boolean; reason: string | null };
    };
    assert.equal(verificationData.status, 'REVOKED');
    assert.equal(verificationData.viewer.canAccept, false);
    assert.equal(verificationData.viewer.canDecline, false);
    assert.equal(verificationData.viewer.reason, 'REVOKED');

    const response = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'INVITATION_REVOKED');
  });

  test('a second pending invitation for the same address is refused', async () => {
    const ownerEmail = uniqueEmail('duplicate-owner');

    await createUser('Duplicate Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('duplicate-invitee');

    const first = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.error?.code, 'INVITATION_EXISTS');
  });

  test('concurrent duplicate invitations create only one pending invitation', async () => {
    const ownerEmail = uniqueEmail('concurrent-invite-owner');
    await createUser('Concurrent Invite Owner', ownerEmail);
    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);
    const inviteeEmail = uniqueEmail('concurrent-invitee');

    const responses = await Promise.all([
      api(`/workspaces/${workspace.id}/invitations`, {
        method: 'POST',
        token: ownerToken,
        body: { email: inviteeEmail },
      }),
      api(`/workspaces/${workspace.id}/invitations`, {
        method: 'POST',
        token: ownerToken,
        body: { email: inviteeEmail },
      }),
    ]);

    assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(
      await prisma.invitation.count({
        where: { workspaceId: workspace.id, email: inviteeEmail, status: 'PENDING' },
      }),
      1,
    );
  });

  test('an invitation for a member of the workspace is refused', async () => {
    const ownerEmail = uniqueEmail('member-invite-owner');

    await createUser('Member Invite Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const memberEmail = uniqueEmail('member-invite-member');

    await createUser('Existing Member', memberEmail);

    await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: memberEmail },
    });

    const response = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: memberEmail },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'ALREADY_A_MEMBER');
  });

  test('an invitation belongs to the account it was sent to', async () => {
    const ownerEmail = uniqueEmail('other-owner');

    await createUser('Other Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('other-invitee');
    const strangerEmail = uniqueEmail('other-stranger');

    await createUser('Other Invitee', inviteeEmail);
    await createUser('Other Stranger', strangerEmail);

    sent = [];

    await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    const token = tokenFromEmail(lastInvitationEmail());
    const strangerToken = await login(strangerEmail);

    const response = await api(`/invitations/${token}/accept`, {
      method: 'POST',
      token: strangerToken,
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error?.code, 'INVITATION_FOR_OTHER_USER');
  });

  test('a resend replaces the token of the invitation', async () => {
    const ownerEmail = uniqueEmail('resend-owner');

    await createUser('Resend Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const inviteeEmail = uniqueEmail('resend-invitee');

    await createUser('Resend Invitee', inviteeEmail);

    sent = [];

    const created = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });

    const invitationId = (created.body.data as { invitation: { id: string } }).invitation.id;
    const firstToken = tokenFromEmail(lastInvitationEmail());

    const resent = await api(`/workspaces/${workspace.id}/invitations/${invitationId}/resend`, {
      method: 'POST',
      token: ownerToken,
    });

    assert.equal(resent.status, 200, JSON.stringify(resent.body));

    const secondToken = tokenFromEmail(lastInvitationEmail());

    assert.notEqual(firstToken, secondToken);

    const inviteeToken = await login(inviteeEmail);

    const withOldToken = await api(`/invitations/${firstToken}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(withOldToken.status, 404);

    const withNewToken = await api(`/invitations/${secondToken}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });

    assert.equal(withNewToken.status, 200, JSON.stringify(withNewToken.body));
  });

  test('a member can be added, changed and removed', async () => {
    const ownerEmail = uniqueEmail('members-owner');

    await createUser('Members Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const memberEmail = uniqueEmail('members-member');
    const member = await createUser('Members Member', memberEmail);
    const memberToken = await login(memberEmail);

    const added = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: memberEmail, role: 'VIEWER' },
    });

    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((added.body.data as { role: string }).role, 'VIEWER');

    const changed = await api(`/workspaces/${workspace.id}/members/${member.id}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { role: 'MEMBER' },
    });

    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((changed.body.data as { role: string }).role, 'MEMBER');

    const members = await api(`/workspaces/${workspace.id}/members`, { token: ownerToken });

    assert.equal(members.status, 200);
    assert.equal((members.body.data as unknown[]).length, 2);

    const removed = await api(`/workspaces/${workspace.id}/members/${member.id}`, {
      method: 'DELETE',
      token: ownerToken,
    });

    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    // The removed member loses the access to the workspace.
    const denied = await api(`/workspaces/${workspace.id}`, { token: memberToken });

    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.code, 'WORKSPACE_ACCESS_DENIED');

    const audit = await prisma.auditLog.findMany({
      where: { workspaceId: workspace.id, action: { startsWith: 'workspace.member_' } },
    });

    assert.equal(audit.length, 3);
  });

  test('the owner of a workspace cannot be demoted or removed', async () => {
    const ownerEmail = uniqueEmail('fixed-owner');

    const owner = await createUser('Fixed Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const demoted = await api(`/workspaces/${workspace.id}/members/${owner.id}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { role: 'MEMBER' },
    });

    assert.equal(demoted.status, 409);
    assert.equal(demoted.body.error?.code, 'LAST_ORGANIZATION_OWNER');

    const removed = await api(`/workspaces/${workspace.id}/members/${owner.id}`, {
      method: 'DELETE',
      token: ownerToken,
    });

    assert.equal(removed.status, 409);
    assert.equal(removed.body.error?.code, 'LAST_ORGANIZATION_OWNER');
  });

  test('a project manager cannot manage another project manager', async () => {
    const ownerEmail = uniqueEmail('manager-owner');

    await createUser('Manager Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const firstEmail = uniqueEmail('manager-first');
    const secondEmail = uniqueEmail('manager-second');

    await createUser('Manager First', firstEmail);
    await createUser('Manager Second', secondEmail);

    await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: firstEmail, role: 'PROJECT_MANAGER' },
    });

    await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: secondEmail, role: 'PROJECT_MANAGER' },
    });

    const first = await prisma.user.findUnique({ where: { email: firstEmail } });
    const second = await prisma.user.findUnique({ where: { email: secondEmail } });

    const firstToken = await login(firstEmail);

    const response = await api(`/workspaces/${workspace.id}/members/${second?.id}`, {
      method: 'PATCH',
      token: firstToken,
      body: { role: 'MEMBER' },
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error?.code, 'INSUFFICIENT_ROLE');
    assert.ok(first);
  });

  test('a project manager cannot grant project-manager privileges through any workspace role path', async () => {
    const ownerEmail = uniqueEmail('grant-role-owner');
    const managerEmail = uniqueEmail('grant-role-manager');
    const memberEmail = uniqueEmail('grant-role-member');
    const addedEmail = uniqueEmail('grant-role-added');
    const invitedEmail = uniqueEmail('grant-role-invited');

    await createUser('Grant Role Owner', ownerEmail);
    const manager = await createUser('Grant Role Manager', managerEmail);
    const member = await createUser('Grant Role Member', memberEmail);
    await createUser('Grant Role Added', addedEmail);

    const ownerToken = await login(ownerEmail);
    const managerToken = await login(managerEmail);
    const workspace = await createWorkspace(ownerToken);

    // The owner's legitimate role grants continue to work.
    const managerAdded = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: managerEmail, role: 'PROJECT_MANAGER' },
    });
    assert.equal(managerAdded.status, 201, JSON.stringify(managerAdded.body));

    const memberAdded = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: memberEmail, role: 'MEMBER' },
    });
    assert.equal(memberAdded.status, 201, JSON.stringify(memberAdded.body));

    const elevateByAdding = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: managerToken,
      body: { email: addedEmail, role: 'PROJECT_MANAGER' },
    });
    assert.equal(elevateByAdding.status, 403);
    assert.equal(elevateByAdding.body.error?.code, 'INSUFFICIENT_ROLE');

    const elevateMember = await api(`/workspaces/${workspace.id}/members/${member.id}`, {
      method: 'PATCH',
      token: managerToken,
      body: { role: 'PROJECT_MANAGER' },
    });
    assert.equal(elevateMember.status, 403);
    assert.equal(elevateMember.body.error?.code, 'INSUFFICIENT_ROLE');

    const manageLowerRole = await api(`/workspaces/${workspace.id}/members/${member.id}`, {
      method: 'PATCH',
      token: managerToken,
      body: { role: 'VIEWER' },
    });
    assert.equal(manageLowerRole.status, 200, JSON.stringify(manageLowerRole.body));
    assert.equal((manageLowerRole.body.data as { role: string }).role, 'VIEWER');

    const elevateSelf = await api(`/workspaces/${workspace.id}/members/${manager.id}`, {
      method: 'PATCH',
      token: managerToken,
      body: { role: 'PROJECT_MANAGER' },
    });
    assert.equal(elevateSelf.status, 403);
    assert.equal(elevateSelf.body.error?.code, 'INSUFFICIENT_ROLE');

    const inviteAsManager = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: managerToken,
      body: { email: invitedEmail, role: 'PROJECT_MANAGER' },
    });
    assert.equal(inviteAsManager.status, 403);
    assert.equal(inviteAsManager.body.error?.code, 'INSUFFICIENT_ROLE');

    // A resend re-issues the role of the stored invitation, so a project
    // manager must not be able to resend a project-manager invitation that
    // the owner created. Otherwise the create-time guard is bypassed.
    const resendTargetEmail = uniqueEmail('grant-role-resend');
    const ownerInvite = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: resendTargetEmail, role: 'PROJECT_MANAGER' },
    });
    assert.equal(ownerInvite.status, 201, JSON.stringify(ownerInvite.body));

    const ownerInvitationId = (ownerInvite.body.data as { invitation: { id: string } }).invitation
      .id;

    const resendAsManager = await api(
      `/workspaces/${workspace.id}/invitations/${ownerInvitationId}/resend`,
      { method: 'POST', token: managerToken },
    );
    assert.equal(resendAsManager.status, 403);
    assert.equal(resendAsManager.body.error?.code, 'INSUFFICIENT_ROLE');

    // The owner can still resend the same invitation.
    const resendAsOwner = await api(
      `/workspaces/${workspace.id}/invitations/${ownerInvitationId}/resend`,
      { method: 'POST', token: ownerToken },
    );
    assert.equal(resendAsOwner.status, 200, JSON.stringify(resendAsOwner.body));

    assert.equal(
      await prisma.workspaceMembership
        .findUnique({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: member.id } },
          select: { role: true },
        })
        .then((row) => row?.role),
      'VIEWER',
    );
    assert.equal(
      await prisma.workspaceMembership
        .findUnique({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: manager.id } },
          select: { role: true },
        })
        .then((row) => row?.role),
      'PROJECT_MANAGER',
    );
    assert.equal(
      await prisma.invitation.count({ where: { workspaceId: workspace.id, email: invitedEmail } }),
      0,
    );
  });

  test('membership role changes stay scoped to the actor workspace', async () => {
    const firstOwnerEmail = uniqueEmail('scope-first-owner');
    const secondOwnerEmail = uniqueEmail('scope-second-owner');
    const managerEmail = uniqueEmail('scope-manager');
    const targetEmail = uniqueEmail('scope-target');

    await createUser('First Workspace Owner', firstOwnerEmail);
    await createUser('Second Workspace Owner', secondOwnerEmail);
    await createUser('Scoped Manager', managerEmail);
    const target = await createUser('Other Workspace Member', targetEmail);

    const firstOwnerToken = await login(firstOwnerEmail);
    const secondOwnerToken = await login(secondOwnerEmail);
    const managerToken = await login(managerEmail);
    const firstWorkspace = await createWorkspace(firstOwnerToken);
    const secondWorkspace = await createWorkspace(secondOwnerToken);

    const managerAdded = await api(`/workspaces/${firstWorkspace.id}/members`, {
      method: 'POST',
      token: firstOwnerToken,
      body: { email: managerEmail, role: 'PROJECT_MANAGER' },
    });
    assert.equal(managerAdded.status, 201, JSON.stringify(managerAdded.body));

    const targetAdded = await api(`/workspaces/${secondWorkspace.id}/members`, {
      method: 'POST',
      token: secondOwnerToken,
      body: { email: targetEmail, role: 'MEMBER' },
    });
    assert.equal(targetAdded.status, 201, JSON.stringify(targetAdded.body));

    const crossWorkspaceTarget = await api(
      `/workspaces/${firstWorkspace.id}/members/${target.id}`,
      { method: 'PATCH', token: managerToken, body: { role: 'VIEWER' } },
    );
    assert.equal(crossWorkspaceTarget.status, 404);
    assert.equal(crossWorkspaceTarget.body.error?.code, 'MEMBER_NOT_FOUND');

    const outsideActor = await login(secondOwnerEmail);
    const unauthorizedWorkspace = await api(
      `/workspaces/${firstWorkspace.id}/members/${target.id}`,
      { method: 'PATCH', token: outsideActor, body: { role: 'VIEWER' } },
    );
    assert.equal(unauthorizedWorkspace.status, 403);
    assert.equal(unauthorizedWorkspace.body.error?.code, 'WORKSPACE_ACCESS_DENIED');
  });

  test('a member without the right role cannot manage the members', async () => {
    const ownerEmail = uniqueEmail('viewer-owner');

    await createUser('Viewer Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const viewerEmail = uniqueEmail('viewer-member');

    await createUser('Viewer Member', viewerEmail);

    await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: viewerEmail, role: 'VIEWER' },
    });

    const viewerToken = await login(viewerEmail);

    const response = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: viewerToken,
      body: { email: uniqueEmail('viewer-target') },
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error?.code, 'INSUFFICIENT_ROLE');
  });

  test('a workspace can be archived and deleted', async () => {
    const ownerEmail = uniqueEmail('lifecycle-owner');

    await createUser('Lifecycle Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const archived = await api(`/workspaces/${workspace.id}/archive`, {
      method: 'POST',
      token: ownerToken,
    });

    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal((archived.body.data as { status: string }).status, 'ARCHIVED');

    const deleted = await api(`/workspaces/${workspace.id}`, {
      method: 'DELETE',
      token: ownerToken,
    });

    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

    const missing = await api(`/workspaces/${workspace.id}`, { token: ownerToken });

    assert.equal(missing.status, 404);

    const list = await api('/workspaces', { token: ownerToken });

    assert.ok(
      !(list.body.data as Array<{ id: string }>).some((entry) => entry.id === workspace.id),
    );
  });

  test('archiving revokes pending invitations and prevents invitation use or workspace switching', async () => {
    const ownerEmail = uniqueEmail('archive-invite-owner');
    const inviteeEmail = uniqueEmail('archive-invitee');
    await createUser('Archive Invite Owner', ownerEmail);
    await createUser('Archive Invitee', inviteeEmail);
    const ownerToken = await login(ownerEmail);
    const inviteeToken = await login(inviteeEmail);
    const workspace = await createWorkspace(ownerToken);
    const invited = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: inviteeEmail },
    });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const invite = (invited.body.data as { invitation: { id: string } }).invitation;
    const inviteToken = tokenFromEmail(lastInvitationEmail());

    const archived = await api(`/workspaces/${workspace.id}/archive`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));

    const stored = await prisma.invitation.findUnique({ where: { id: invite.id } });
    assert.equal(stored?.status, 'REVOKED');
    assert.equal(stored?.pendingKey, null);
    const preview = await api(`/invitations/${inviteToken}`);
    assert.equal(preview.status, 410);
    assert.equal(preview.body.error?.code, 'INVITATION_WORKSPACE_UNAVAILABLE');
    const accept = await api(`/invitations/${inviteToken}/accept`, {
      method: 'POST',
      token: inviteeToken,
    });
    assert.equal(accept.status, 409);
    assert.equal(accept.body.error?.code, 'INVITATION_REVOKED');
    const newInvite = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: uniqueEmail('archived-target') },
    });
    assert.equal(newInvite.status, 409);
    assert.equal(newInvite.body.error?.code, 'WORKSPACE_NOT_ACTIVE');
    const switchResult = await api(`/workspaces/${workspace.id}/switch`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(switchResult.status, 409);
    assert.equal(switchResult.body.error?.code, 'WORKSPACE_NOT_ACTIVE');
  });

  test('only the workspace owner can restore an archived workspace and the change is audited', async () => {
    const ownerEmail = uniqueEmail('restore-owner');
    const managerEmail = uniqueEmail('restore-manager');
    const owner = await createUser('Restore Owner', ownerEmail);
    const manager = await createUser('Restore Manager', managerEmail);
    const ownerToken = await login(ownerEmail);
    const managerToken = await login(managerEmail);
    const workspace = await createWorkspace(ownerToken);

    await prisma.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: manager.id, role: 'PROJECT_MANAGER' },
    });

    const archived = await api(`/workspaces/${workspace.id}/archive`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));

    const managerRestore = await api(`/workspaces/${workspace.id}/restore`, {
      method: 'POST',
      token: managerToken,
    });
    assert.equal(managerRestore.status, 403);

    const restored = await api(`/workspaces/${workspace.id}/restore`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((restored.body.data as { status: string }).status, 'ACTIVE');

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: 'workspace.restored' },
    });
    assert.equal(audit?.actorId, owner.id);

    const redundantRestore = await api(`/workspaces/${workspace.id}/restore`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(redundantRestore.status, 409);
    assert.equal(redundantRestore.body.error?.code, 'WORKSPACE_NOT_ARCHIVED');

    const deleted = await api(`/workspaces/${workspace.id}`, {
      method: 'DELETE',
      token: ownerToken,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

    const restoreDeleted = await api(`/workspaces/${workspace.id}/restore`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(restoreDeleted.status, 404);
  });

  test('the invitations of a workspace are listed with their state', async () => {
    const ownerEmail = uniqueEmail('list-invite-owner');

    await createUser('List Invite Owner', ownerEmail);

    const ownerToken = await login(ownerEmail);
    const workspace = await createWorkspace(ownerToken);

    const pendingEmail = uniqueEmail('list-invite-pending');
    const revokedEmail = uniqueEmail('list-invite-revoked');

    const pending = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: pendingEmail },
    });

    const revoked = await api(`/workspaces/${workspace.id}/invitations`, {
      method: 'POST',
      token: ownerToken,
      body: { email: revokedEmail },
    });

    const revokedInvitationId = (revoked.body.data as { invitation: { id: string } }).invitation.id;

    await api(`/workspaces/${workspace.id}/invitations/${revokedInvitationId}`, {
      method: 'DELETE',
      token: ownerToken,
    });

    const all = await api(`/workspaces/${workspace.id}/invitations`, { token: ownerToken });

    assert.equal(all.status, 200);
    assert.equal((all.body.data as unknown[]).length, 2);

    const open = await api(`/workspaces/${workspace.id}/invitations?status=PENDING`, {
      token: ownerToken,
    });

    assert.equal((open.body.data as unknown[]).length, 1);
    assert.equal(
      (open.body.data as Array<{ id: string }>)[0]?.id,
      (pending.body.data as { invitation: { id: string } }).invitation.id,
    );
  });

  test('a caller without a session cannot reach the workspace endpoints', async () => {
    const response = await api('/workspaces');

    assert.equal(response.status, 401);
  });
});
