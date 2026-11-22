/* eslint-disable @typescript-eslint/no-explicit-any -- test DB/prisma client shapes */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { AppError } from '../src/utils/errors';
import { resolveTestDatabaseUrl, connectTestDatabase } from './helpers/test-database';
import { createDevIntegrationService } from '../src/modules/dev-integrations/dev-integration.service';

const DB_FLAG = 'RUN_BE9_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-9 repository access member API DB tests', () =>
    test('skipped — set RUN_BE9_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('BE-9 repository access member API DB tests', () => {
    let prisma: any;
    const created: any = { users: [], memberships: [], projectMemberships: [], memberRows: [] };
    const config: any = { frontendUrl: 'http://localhost:3000', corsOrigins: ['http://localhost:3000'] };

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;
      const suffix = Date.now().toString(36);

      const owner = await prisma.user.create({ data: { email: `be9-m-owner-${suffix}@example.test`, passwordHash: 'x', name: 'Owner' } });
      const manager = await prisma.user.create({ data: { email: `be9-m-mgr-${suffix}@example.test`, passwordHash: 'x', name: 'Manager' } });
      const member = await prisma.user.create({ data: { email: `be9-m-member-${suffix}@example.test`, passwordHash: 'x', name: 'Member' } });
      const outsider = await prisma.user.create({ data: { email: `be9-m-out-${suffix}@example.test`, passwordHash: 'x', name: 'Outsider' } });
      created.users = [owner.id, manager.id, member.id, outsider.id];

      const workspace = await prisma.workspace.create({
        data: { name: 'BE9 M WS', slug: `be9-m-${suffix}`, ownerId: owner.id, type: 'COMPANY' },
      });
      created.workspace = workspace.id;

      for (const [uid, role] of [[owner.id, 'OWNER'], [manager.id, 'MEMBER'], [member.id, 'MEMBER']] as const) {
        const m = await prisma.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: uid, role, status: 'ACTIVE' } });
        created.memberships.push(m.id);
      }

      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id, name: 'BE9 M Project',
          key: `B9M${suffix.toUpperCase()}`.slice(0, 10), ownerId: owner.id, visibility: 'PRIVATE',
        },
      });
      created.project = project.id;

      for (const [uid, role] of [[manager.id, 'PROJECT_MANAGER'], [member.id, 'MEMBER']] as const) {
        const pm = await prisma.projectMembership.create({ data: { projectId: project.id, userId: uid, role } });
        created.projectMemberships.push(pm.id);
      }

      const connection = await prisma.integrationConnection.create({
        data: { workspaceId: workspace.id, provider: 'GITHUB', externalAccountId: `acc-${suffix}`, encryptedCredentials: 'enc', createdById: owner.id, status: 'ACTIVE' },
      });
      created.connection = connection.id;
      const repo = await prisma.projectRepository.create({
        data: { projectId: project.id, connectionId: connection.id, provider: 'GITHUB', externalRepoId: `repo-${suffix}`, fullName: 'acme/repo', defaultBranch: 'main' },
      });
      created.repo = repo.id;
    });

    after(async () => {
      for (const id of created.memberRows) await prisma.projectRepositoryMember.delete({ where: { id } }).catch(() => undefined);
      if (created.repo) await prisma.projectRepository.delete({ where: { id: created.repo } }).catch(() => undefined);
      if (created.connection) await prisma.integrationConnection.delete({ where: { id: created.connection } }).catch(() => undefined);
      for (const id of created.projectMemberships) await prisma.projectMembership.delete({ where: { id } }).catch(() => undefined);
      if (created.project) await prisma.project.delete({ where: { id: created.project } }).catch(() => undefined);
      for (const id of created.memberships) await prisma.workspaceMembership.delete({ where: { id } }).catch(() => undefined);
      if (created.workspace) await prisma.workspace.delete({ where: { id: created.workspace } }).catch(() => undefined);
      for (const id of created.users) await prisma.user.delete({ where: { id } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    });

    test('permission denial, non-member target, override/remove, and self-NONE manager can still manage', async () => {
      const svc = createDevIntegrationService(config, prisma);
      const base = { workspaceId: created.workspace, projectId: created.project, repositoryId: created.repo };
      const [owner, manager, member, outsider] = created.users;

      // permission denial (contributor/member without manager permission)
      await assert.rejects(
        () => svc.listRepositoryMembers({ ...base, userId: member }),
        (e: any) => e instanceof AppError && e.statusCode === 403 && e.code === 'PERMISSION_DENIED',
      );
      await assert.rejects(
        () => svc.setRepositoryMemberOverride({ ...base, userId: member, targetUserId: member, level: 'READ' }),
        (e: any) => e instanceof AppError && e.statusCode === 403 && e.code === 'PERMISSION_DENIED',
      );
      await assert.rejects(
        () => svc.removeRepositoryMemberOverride({ ...base, userId: member, targetUserId: member }),
        (e: any) => e instanceof AppError && e.statusCode === 403 && e.code === 'PERMISSION_DENIED',
      );

      // non-member target
      await assert.rejects(
        () => svc.setRepositoryMemberOverride({ ...base, userId: owner, targetUserId: outsider, level: 'READ' }),
        (e: any) => e instanceof AppError && e.statusCode === 404 && e.code === 'PROJECT_MEMBER_NOT_FOUND',
      );
      await assert.rejects(
        () => svc.removeRepositoryMemberOverride({ ...base, userId: owner, targetUserId: outsider }),
        (e: any) => e instanceof AppError && e.statusCode === 404 && e.code === 'PROJECT_MEMBER_NOT_FOUND',
      );

      // override then removal returns to default
      const before = await svc.listRepositoryMembers({ ...base, userId: owner });
      const memberRow = before.find((r: any) => r.userId === member);
      assert.ok(memberRow);
      assert.equal(memberRow.isOverride, false);
      assert.equal(typeof memberRow.inheritedWorkspaceAccess, 'boolean');
      const defaultLevel = memberRow.defaultLevel;
      const ownerRow = before.find((r: any) => r.userId === owner);
      assert.ok(ownerRow);
      assert.equal(typeof ownerRow.inheritedWorkspaceAccess, 'boolean');

      const set = await svc.setRepositoryMemberOverride({ ...base, userId: owner, targetUserId: member, level: 'NONE' });
      assert.equal(set.isOverride, true);
      assert.equal(set.overrideLevel, 'NONE');
      assert.equal(set.effectiveAccessLevel, 'NONE');

      const removed = await svc.removeRepositoryMemberOverride({ ...base, userId: owner, targetUserId: member });
      assert.equal(removed.isOverride, false);
      assert.equal(removed.overrideLevel, null);
      assert.equal(removed.effectiveAccessLevel, defaultLevel);

      // DELETE idempotent
      const removedAgain = await svc.removeRepositoryMemberOverride({ ...base, userId: owner, targetUserId: member });
      assert.equal(removedAgain.isOverride, false);
      assert.equal(removedAgain.effectiveAccessLevel, defaultLevel);

      // manager who overrides themselves to NONE can still call management endpoints
      const selfSet = await svc.setRepositoryMemberOverride({ ...base, userId: manager, targetUserId: manager, level: 'NONE' });
      assert.equal(selfSet.effectiveAccessLevel, 'NONE');
      const listAfterSelfNone = await svc.listRepositoryMembers({ ...base, userId: manager });
      assert.ok(Array.isArray(listAfterSelfNone));
      const selfRow = listAfterSelfNone.find((r: any) => r.userId === manager);
      assert.equal(selfRow?.effectiveAccessLevel, 'NONE');
      const selfRemoved = await svc.removeRepositoryMemberOverride({ ...base, userId: manager, targetUserId: manager });
      assert.equal(selfRemoved.isOverride, false);
    });
  });
}
