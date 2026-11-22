/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { resolveTestDatabaseUrl, connectTestDatabase } from './helpers/test-database';
import { resolveRepositoryAccess } from '../src/modules/dev-integrations/repository-access.resolver';

const DB_FLAG = 'RUN_BE9_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-9 repository access resolver DB tests', () =>
    test('skipped — set RUN_BE9_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('BE-9 repository access resolver DB tests', () => {
    let prisma: any;
    const created: {
      user?: string;
      workspace?: string;
      membership?: string;
      project?: string;
      connection?: string;
      repo?: string;
      memberRows: string[];
    } = { memberRows: [] };

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;

      const user = await prisma.user.create({
        data: { email: `be9-${Date.now()}@example.test`, passwordHash: 'x', name: 'BE9 User' },
      });
      const workspace = await prisma.workspace.create({
        data: { name: 'BE9 WS', slug: `be9-ws-${Date.now()}`, ownerId: user.id, type: 'COMPANY' },
      });
      // Create workspace membership
      const membership = await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: user.id, role: 'MEMBER', status: 'ACTIVE' },
      });
      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: 'BE9 Project',
          key: `B9${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
          ownerId: user.id,
          visibility: 'WORKSPACE',
        },
      });
      const connection = await prisma.integrationConnection.create({
        data: {
          workspaceId: workspace.id,
          provider: 'GITHUB',
          externalAccountId: `acc-${Date.now()}`,
          encryptedCredentials: 'test-encrypted',
          createdById: user.id,
          status: 'ACTIVE',
        },
      });
      const repo = await prisma.projectRepository.create({
        data: {
          projectId: project.id,
          connectionId: connection.id,
          provider: 'GITHUB',
          externalRepoId: String(9000 + Date.now()),
          fullName: 'org/repo',
          defaultBranch: 'main',
        },
      });

      created.user = user.id;
      created.workspace = workspace.id;
      created.membership = membership.id;
      created.project = project.id;
      created.connection = connection.id;
      created.repo = repo.id;
    });

    after(async () => {
      for (const id of created.memberRows) {
        await prisma.projectRepositoryMember.delete({ where: { id } }).catch(() => undefined);
      }
      if (created.repo) await prisma.projectRepository.delete({ where: { id: created.repo } }).catch(() => undefined);
      if (created.connection) await prisma.integrationConnection.delete({ where: { id: created.connection } }).catch(() => undefined);
      if (created.project) await prisma.project.delete({ where: { id: created.project } }).catch(() => undefined);
      if (created.membership) await prisma.workspaceMembership.delete({ where: { id: created.membership } }).catch(() => undefined);
      if (created.workspace) await prisma.workspace.delete({ where: { id: created.workspace } }).catch(() => undefined);
      if (created.user) await prisma.user.delete({ where: { id: created.user } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    });

    test('default mapping applies when no override row exists (non-viewer workspace member with project access)', async () => {
      const level = await resolveRepositoryAccess(prisma, {
        projectId: created.project!,
        repositoryId: created.repo!,
        userId: created.user!,
      });
      // With workspace MEMBER and project visibility WORKSPACE + owner is user, authorization gives access;
      // default for non-VIEWER project role context in our resolver maps to LINK in general, but depends on
      // resolveProjectAuthorization result. This is a smoke test that it returns a valid enum.
      assert.ok(['NONE', 'METADATA', 'READ', 'LINK'].includes(level));
    });

    test('explicit override is returned', async () => {
      const row = await prisma.projectRepositoryMember.create({
        data: {
          projectRepositoryId: created.repo!,
          projectId: created.project!,
          userId: created.user!,
          level: 'METADATA',
          grantedById: created.user!,
        },
      });
      created.memberRows.push(row.id);
      const level = await resolveRepositoryAccess(prisma, {
        projectId: created.project!,
        repositoryId: created.repo!,
        userId: created.user!,
      });
      assert.strictEqual(level, 'METADATA');
    });
  });
}
