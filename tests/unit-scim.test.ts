import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PrismaClient, ScimTokenStatus, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createScimService } from '../src/modules/scim/scim.service';
import { AppError } from '../src/utils/errors';
import {
  provisionScimUserSchema,
  patchScimUserSchema,
  provisionScimGroupSchema,
  patchScimGroupSchema,
  scimListQuerySchema,
} from '../src/modules/scim/scim.schemas';

function hashSecret(value: string): string {
  return require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex');
}

function whereOf<T extends Record<string, unknown>>(arg: T): T['where'] {
  return (arg as { where?: T['where'] }).where ?? {};
}

/**
 * Minimal in-memory fake Prisma client for SCIM service tests.
 * Prisma find methods receive `{ where, include?, select? }`; write methods
 * receive `{ where, data }`.
 */
function makeFakePrisma(overrides: {
  users: Record<string, any>;
  memberships: Record<string, any>;
  sessions: Record<string, any>;
  integrations: Record<string, any>;
  scimTokens: Record<string, any>;
  scimGroups: Record<string, any>;
  teams: Record<string, any>;
  workspaces: Record<string, any>;
}) {
  const state = {
    users: { ...overrides.users },
    memberships: { ...overrides.memberships },
    sessions: { ...overrides.sessions },
    integrations: { ...overrides.integrations },
    scimTokens: { ...overrides.scimTokens },
    scimGroups: { ...overrides.scimGroups },
    teams: { ...overrides.teams },
    workspaces: { ...overrides.workspaces },
    auditLog: { create: async () => ({}) },
  };
  const now = new Date();

  return {
    $connect: async () => {},
    $disconnect: async () => {},
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = buildTx(state);
      console.log('DEBUG tx keys:', Object.keys(tx), 'user.update type:', typeof tx.user?.update);
      return fn(tx);
    },
    scimToken: {
      findUnique: async (arg: any) =>
        Object.values(state.scimTokens).find((t: any) => t.tokenHash === whereOf(arg).tokenHash) ?? null,
      findFirst: async (arg: any) => {
        const w = whereOf(arg);
        return (
          Object.values(state.scimTokens).find(
            (t: any) => t.id === w.id && t.workspaceId === w.workspaceId,
          ) ?? null
        );
      },
      findMany: async (arg: any) => {
        const w = whereOf(arg);
        return Object.values(state.scimTokens).filter(
          (t: any) => t.workspaceId === w.workspaceId && (!w.status || t.status === w.status),
        );
      },
      create: async (arg: any) => {
        const id = 'scim-token-' + Date.now();
        const row = { id, ...arg.data, createdAt: now, updatedAt: now };
        state.scimTokens[id] = row;
        return row;
      },
      update: async (arg: any) => {
        const row = state.scimTokens[whereOf(arg).id];
        Object.assign(row, arg.data, { updatedAt: now });
        return row;
      },
      updateMany: async (arg: any) => {
        const w = whereOf(arg);
        let count = 0;
        for (const row of Object.values(state.scimTokens)) {
          let match = true;
          for (const [k, v] of Object.entries(w)) {
            if (row[k] !== v) { match = false; break; }
          }
          if (match) { Object.assign(row, arg.data, { updatedAt: now }); count += 1; }
        }
        return { count };
      },
    },
    user: {
      findUnique: async (arg: any) => {
        const w = whereOf(arg);
        if (w.id) return state.users[w.id] ?? null;
        if (w.email) {
          return Object.values(state.users).find((u: any) => u.email === w.email) ?? null;
        }
        return null;
      },
      create: async (arg: any) => {
        const id = 'user-' + Date.now();
        const row = { id, ...arg.data, createdAt: now, updatedAt: now, deletedAt: null };
        state.users[id] = row;
        return row;
      },
      update: async (arg: any) => {
        const row = state.users[whereOf(arg).id];
        Object.assign(row, arg.data, { updatedAt: now });
        return row;
      },
      delete: async (arg: any) => {
        delete state.users[whereOf(arg).id];
        return { id: whereOf(arg).id };
      },
    },
    workspaceMembership: {
      findUnique: async (arg: any) => {
        const w = whereOf(arg).workspaceId_userId;
        return state.memberships[w.workspaceId + ':' + w.userId] ?? null;
      },
      findFirst: async (arg: any) => {
        const w = whereOf(arg);
        const found = Object.values(state.memberships).find(
          (m: any) => m.workspaceId === w.workspaceId && m.userId === w.userId,
        );
        if (!found) return null;
        if (arg.include?.user) {
          return { ...found, user: state.users[found.userId] };
        }
        return found;
      },
      findMany: async (arg: any) => {
        const w = whereOf(arg);
        let list = Object.values(state.memberships).filter((m: any) =>
          w.workspaceId ? m.workspaceId === w.workspaceId : true,
        );
        if (arg.include?.user) {
          list = list.map((m: any) => ({ ...m, user: state.users[m.userId] }));
        }
        return list;
      },
      create: async (arg: any) => {
        const d = arg.data;
        const id = 'membership-' + Date.now();
        const row = { id, ...d, createdAt: now, updatedAt: now };
        state.memberships[d.workspaceId + ':' + d.userId] = row;
        return row;
      },
      update: async (arg: any) => {
        const w = whereOf(arg).workspaceId_userId;
        const row = state.memberships[w.workspaceId + ':' + w.userId];
        Object.assign(row, arg.data, { updatedAt: now });
        return row;
      },
      updateMany: async (arg: any) => {
        const w = whereOf(arg);
        let count = 0;
        for (const row of Object.values(state.memberships)) {
          let match = true;
          for (const [k, v] of Object.entries(w)) {
            if (k === 'workspaceId_userId') continue;
            if (row[k] !== v) { match = false; break; }
          }
          if (match) { Object.assign(row, arg.data, { updatedAt: now }); count += 1; }
        }
        return { count };
      },
    },
    session: {
      updateMany: async (arg: any) => {
        const w = whereOf(arg);
        let count = 0;
        for (const row of Object.values(state.sessions)) {
          if (row.userId === w.userId && row.revokedAt === null) {
            Object.assign(row, arg.data, { updatedAt: now }); count += 1;
          }
        }
        return { count };
      },
    },
    integration: {
      updateMany: async (arg: any) => {
        const w = whereOf(arg);
        let count = 0;
        for (const row of Object.values(state.integrations)) {
          if (row.userId === w.userId && row.workspaceId === w.workspaceId) {
            Object.assign(row, arg.data, { updatedAt: now }); count += 1;
          }
        }
        return { count };
      },
    },
    scimGroup: {
      findFirst: async (arg: any) => {
        const w = whereOf(arg);
        return (
          Object.values(state.scimGroups).find(
            (g: any) => g.id === w.id && g.workspaceId === w.workspaceId && g.deletedAt === null,
          ) ?? null
        );
      },
      findMany: async (arg: any) => {
        const w = whereOf(arg);
        return Object.values(state.scimGroups).filter(
          (g: any) => g.workspaceId === w.workspaceId && g.deletedAt === null,
        );
      },
      create: async (arg: any) => {
        const id = 'scim-group-' + Date.now();
        const row = { id, ...arg.data, createdAt: now, updatedAt: now, deletedAt: null };
        state.scimGroups[id] = row;
        return row;
      },
      findUnique: async (arg: any) => state.scimGroups[whereOf(arg).id] ?? null,
      update: async (arg: any) => {
        const row = state.scimGroups[whereOf(arg).id];
        Object.assign(row, arg.data, { updatedAt: now });
        return row;
      },
    },
    team: {
      findFirst: async (arg: any) => state.teams[whereOf(arg).id] ?? null,
      create: async (arg: any) => {
        const id = 'team-' + Date.now();
        const row = { id, ...arg.data, createdAt: now, updatedAt: now, deletedAt: null, members: [] };
        state.teams[id] = row;
        return row;
      },
    },
    teamMembership: {
      findMany: async (arg: any) =>
        Object.values(state.teams[whereOf(arg).teamId]?.members ?? []),
      delete: async () => ({ count: 1 }),
      upsert: async (arg: any) => {
        const w = whereOf(arg).teamId_userId;
        const team = state.teams[w.teamId];
        if (!team.members) team.members = [];
        const existing = team.members.find((m: any) => m.userId === w.userId);
        if (existing) return existing;
        const row = { id: 'tm-' + Date.now(), ...arg.create };
        team.members.push(row);
        return row;
      },
    },
    workspace: {
      findFirst: async (arg: any) => state.workspaces[whereOf(arg).id] ?? null,
    },
    workspaceSsoConfig: { findFirst: async () => null },
    auditLog: { create: async () => ({}) },
  } as unknown as PrismaClient;
}

