import assert from 'node:assert/strict';
import test from 'node:test';
import { createBillingService } from '../src/modules/billing/billing.service';
import type { AppConfig } from '../src/config/env';
import type { PaystackClient } from '../src/modules/billing/paystack.client';
import type { PrismaClient } from '@prisma/client';
import { encryptProviderToken } from '../src/modules/billing/token-cipher';

const config = {
  paystackSecretKey: 'test-secret',
  paystackEncryptionKey: Buffer.alloc(32, 9).toString('base64url'),
  paystackUsdEnabled: true,
} as AppConfig;

const actor = { userId: 'owner-1', email: 'owner@example.test' };

function mockPaystack(overrides: Partial<PaystackClient> = {}): PaystackClient {
  return {
    initialize: async () => ({ authorization_url: 'https://checkout.example.test' }),
    verify: async (reference) => ({
      reference,
      status: 'failed',
      amount: 1_000,
      currency: 'USD',
      paid_at: null,
      customer: { email: actor.email, customer_code: 'customer-1' },
      authorization: { authorization_code: 'authorization-1', reusable: false },
    }),
    createPlan: async () => ({ plan_code: 'plan-1' }),
    createSubscription: async () => ({
      subscription_code: 'subscription-1',
      email_token: 'opaque-token',
      next_payment_date: null,
      status: 'active',
    }),
    fetchSubscription: async (code) => ({
      subscription_code: code,
      email_token: 'opaque-token',
      next_payment_date: null,
      status: 'active',
      plan: { amount: 1_000, currency: 'USD', interval: 'monthly' },
    }),
    disableSubscription: async () => {},
    ...overrides,
  };
}

test('server verification rejects a failed checkout and never creates paid subscription state', async () => {
  const writes: string[] = [];
  const prisma = {
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        ownerId: actor.userId,
        owner: { email: actor.email, status: 'ACTIVE' },
        members: [],
      }),
    },
    billingCheckout: {
      findUnique: async () => ({
        id: 'checkout-1',
        workspaceId: 'workspace-1',
        createdByUserId: actor.userId,
        reference: 'ref-1',
        status: 'PENDING',
        plan: 'PRO',
        interval: 'MONTHLY',
        billableSeats: 1,
        amountSubunit: 1_000,
        providerPlanCode: 'plan-1',
        providerSubscriptionCode: null,
        providerManageTokenCiphertext: null,
        providerAuthorizationReusable: null,
        verifiedAt: null,
      }),
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: { status?: string } }) => {
        if (data.status) writes.push(data.status);
        return {};
      },
    },
    subscription: {
      findUnique: async () => null,
      upsert: async () => {
        writes.push('SUBSCRIPTION_CREATED');
        return {};
      },
    },
  } as unknown as PrismaClient;
  const service = createBillingService(config, { prisma, paystack: mockPaystack() });

  await assert.rejects(
    service.verifyCheckout({ actor, workspaceId: 'workspace-1', reference: 'ref-1' }),
    { code: 'PAYMENT_NOT_VERIFIED' },
  );
  assert.deepEqual(writes, ['FAILED']);
});

