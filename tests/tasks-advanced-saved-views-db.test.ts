import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createTaskAdvancedService } from '../src/modules/tasks/task-advanced.service';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_TASKS_ADVANCED_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_TASKS_ADVANCED_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_TASKS_ADVANCED_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

describe('Task advanced saved views (shared view admin management)', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const projectIds: string[] = [];
  const viewIds: string[] = [];

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = database.prisma;
  });

  after(async () => {
    if (prisma) {
      await prisma.taskSavedView.deleteMany({ where: { id: { in: viewIds } } });
      await prisma.projectMembership.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });

  async function createUser(name: string, suffix: string): Promise<string> {
    const email = `sav-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: 'x', name, status: 'ACTIVE', emailVerifiedAt: new Date() } });
    userIds.push(user.id);
    return user.id;
  }

  async function setup() {
    const owner = await createUser('Owner', 'owner');
    const admin = await createUser('Admin', 'admin');
    const member = await createUser('Member', 'member');

    const ws = await prisma.workspace.create({ data: { name: 'SV WS', slug: `sv-${Date.now()}-${Math.random().toString(36).slice(2)}`, ownerId: owner } });
    workspaceIds.push(ws.id);
    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId: ws.id, userId: owner, role: 'OWNER' },
        { workspaceId: ws.id, userId: admin, role: 'MEMBER' },
        { workspaceId: ws.id, userId: member, role: 'MEMBER' },
      ],
    });

    const project = await prisma.project.create({ data: { workspaceId: ws.id, name: 'SV Project', key: `SV${Date.now().toString().slice(-3)}`, ownerId: owner, visibility: 'WORKSPACE' } });
    projectIds.push(project.id);
    await prisma.projectMembership.createMany({
      data: [
        { projectId: project.id, userId: owner, role: 'PROJECT_MANAGER' },
        { projectId: project.id, userId: admin, role: 'PROJECT_MANAGER' },
        { projectId: project.id, userId: member, role: 'MEMBER' },
      ],
    });

    const view = await prisma.taskSavedView.create({
      data: {
        projectId: project.id,
        ownerId: owner,
        name: 'Shared by owner',
        isShared: true,
        config: { version: 1, filters: { status: ['ASSIGNED'] }, sort: null, group: null },
      },
    });
    viewIds.push(view.id);

    return { owner, admin, member, workspaceId: ws.id, projectId: project.id, viewId: view.id };
  }

  test('project admin can edit and delete a shared view they do not own', async () => {
    const { admin, workspaceId, projectId, viewId } = await setup();
    const service = createTaskAdvancedService(prisma);

    const updated = await service.updateSavedView(
      { userId: admin, workspaceId, projectId, viewId, name: 'Renamed by admin', config: { version: 1, filters: { status: ['IN_PROGRESS'] } } },
      {},
    );
    assert.equal(updated.name, 'Renamed by admin');

    const deleted = await service.deleteSavedView({ userId: admin, workspaceId, projectId, viewId }, {});
    assert.equal(deleted.deleted, true);
  });

  test('non-admin non-owner cannot edit or delete a shared view', async () => {
    const { member, workspaceId, projectId, viewId } = await setup();
    const service = createTaskAdvancedService(prisma);

    await assert.rejects(
      service.updateSavedView({ userId: member, workspaceId, projectId, viewId, name: 'Nope' }, {}),
      (error: unknown) => (error as { code?: string; statusCode?: number }).statusCode === 403,
    );

    await assert.rejects(
      service.deleteSavedView({ userId: member, workspaceId, projectId, viewId }, {}),
      (error: unknown) => (error as { code?: string; statusCode?: number }).statusCode === 403,
    );
  });
});
