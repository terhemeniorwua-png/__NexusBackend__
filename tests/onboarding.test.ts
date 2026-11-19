/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOnboardingService } from '../src/modules/users/onboarding.service';
import { ONBOARDING_STEPS } from '../src/modules/users/onboarding.config';

interface FakeUser {
  id: string;
  deletedAt: Date | null;
  aiAccessEnabled: boolean;
  aiAccessUpdatedAt: Date | null;
  profile: { id: string } | null;
  workspaceMemberships: Array<{ id: string }>;
  ownedWorkspaces: Array<{ id: string }>;
  onboardingState: {
    id: string;
    userId: string;
    currentStep: string;
    completedAt: Date | null;
    skippedSteps: string[];
    createdAt: Date;
    updatedAt: Date;
  } | null;
}

interface FakeAcceptance {
  id: string;
  userId: string;
  documentType: string;
  version: string;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

interface SecurityEvent {
  action: string;
  targetType: string;
  targetId: string;
  actorId: string | undefined;
  metadata: Record<string, unknown> | undefined;
  ip: string | undefined;
  userAgent: string | undefined;
}

function makeFakePrisma(seed?: {
  user?: Partial<FakeUser>;
  acceptances?: FakeAcceptance[];
}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const user: FakeUser = {
    id: 'user-1',
    deletedAt: null,
    aiAccessEnabled: false,
    aiAccessUpdatedAt: null,
    profile: null,
    workspaceMemberships: [],
    ownedWorkspaces: [],
    onboardingState: null,
    ...seed?.user,
  };
  const acceptances: FakeAcceptance[] = [...(seed?.acceptances ?? [])];
  const securityEvents: SecurityEvent[] = [];
  let idSeq = 1;

  function selectUser(select: any) {
    if (!select) return user;
    const out: any = {};
    for (const [key, val] of Object.entries(select)) {
      if (!val) continue;
      if (key === 'profile') out.profile = user.profile;
      else if (key === 'workspaceMemberships') out.workspaceMemberships = user.workspaceMemberships;
      else if (key === 'ownedWorkspaces') out.ownedWorkspaces = user.ownedWorkspaces;
      else if (key === 'onboardingState') out.onboardingState = user.onboardingState;
      else out[key] = (user as any)[key];
    }
    return out;
  }

  const prisma: any = {
    user: {
      findUnique: async ({ where, select }: any) => {
        if (where.id !== user.id) return null;
        return selectUser(select);
      },
      update: async ({ where, data, select }: any) => {
        if (where.id !== user.id) throw new Error('user not found');
        if (Object.prototype.hasOwnProperty.call(data, 'aiAccessEnabled')) {
          user.aiAccessEnabled = data.aiAccessEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'aiAccessUpdatedAt')) {
          user.aiAccessUpdatedAt = data.aiAccessUpdatedAt;
        }
        return selectUser(select ?? {});
      },
    },
    userOnboardingState: {
      findUnique: async ({ where }: any) => {
        if (where.userId !== user.id) return null;
        return user.onboardingState;
      },
      upsert: async ({ where, create, update }: any) => {
        if (where.userId !== user.id) throw new Error('user not found');
        if (!user.onboardingState) {
          user.onboardingState = {
            id: `state-${idSeq++}`,
            userId: user.id,
            currentStep: create.currentStep ?? ONBOARDING_STEPS.WELCOME,
            completedAt: create.completedAt ?? null,
            skippedSteps: create.skippedSteps ?? [],
            createdAt: now,
            updatedAt: now,
          };
        } else if (update && Object.keys(update).length > 0) {
          user.onboardingState = { ...user.onboardingState, ...update, updatedAt: new Date() };
        }
        return user.onboardingState;
      },
      update: async ({ where, data }: any) => {
        if (where.userId !== user.id || !user.onboardingState) throw new Error('state not found');
        user.onboardingState = { ...user.onboardingState, ...data, updatedAt: new Date() };
        return user.onboardingState;
      },
    },
    userLegalAcceptance: {
      findUnique: async ({ where }: any) => {
        const key = where.userId_documentType_version;
        if (!key) return null;
        return (
          acceptances.find(
            (a) =>
              a.userId === key.userId &&
              a.documentType === key.documentType &&
              a.version === key.version,
          ) ?? null
        );
      },
      findMany: async ({ where }: any) => {
        let rows = acceptances.filter((a) => a.userId === where.userId);
        if (where.OR && Array.isArray(where.OR)) {
          rows = rows.filter((a) =>
            where.OR.some(
              (cond: any) => cond.documentType === a.documentType && cond.version === a.version,
            ),
          );
        }
        return rows.map((a) => ({ documentType: a.documentType, version: a.version }));
      },
      upsert: async ({ where, create, update }: any) => {
        const key = where.userId_documentType_version;
        const existing = acceptances.find(
          (a) =>
            a.userId === key.userId &&
            a.documentType === key.documentType &&
            a.version === key.version,
        );
        if (existing) {
          Object.assign(existing, update ?? {});
          return existing;
        }
        const row: FakeAcceptance = {
          id: `acc-${idSeq++}`,
          userId: create.userId,
          documentType: create.documentType,
          version: create.version,
          acceptedAt: create.acceptedAt ?? new Date(),
          ipAddress: create.ipAddress ?? null,
          userAgent: create.userAgent ?? null,
          createdAt: now,
        };
        acceptances.push(row);
        return row;
      },
    },
    auditLog: {
      create: async (data: any) => {
        const evt = data.data ?? data;
        securityEvents.push({
          action: evt.action,
          targetType: evt.targetType,
          targetId: evt.targetId,
          actorId: evt.actorId,
          metadata: evt.metadata,
          ip: evt.ip,
          userAgent: evt.userAgent,
        });
        return { id: `audit-${idSeq++}` };
      },
    },
  };