test('deletion cancellation does not reach the provider when recovery or ownership transfer made the job stale', async () => {
  let providerCalls = 0;
  const prisma = {
    workspace: {
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;
  const service = createBillingService(config, {
    prisma,
    paystack: mockPaystack({
      disableSubscription: async () => {
        providerCalls += 1;
      },
    }),
  });

  await service.synchronizeDeletionCancellation({ workspaceId: 'workspace-1' });
  assert.equal(providerCalls, 0);
});

test('provider reconciliation verifies a paid checkout missed by its webhook', async () => {
  let checkoutStatus = 'PENDING';
  let subscriptionState: Record<string, unknown> | null = null;
  let paymentWrites = 0;
  const checkout = {
    id: 'checkout-1',
    workspaceId: 'workspace-1',
    createdByUserId: actor.userId,
    reference: 'ref-reconcile',
    status: 'PENDING',
    plan: 'PRO',
    interval: 'MONTHLY',
    billableSeats: 1,
    amountSubunit: 1_000,
    currency: 'USD',
    providerPlanCode: 'plan-1',
    providerSubscriptionCode: null,
    providerManageTokenCiphertext: null,
    providerAuthorizationReusable: null,
    verifiedAt: null,
  };
  const prisma = {
    billingCheckout: {
      findMany: async () => (checkoutStatus === 'PAID' ? [] : [checkout]),
      findUnique: async () => ({ ...checkout, status: checkoutStatus }),
      updateMany: async ({ data }: { data: { status: string } }) => {
        checkoutStatus = data.status;
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(checkout, data),
    },
    billingPayment: {},
    subscription: {
      findMany: async () => [],
      findUnique: async () => subscriptionState,
    },
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        ownerId: actor.userId,
        owner: { email: actor.email, status: 'ACTIVE' },
        members: [],
      }),
      findUnique: async () => ({
        ownerId: actor.userId,
        owner: { status: 'ACTIVE' },
        members: [{ userId: actor.userId }],
      }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        billingPayment: {
          upsert: async () => {
            paymentWrites += 1;
            return {};
          },
        },
        subscription: {
          upsert: async ({ create }: { create: Record<string, unknown> }) => {
            subscriptionState = { ...create, id: 'subscription-1' };
            return subscriptionState;
          },
        },
        billingCheckout: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            if (typeof data.status === 'string') checkoutStatus = data.status;
            return Object.assign(checkout, data);
          },
        },
      }),
  } as unknown as PrismaClient;
  const paystack = mockPaystack({
    verify: async (reference) => ({
      reference,
      status: 'success',
      amount: 1_000,
      currency: 'USD',
      paid_at: '2026-11-04T10:00:00.000Z',
      customer: { email: actor.email, customer_code: 'customer-1' },
      authorization: { authorization_code: 'authorization-1', reusable: false },
    }),
  });
  const service = createBillingService(config, {
    prisma,
    paystack,
    now: () => new Date('2026-11-04T11:00:00.000Z'),
  });

  const result = await service.reconcileProviderState();
  assert.equal(result.repairedCheckouts, 1);
  assert.equal(paymentWrites, 1);
  assert.equal(checkoutStatus, 'PAID');
  assert.equal((subscriptionState as { status?: string } | null)?.status, 'NON_RENEWING');
});

test('a webhook for the old subscription cannot cancel a scheduled replacement', async () => {
  let subscriptionWrites = 0;
  const prisma = {
    billingWebhookEvent: {
      findUnique: async () => null,
      create: async () => ({}),
    },
    subscription: {
      findFirst: async () => ({
        id: 'subscription-row',
        workspaceId: 'workspace-1',
        providerSubscriptionCode: 'old-subscription',
        pendingSubscriptionCode: 'replacement-subscription',
        currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
      }),
      update: async () => {
        subscriptionWrites += 1;
        return {};
      },
    },
  } as unknown as PrismaClient;
  const service = createBillingService(config, { prisma, paystack: mockPaystack() });

  await service.processWebhook({
    event: 'subscription.disable',
    eventKey: 'evt-old-disable',
    subscriptionCode: 'old-subscription',
  });
  assert.equal(subscriptionWrites, 0);
});

test('replayed webhook event keys are ignored before provider or subscription writes', async () => {
  let otherQueries = 0;
  const prisma = {
    billingWebhookEvent: { findUnique: async () => ({ eventKey: 'event-1' }) },
    billingCheckout: {
      findUnique: async () => {
        otherQueries += 1;
        return null;
      },
    },
    subscription: {
      findFirst: async () => {
        otherQueries += 1;
        return null;
      },
    },
  } as unknown as PrismaClient;
  const service = createBillingService(config, {
    prisma,
    paystack: mockPaystack({
      verify: async () => {
        otherQueries += 1;
        throw new Error('should not verify');
      },
    }),
  });

  await service.processWebhook({
    event: 'charge.success',
    eventKey: 'event-1',
    reference: 'ref-1',
  });
  assert.equal(otherQueries, 0);
});

test('failed subscription invoices synchronize provider status and retain paid-period boundaries', async () => {
  const subscription = {
    id: 'subscription-row',
    workspaceId: 'workspace-1',
    status: 'ACTIVE',
    currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
  };
  let subscriptionStatus = '';
  let paymentCreate: Record<string, unknown> | undefined;
  const prisma = {
    billingWebhookEvent: {
      findUnique: async () => null,
      create: async () => ({}),
    },
    subscription: {
      findFirst: async () => subscription,
      update: async ({ data }: { data: { status: string } }) => {
        subscriptionStatus = data.status;
        return {};
      },
    },
    billingPayment: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        paymentCreate = create;
        return {};
      },
    },
  } as unknown as PrismaClient;
  const service = createBillingService(config, { prisma, paystack: mockPaystack() });

  await service.processWebhook({
    event: 'invoice.payment_failed',
    eventKey: 'failed-invoice-event',
    subscriptionCode: 'subscription-1',
    reference: 'failed-charge-ref',
    amount: 1_000,
    currency: 'USD',
  });

  assert.equal(subscriptionStatus, 'ATTENTION');
  assert.equal(subscription.currentPeriodEnd.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(paymentCreate?.providerReference, 'failed-charge-ref');
  assert.equal(paymentCreate?.status, 'FAILED');
});

