import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBillableMemberIds,
  getRecurringSubscriptionChargeCents,
  getWorkspaceSeatBillingSummary,
  assertWorkspaceSeatCapacity,
  enqueueWorkspaceSeatReduction,
  type MembershipBillingRecord,
} from '../src/modules/billing/membership-billing';
import { subscriptionCatalog } from '../src/modules/billing/pricing';
import {
  assertBillingOwner,
  failedPaymentPolicy,
  prepareAdditionalSeatIncrease,
  prepareImmediateUpgrade,
  prorateCents,
  refundPolicy,
  scheduleAdditionalSeatReduction,
  scheduleCancellation,
  scheduleDowngrade,
} from '../src/modules/billing/lifecycle-policy';
import type { Prisma, PrismaClient } from '@prisma/client';

const record = (
  userId: string,
  membershipStatus: MembershipBillingRecord['membershipStatus'],
  userStatus: MembershipBillingRecord['userStatus'] = 'ACTIVE',
  workspaceId = 'workspace-a',
): MembershipBillingRecord => ({ workspaceId, userId, membershipStatus, userStatus });

test('the approved server catalog contains base and additional-member prices and allowances', () => {
  assert.deepEqual(subscriptionCatalog.PRO, {
    monthlyBaseCents: 1_000,
    annualBaseCents: 5_000,
    includedMembers: 15,
    additionalMemberMonthlyCents: 50,
    additionalMemberAnnualCents: 100,
  });
  assert.deepEqual(subscriptionCatalog.BUSINESS, {
    monthlyBaseCents: 1_500,
    annualBaseCents: 7_000,
    includedMembers: 25,
    additionalMemberMonthlyCents: 50,
    additionalMemberAnnualCents: 100,
  });
});

test('only active workspace memberships count; pending, suspended, removed, and deactivated do not', () => {
  const ids = getBillableMemberIds({
    workspaceId: 'workspace-a',
    ownerId: 'owner',
    ownerStatus: 'ACTIVE',
    memberships: [
      record('owner', 'ACTIVE'),
      record('active', 'ACTIVE'),
      record('pending', 'PENDING'),
      record('invite', 'PENDING_INVITATION'),
      record('suspended', 'SUSPENDED'),
      record('removed', 'REMOVED'),
      record('deactivated', 'ACTIVE', 'DEACTIVATED'),
    ],
  });
  assert.deepEqual(ids.sort(), ['active', 'owner']);
});

test('owner consumes one included seat and duplicate membership rows do not inflate counts', () => {
  const ids = getBillableMemberIds({
    workspaceId: 'workspace-a',
    ownerId: 'owner',
    ownerStatus: 'ACTIVE',
    memberships: [
      record('owner', 'ACTIVE'),
      record('member', 'ACTIVE'),
      record('member', 'ACTIVE'),
    ],
  });
  assert.equal(ids.length, 2);
  assert.equal(ids.filter((id) => id === 'owner').length, 1);
});

