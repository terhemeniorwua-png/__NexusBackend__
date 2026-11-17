import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { requireWorkspaceAccess, WorkspaceCapability } from '../src/modules/authorization/workspace.policy';

describe('membership checked on every request (workspace access)', () => {
  test('removed member loses access immediately even with an unexpired access token/session context', async () => {
    // Simulates a request where the caller still presents a valid session/token context,
    // but their workspace membership row has been removed. requireWorkspaceAccess must
    // check membership on every request and deny access.
    const db = {
      workspace: {
        findFirst: async () => ({
          id: 'ws1',
          status: 'ACTIVE',
          type: 'COMPANY',
          deletedAt: null,
          ownerId: 'owner1',
        }),
      },
      workspaceMembership: {
        findUnique: async () => null, // membership removed
      },
    } as any;

    await assert.rejects(
      () =>
        requireWorkspaceAccess(db, {
          userId: 'user-removed',
          workspaceId: 'ws1',
          capability: WorkspaceCapability.ViewWorkspace,
          auth: { authMethod: 'sso', sessionId: 'sess-valid' },
        } as any),
      (err: any) => err?.code === 'WORKSPACE_ACCESS_DENIED' || err?.statusCode === 403,
    );
  });

  test('suspended member loses access immediately', async () => {
    const db = {
      workspace: {
        findFirst: async () => ({
          id: 'ws1',
          status: 'ACTIVE',
          type: 'COMPANY',
          deletedAt: null,
          ownerId: 'owner1',
        }),
      },
      workspaceMembership: {
        findUnique: async () => ({
          id: 'm1',
          workspaceId: 'ws1',
          userId: 'user1',
          role: 'MEMBER',
          organizationRole: null,
          status: 'SUSPENDED',
        }),
      },
    } as any;

    await assert.rejects(
      () =>
        requireWorkspaceAccess(db, {
          userId: 'user1',
          workspaceId: 'ws1',
          capability: WorkspaceCapability.ViewWorkspace,
          auth: { authMethod: 'sso', sessionId: 'sess-valid' },
        } as any),
      (err: any) => err?.code === 'MEMBERSHIP_SUSPENDED',
    );
  });
});