test('billing mutations reject non-owners before reading or changing subscription data', async () => {
  let subscriptionReads = 0;
  const prisma = {
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        ownerId: 'another-owner',
        owner: { email: actor.email, status: 'ACTIVE' },
        members: [{ userId: actor.userId }],
      }),
    },
    subscription: {
      findUnique: async () => {
        subscriptionReads += 1;
        return null;
      },
    },
  } as unknown as PrismaClient;
  const service = createBillingService(config, { prisma, paystack: mockPaystack() });

  await assert.rejects(service.cancel({ actor, workspaceId: 'workspace-1' }), {
    code: 'BILLING_OWNER_REQUIRED',
  });
  assert.equal(subscriptionReads, 0);
});

test('automatic seat reduction schedules a recurring quantity at the original renewal cadence', async () => {
  for (const fixture of [
    {
      interval: 'MONTHLY' as const,
      currentSeats: 16,
      activeSeats: 15,
      expectedAmount: 1_000,
      expectedProviderInterval: 'monthly',
    },
    {
      interval: 'ANNUAL' as const,
      currentSeats: 18,
      activeSeats: 17,
      expectedAmount: 5_200,
      expectedProviderInterval: 'annually',
    },
  ]) {
    const calls: Array<{ name: string; input?: Record<string, unknown> }> = [];
    const startAt = new Date('2026-12-01T00:00:00.000Z');
    const current = {
      id: 'subscription-row',
      workspaceId: 'workspace-1',
      plan: 'PRO',
      interval: fixture.interval,
      status: 'ACTIVE',
      billableSeats: fixture.currentSeats,
      providerCustomerCode: 'customer-1',
      providerSubscriptionCode: 'old-subscription',
      providerManageTokenCiphertext: encryptProviderToken(
        'old-token',
        config.paystackEncryptionKey,
      ),
      pendingSubscriptionCode: null,
      pendingManageTokenCiphertext: null,
      pendingPlan: null,
      pendingInterval: null,
      pendingBillableSeats: null,
      currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
      currentPeriodEnd: startAt,
      cancelAtPeriodEnd: false,
    };
    const prisma = {
      workspace: {
        findUnique: async () => ({
          id: 'workspace-1',
          ownerId: actor.userId,
          owner: { email: actor.email, status: 'ACTIVE' },
          members: Array.from({ length: fixture.activeSeats - 1 }, (_, index) => ({
            userId: `member-${index}`,
          })),
        }),
      },
      subscription: {
        findUnique: async () => current,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          calls.push({ name: 'subscription.update', input: data });
          return { ...current, ...data };
        },
      },
      billingSeatSync: {
        findUnique: async () => ({
          id: 'sync-1',
          generation: 1,
          providerSubscriptionCode: null,
          providerManageTokenCiphertext: null,
          previousSubscriptionCode: null,
          previousManageTokenCiphertext: null,
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          calls.push({ name: 'sync.update', input: data });
          return {};
        },
      },
      paystackPlan: {
        findUnique: async () => null,
        create: async (_input: { data: Record<string, unknown> }) => ({
          providerPlanCode: 'plan-reduced',
        }),
      },
    } as unknown as PrismaClient;
    const paystack = mockPaystack({
      createPlan: async (input) => {
        calls.push({ name: 'plan.create', input });
        return { plan_code: 'plan-reduced' };
      },
      createSubscription: async (input) => {
        calls.push({ name: 'subscription.create', input });
        return {
          subscription_code: 'replacement',
          email_token: 'replacement-token',
          next_payment_date: startAt.toISOString(),
          status: 'active',
        };
      },
      disableSubscription: async (input) => {
        calls.push({ name: 'subscription.disable', input });
      },
    });
    const service = createBillingService(config, {
      prisma,
      paystack,
      now: () => new Date('2026-11-15T00:00:00.000Z'),
    });

    await service.synchronizeSeatReduction({ workspaceId: 'workspace-1', syncId: 'sync-1' });
    const providerPlan = calls.find((call) => call.name === 'plan.create')?.input;
    const providerSubscription = calls.find((call) => call.name === 'subscription.create')?.input;
    const scheduled = calls.find((call) => call.name === 'subscription.update')?.input;
    assert.equal(providerPlan?.amount, fixture.expectedAmount);
    assert.equal(providerPlan?.interval, fixture.expectedProviderInterval);
    assert.equal(providerSubscription?.start_date, startAt.toISOString());
    assert.equal(scheduled?.pendingBillableSeats, fixture.activeSeats);
    assert.equal(scheduled?.pendingEffectiveAt, startAt);
  }
});