test('an active paid subscription prevents activating an additional unpaid member', async () => {
  const tx = {
    subscription: { findUnique: async () => ({ status: 'ACTIVE', billableSeats: 2 }) },
    workspace: {
      findUnique: async () => ({
        ownerId: 'owner',
        owner: { status: 'ACTIVE' },
        members: [{ userId: 'owner' }, { userId: 'member-1' }],
      }),
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    assertWorkspaceSeatCapacity(tx, { workspaceId: 'workspace-a', userId: 'member-2' }),
    {
      code: 'PAID_SEAT_REQUIRED',
    },
  );
});

test('membership activation remains allowed within already-paid seat quantity', async () => {
  const tx = {
    subscription: { findUnique: async () => ({ status: 'ACTIVE', billableSeats: 3 }) },
    workspace: {
      findUnique: async () => ({
        ownerId: 'owner',
        owner: { status: 'ACTIVE' },
        members: [{ userId: 'owner' }, { userId: 'member-1' }],
      }),
    },
  } as unknown as Prisma.TransactionClient;

  await assert.doesNotReject(
    assertWorkspaceSeatCapacity(tx, { workspaceId: 'workspace-a', userId: 'member-2' }),
  );
});

test('membership reductions enqueue the authoritative active seat count in the same transaction', async () => {
  let queued: Record<string, unknown> | undefined;
  const tx = {
    subscription: {
      findUnique: async () => ({
        status: 'ACTIVE',
        billableSeats: 5,
        pendingBillableSeats: null,
        pendingSubscriptionCode: null,
        cancelAtPeriodEnd: false,
      }),
    },
    workspace: {
      findUnique: async () => ({
        ownerId: 'owner',
        owner: { status: 'ACTIVE' },
        members: [{ userId: 'owner' }, { userId: 'member-1' }, { userId: 'member-2' }],
      }),
    },
    billingSeatSync: {
      findUnique: async () => null,
      upsert: async (args: { create: Record<string, unknown> }) => {
        queued = args.create;
        return args.create;
      },
    },
  } as unknown as Prisma.TransactionClient;

  await enqueueWorkspaceSeatReduction(tx, 'workspace-a');
  assert.deepEqual(queued, { workspaceId: 'workspace-a', requestedSeats: 3 });
});

test('deactivated owner is not billable and memberships in another workspace are isolated', () => {
  const ids = getBillableMemberIds({
    workspaceId: 'workspace-a',
    ownerId: 'owner',
    ownerStatus: 'DEACTIVATED',
    memberships: [record('other-workspace-member', 'ACTIVE', 'ACTIVE', 'workspace-b')],
  });
  assert.deepEqual(ids, []);
});

test('database-backed summary scopes its query to the requested workspace and uses server catalog values', async () => {
  let requestedWorkspaceId = '';
  const prisma = {
    workspace: {
      findUnique: async (args: { where: { id: string } }) => {
        requestedWorkspaceId = args.where.id;
        return {
          ownerId: 'owner',
          owner: { status: 'ACTIVE' },
          members: [{ userId: 'owner' }, { userId: 'm1' }, { userId: 'm2' }],
        };
      },
    },
  } as unknown as PrismaClient;
  const summary = await getWorkspaceSeatBillingSummary(prisma, {
    workspaceId: 'workspace-a',
    plan: 'PRO',
  });

  assert.equal(requestedWorkspaceId, 'workspace-a');
  assert.deepEqual(summary, {
    activeMemberCount: 3,
    includedMemberCount: 15,
    additionalMemberCount: 0,
    additionalMemberMonthlyChargeCents: 0,
    additionalMemberChargeCents: 0,
    additionalMemberBillingInterval: 'MONTHLY',
    totalSubscriptionChargeCents: 1_000,
  });
});

test('Pro and Business additional members are calculated at their monthly rates', async () => {
  const prisma = {
    workspace: {
      findUnique: async () => ({
        ownerId: 'owner',
        owner: { status: 'ACTIVE' },
        members: Array.from({ length: 27 }, (_, index) => ({ userId: `member-${index}` })),
      }),
    },
  } as unknown as PrismaClient;
  const pro = await getWorkspaceSeatBillingSummary(prisma, {
    workspaceId: 'workspace-a',
    plan: 'PRO',
  });
  const business = await getWorkspaceSeatBillingSummary(prisma, {
    workspaceId: 'workspace-a',
    plan: 'BUSINESS',
  });
  assert.equal(pro.additionalMemberCount, 13);
  assert.equal(pro.additionalMemberMonthlyChargeCents, 650);
  assert.equal(business.additionalMemberCount, 3);
  assert.equal(business.additionalMemberMonthlyChargeCents, 150);
});

test('annual seat charges use the annual cadence and approved annual per-seat amount', () => {
  assert.equal(
    getRecurringSubscriptionChargeCents({ plan: 'PRO', interval: 'ANNUAL', billableSeats: 16 }),
    5_100,
  );
  assert.equal(
    getRecurringSubscriptionChargeCents({
      plan: 'BUSINESS',
      interval: 'ANNUAL',
      billableSeats: 26,
    }),
    7_100,
  );
});

test('proration uses the supplied UTC period boundaries and rounds to cents', () => {
  const period = {
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    endsAt: new Date('2026-02-01T00:00:00.000Z'),
  };
  const result = prorateCents(1_000, period, new Date('2026-01-16T12:00:00.000Z'));
  assert.equal(result.amountCents, 500);
  assert.equal(result.remainingFraction, 0.5);
});

test('upgrade prepares an immediate, prorated delta that is effective only after verified payment', () => {
  const result = prepareImmediateUpgrade({
    currentPlan: 'PRO',
    targetPlan: 'BUSINESS',
    interval: 'ANNUAL',
    period: {
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2027-01-01T00:00:00.000Z'),
    },
    now: new Date('2026-07-02T00:00:00.000Z'),
  });
  assert.equal(result.amountCents, 1_003);
  assert.equal(result.effectiveWhen, 'verified-payment');
  assert.equal(result.planToActivate, 'BUSINESS');
});

test('downgrade is scheduled at renewal and reports conflicts without removing members', () => {
  const renewal = new Date('2027-01-01T00:00:00.000Z');
  const result = scheduleDowngrade({
    targetPlan: 'PRO',
    periodEndsAt: renewal,
    activeMemberCount: 18,
  });
  assert.equal(result.effectiveAt.toISOString(), renewal.toISOString());
  assert.equal(result.currentPlanRemainsActiveUntil.toISOString(), renewal.toISOString());
  assert.equal(result.seatLimitConflictCount, 3);
  assert.equal(result.membersRemoved, false);
});

test('additional seats on annual base plans use the annual cadence and require confirmed payment', () => {
  const result = prepareAdditionalSeatIncrease({
    plan: 'BUSINESS',
    interval: 'ANNUAL',
    addedSeatCount: 2,
    seatPeriod: {
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2027-01-01T00:00:00.000Z'),
    },
    now: new Date('2026-07-02T00:00:00.000Z'),
  });
  assert.equal(result.amountCents, 100);
  assert.equal(result.billingInterval, 'ANNUAL');
  assert.equal(result.effectiveWhen, 'verified-payment');
});

test('seat reductions apply at renewal without automatic credits', () => {
  const renewalAt = new Date('2027-01-01T00:00:00.000Z');
  assert.deepEqual(scheduleAdditionalSeatReduction({ renewalAt, reducedSeatCount: 2 }), {
    effectiveAt: renewalAt,
    reducedSeatCount: 2,
    automaticCreditCents: 0,
  });
});

test('cancellation is period-end, preserves benefits until then, and duplicate requests are idempotent', () => {
  const periodEndsAt = new Date('2027-01-01T00:00:00.000Z');
  assert.deepEqual(scheduleCancellation({ periodEndsAt, alreadyEffectiveAt: null }), {
    effectiveAt: periodEndsAt,
    benefitsRetainedUntil: periodEndsAt,
    duplicateRequest: false,
  });
  assert.equal(
    scheduleCancellation({ periodEndsAt, alreadyEffectiveAt: periodEndsAt }).duplicateRequest,
    true,
  );
});

test('refunds are manual and failed-payment timelines remain explicitly deferred', () => {
  assert.equal(refundPolicy.automaticRefunds, false);
  assert.equal(failedPaymentPolicy.retrySchedule, 'deferred');
  assert.equal(failedPaymentPolicy.gracePeriod, 'deferred');
  assert.equal(failedPaymentPolicy.accessRestrictionTimeline, 'deferred');
  assert.equal(failedPaymentPolicy.neverGrantPaidAccessWithoutVerifiedPayment, true);
  assert.equal(failedPaymentPolicy.neverDeleteCustomerDataForPaymentFailure, true);
});

test('only the workspace owner is authorized to change billing', () => {
  assert.doesNotThrow(() => assertBillingOwner('owner', 'owner'));
  assert.throws(() => assertBillingOwner('member', 'owner'), { name: 'BillingAuthorizationError' });
});