  return { prisma, user, acceptances, securityEvents };
}

test('new user gets required: true and starts at welcome', async () => {
  const { prisma } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  const status = await service.getStatus('user-1');

  assert.equal(status.required, true);
  assert.equal(status.currentStep, ONBOARDING_STEPS.WELCOME);
  assert.equal(status.completedAt, null);
  assert.deepEqual(status.pendingLegal, [
    { documentType: 'terms', version: '1.0' },
    { documentType: 'privacy', version: '1.0' },
  ]);
  assert.equal(status.aiAccessEnabled, false);
  assert.deepEqual(status.skippedSteps, []);
});

test('existing user with backfilled onboarding state gets required: false', async () => {
  const { prisma } = makeFakePrisma({
    user: {
      onboardingState: {
        id: 's1',
        userId: 'user-1',
        currentStep: ONBOARDING_STEPS.DONE,
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        skippedSteps: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    },
  });
  const service = createOnboardingService(prisma);

  // Backfilled users are not required to onboard even if legal docs are pending.
  const status = await service.getStatus('user-1');

  assert.equal(status.required, false);
  assert.equal(status.currentStep, ONBOARDING_STEPS.DONE);
  assert.ok(status.completedAt !== null);

  // After accepting all required legal docs, pendingLegal is empty.
  await service.acceptLegalDocument('user-1', { documentType: 'terms', version: '1.0' });
  await service.acceptLegalDocument('user-1', { documentType: 'privacy', version: '1.0' });
  const after = await service.getStatus('user-1');
  assert.deepEqual(after.pendingLegal, []);
});

test('acceptLegalDocument is idempotent for the same user, document type and version', async () => {
  const { prisma, acceptances } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  const first = await service.acceptLegalDocument('user-1', {
    documentType: 'terms',
    version: '1.0',
  });
  const second = await service.acceptLegalDocument('user-1', {
    documentType: 'terms',
    version: '1.0',
  });

  assert.equal(acceptances.length, 1);
  assert.equal(acceptances[0].documentType, 'terms');
  assert.equal(acceptances[0].version, '1.0');
  assert.equal(
    first.pendingLegal.some((d) => d.documentType === 'terms'),
    false,
  );
  assert.equal(
    second.pendingLegal.some((d) => d.documentType === 'terms'),
    false,
  );
});

test('acceptLegalDocument rejects a stale version', async () => {
  const { prisma, acceptances } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  await assert.rejects(
    () =>
      service.acceptLegalDocument('user-1', {
        documentType: 'terms',
        version: '0.9',
      }),
    (error: any) =>
      error?.code === 'STALE_LEGAL_DOCUMENT_VERSION' && error?.statusCode === 400,
  );
  assert.equal(acceptances.length, 0);
});

test('acceptLegalDocument rejects unknown document type', async () => {
  const { prisma, acceptances } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  await assert.rejects(
    () =>
      service.acceptLegalDocument('user-1', {
        documentType: 'unknown_doc',
        version: '1.0',
      }),
    (error: any) => error?.code === 'UNKNOWN_LEGAL_DOCUMENT' && error?.statusCode === 400,
  );
  assert.equal(acceptances.length, 0);
});

test('advanceStep rejects skipping required legal steps', async () => {
  const { prisma } = makeFakePrisma({
    user: { onboardingState: {
      id: 's1', userId: 'user-1', currentStep: ONBOARDING_STEPS.TERMS,
      completedAt: null, skippedSteps: [], createdAt: new Date(), updatedAt: new Date(),
    } },
  });
  const service = createOnboardingService(prisma);

  await assert.rejects(
    () => service.advanceStep('user-1', { step: ONBOARDING_STEPS.TERMS, action: 'skip' }),
    (error: any) =>
      error?.code === 'ONBOARDING_STEP_NOT_SKIPPABLE' && error?.statusCode === 400,
  );
});

test('advanceStep rejects out-of-order steps', async () => {
  const { prisma } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  await assert.rejects(
    () => service.advanceStep('user-1', { step: ONBOARDING_STEPS.PRIVACY, action: 'complete' }),
    (error: any) => error?.code === 'ONBOARDING_STEP_OUT_OF_ORDER' && error?.statusCode === 409,
  );
});

test('advanceStep rejects unknown step', async () => {
  const { prisma } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  await assert.rejects(
    () => service.advanceStep('user-1', { step: 'bogus' as any, action: 'complete' }),
    (error: any) => error?.code === 'INVALID_ONBOARDING_STEP' && error?.statusCode === 400,
  );
});

test('complete succeeds only when all required legal documents are accepted', async () => {
  const { prisma } = makeFakePrisma({
    user: {
      profile: { id: 'profile-1' },
      onboardingState: {
        id: 's1',
        userId: 'user-1',
        currentStep: ONBOARDING_STEPS.DONE,
        completedAt: null,
        skippedSteps: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
  });
  const service = createOnboardingService(prisma);

  await assert.rejects(
    () => service.complete('user-1'),
    (error: any) =>
      error?.code === 'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED' && error?.statusCode === 400,
  );

  await service.acceptLegalDocument('user-1', { documentType: 'terms', version: '1.0' });
  await assert.rejects(
    () => service.complete('user-1'),
    (error: any) =>
      error?.code === 'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED' && error?.statusCode === 400,
  );

  await service.acceptLegalDocument('user-1', { documentType: 'privacy', version: '1.0' });
  const completed = await service.complete('user-1');

  assert.equal(completed.required, false);
  assert.equal(completed.currentStep, ONBOARDING_STEPS.DONE);
  assert.ok(completed.completedAt !== null);
  assert.deepEqual(completed.pendingLegal, []);
});

test('complete is idempotent', async () => {
  const { prisma } = makeFakePrisma({
    user: {
      profile: { id: 'profile-1' },
      onboardingState: {
        id: 's1',
        userId: 'user-1',
        currentStep: ONBOARDING_STEPS.DONE,
        completedAt: new Date('2026-01-02T00:00:00.000Z'),
        skippedSteps: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
  });
  const service = createOnboardingService(prisma);

  const first = await service.complete('user-1');
  const second = await service.complete('user-1');

  assert.equal(first.required, false);
  assert.equal(second.required, false);
  assert.equal(first.completedAt, second.completedAt);
});

test('user A cannot affect user B', async () => {
  const { prisma: prismaA, acceptances: acceptancesA } = makeFakePrisma({
    user: { id: 'user-a', onboardingState: null },
  });
  const { prisma: prismaB, acceptances: acceptancesB } = makeFakePrisma({
    user: { id: 'user-b', onboardingState: null },
  });

  const serviceA = createOnboardingService(prismaA);
  const serviceB = createOnboardingService(prismaB);

  await serviceA.acceptLegalDocument('user-a', { documentType: 'terms', version: '1.0' });
  await serviceB.acceptLegalDocument('user-b', { documentType: 'privacy', version: '1.0' });

  assert.equal(acceptancesA.length, 1);
  assert.equal(acceptancesA[0].userId, 'user-a');
  assert.equal(acceptancesA[0].documentType, 'terms');

  assert.equal(acceptancesB.length, 1);
  assert.equal(acceptancesB[0].userId, 'user-b');
  assert.equal(acceptancesB[0].documentType, 'privacy');

  // User B cannot read User A's status
  const statusB = await serviceB.getStatus('user-b');
  assert.equal(statusB.pendingLegal.some((d) => d.documentType === 'terms'), true);
  assert.equal(statusB.pendingLegal.some((d) => d.documentType === 'privacy'), false);
});

test('updateAiAccess stores preference and records security event', async () => {
  const { prisma, user, securityEvents } = makeFakePrisma();
  const service = createOnboardingService(prisma);

  const result = await service.updateAiAccess('user-1', true, {
    ip: '127.0.0.1',
    userAgent: 'test-agent',
  });

  assert.equal(result.aiAccessEnabled, true);
  assert.ok(result.aiAccessUpdatedAt !== null);

  assert.equal(user.aiAccessEnabled, true);

  assert.equal(securityEvents.length, 1);
  assert.equal(securityEvents[0].action, 'auth.ai_access_enabled');
  assert.equal(securityEvents[0].targetId, 'user-1');

  // Turn it off
  const result2 = await service.updateAiAccess('user-1', false);
  assert.equal(result2.aiAccessEnabled, false);
  assert.equal(securityEvents.length, 2);
  assert.equal(securityEvents[1].action, 'auth.ai_access_disabled');
});
