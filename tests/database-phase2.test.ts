import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const shouldRun = hasDatabase && process.env.RUN_PHASE2_DB_TESTS === 'true';

function createClient(): PrismaClient {
  return new PrismaClient();
}

test('Prisma schema includes core Phase 2 models and enums', () => {
  const client = createClient();

  assert.ok(client.user);
  assert.ok(client.workspace);
  assert.ok(client.workspaceMembership);
  assert.ok(client.team);
  assert.ok(client.teamMembership);
  assert.ok(client.project);
  assert.ok(client.projectMembership);
  assert.ok(client.task);
  assert.ok(client.taskAssignee);
  assert.ok(client.taskDependency);
  assert.ok(client.comment);
  assert.ok(client.notification);
  assert.ok(client.invitation);
  assert.ok(client.fileAttachment);
  assert.ok(client.auditLog);
  assert.ok(client.session);
  assert.ok(client.authToken);

  void client.$disconnect();
});

test(
  'migrations create unique constraints for memberships and invitations',
  {
    skip: !shouldRun,
  },
  async () => {
    const client = createClient();

    try {
      await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: '00000000-0000-0000-0000-000000000000',
            userId: '00000000-0000-0000-0000-000000000000',
          },
        },
      });
      await client.teamMembership.findUnique({
        where: {
          teamId_userId: {
            teamId: '00000000-0000-0000-0000-000000000000',
            userId: '00000000-0000-0000-0000-000000000000',
          },
        },
      });
      await client.projectMembership.findUnique({
        where: {
          projectId_userId: {
            projectId: '00000000-0000-0000-0000-000000000000',
            userId: '00000000-0000-0000-0000-000000000000',
          },
        },
      });
      await client.taskAssignee.findUnique({
        where: {
          taskId_userId: {
            taskId: '00000000-0000-0000-0000-000000000000',
            userId: '00000000-0000-0000-0000-000000000000',
          },
        },
      });
      await client.invitation.findUnique({
        where: { tokenHash: 'nonexistent' },
      });
    } finally {
      await client.$disconnect();
    }
  },
);
