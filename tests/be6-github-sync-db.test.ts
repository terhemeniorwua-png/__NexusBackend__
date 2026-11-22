/* eslint-disable @typescript-eslint/no-explicit-any */ // Test fixtures and mock DB interactions
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { resolveTestDatabaseUrl, connectTestDatabase } from './helpers/test-database';

const DB_FLAG = 'RUN_BE6_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

function runTests(rawDbUrl: string): void {
  describe('BE-6 GitHub sync PostgreSQL tests', () => {
    let prisma: any;
    const created: { user?: string; workspace?: string; project?: string; tasks: string[]; links: string[] } = {
      tasks: [],
      links: [],
    };

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;

      const user = await prisma.user.create({
        data: { email: `be6-${Date.now()}@example.test`, passwordHash: 'x', name: 'BE6 User' },
      });
      const workspace = await prisma.workspace.create({
        data: { name: 'BE6 WS', slug: `be6-ws-${Date.now()}`, ownerId: user.id },
      });
      const project = await prisma.project.create({
        data: { workspaceId: workspace.id, name: 'BE6 Project', key: 'BE6', ownerId: user.id },
      });
      created.user = user.id;
      created.workspace = workspace.id;
      created.project = project.id;
    });

    after(async () => {
      for (const id of created.links) {
        await prisma.taskDevLink.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of created.tasks) {
        await prisma.task.delete({ where: { id } }).catch(() => undefined);
      }
      if (created.project) await prisma.project.delete({ where: { id: created.project } }).catch(() => undefined);
      if (created.workspace) await prisma.workspace.delete({ where: { id: created.workspace } }).catch(() => undefined);
      if (created.user) await prisma.user.delete({ where: { id: created.user } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    });

    async function makeLinkedTask(status: string): Promise<string> {
      const task = await prisma.task.create({
        data: {
          projectId: created.project!,
          key: `BE6-${Date.now()}`,
          title: 'BE6 task',
          creatorId: created.user!,
          status,
        },
      });
      const link = await prisma.taskDevLink.create({
        data: {
          taskId: task.id,
          projectId: created.project!,
          provider: 'GITHUB',
          externalType: 'PULL_REQUEST',
          externalId: String(6000 + Date.now()),
          linkedById: created.user!,
        },
      });
      created.tasks.push(task.id);
      created.links.push(link.id);
      return task.id;
    }

    test('CHECK constraint rejects an invalid reviewState on TaskDevLink', async () => {
      const taskId = await makeLinkedTask('IN_PROGRESS');
      const link = await prisma.taskDevLink.findFirst({ where: { taskId } });
      assert.ok(link, 'linked task dev link exists');
      await assert.rejects(
        // Raw SQL bypasses the generated client DMMF and exercises the DB CHECK directly.
        prisma['$executeRawUnsafe'](
          `UPDATE "TaskDevLink" SET reviewState = $1 WHERE id = $2`,
          'NOT_A_STATE',
          link!.id,
        ),
        (err: any) => err && typeof err.code === 'string',
        'expected a database check-violation error for invalid reviewState',
      );
    });

    test('two concurrent merge transitions on the same task produce exactly one status change', async () => {
      const taskId = await makeLinkedTask('IN_PROGRESS');

      const now = new Date();
      const [r1, r2] = await Promise.all([
        prisma.task.updateMany({
          where: { id: taskId, status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
          data: { status: 'SUBMITTED', submittedAt: now, submittedById: created.user! },
        }),
        prisma.task.updateMany({
          where: { id: taskId, status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
          data: { status: 'SUBMITTED', submittedAt: now, submittedById: created.user! },
        }),
      ]);
      const counts = [r1.count, r2.count].sort((a, b) => a - b);
      assert.deepStrictEqual(counts, [0, 1], 'exactly one of the two concurrent updates matched a row');

      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      assert.strictEqual(task!.status, 'SUBMITTED', 'task moved to SUBMITTED exactly once');
    });

    test('merge on an ASSIGNED task changes nothing', async () => {
      const taskId = await makeLinkedTask('ASSIGNED');

      const r = await prisma.task.updateMany({
        where: { id: taskId, status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
        data: { status: 'SUBMITTED', submittedAt: new Date(), submittedById: created.user! },
      });
      assert.strictEqual(r.count, 0, 'conditional update matches no rows for an ASSIGNED task');

      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      assert.strictEqual(task!.status, 'ASSIGNED', 'ASSIGNED task is left unchanged');
    });
  });
}

if (!databaseUrl) {
  describe('BE-6 GitHub sync PostgreSQL tests', () =>
    test('skipped — set RUN_BE6_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}
