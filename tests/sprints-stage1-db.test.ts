/* eslint-disable @typescript-eslint/no-explicit-any -- test DB/prisma client shapes */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const DB_FLAG = 'RUN_S1_SPRINTS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('S1 sprints schema/guard DB tests', () =>
    test('skipped — set RUN_S1_SPRINTS_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('S1 sprints schema/guard DB tests', () => {
    let prisma: any;
    const created: { user?: string; workspace?: string; membership?: string; project?: string; sprints: string[] } = {
      sprints: [],
    };

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;

      const user = await prisma.user.create({
        data: { email: `s1-${Date.now()}@example.test`, passwordHash: 'x', name: 'S1 User' },
      });
      const workspace = await prisma.workspace.create({
        data: { name: 'S1 WS', slug: `s1-ws-${Date.now()}`, ownerId: user.id, type: 'COMPANY' },
      });
      const membership = await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: user.id, role: 'MEMBER', status: 'ACTIVE' },
      });
      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: 'S1 Project',
          key: `S1${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
          ownerId: user.id,
          visibility: 'WORKSPACE',
        },
      });

      created.user = user.id;
      created.workspace = workspace.id;
      created.membership = membership.id;
      created.project = project.id;
    });

    after(async () => {
      for (const id of created.sprints) {
        await prisma.sprint.delete({ where: { id } }).catch(() => undefined);
      }
      if (created.project) await prisma.project.delete({ where: { id: created.project } }).catch(() => undefined);
      if (created.membership) await prisma.workspaceMembership.delete({ where: { id: created.membership } }).catch(() => undefined);
      if (created.workspace) await prisma.workspace.delete({ where: { id: created.workspace } }).catch(() => undefined);
      if (created.user) await prisma.user.delete({ where: { id: created.user } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    });

    test('migration applies and existing/new projects default to BACKLOG_ONLY', async () => {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: created.project } });
      assert.equal(project.workflowMode, 'BACKLOG_ONLY');
    });

    test('second ACTIVE sprint in one project is rejected by DB partial unique index', async () => {
      const first = await prisma.sprint.create({
        data: {
          projectId: created.project!,
          name: 'Sprint 1',
          status: 'ACTIVE',
          createdById: created.user!,
        },
      });
      created.sprints.push(first.id);

      await assert.rejects(
        () =>
          prisma.sprint.create({
            data: {
              projectId: created.project!,
              name: 'Sprint 2',
              status: 'ACTIVE',
              createdById: created.user!,
            },
          }),
        (error: any) => {
          // Prisma P2002 or underlying unique violation
          const code = error?.code;
          const message = String(error?.message ?? '');
          assert.ok(code === 'P2002' || /unique|duplicate/i.test(message));
          return true;
        },
      );

      // Different status should be allowed
      const planned = await prisma.sprint.create({
        data: {
          projectId: created.project!,
          name: 'Sprint Planned',
          status: 'PLANNED',
          createdById: created.user!,
        },
      });
      created.sprints.push(planned.id);
      assert.equal(planned.status, 'PLANNED');
    });
  });
}
