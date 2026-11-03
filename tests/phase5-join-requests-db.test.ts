import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { getPrismaClient } from '../src/db/prisma';
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
 * Phase 5 join-request, discovery and membership-suspension integration tests.
 *
 * The suite runs against a real PostgreSQL database and the real HTTP
 * application. It is opt-in because it creates accounts and workspaces.
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

describe('Phase 5 discovery, join requests and suspension', { skip: skipReason || false }, () => {
  let app: Express;
  let server: RunningServer;
  let prisma: ReturnType<typeof getPrismaClient>;
  let config: AppConfig;
  let baseUrl: string;
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdEmails: string[] = [];

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = getPrismaClient(database.url);
    config = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'info',
      JWT_ACCESS_SECRET: 'phase5-join-integration-test-access-secret',
      BCRYPT_SALT_ROUNDS: '4',
      RATE_LIMIT_MAX: '100000',
      RATE_LIMIT_NAMESPACE: `nexus-phase5-join-${process.pid}-${Date.now()}`,
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      AUTH_LOGIN_RATE_LIMIT_MAX: '1000',
      AUTH_VERIFICATION_RATE_LIMIT_MAX: '1000',
      AUTH_PASSWORD_RATE_LIMIT_MAX: '1000',
      EMAIL_PROVIDER: 'console',
      EMAIL_FROM_ADDRESS: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'Nexus',
      WORKSPACE_JOIN_REQUEST_TTL_SECONDS: '604800',
    });

    setEmailSender({
      async send(_message: EmailMessage) {
        return { accepted: true, providerMessageId: 'phase5-join' };
      },
    });

    app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    await server?.close();

    await prisma?.joinRequest.deleteMany({
      where: {
        OR: [{ workspaceId: { in: createdWorkspaceIds } }, { userId: { in: createdUserIds } }],
      },
    });
    await prisma?.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma?.invitation.deleteMany({ where: { workspaceId: { in: createdWorkspaceIds } } });
    await prisma?.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma?.user.deleteMany({ where: { id: { in: createdUserIds } } });
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

  async function api<T = unknown>(
    path: string,
    options: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: JsonResponse<T>['body'] }> {
    const response = await jsonRequest<T>(`${baseUrl}/api/v1${path}`, {
      method: options.method ?? 'GET',
      ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    return { status: response.status, body: response.body };
  }

  async function createWorkspace(
    token: string,
    body: { name: string; type?: string; visibility?: string },
  ) {
    const response = await api('/workspaces', { method: 'POST', token, body });

    assert.equal(response.status, 201, JSON.stringify(response.body));

    const workspace = response.body.data as {
      id: string;
      name: string;
      type: string;
      visibility: string;
      joinCodeEnabled: boolean;
    };

    createdWorkspaceIds.push(workspace.id);

    return workspace;
  }

  async function addWorkspaceMember(token: string, workspaceId: string, email: string) {
    return api(`/workspaces/${workspaceId}/members`, {
      method: 'POST',
      token,
      body: { email, role: 'MEMBER' },
    });
  }

  async function createAssignedTask(input: {
    workspaceId: string;
    ownerId: string;
    formerAssigneeId: string;
    replacementId?: string;
    status?: 'ASSIGNED' | 'APPROVED';
  }): Promise<string> {
    const project = await prisma.project.create({
      data: {
        workspaceId: input.workspaceId,
        name: `Reassignment Project ${uniqueSuffix()}`,
        key: `RA${uniqueCounter}`,
        status: 'ACTIVE',
        ownerId: input.ownerId,
      },
    });

    await prisma.projectMembership.create({
      data: {
        projectId: project.id,
        userId: input.formerAssigneeId,
        role: 'MEMBER',
      },
    });

    if (input.replacementId) {
      await prisma.projectMembership.create({
        data: {
          projectId: project.id,
          userId: input.replacementId,
          role: 'MEMBER',
        },
      });
    }

    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        key: `T${uniqueCounter}`,
        title: `Reassign task ${uniqueSuffix()}`,
        creatorId: input.ownerId,
        ...(input.status ? { status: input.status } : {}),
      },
    });

    await prisma.taskAssignee.create({
      data: { taskId: task.id, userId: input.formerAssigneeId, assignedBy: input.ownerId },
    });

    return task.id;
  }

  test('a public institution is discoverable and approval grants membership', async () => {
    const ownerEmail = uniqueEmail('discover-owner');
    const applicantEmail = uniqueEmail('discover-applicant');
    const workspaceName = `Open Institute ${uniqueSuffix()}`;

    await createUser('Open Institute Owner', ownerEmail);
    await createUser('Open Institute Applicant', applicantEmail);

    const ownerToken = await login(ownerEmail);
    const applicantToken = await login(applicantEmail);

    const workspace = await createWorkspace(ownerToken, {
      name: workspaceName,
      type: 'INSTITUTION',
      visibility: 'PUBLIC',
    });

    assert.equal(workspace.type, 'INSTITUTION');
    assert.equal(workspace.visibility, 'PUBLIC');

    // A pending applicant has no access before approval.
    const beforeApproval = await api(`/workspaces/${workspace.id}`, { token: applicantToken });
    assert.equal(beforeApproval.status, 403);

    const discovered = await api<Array<{ id: string }>>(
      `/workspaces/discover?search=${encodeURIComponent(workspaceName)}`,
      { token: applicantToken },
    );
    assert.equal(discovered.status, 200, JSON.stringify(discovered.body));
    assert.ok(
      (discovered.body.data as Array<{ id: string }>).some((row) => row.id === workspace.id),
      'the public workspace must appear in discovery',
    );

    const requested = await api<{ id: string; status: string }>(
      `/workspaces/${workspace.id}/join-requests`,
      { method: 'POST', token: applicantToken, body: { message: 'I would like to join.' } },
    );
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    assert.equal((requested.body.data as { status: string }).status, 'PENDING');

    const requestId = (requested.body.data as { id: string }).id;

    const listed = await api<Array<{ id: string }>>(`/workspaces/${workspace.id}/join-requests`, {
      token: ownerToken,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok((listed.body.data as Array<{ id: string }>).some((row) => row.id === requestId));

    const approved = await api(`/workspaces/${workspace.id}/join-requests/${requestId}/approve`, {
      method: 'POST',
      token: ownerToken,
      body: { role: 'MEMBER' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const afterApproval = await api<{ role: string }>(`/workspaces/${workspace.id}`, {
      token: applicantToken,
    });
    assert.equal(afterApproval.status, 200, JSON.stringify(afterApproval.body));
    assert.equal((afterApproval.body.data as { role: string }).role, 'MEMBER');

    const duplicate = await api(`/workspaces/${workspace.id}/join-requests`, {
      method: 'POST',
      token: applicantToken,
      body: {},
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error?.code, 'ALREADY_A_MEMBER');
  });

  test('a private workspace is not discoverable but a join code works', async () => {
    const ownerEmail = uniqueEmail('code-owner');
    const applicantEmail = uniqueEmail('code-applicant');
    const workspaceName = `Private Company ${uniqueSuffix()}`;

    await createUser('Private Company Owner', ownerEmail);
    await createUser('Private Company Applicant', applicantEmail);

    const ownerToken = await login(ownerEmail);
    const applicantToken = await login(applicantEmail);

    const workspace = await createWorkspace(ownerToken, { name: workspaceName });

    assert.equal(workspace.visibility, 'PRIVATE');

    const discovered = await api<Array<{ id: string }>>(
      `/workspaces/discover?search=${encodeURIComponent(workspaceName)}`,
      { token: applicantToken },
    );
    assert.equal(discovered.status, 200);
    assert.equal(
      (discovered.body.data as Array<{ id: string }>).some((row) => row.id === workspace.id),
      false,
    );

    const direct = await api(`/workspaces/${workspace.id}/join-requests`, {
      method: 'POST',
      token: applicantToken,
      body: {},
    });
    assert.equal(direct.status, 403);
    assert.equal(direct.body.error?.code, 'WORKSPACE_NOT_DISCOVERABLE');

    const generated = await api<{ code: string; link: string }>(
      `/workspaces/${workspace.id}/join-code`,
      { method: 'POST', token: ownerToken },
    );
    assert.equal(generated.status, 201, JSON.stringify(generated.body));

    const code = (generated.body.data as { code: string }).code;
    const link = (generated.body.data as { link: string }).link;
    assert.match(link, /code=/);

    const byCode = await api<{ id: string; status: string }>('/workspaces/join', {
      method: 'POST',
      token: applicantToken,
      body: { code },
    });
    assert.equal(byCode.status, 201, JSON.stringify(byCode.body));

    const rotated = await api<{ code: string }>(`/workspaces/${workspace.id}/join-code`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(rotated.status, 201);

    const otherEmail = uniqueEmail('code-other');
    await createUser('Private Company Other', otherEmail);
    const otherToken = await login(otherEmail);

    const staleCode = await api('/workspaces/join', {
      method: 'POST',
      token: otherToken,
      body: { code },
    });
    assert.equal(staleCode.status, 404);
    assert.equal(staleCode.body.error?.code, 'JOIN_CODE_NOT_FOUND');

    const disabled = await api(`/workspaces/${workspace.id}/join-code`, {
      method: 'DELETE',
      token: ownerToken,
    });
    assert.equal(disabled.status, 200);

    const disabledCode = await api('/workspaces/join', {
      method: 'POST',
      token: otherToken,
      body: { code: (rotated.body.data as { code: string }).code },
    });
    assert.equal(disabledCode.status, 404);
  });

  test('a request can be withdrawn or rejected without granting membership', async () => {
    const ownerEmail = uniqueEmail('decision-owner');
    const applicantEmail = uniqueEmail('decision-applicant');
    const workspaceName = `Decision Company ${uniqueSuffix()}`;

    await createUser('Decision Owner', ownerEmail);
    await createUser('Decision Applicant', applicantEmail);

    const ownerToken = await login(ownerEmail);
    const applicantToken = await login(applicantEmail);

    const workspace = await createWorkspace(ownerToken, {
      name: workspaceName,
      visibility: 'PUBLIC',
    });

    const first = await api<{ id: string }>(`/workspaces/${workspace.id}/join-requests`, {
      method: 'POST',
      token: applicantToken,
      body: {},
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const withdrawn = await api<{ status: string }>(
      `/workspaces/join-requests/${(first.body.data as { id: string }).id}`,
      { method: 'DELETE', token: applicantToken },
    );
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal((withdrawn.body.data as { status: string }).status, 'WITHDRAWN');

    const second = await api<{ id: string }>(`/workspaces/${workspace.id}/join-requests`, {
      method: 'POST',
      token: applicantToken,
      body: {},
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const rejected = await api<{ status: string }>(
      `/workspaces/${workspace.id}/join-requests/${(second.body.data as { id: string }).id}/reject`,
      { method: 'POST', token: ownerToken, body: { note: 'Not a fit right now.' } },
    );
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal((rejected.body.data as { status: string }).status, 'REJECTED');

    const access = await api(`/workspaces/${workspace.id}`, { token: applicantToken });
    assert.equal(access.status, 403);
  });

  test('concurrent approval attempts create only one membership', async () => {
    const ownerEmail = uniqueEmail('concurrent-owner');
    const applicantEmail = uniqueEmail('concurrent-applicant');

    await createUser('Concurrent Owner', ownerEmail);
    await createUser('Concurrent Applicant', applicantEmail);

    const ownerToken = await login(ownerEmail);
    const applicantToken = await login(applicantEmail);
    const workspace = await createWorkspace(ownerToken, {
      name: `Concurrent Company ${uniqueSuffix()}`,
      visibility: 'PUBLIC',
    });

    const requested = await api<{ id: string }>(`/workspaces/${workspace.id}/join-requests`, {
      method: 'POST',
      token: applicantToken,
      body: {},
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));

    const approvePath =
      `/workspaces/${workspace.id}/join-requests/` +
      `${(requested.body.data as { id: string }).id}/approve`;
    const outcomes = await Promise.all([
      api(approvePath, { method: 'POST', token: ownerToken, body: {} }),
      api(approvePath, { method: 'POST', token: ownerToken, body: {} }),
    ]);

    assert.deepEqual(
      outcomes.map((outcome) => outcome.status).sort(),
      [200, 409],
      JSON.stringify(outcomes.map((outcome) => outcome.body)),
    );
    assert.equal(
      await prisma.workspaceMembership.count({
        where: { workspaceId: workspace.id, user: { email: applicantEmail } },
      }),
      1,
    );
  });

  test('an expired request cannot be approved', async () => {
    const ownerEmail = uniqueEmail('expire-owner');
    const applicantEmail = uniqueEmail('expire-applicant');

    await createUser('Expire Owner', ownerEmail);
    await createUser('Expire Applicant', applicantEmail);

    const ownerToken = await login(ownerEmail);
    const applicantToken = await login(applicantEmail);

    const workspace = await createWorkspace(ownerToken, {
      name: `Expire Company ${uniqueSuffix()}`,
      visibility: 'PUBLIC',
    });

    const requested = await api<{ id: string }>(`/workspaces/${workspace.id}/join-requests`, {
      method: 'POST',
      token: applicantToken,
      body: {},
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));

    await prisma.joinRequest.update({
      where: { id: (requested.body.data as { id: string }).id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const approved = await api(
      `/workspaces/${workspace.id}/join-requests/${(requested.body.data as { id: string }).id}/approve`,
      { method: 'POST', token: ownerToken, body: {} },
    );
    assert.equal(approved.status, 410);
    assert.equal(approved.body.error?.code, 'JOIN_REQUEST_EXPIRED');

    const membership = await prisma.workspaceMembership.count({
      where: { workspaceId: workspace.id },
    });
    assert.equal(membership, 1, 'only the owner membership may exist');
  });

  test('a suspended member loses access and can be restored', async () => {
    const ownerEmail = uniqueEmail('suspend-owner');
    const memberEmail = uniqueEmail('suspend-member');

    const owner = await createUser('Suspend Owner', ownerEmail);
    const member = await createUser('Suspend Member', memberEmail);

    const ownerToken = await login(ownerEmail);
    const memberToken = await login(memberEmail);

    const workspace = await createWorkspace(ownerToken, {
      name: `Suspend Company ${uniqueSuffix()}`,
    });

    const added = await api(`/workspaces/${workspace.id}/members`, {
      method: 'POST',
      token: ownerToken,
      body: { email: memberEmail, role: 'MEMBER' },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    const suspended = await api<{ membershipStatus: string }>(
      `/workspaces/${workspace.id}/members/${member.id}/suspend`,
      { method: 'POST', token: ownerToken },
    );
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(
      (suspended.body.data as { membershipStatus: string }).membershipStatus,
      'SUSPENDED',
    );

    const blocked = await api(`/workspaces/${workspace.id}`, { token: memberToken });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error?.code, 'MEMBERSHIP_SUSPENDED');

    const restored = await api<{ membershipStatus: string }>(
      `/workspaces/${workspace.id}/members/${member.id}/restore`,
      { method: 'POST', token: ownerToken },
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((restored.body.data as { membershipStatus: string }).membershipStatus, 'ACTIVE');

    const allowed = await api(`/workspaces/${workspace.id}`, { token: memberToken });
    assert.equal(allowed.status, 200);

    const ownerSuspend = await api(`/workspaces/${workspace.id}/members/${owner.id}/suspend`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(ownerSuspend.status, 403);
  });

  test('an individual workspace cannot be published or given a join code', async () => {
    const ownerEmail = uniqueEmail('individual-owner');
    const workspaceName = `Personal ${uniqueSuffix()}`;

    await createUser('Individual Owner', ownerEmail);
    const ownerToken = await login(ownerEmail);

    const workspace = await createWorkspace(ownerToken, {
      name: workspaceName,
      type: 'INDIVIDUAL',
    });

    const publish = await api(`/workspaces/${workspace.id}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { visibility: 'PUBLIC' },
    });
    assert.equal(publish.status, 400);
    assert.equal(publish.body.error?.code, 'INDIVIDUAL_WORKSPACE_NOT_DISCOVERABLE');

    const code = await api(`/workspaces/${workspace.id}/join-code`, {
      method: 'POST',
      token: ownerToken,
    });
    assert.equal(code.status, 409);
    assert.equal(code.body.error?.code, 'WORKSPACE_NOT_JOINABLE');

    const discovered = await api<Array<{ id: string }>>(
      `/workspaces/discover?search=${encodeURIComponent(workspaceName)}`,
      { token: ownerToken },
    );
    assert.equal(discovered.status, 200);
    assert.equal(
      (discovered.body.data as Array<{ id: string }>).some((row) => row.id === workspace.id),
      false,
    );
  });

  test('a matching email domain does not grant workspace access without an invitation', async () => {
    const ownerEmail = uniqueEmail('domain-owner');
    const applicantEmail = uniqueEmail('domain-applicant');

    await createUser('Domain Owner', ownerEmail);
    const applicant = await createUser('Domain Applicant', applicantEmail);
    const ownerToken = await login(ownerEmail);
    const applicantToken = await login(applicantEmail);
    const workspace = await createWorkspace(ownerToken, {
      name: `Private Domain Company ${uniqueSuffix()}`,
    });

    assert.equal(ownerEmail.split('@')[1], applicantEmail.split('@')[1]);

    const access = await api(`/workspaces/${workspace.id}`, { token: applicantToken });
    assert.equal(access.status, 403);
    assert.equal(
      await prisma.workspaceMembership.count({
        where: { workspaceId: workspace.id, userId: applicant.id },
      }),
      0,
    );
  });

  test('member removal requires and atomically applies an eligible task reassignee', async () => {
    const ownerEmail = uniqueEmail('task-removal-owner');
    const formerEmail = uniqueEmail('task-removal-former');
    const replacementEmail = uniqueEmail('task-removal-replacement');
    const owner = await createUser('Task Removal Owner', ownerEmail);
    const former = await createUser('Former Task Assignee', formerEmail);
    const replacement = await createUser('Replacement Assignee', replacementEmail);
    const ownerToken = await login(ownerEmail);
    const formerToken = await login(formerEmail);
    const replacementToken = await login(replacementEmail);
    const workspace = await createWorkspace(ownerToken, {
      name: `Task Removal Company ${uniqueSuffix()}`,
    });

    assert.equal((await addWorkspaceMember(ownerToken, workspace.id, formerEmail)).status, 201);
    assert.equal(
      (await addWorkspaceMember(ownerToken, workspace.id, replacementEmail)).status,
      201,
    );
    const taskId = await createAssignedTask({
      workspaceId: workspace.id,
      ownerId: owner.id,
      formerAssigneeId: former.id,
      replacementId: replacement.id,
    });
    const completedTaskId = await createAssignedTask({
      workspaceId: workspace.id,
      ownerId: owner.id,
      formerAssigneeId: former.id,
      status: 'APPROVED',
    });

    const missingReplacement = await api(`/workspaces/${workspace.id}/members/${former.id}`, {
      method: 'DELETE',
      token: ownerToken,
    });
    assert.equal(missingReplacement.status, 409);
    assert.equal(missingReplacement.body.error?.code, 'TASK_REASSIGNMENT_REQUIRED');
    assert.equal((missingReplacement.body.error?.details as { taskCount: number }).taskCount, 1);
    assert.equal(
      await prisma.workspaceMembership.count({
        where: { workspaceId: workspace.id, userId: former.id },
      }),
      1,
      'the membership remains when reassignment is required',
    );

    const before = new Date();
    const removed = await api(`/workspaces/${workspace.id}/members/${former.id}`, {
      method: 'DELETE',
      token: ownerToken,
      body: { reassignTasksToUserId: replacement.id },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const assignments = await prisma.taskAssignee.findMany({ where: { taskId } });
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]?.userId, replacement.id);
    assert.equal(assignments[0]?.assignedBy, owner.id);
    assert.ok(assignments[0]?.assignedAt.getTime() >= before.getTime());
    assert.equal(
      await prisma.taskAssignee.count({ where: { taskId: completedTaskId, userId: former.id } }),
      1,
      'approved task assignments remain as historical records',
    );
    assert.equal(
      await prisma.workspaceMembership.count({
        where: { workspaceId: workspace.id, userId: former.id },
      }),
      0,
    );

    const notification = await prisma.notification.findFirst({
      where: {
        userId: replacement.id,
        type: 'TASK_REASSIGNED',
        data: { path: ['taskId'], equals: taskId },
      },
    });
    assert.ok(notification, 'the replacement assignee receives a task notification');

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: 'task.reassigned', targetId: taskId },
    });
    assert.ok(audit, 'the task reassignment is retained in the audit trail');
    const reassignedTask = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.deepEqual(audit.metadata, {
      projectId: reassignedTask.projectId,
      previousAssigneeId: former.id,
      assigneeId: replacement.id,
      reason: 'workspace_member_removed',
      assigneeWasAlreadyAssigned: false,
    });

    const formerWorkspace = await api(`/workspaces/${workspace.id}`, { token: formerToken });
    assert.equal(formerWorkspace.status, 403);
    const replacementWorkspace = await api(`/workspaces/${workspace.id}`, {
      token: replacementToken,
    });
    assert.equal(replacementWorkspace.status, 200);
  });

  test('task reassignment rejects workspace members without project access', async () => {
    const ownerEmail = uniqueEmail('task-scope-owner');
    const formerEmail = uniqueEmail('task-scope-former');
    const outsiderEmail = uniqueEmail('task-scope-outsider');
    const owner = await createUser('Task Scope Owner', ownerEmail);
    const former = await createUser('Task Scope Former', formerEmail);
    const outsider = await createUser('Task Scope Outsider', outsiderEmail);
    const ownerToken = await login(ownerEmail);
    await login(formerEmail);
    const outsiderToken = await login(outsiderEmail);
    const workspace = await createWorkspace(ownerToken, {
      name: `Task Scope Company ${uniqueSuffix()}`,
    });

    assert.equal((await addWorkspaceMember(ownerToken, workspace.id, formerEmail)).status, 201);
    assert.equal((await addWorkspaceMember(ownerToken, workspace.id, outsiderEmail)).status, 201);
    const taskId = await createAssignedTask({
      workspaceId: workspace.id,
      ownerId: owner.id,
      formerAssigneeId: former.id,
    });

    const response = await api(`/workspaces/${workspace.id}/members/${former.id}`, {
      method: 'DELETE',
      token: ownerToken,
      body: { reassignTasksToUserId: outsider.id },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error?.code, 'TASK_REASSIGNEE_CANNOT_ACCESS_PROJECT');

    assert.equal(await prisma.taskAssignee.count({ where: { taskId, userId: former.id } }), 1);
    assert.equal(
      await prisma.workspaceMembership.count({
        where: { workspaceId: workspace.id, userId: former.id },
      }),
      1,
    );

    const unauthorized = await api(`/workspaces/${workspace.id}/members/${outsider.id}`, {
      method: 'DELETE',
      token: outsiderToken,
    });
    assert.equal(unauthorized.status, 403);
  });
});
