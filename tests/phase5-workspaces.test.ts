import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../src/config/env';
import {
  assertMayManageMember,
  assertMayAssignRole,
  roleCan,
  WorkspaceCapability,
} from '../src/modules/workspaces/authorization';
import {
  createInvitationService,
  maskInvitationEmail,
} from '../src/modules/workspaces/invitation.service';
import { slugifyWorkspaceName } from '../src/modules/workspaces/workspace.service';
import {
  addMemberSchema,
  assignableRoleSchema,
  createInvitationSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from '../src/modules/workspaces/workspace.schemas';
import { AppError } from '../src/utils/errors';

/**
 * Phase 5 unit tests.
 *
 * These cover the parts of the workspace module that do not need a database:
 * the role matrix, the slug of a workspace, the masking of an address and the
 * validation of the request bodies.
 */

describe('Phase 5 workspace rules', () => {
  test('every role may read a workspace', () => {
    for (const role of ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'] as const) {
      assert.equal(roleCan(role, WorkspaceCapability.ViewWorkspace), true, role);
      assert.equal(roleCan(role, WorkspaceCapability.ViewMembers), true, role);
    }
  });

  test('only the owner and a project manager may change a workspace', () => {
    assert.equal(roleCan('OWNER', WorkspaceCapability.UpdateWorkspace), true);
    assert.equal(roleCan('PROJECT_MANAGER', WorkspaceCapability.UpdateWorkspace), true);
    assert.equal(roleCan('MEMBER', WorkspaceCapability.UpdateWorkspace), false);
    assert.equal(roleCan('COLLABORATOR', WorkspaceCapability.UpdateWorkspace), false);
    assert.equal(roleCan('VIEWER', WorkspaceCapability.UpdateWorkspace), false);
  });

  test('only the owner may archive or delete a workspace', () => {
    assert.equal(roleCan('OWNER', WorkspaceCapability.ArchiveWorkspace), true);
    assert.equal(roleCan('OWNER', WorkspaceCapability.DeleteWorkspace), true);
    assert.equal(roleCan('PROJECT_MANAGER', WorkspaceCapability.ArchiveWorkspace), false);
    assert.equal(roleCan('PROJECT_MANAGER', WorkspaceCapability.DeleteWorkspace), false);
    assert.equal(roleCan('MEMBER', WorkspaceCapability.DeleteWorkspace), false);
  });

  test('the owner of a workspace cannot be changed or removed', () => {
    assert.throws(
      () =>
        assertMayManageMember({
          actorRole: 'OWNER',
          targetRole: 'OWNER',
          targetIsOwner: true,
        }),
      /owner of a workspace cannot be changed or removed/i,
    );
  });

  test('a project manager cannot manage another project manager', () => {
    assert.throws(
      () =>
        assertMayManageMember({
          actorRole: 'PROJECT_MANAGER',
          targetRole: 'PROJECT_MANAGER',
          targetIsOwner: false,
        }),
      /Only the owner of a workspace can manage a project manager/i,
    );

    assert.doesNotThrow(() =>
      assertMayManageMember({
        actorRole: 'PROJECT_MANAGER',
        targetRole: 'MEMBER',
        targetIsOwner: false,
      }),
    );
  });

  test('only the workspace owner may grant the project manager role', () => {
    assert.throws(
      () => assertMayAssignRole({ actorRole: 'PROJECT_MANAGER', requestedRole: 'PROJECT_MANAGER' }),
      /Only the owner of a workspace can grant the project manager role/i,
    );

    assert.doesNotThrow(() =>
      assertMayAssignRole({ actorRole: 'OWNER', requestedRole: 'PROJECT_MANAGER' }),
    );
    assert.doesNotThrow(() =>
      assertMayAssignRole({ actorRole: 'PROJECT_MANAGER', requestedRole: 'MEMBER' }),
    );
  });

  test('a slug keeps the name readable', () => {
    assert.equal(slugifyWorkspaceName('Acme Rockets'), 'acme-rockets');
    assert.equal(slugifyWorkspaceName('  Ünïcode & Spaces  '), 'unicode-spaces');
    assert.equal(slugifyWorkspaceName('Team 42'), 'team-42');
    assert.equal(slugifyWorkspaceName('---'), '');
  });

  test('the address of an invitation is masked', () => {
    assert.equal(maskInvitationEmail('philip@example.com'), 'p***@example.com');
    assert.equal(maskInvitationEmail('broken'), '***');
  });

  test('the owner role cannot be handed out', () => {
    assert.equal(assignableRoleSchema.safeParse('OWNER').success, false);
    assert.equal(assignableRoleSchema.safeParse('MEMBER').success, true);
    assert.equal(assignableRoleSchema.safeParse('PROJECT_MANAGER').success, true);
  });

  test('a workspace needs a name', () => {
    assert.equal(createWorkspaceSchema.safeParse({ name: 'Acme' }).success, true);
    assert.equal(createWorkspaceSchema.safeParse({ name: 'A' }).success, false);
    assert.equal(createWorkspaceSchema.safeParse({}).success, false);
  });

  test('unknown fields are rejected', () => {
    assert.equal(
      createWorkspaceSchema.safeParse({ name: 'Acme', ownerId: 'someone-else' }).success,
      false,
    );
    assert.equal(
      addMemberSchema.safeParse({ email: 'a@example.com', role: 'OWNER' }).success,
      false,
    );
    assert.equal(
      updateWorkspaceSchema.safeParse({ name: 'Acme', status: 'ARCHIVED' }).success,
      false,
    );
  });

  test('an invitation needs a valid address', () => {
    assert.equal(createInvitationSchema.safeParse({ email: 'a@example.com' }).success, true);
    assert.equal(createInvitationSchema.safeParse({ email: 'not-an-address' }).success, false);
  });

  test('an address is stored in lower case', () => {
    const parsed = createInvitationSchema.parse({ email: '  Person@Example.COM ' });

    assert.equal(parsed.email, 'person@example.com');
  });
});

describe('Phase 5 invitation state guards', () => {
  const config = {
    frontendUrl: 'https://app.example.com',
    workspaceInvitationLinkPath: '/workspaces/invitations/accept',
    workspaceInvitationTtlSeconds: 172_800,
    appName: 'Nexus',
    emailFromName: 'Nexus',
    emailSupportAddress: undefined,
    emailAppUrl: undefined,
  } as unknown as AppConfig;

  function serviceWith(invitation: Record<string, unknown>, onWrite: () => void) {
    const client = {
      invitation: {
        findUnique: async () => invitation,
        update: async () => {
          onWrite();
          throw new Error('An expired invitation must not be rewritten on accept');
        },
        updateMany: async () => {
          onWrite();
          return { count: 0 };
        },
      },
      workspaceMembership: {
        findUnique: async () => null,
        create: async () => {
          onWrite();
          throw new Error('An expired invitation must not create a membership');
        },
      },
    } as unknown as PrismaClient;

    return createInvitationService(config, client);
  }

  test('an invitation already marked expired is rejected before any membership write', async () => {
    let wrote = false;
    const service = serviceWith(
      {
        id: 'invitation-1',
        workspaceId: 'workspace-1',
        email: 'invitee@example.com',
        role: 'MEMBER',
        type: 'WORKSPACE',
        status: 'EXPIRED',
        tokenHash: 'digest',
        forUserId: null,
        invitedById: 'owner-1',
        expiresAt: new Date(Date.now() + 60_000),
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date(),
        workspace: { id: 'workspace-1', name: 'Acme' },
        invitedBy: { id: 'owner-1', name: 'Owner' },
      },
      () => {
        wrote = true;
      },
    );

    await assert.rejects(
      service.accept(
        { userId: 'invitee-1', token: 'token' },
        { ip: undefined, userAgent: undefined },
      ),
      (error) =>
        error instanceof AppError &&
        error.statusCode === 410 &&
        error.code === 'INVITATION_EXPIRED',
    );

    assert.equal(wrote, false);
  });

  test('a revoked invitation can never be accepted', async () => {
    let wrote = false;
    const service = serviceWith(
      {
        id: 'invitation-2',
        workspaceId: 'workspace-1',
        email: 'invitee@example.com',
        role: 'MEMBER',
        type: 'WORKSPACE',
        status: 'REVOKED',
        tokenHash: 'digest',
        forUserId: null,
        invitedById: 'owner-1',
        expiresAt: new Date(Date.now() + 60_000),
        acceptedAt: null,
        revokedAt: new Date(),
        createdAt: new Date(),
        workspace: { id: 'workspace-1', name: 'Acme' },
        invitedBy: { id: 'owner-1', name: 'Owner' },
      },
      () => {
        wrote = true;
      },
    );

    await assert.rejects(
      service.accept(
        { userId: 'invitee-1', token: 'token' },
        { ip: undefined, userAgent: undefined },
      ),
      (error) =>
        error instanceof AppError &&
        error.statusCode === 409 &&
        error.code === 'INVITATION_REVOKED',
    );

    assert.equal(wrote, false);
  });
});