function buildTx(state: any) {
  return {
    user: {
      findUnique: async (arg: any) => state.users[whereOf(arg).id] ?? null,
      create: async (arg: any) => {
        const id = 'user-' + Date.now();
        const row = { id, ...arg.data, createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
        state.users[id] = row;
        return row;
      },
      update: async (arg: any) => {
        console.log('DEBUG buildTx.user.update called');
        const row = state.users[whereOf(arg).id];
        Object.assign(row, arg.data, { updatedAt: new Date() });
        return row;
      },
    },
    workspaceMembership: {
      findUnique: async (arg: any) => {
        const w = whereOf(arg).workspaceId_userId;
        return state.memberships[w.workspaceId + ':' + w.userId] ?? null;
      },
      create: async (arg: any) => {
        const d = arg.data;
        const id = 'membership-' + Date.now();
        const row = { id, ...d, createdAt: new Date(), updatedAt: new Date() };
        state.memberships[d.workspaceId + ':' + d.userId] = row;
        return row;
      },
      update: async (arg: any) => {
        const w = whereOf(arg).workspaceId_userId;
        Object.assign(state.memberships[w.workspaceId + ':' + w.userId], arg.data, { updatedAt: new Date() });
        return state.memberships[w.workspaceId + ':' + w.userId];
      },
      updateMany: async () => ({ count: 1 }),
    },
    session: { updateMany: async () => ({ count: 1 }) },
    integration: { updateMany: async () => ({ count: 1 }) },
    scimToken: { updateMany: async () => ({ count: 1 }) },
    scimGroup: { findUnique: async (arg: any) => state.scimGroups[whereOf(arg).id] ?? null },
    teamMembership: {
      findMany: async (arg: any) =>
        Object.values(state.teams[whereOf(arg).teamId]?.members ?? []),
      delete: async () => ({ count: 1 }),
      upsert: async (arg: any) => arg.create,
    },
    user: { delete: async (arg: any) => { delete state.users[whereOf(arg).id]; return { id: whereOf(arg).id }; } },
  };
}

const workspaceA = 'ws-a';
const workspaceB = 'ws-b';
const adminA = 'admin-a';
const userA1 = 'user-a-1';
const userA2 = 'user-a-2';
const userB1 = 'user-b-1';

function baseState() {
  const now = new Date();
  return {
    users: {
      [adminA]: {
        id: adminA, email: 'admin-a@example.com', name: 'Admin A', status: 'ACTIVE' as UserStatus,
        emailVerifiedAt: now, createdAt: now, updatedAt: now, deletedAt: null,
      },
      [userA1]: {
        id: userA1, email: 'user-a-1@example.com', name: 'User A1', status: 'ACTIVE' as UserStatus,
        emailVerifiedAt: now, createdAt: now, updatedAt: now, deletedAt: null,
      },
      [userA2]: {
        id: userA2, email: 'user-a-2@example.com', name: 'User A2', status: 'ACTIVE' as UserStatus,
        emailVerifiedAt: now, createdAt: now, updatedAt: now, deletedAt: null,
      },
      [userB1]: {
        id: userB1, email: 'user-b-1@example.com', name: 'User B1', status: 'ACTIVE' as UserStatus,
        emailVerifiedAt: now, createdAt: now, updatedAt: now, deletedAt: null,
      },
    },
    memberships: {
      [`${workspaceA}:${adminA}`]: {
        id: 'm-a-admin', workspaceId: workspaceA, userId: adminA, role: 'OWNER', status: 'ACTIVE', createdAt: now,
      },
      [`${workspaceA}:${userA1}`]: {
        id: 'm-a-1', workspaceId: workspaceA, userId: userA1, role: 'MEMBER', status: 'ACTIVE', createdAt: now,
      },
      [`${workspaceA}:${userA2}`]: {
        id: 'm-a-2', workspaceId: workspaceA, userId: userA2, role: 'MEMBER', status: 'ACTIVE', createdAt: now,
      },
      [`${workspaceB}:${userB1}`]: {
        id: 'm-b-1', workspaceId: workspaceB, userId: userB1, role: 'MEMBER', status: 'ACTIVE', createdAt: now,
      },
    },
    sessions: {
      'sess-1': { id: 'sess-1', userId: userA1, refreshTokenHash: hashSecret('token-1'), revokedAt: null, expiresAt: new Date(Date.now() + 86400000) },
      'sess-2': { id: 'sess-2', userId: userA1, refreshTokenHash: hashSecret('token-2'), revokedAt: null, expiresAt: new Date(Date.now() + 86400000) },
    },
    integrations: {
      'int-1': { id: 'int-1', userId: userA1, workspaceId: workspaceA, enabled: true, revokedAt: null, status: 'ACTIVE' },
    },
    scimTokens: {},
    scimGroups: {},
    teams: {
      'team-a-1': { id: 'team-a-1', workspaceId: workspaceA, name: 'Team A1', members: [] },
    },
    workspaces: {
      [workspaceA]: { id: workspaceA, name: 'Workspace A', deletedAt: null },
      [workspaceB]: { id: workspaceB, name: 'Workspace B', deletedAt: null },
    },
  };
}

// ---------------------------------------------------------------------------
// Token scope and revocation
// ---------------------------------------------------------------------------

describe('SCIM token scope and revocation', () => {
  test('createToken returns plaintext once and stores only the hash', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    const { token, scimToken } = await service.createToken({
      actorId: adminA,
      workspaceId: workspaceA,
      name: 'SCIM provisioning token',
      scopes: ['scim:read', 'scim:write'],
    });

    assert.ok(token, 'plaintext token must be returned');
    assert.equal(typeof token, 'string');
    assert.equal(scimToken.workspaceId, workspaceA);
    assert.equal(scimToken.userId, adminA);
    assert.equal(scimToken.status, 'ACTIVE');
    assert.equal(scimToken.name, 'SCIM provisioning token');

    // The stored row must hold the hash, never the plaintext.
    const stored = await prisma.scimToken.findUnique({ where: { tokenHash: hashSecret(token) } });
    assert.ok(stored, 'token hash must be stored');
    assert.notEqual(stored.tokenHash, token, 'plaintext must not be stored');
    assert.equal(scimToken.id, stored.id);
  });

  test('revokeToken marks the token as revoked', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    const { scimToken } = await service.createToken({
      actorId: adminA, workspaceId: workspaceA, name: 'revocable',
    });

    await service.revokeToken({ actorId: adminA, workspaceId: workspaceA, tokenId: scimToken.id });

    const stored = await prisma.scimToken.findFirst({ where: { id: scimToken.id, workspaceId: workspaceA } });
    assert.equal(stored.status, 'REVOKED' as ScimTokenStatus);
    assert.ok(stored.revokedAt);
  });

  test('a token cannot be revoked from another workspace', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    const { scimToken } = await service.createToken({
      actorId: adminA, workspaceId: workspaceA, name: 'ws-a token',
    });

    // adminA is not a member of workspaceB; revoking from workspaceB must fail.
    await assert.rejects(
      () => service.revokeToken({ actorId: adminA, workspaceId: workspaceB, tokenId: scimToken.id }),
      (err: AppError) => err.code === 'WORKSPACE_ACCESS_DENIED' || err.statusCode === 403,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace isolation
// ---------------------------------------------------------------------------

describe('cross-workspace isolation', () => {
  test('a token for workspace A cannot list users of workspace B', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    // Create a token scoped to workspace A.
    await service.createToken({
      actorId: adminA, workspaceId: workspaceA, name: 'ws-a token',
    });

    // Use adminA's actorId but request workspace B — adminA is not a member of B.
    await assert.rejects(
      () => service.listUsers({
        actorId: adminA, workspaceId: workspaceB, startIndex: 1, count: 20,
      }),
      (err: AppError) => err.code === 'WORKSPACE_ACCESS_DENIED' || err.statusCode === 403,
    );
  });

  test('deactivating a user in workspace A does not affect workspace B users', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    await service.deactivateUser({
      actorId: adminA, workspaceId: workspaceA, scimUserId: userA1, hardDelete: false,
    });

    // Workspace B user must be untouched.
    const bUser = await prisma.user.findUnique({ where: { id: userB1 } });
    assert.equal(bUser.status, 'ACTIVE');
    const bMembership = await prisma.workspaceMembership.findFirst({
      where: { workspaceId: workspaceB, userId: userB1 },
    });
    assert.equal(bMembership.status, 'ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// Deactivation revokes sessions and tokens
// ---------------------------------------------------------------------------

describe('deactivation revokes sessions and tokens', () => {
  test('deactivateUser revokes sessions, SCIM tokens and integration tokens', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    console.log('DEBUG prisma keys:', Object.keys(prisma), 'has $transaction:', typeof prisma['\$transaction']);
    const service = createScimService({ prisma });

    // Create a SCIM token for userA1.
    const { scimToken } = await service.createToken({
      actorId: adminA, workspaceId: workspaceA, name: 'user token', scopes: ['scim:read'],
    });
    // Associate the token with userA1 by updating the stored row.
    await prisma.scimToken.update({ where: { id: scimToken.id }, data: { userId: userA1 } });

    await service.deactivateUser({
      actorId: adminA, workspaceId: workspaceA, scimUserId: userA1, hardDelete: false,
    });

    // User is deactivated, not deleted.
    const user = await prisma.user.findUnique({ where: { id: userA1 } });
    assert.equal(user.status, 'DEACTIVATED' as UserStatus);
    assert.ok(user);

    // Membership suspended.
    const membership = await prisma.workspaceMembership.findFirst({
      where: { workspaceId: workspaceA, userId: userA1 },
    });
    assert.equal(membership.status, 'SUSPENDED');

    // SCIM token revoked.
    const tokenRow = await prisma.scimToken.findFirst({ where: { id: scimToken.id } });
    assert.equal(tokenRow.status, 'REVOKED' as ScimTokenStatus);

    // Integration token disabled/revoked.
    const integration = await prisma.integration.findFirst({ where: { userId: userA1, workspaceId: workspaceA } });
    assert.equal(integration.enabled, false);
  });

  test('hardDelete removes the user record', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    await service.deactivateUser({
      actorId: adminA, workspaceId: workspaceA, scimUserId: userA2, hardDelete: true,
    });

    const user = await prisma.user.findUnique({ where: { id: userA2 } });
    assert.equal(user, null);
  });
});

// ---------------------------------------------------------------------------
// Malformed SCIM payloads
// ---------------------------------------------------------------------------

describe('malformed SCIM payloads', () => {
  test('rejects a non-email userName', () => {
    assert.throws(() => provisionScimUserSchema.parse({ userName: 'not-an-email' }));
  });

  test('rejects a userName that is missing', () => {
    assert.throws(() => provisionScimUserSchema.parse({}));
  });

  test('rejects an invalid email in a patch', () => {
    assert.throws(() =>
      patchScimUserSchema.parse({ emails: [{ value: 'bad-email', type: 'work', primary: true }] }),
    );
  });

  test('rejects a group with empty displayName', () => {
    assert.throws(() => provisionScimGroupSchema.parse({ displayName: '   ' }));
  });

  test('accepts a valid list query and applies defaults', () => {
    const parsed = scimListQuerySchema.parse({});
    assert.equal(parsed.startIndex, 1);
    assert.equal(parsed.count, 20);
  });

  test('rejects a list query count above the cap', () => {
    assert.throws(() => scimListQuerySchema.parse({ count: 999 }));
  });
});

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

describe('password handling', () => {
  test('createUser hashes a provided password', async () => {
    const state = baseState();
    const prisma = makeFakePrisma(state) as any;
    const service = createScimService({ prisma });

    const created = await service.createUser({
      actorId: adminA,
      workspaceId: workspaceA,
      userName: 'new-user@example.com',
      password: 'Str0ng!Pass',
      displayName: 'New User',
    });

    assert.equal(created.userName, 'new-user@example.com');
    assert.ok(created.active);

    const storedUser = await prisma.user.findUnique({ where: { id: created.id } });
    assert.ok(storedUser.passwordHash);
    assert.notEqual(storedUser.passwordHash, 'Str0ng!Pass');
    assert.ok(await bcrypt.compare('Str0ng!Pass', storedUser.passwordHash));
  });
});
