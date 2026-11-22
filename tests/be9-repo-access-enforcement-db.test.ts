/* eslint-disable @typescript-eslint/no-explicit-any -- test DB/prisma client shapes */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { resolveTestDatabaseUrl, connectTestDatabase } from './helpers/test-database';
import { createDevIntegrationService } from '../src/modules/dev-integrations/dev-integration.service';

const DB_FLAG = 'RUN_BE9_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-9 repository access enforcement DB tests', () =>
    test('skipped — set RUN_BE9_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('BE-9 repository access enforcement DB tests', () => {
    let prisma: any;
    const created: {
      users: string[];
      workspace?: string;
      memberships: string[];
      project?: string;
      connection?: string;
      repo?: string;
      memberRows: string[];
    } = { users: [], memberships: [], memberRows: [] };

    const config: any = { frontendUrl: 'http://localhost:3000', corsOrigins: ['http://localhost:3000'] };

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;

      const suffix = Date.now().toString(36);
      const owner = await prisma.user.create({
        data: { email: `be9-e2e-owner-${suffix}@example.test`, passwordHash: 'x', name: 'BE9 Owner' },
      });
      const viewer = await prisma.user.create({
        data: { email: `be9-e2e-viewer-${suffix}@example.test`, passwordHash: 'x', name: 'BE9 Viewer' },
      });
      created.users.push(owner.id, viewer.id);

      const workspace = await prisma.workspace.create({
        data: { name: 'BE9 E2E WS', slug: `be9-e2e-${suffix}`, ownerId: owner.id, type: 'COMPANY' },
      });
      created.workspace = workspace.id;

      const ownerMem = await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
      });
      const viewerMem = await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: viewer.id, role: 'MEMBER', status: 'ACTIVE' },
      });
      created.memberships.push(ownerMem.id, viewerMem.id);

      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: 'BE9 E2E Project',
          key: `B9E${suffix.toUpperCase()}`.slice(0, 10),
          ownerId: owner.id,
          visibility: 'PRIVATE',
        },
      });
      created.project = project.id;

      // Give viewer project access as VIEWER
      await prisma.projectMembership.create({
        data: { projectId: project.id, userId: viewer.id, role: 'VIEWER' },
      });

      const connection = await prisma.integrationConnection.create({
        data: {
          workspaceId: workspace.id,
          provider: 'GITHUB',
          externalAccountId: `acc-${suffix}`,
          encryptedCredentials: 'test-encrypted',
          createdById: owner.id,
          status: 'ACTIVE',
        },
      });
      created.connection = connection.id;

      const repo = await prisma.projectRepository.create({
        data: {
          projectId: project.id,
          connectionId: connection.id,
          provider: 'GITHUB',
          externalRepoId: `repo-${suffix}`,
          fullName: 'acme/secret-repo',
          defaultBranch: 'main',
        },
      });
      created.repo = repo.id;
    });

    after(async () => {
      for (const id of created.memberRows) {
        await prisma.projectRepositoryMember.delete({ where: { id } }).catch(() => undefined);
      }
      if (created.repo) await prisma.projectRepository.delete({ where: { id: created.repo } }).catch(() => undefined);
      if (created.connection) await prisma.integrationConnection.delete({ where: { id: created.connection } }).catch(() => undefined);
      if (created.project) {
        await prisma.projectMembership.deleteMany({ where: { projectId: created.project } }).catch(() => undefined);
        await prisma.project.delete({ where: { id: created.project } }).catch(() => undefined);
      }
      for (const id of created.memberships) {
        await prisma.workspaceMembership.delete({ where: { id } }).catch(() => undefined);
      }
      if (created.workspace) await prisma.workspace.delete({ where: { id: created.workspace } }).catch(() => undefined);
      for (const id of created.users) {
        await prisma.user.delete({ where: { id } }).catch(() => undefined);
      }
      await prisma.$disconnect().catch(() => undefined);
    });

    test('listProjectRepositories enforces NONE/METADATA/READ/LINK with explicit override', async () => {
      const svc = createDevIntegrationService(config, prisma);
      const base = { workspaceId: created.workspace!, projectId: created.project! };

      // Viewer default is READ (project role VIEWER) -> full repo
      const viewerDefault = await svc.listProjectRepositories({ ...base, userId: created.users[1]! });
      assert.equal(viewerDefault.length, 1);
      assert.equal(viewerDefault[0]!.fullName, 'acme/secret-repo');

      // Explicit override METADATA -> masked
      const metaRow = await prisma.projectRepositoryMember.create({
        data: {
          projectRepositoryId: created.repo!,
          projectId: created.project!,
          userId: created.users[1]!,
          level: 'METADATA',
          grantedById: created.users[0]!,
        },
      });
      created.memberRows.push(metaRow.id);
      const viewerMeta = await svc.listProjectRepositories({ ...base, userId: created.users[1]! });
      assert.equal(viewerMeta.length, 1);
      assert.equal(viewerMeta[0]!.fullName, 'Restricted repository');
      assert.equal(viewerMeta[0]!.defaultBranch, null);

      // Explicit override NONE -> omitted
      await prisma.projectRepositoryMember.update({ where: { id: metaRow.id }, data: { level: 'NONE' } });
      const viewerNone = await svc.listProjectRepositories({ ...base, userId: created.users[1]! });
      assert.equal(viewerNone.length, 0);

      // Explicit override LINK -> full (beats default)
      await prisma.projectRepositoryMember.update({ where: { id: metaRow.id }, data: { level: 'LINK' } });
      const viewerLink = await svc.listProjectRepositories({ ...base, userId: created.users[1]! });
      assert.equal(viewerLink.length, 1);
      assert.equal(viewerLink[0]!.fullName, 'acme/secret-repo');
    });
  });
}
