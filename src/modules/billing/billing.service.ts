import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  PrismaClient,
  SubscriptionInterval,
  SubscriptionPlanId,
} from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import {
  getWorkspaceBillableMemberIds,
  getRecurringSubscriptionChargeCents,
} from './membership-billing';
import { subscriptionCatalog, type BaseBillingInterval, type PaidPlanId } from './pricing';
import {
  createPaystackClient,
  type PaystackClient,
  type PaystackSubscription,
  type PaystackTransaction,
} from './paystack.client';
import { decryptProviderToken, encryptProviderToken } from './token-cipher';

type BillingActor = { userId: string; email: string };
type Target = { plan: PaidPlanId; interval: BaseBillingInterval; billableSeats: number };

function asPlan(value: SubscriptionPlanId): PaidPlanId {
  return value;
}
function asInterval(value: SubscriptionInterval): BaseBillingInterval {
  return value;
}
function nextPeriod(start: Date, interval: BaseBillingInterval): Date {
  const next = new Date(start);
  if (interval === 'ANNUAL') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastDay = new Date(
      Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
    ).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  }
  return next;
}

export function getTargetCycleChargeCents(target: Target): number {
  return getRecurringSubscriptionChargeCents(target);
}

export function prorateUpgradeAmountCents(input: {
  oldAmountCents: number;
  newAmountCents: number;
  startsAt: Date;
  endsAt: Date;
  now: Date;
}): number {
  if (input.endsAt <= input.startsAt || input.newAmountCents <= input.oldAmountCents) return 0;
  const full = input.newAmountCents - input.oldAmountCents;
  const remaining = Math.max(
    0,
    Math.min(
      1,
      (input.endsAt.getTime() - input.now.getTime()) /
        (input.endsAt.getTime() - input.startsAt.getTime()),
    ),
  );
  return Math.round(full * remaining);
}

export interface BillingService {
  listPlans(): unknown;
  getWorkspace(input: { actor: BillingActor; workspaceId: string }): Promise<unknown>;
  createCheckout(input: {
    actor: BillingActor;
    workspaceId: string;
    plan: PaidPlanId;
    interval: BaseBillingInterval;
    billableSeats?: number;
  }): Promise<unknown>;
  verifyCheckout(input: {
    actor: BillingActor;
    workspaceId: string;
    reference: string;
  }): Promise<unknown>;
  scheduleChange(input: {
    actor: BillingActor;
    workspaceId: string;
    plan: PaidPlanId;
    interval: BaseBillingInterval;
    billableSeats?: number;
  }): Promise<unknown>;
  cancel(input: { actor: BillingActor; workspaceId: string }): Promise<unknown>;
  listPayments(input: { actor: BillingActor; workspaceId: string }): Promise<unknown>;
  processWebhook(input: {
    event: string;
    eventKey: string;
    reference?: string;
    subscriptionCode?: string;
    amount?: number;
    currency?: string;
    paidAt?: string;
  }): Promise<void>;
  synchronizeSeatReduction(input: { workspaceId: string; syncId: string }): Promise<void>;
  reconcileProviderState(): Promise<{ checked: number; repairedCheckouts: number; mismatches: number }>;
}

export function createBillingService(
  config: AppConfig,
  options: { prisma?: PrismaClient; paystack?: PaystackClient; now?: () => Date } = {},
): BillingService {
  const prisma = options.prisma ?? getPrismaClient();
  const paystack = options.paystack ?? createPaystackClient(config);
  const now = options.now ?? (() => new Date());

  function assertUsdAvailable(): void {
    if (!config.paystackSecretKey || !config.paystackUsdEnabled || !config.paystackEncryptionKey) {
      throw new AppError(
        503,
        'USD_BILLING_UNAVAILABLE',
        'USD billing is unavailable until Paystack USD is enabled and configured',
      );
    }
  }

  async function requireWorkspace(actor: BillingActor, workspaceId: string, ownerOnly: boolean) {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null, status: 'ACTIVE' },
      select: {
        id: true,
        ownerId: true,
        owner: { select: { email: true, status: true } },
        members: { where: { userId: actor.userId, status: 'ACTIVE' }, select: { userId: true } },
      },
    });
    if (!workspace || (workspace.ownerId !== actor.userId && workspace.members.length === 0)) {
      throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'The workspace is unavailable');
    }
    if (ownerOnly && workspace.ownerId !== actor.userId) {
      throw new AppError(
        403,
        'BILLING_OWNER_REQUIRED',
        'Only the workspace owner can manage billing',
      );
    }
    if (workspace.owner.status !== 'ACTIVE')
      throw new AppError(
        409,
        'BILLING_OWNER_INACTIVE',
        'The workspace owner account is not active',
      );
    return workspace;
  }

  async function getPaystackPlan(target: Target): Promise<string> {
    const amountSubunit = getTargetCycleChargeCents(target);
    const existing = await prisma.paystackPlan.findUnique({
      where: {
        plan_interval_billableSeats: {
          plan: target.plan,
          interval: target.interval,
          billableSeats: target.billableSeats,
        },
      },
      select: { providerPlanCode: true, amountSubunit: true },
    });
    if (existing) {
      if (existing.amountSubunit !== amountSubunit)
        throw new AppError(
          409,
          'BILLING_CATALOG_CHANGED',
          'The stored provider plan does not match the current price catalog',
        );
      return existing.providerPlanCode;
    }
    const created = await paystack.createPlan({
      name: `Nexus ${target.plan} ${target.interval.toLowerCase()} (${target.billableSeats} seats)`,
      amount: amountSubunit,
      interval: target.interval === 'MONTHLY' ? 'monthly' : 'annually',
    });
    try {
      const saved = await prisma.paystackPlan.create({
        data: {
          plan: target.plan,
          interval: target.interval,
          billableSeats: target.billableSeats,
          amountSubunit,
          currency: 'USD',
          providerPlanCode: created.plan_code,
        },
      });
      return saved.providerPlanCode;
    } catch (error) {
      // Concurrent plan creation can leave an unused Paystack catalog entry;
      // only the unique local row is authoritative for later subscriptions.
      const raced = await prisma.paystackPlan.findUnique({
        where: {
          plan_interval_billableSeats: {
            plan: target.plan,
            interval: target.interval,
            billableSeats: target.billableSeats,
          },
        },
        select: { providerPlanCode: true },
      });
      if (raced) return raced.providerPlanCode;
      throw error;
    }
  }

  async function subscriptionSummary(workspaceId: string) {
    const [subscription, activeMemberIds] = await Promise.all([
      prisma.subscription.findUnique({ where: { workspaceId } }),
      getWorkspaceBillableMemberIds(prisma, workspaceId),
    ]);
    if (!subscription)
      return {
        subscription: null,
        activeBillableSeats: activeMemberIds.length,
        includedSeats: 0,
        additionalSeats: 0,
      };
    const includedSeats = subscriptionCatalog[asPlan(subscription.plan)].includedMembers;
    return {
      subscription: {
        id: subscription.id,
        plan: subscription.plan,
        interval: subscription.interval,
        currency: subscription.currency,
        status: subscription.status,
        billableSeats: subscription.billableSeats,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        pendingChange: subscription.pendingEffectiveAt
          ? {
              plan: subscription.pendingPlan,
              interval: subscription.pendingInterval,
              billableSeats: subscription.pendingBillableSeats,
              effectiveAt: subscription.pendingEffectiveAt,
            }
          : null,
      },
      activeBillableSeats: activeMemberIds.length,
      includedSeats,
      additionalSeats: Math.max(0, activeMemberIds.length - includedSeats),
    };
  }

  async function verifyAndFulfill(workspaceId: string, reference: string, actorUserId?: string) {
    let checkout = await prisma.billingCheckout.findUnique({ where: { reference } });
    if (
      !checkout ||
      checkout.workspaceId !== workspaceId ||
      (actorUserId && checkout.createdByUserId !== actorUserId)
    ) {
      throw new AppError(404, 'BILLING_CHECKOUT_NOT_FOUND', 'The checkout is unavailable');
    }
    if (checkout.status === 'PAID') return subscriptionSummary(workspaceId);
    if (
      checkout.status === 'PROCESSING' &&
      !checkout.providerSubscriptionCode &&
      !checkout.verifiedAt
    ) {
      throw new AppError(
        409,
        'BILLING_CHECKOUT_PROCESSING',
        'Payment verification is being completed; contact support if this persists',
      );
    }
    if (checkout.status === 'PENDING') {
      const claim = await prisma.billingCheckout.updateMany({
        where: { id: checkout.id, status: 'PENDING' },
        data: { status: 'PROCESSING' },
      });
      if (claim.count !== 1)
        throw new AppError(
          409,
          'BILLING_CHECKOUT_PROCESSING',
          'Payment verification is being completed; refresh shortly',
        );
      checkout = { ...checkout, status: 'PROCESSING' };
    }
    const transaction = await paystack.verify(reference);
    if (
      transaction.reference !== reference ||
      transaction.status !== 'success' ||
      transaction.currency !== 'USD' ||
      transaction.amount !== checkout.amountSubunit
    ) {
      await prisma.billingCheckout.update({
        where: { id: checkout.id },
        data: { status: 'FAILED' },
      });
      throw new AppError(
        402,
        'PAYMENT_NOT_VERIFIED',
        'The payment could not be verified for the expected USD amount',
      );
    }
    const startedAt = transaction.paid_at ? new Date(transaction.paid_at) : now();
    const current = await prisma.subscription.findUnique({ where: { workspaceId } });
    const effectiveAt =
      current?.currentPeriodEnd && current.currentPeriodEnd > startedAt
        ? current.currentPeriodEnd
        : nextPeriod(startedAt, asInterval(checkout.interval));
    const target: Target = {
      plan: asPlan(checkout.plan),
      interval: asInterval(checkout.interval),
      billableSeats: checkout.billableSeats,
    };
    const providerPlanCode = checkout.providerPlanCode ?? (await getPaystackPlan(target));
    let providerSubscription: PaystackSubscription | null = checkout.providerSubscriptionCode
      ? {
          subscription_code: checkout.providerSubscriptionCode,
          email_token: checkout.providerManageTokenCiphertext
            ? decryptProviderToken(
                checkout.providerManageTokenCiphertext,
                config.paystackEncryptionKey,
              )
            : '',
          next_payment_date: effectiveAt.toISOString(),
          status: 'active',
        }
      : null;
    if (
      !providerSubscription &&
      transaction.authorization?.reusable &&
      checkout.status === 'PROCESSING' &&
      checkout.providerAuthorizationReusable === true
    ) {
      throw new AppError(
        409,
        'BILLING_RECONCILIATION_REQUIRED',
        'Payment is verified but subscription setup needs support review',
      );
    }
    if (!providerSubscription && transaction.authorization?.reusable) {
      const createdSubscription = await paystack.createSubscription({
        customer: transaction.customer.customer_code,
        plan: providerPlanCode,
        authorization: transaction.authorization.authorization_code,
        start_date: effectiveAt.toISOString(),
      });
      providerSubscription = createdSubscription;
      await prisma.billingCheckout.update({
        where: { id: checkout.id },
        data: {
          providerSubscriptionCode: createdSubscription.subscription_code,
          providerManageTokenCiphertext: encryptProviderToken(
            createdSubscription.email_token,
            config.paystackEncryptionKey,
          ),
          providerAuthorizationReusable: true,
          providerCustomerCode: transaction.customer.customer_code,
          verifiedAt: startedAt,
        },
      });
    } else if (!checkout.verifiedAt) {
      await prisma.billingCheckout.update({
        where: { id: checkout.id },
        data: {
          providerAuthorizationReusable: false,
          providerCustomerCode: transaction.customer.customer_code,
          verifiedAt: startedAt,
        },
      });
    }

    if (current?.providerSubscriptionCode && current.providerManageTokenCiphertext) {
      await paystack.disableSubscription({
        code: current.providerSubscriptionCode,
        token: decryptProviderToken(
          current.providerManageTokenCiphertext,
          config.paystackEncryptionKey,
        ),
      });
    }

    const isInitial = !current;
    const status = providerSubscription ? 'ACTIVE' : 'NON_RENEWING';
    const encryptedManageToken = providerSubscription
      ? encryptProviderToken(providerSubscription.email_token, config.paystackEncryptionKey)
      : null;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.billingPayment.upsert({
        where: { providerReference: reference },
        create: {
          workspaceId,
          subscriptionId: current?.id,
          checkoutId: checkout.id,
          providerReference: reference,
          amountSubunit: checkout.amountSubunit,
          currency: 'USD',
          status: 'SUCCESS',
          paidAt: startedAt,
          periodStart: startedAt,
          periodEnd: effectiveAt,
        },
        update: {},
      });
      await tx.subscription.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          plan: target.plan,
          interval: target.interval,
          currency: 'USD',
          status,
          billableSeats: target.billableSeats,
          providerCustomerCode: transaction.customer.customer_code,
          providerSubscriptionCode: providerSubscription?.subscription_code ?? null,
          providerManageTokenCiphertext: encryptedManageToken,
          currentPeriodStart: startedAt,
          currentPeriodEnd: effectiveAt,
        },
        update: {
          plan: target.plan,
          interval: target.interval,
          status,
          billableSeats: target.billableSeats,
          providerCustomerCode: transaction.customer.customer_code,
          providerSubscriptionCode: providerSubscription?.subscription_code ?? null,
          providerManageTokenCiphertext: encryptedManageToken,
          currentPeriodStart: isInitial ? startedAt : current?.currentPeriodStart,
          currentPeriodEnd: effectiveAt,
          cancelAtPeriodEnd: !providerSubscription,
          cancelledAt: null,
          pendingSubscriptionCode: null,
          pendingPlan: null,
          pendingInterval: null,
          pendingBillableSeats: null,
          pendingEffectiveAt: null,
        },
      });
      await tx.billingCheckout.update({
        where: { id: checkout.id },
        data: {
          status: 'PAID',
          verifiedAt: now(),
          providerCustomerCode: transaction.customer.customer_code,
          providerPlanCode,
          providerSubscriptionCode: providerSubscription?.subscription_code ?? null,
          providerManageTokenCiphertext: providerSubscription
            ? encryptProviderToken(providerSubscription.email_token, config.paystackEncryptionKey)
            : null,
          providerAuthorizationReusable: Boolean(providerSubscription),
        },
      });
    });
    return subscriptionSummary(workspaceId);
  }

  return {
    listPlans() {
      return Object.entries(subscriptionCatalog).map(([id, price]) => ({
        id,
        currency: 'USD',
        includedSeats: price.includedMembers,
        monthly: {
          baseCents: price.monthlyBaseCents,
          additionalSeatCents: price.additionalMemberMonthlyCents,
        },
        annual: {
          baseCents: price.annualBaseCents,
          additionalSeatCents: price.additionalMemberAnnualCents,
        },
      }));
    },
    async getWorkspace({ actor, workspaceId }) {
      await requireWorkspace(actor, workspaceId, false);
      const summary = await subscriptionSummary(workspaceId);
      const subscription = await prisma.subscription.findUnique({ where: { workspaceId } });
      return { ...summary, nextRenewalAt: subscription?.currentPeriodEnd ?? null };
    },
    async createCheckout({ actor, workspaceId, plan, interval, billableSeats }) {
      assertUsdAvailable();
      const workspace = await requireWorkspace(actor, workspaceId, true);
      const seatCount = (await getWorkspaceBillableMemberIds(prisma, workspaceId)).length;
      const targetSeats = billableSeats ?? seatCount;
      if (
        !Number.isInteger(targetSeats) ||
        targetSeats < Math.max(1, seatCount) ||
        targetSeats > 10_000
      ) {
        throw new AppError(
          400,
          'INVALID_BILLABLE_SEATS',
          'The requested seats must cover all current active members',
        );
      }
      const target: Target = { plan, interval, billableSeats: targetSeats };
      const current = await prisma.subscription.findUnique({ where: { workspaceId } });
      let amountSubunit = getTargetCycleChargeCents(target);
      if (current?.status === 'ACTIVE' || current?.status === 'NON_RENEWING') {
        const priorAmount = getTargetCycleChargeCents({
          plan: asPlan(current.plan),
          interval: asInterval(current.interval),
          billableSeats: current.billableSeats,
        });
        if (!current.currentPeriodStart || !current.currentPeriodEnd)
          throw new AppError(
            409,
            'BILLING_PERIOD_UNAVAILABLE',
            'The current billing period is not available',
          );
        amountSubunit = prorateUpgradeAmountCents({
          oldAmountCents: priorAmount,
          newAmountCents: getTargetCycleChargeCents(target),
          startsAt: current.currentPeriodStart,
          endsAt: current.currentPeriodEnd,
          now: now(),
        });
        if (amountSubunit <= 0)
          throw new AppError(
            409,
            'SCHEDULE_CHANGE_REQUIRED',
            'Downgrades and seat reductions take effect at renewal',
          );
      }
      const existingPending = await prisma.billingCheckout.findFirst({
        where: {
          workspaceId,
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { gt: new Date(now().getTime() - 30 * 60_000) },
        },
      });
      if (existingPending)
        throw new AppError(
          409,
          'CHECKOUT_ALREADY_PENDING',
          'A checkout is already awaiting confirmation',
        );
      const reference = `nexus_${randomUUID().replaceAll('-', '')}`;
      const planCode = await getPaystackPlan(target);
      const checkout = await paystack.initialize({
        email: workspace.owner.email,
        amount: amountSubunit,
        reference,
        workspaceId,
      });
      await prisma.billingCheckout.create({
        data: {
          workspaceId,
          subscriptionId: current?.id ?? null,
          createdByUserId: actor.userId,
          reference,
          plan,
          interval,
          billableSeats: targetSeats,
          amountSubunit,
          currency: 'USD',
          checkoutUrl: checkout.authorization_url,
          providerPlanCode: planCode,
        },
      });
      return {
        authorizationUrl: checkout.authorization_url,
        reference,
        amountSubunit,
        currency: 'USD',
      };
    },
    async verifyCheckout({ actor, workspaceId, reference }) {
      await requireWorkspace(actor, workspaceId, true);
      return verifyAndFulfill(workspaceId, reference, actor.userId);
    },
    async scheduleChange({ actor, workspaceId, plan, interval, billableSeats }) {
      assertUsdAvailable();
      const workspace = await requireWorkspace(actor, workspaceId, true);
      const current = await prisma.subscription.findUnique({ where: { workspaceId } });
      if (
        !current ||
        !current.currentPeriodEnd ||
        !current.providerCustomerCode ||
        !current.providerSubscriptionCode ||
        !current.providerManageTokenCiphertext
      ) {
        throw new AppError(
          409,
          'ACTIVE_SUBSCRIPTION_REQUIRED',
          'An active recurring subscription is required to schedule a change',
        );
      }
      const currentSeats = (await getWorkspaceBillableMemberIds(prisma, workspaceId)).length;
      const targetSeats = billableSeats ?? currentSeats;
      if (
        !Number.isInteger(targetSeats) ||
        targetSeats < Math.max(1, currentSeats) ||
        targetSeats > 10_000
      ) {
        throw new AppError(
          400,
          'INVALID_BILLABLE_SEATS',
          'The scheduled seats must cover all current active members',
        );
      }
      const target: Target = { plan, interval, billableSeats: targetSeats };
      const targetTotal = getTargetCycleChargeCents(target);
      const currentTotal = getTargetCycleChargeCents({
        plan: asPlan(current.plan),
        interval: asInterval(current.interval),
        billableSeats: current.billableSeats,
      });
      if (targetTotal >= currentTotal)
        throw new AppError(
          409,
          'IMMEDIATE_PAYMENT_REQUIRED',
          'An upgrade or seat increase requires a verified checkout',
        );
      if (current.pendingSubscriptionCode) {
        if (
          current.pendingBillableSeats !== targetSeats ||
          current.pendingPlan !== plan ||
          current.pendingInterval !== interval
        )
          throw new AppError(
            409,
            'BILLING_CHANGE_ALREADY_SCHEDULED',
            'A different subscription change is already scheduled',
          );
        // The same change is already scheduled. Make sure the old recurring
        // subscription is disabled, in case an earlier attempt stopped part-way.
        await paystack.disableSubscription({
          code: current.providerSubscriptionCode,
          token: decryptProviderToken(
            current.providerManageTokenCiphertext,
            config.paystackEncryptionKey,
          ),
        });
        return {
          pendingChange: {
            plan: current.pendingPlan,
            interval: current.pendingInterval,
            billableSeats: targetSeats,
            effectiveAt: current.pendingEffectiveAt,
          },
          workspaceId: workspace.id,
        };
      }
      const planCode = await getPaystackPlan(target);
      const replacement = await paystack.createSubscription({
        customer: current.providerCustomerCode,
        plan: planCode,
        start_date: current.currentPeriodEnd.toISOString(),
      });
      const encryptedToken = encryptProviderToken(
        replacement.email_token,
        config.paystackEncryptionKey,
      );
      await prisma.subscription.update({
        where: { workspaceId },
        data: {
          status: 'ACTIVE',
          pendingSubscriptionCode: replacement.subscription_code,
          pendingManageTokenCiphertext: encryptedToken,
          pendingPlan: plan,
          pendingInterval: interval,
          pendingBillableSeats: targetSeats,
          pendingEffectiveAt: current.currentPeriodEnd,
        },
      });
      await paystack.disableSubscription({
        code: current.providerSubscriptionCode,
        token: decryptProviderToken(
          current.providerManageTokenCiphertext,
          config.paystackEncryptionKey,
        ),
      });
      return {
        pendingChange: {
          plan,
          interval,
          billableSeats: targetSeats,
          effectiveAt: current.currentPeriodEnd,
        },
        workspaceId: workspace.id,
      };
    },
    async synchronizeSeatReduction({ workspaceId, syncId }) {
      assertUsdAvailable();
      const [workspace, current, activeMemberIds, sync] = await Promise.all([
        prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { id: true, ownerId: true, owner: { select: { email: true } } },
        }),
        prisma.subscription.findUnique({ where: { workspaceId } }),
        getWorkspaceBillableMemberIds(prisma, workspaceId),
        prisma.billingSeatSync.findUnique({ where: { id: syncId } }),
      ]);
      if (!workspace || !current || !sync) return;
      if (
        !['ACTIVE', 'NON_RENEWING'].includes(current.status) ||
        current.cancelAtPeriodEnd ||
        !current.currentPeriodEnd ||
        !current.providerCustomerCode ||
        !current.providerSubscriptionCode ||
        !current.providerManageTokenCiphertext
      ) return;

      const targetSeats = activeMemberIds.length;
      const plan = current.pendingPlan ?? asPlan(current.plan);
      const interval = current.pendingInterval ?? asInterval(current.interval);
      const scheduledSeats = current.pendingBillableSeats ?? current.billableSeats;
      if (current.pendingSubscriptionCode && current.pendingBillableSeats === targetSeats) {
        if (sync.previousSubscriptionCode && sync.previousManageTokenCiphertext) {
          await paystack.disableSubscription({
            code: sync.previousSubscriptionCode,
            token: decryptProviderToken(
              sync.previousManageTokenCiphertext,
              config.paystackEncryptionKey,
            ),
          });
        }
        await paystack.disableSubscription({
          code: current.providerSubscriptionCode,
          token: decryptProviderToken(
            current.providerManageTokenCiphertext,
            config.paystackEncryptionKey,
          ),
        });
        return;
      }
      if (!current.pendingSubscriptionCode && targetSeats >= scheduledSeats) return;
      const target = { plan, interval, billableSeats: targetSeats };

      const planCode = await getPaystackPlan(target);
      let replacementCode = sync.providerSubscriptionCode;
      let replacementToken = sync.providerManageTokenCiphertext;
      if (!replacementCode || !replacementToken) {
        const replacement = await paystack.createSubscription({
          customer: current.providerCustomerCode,
          plan: planCode,
          start_date: current.currentPeriodEnd.toISOString(),
        });
        replacementCode = replacement.subscription_code;
        replacementToken = encryptProviderToken(replacement.email_token, config.paystackEncryptionKey);
        await prisma.billingSeatSync.update({
          where: { id: syncId },
          data: {
            providerSubscriptionCode: replacementCode,
            providerManageTokenCiphertext: replacementToken,
            previousSubscriptionCode: current.pendingSubscriptionCode ?? current.providerSubscriptionCode,
            previousManageTokenCiphertext: current.pendingManageTokenCiphertext ?? current.providerManageTokenCiphertext,
          },
        });
      }

      await prisma.subscription.update({
        where: { workspaceId },
        data: {
          pendingSubscriptionCode: replacementCode,
          pendingManageTokenCiphertext: replacementToken,
          pendingPlan: plan,
          pendingInterval: interval,
          pendingBillableSeats: targetSeats,
          pendingEffectiveAt: current.currentPeriodEnd,
        },
      });
      await paystack.disableSubscription({
        code: sync.previousSubscriptionCode ?? current.pendingSubscriptionCode ?? current.providerSubscriptionCode,
        token: decryptProviderToken(
          sync.previousManageTokenCiphertext ?? current.pendingManageTokenCiphertext ?? current.providerManageTokenCiphertext,
          config.paystackEncryptionKey,
        ),
      });
      if (
        current.pendingSubscriptionCode &&
        current.providerSubscriptionCode !== sync.previousSubscriptionCode
      ) {
        await paystack.disableSubscription({
          code: current.providerSubscriptionCode,
          token: decryptProviderToken(
            current.providerManageTokenCiphertext,
            config.paystackEncryptionKey,
          ),
        });
      }
    },
    async reconcileProviderState() {
      if (!config.paystackSecretKey || !config.paystackUsdEnabled || !config.paystackEncryptionKey) {
        return { checked: 0, repairedCheckouts: 0, mismatches: 0 };
      }
      let checked = 0;
      let repairedCheckouts = 0;
      let mismatches = 0;
      const pendingCheckouts = await prisma.billingCheckout.findMany({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });
      for (const checkout of pendingCheckouts) {
        const transaction = await paystack.verify(checkout.reference);
        checked += 1;
        if (
          transaction.reference === checkout.reference &&
          transaction.status === 'success' &&
          transaction.currency === 'USD' &&
          transaction.amount === checkout.amountSubunit
        ) {
          await verifyAndFulfill(checkout.workspaceId, checkout.reference);
          repairedCheckouts += 1;
        } else if (transaction.status === 'failed') {
          await prisma.billingCheckout.updateMany({
            where: { id: checkout.id, status: { in: ['PENDING', 'PROCESSING'] } },
            data: { status: 'FAILED' },
          });
        } else if (transaction.status === 'success') {
          mismatches += 1;
        }
      }

      const subscriptions = await prisma.subscription.findMany({
        where: {
          status: { in: ['ACTIVE', 'NON_RENEWING', 'ATTENTION'] },
          providerSubscriptionCode: { not: null },
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });
      for (const subscription of subscriptions) {
        const providerCurrent = await paystack.fetchSubscription(subscription.providerSubscriptionCode!);
        checked += 1;
        const expectedCurrent = getTargetCycleChargeCents({
          plan: asPlan(subscription.plan),
          interval: asInterval(subscription.interval),
          billableSeats: subscription.billableSeats,
        });
        const actualAmount = providerCurrent.plan?.amount ?? providerCurrent.amount;
        const currentMismatch = actualAmount !== expectedCurrent || providerCurrent.plan?.currency !== 'USD';
        let pendingMismatch = false;
        if (subscription.pendingSubscriptionCode) {
          const providerPending = await paystack.fetchSubscription(subscription.pendingSubscriptionCode);
          checked += 1;
          const expectedPending = getTargetCycleChargeCents({
            plan: subscription.pendingPlan ? asPlan(subscription.pendingPlan) : asPlan(subscription.plan),
            interval: subscription.pendingInterval ? asInterval(subscription.pendingInterval) : asInterval(subscription.interval),
            billableSeats: subscription.pendingBillableSeats ?? subscription.billableSeats,
          });
          pendingMismatch =
            (providerPending.plan?.amount ?? providerPending.amount) !== expectedPending ||
            providerPending.plan?.currency !== 'USD' ||
            providerPending.status !== 'active';
        }
        if (currentMismatch || pendingMismatch) {
          mismatches += 1;
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: 'ATTENTION' },
          });
          continue;
        }
        if (
          providerCurrent.status === 'active' &&
          (subscription.pendingSubscriptionCode || subscription.cancelAtPeriodEnd) &&
          subscription.providerManageTokenCiphertext
        ) {
          await paystack.disableSubscription({
            code: subscription.providerSubscriptionCode!,
            token: decryptProviderToken(
              subscription.providerManageTokenCiphertext,
              config.paystackEncryptionKey,
            ),
          });
        }
        if (
          subscription.status === 'ACTIVE' &&
          providerCurrent.status !== 'active' &&
          !subscription.pendingSubscriptionCode
        ) {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status:
                subscription.currentPeriodEnd && subscription.currentPeriodEnd <= now()
                  ? 'CANCELLED'
                  : 'NON_RENEWING',
              cancelAtPeriodEnd: Boolean(
                subscription.currentPeriodEnd && subscription.currentPeriodEnd > now(),
              ),
              cancelledAt: subscription.currentPeriodEnd ?? now(),
            },
          });
        } else if (subscription.status === 'ATTENTION') {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status:
                subscription.cancelAtPeriodEnd || providerCurrent.status !== 'active'
                  ? 'NON_RENEWING'
                  : 'ACTIVE',
            },
          });
        }
      }
      return { checked, repairedCheckouts, mismatches };
    },
    async cancel({ actor, workspaceId }) {
      assertUsdAvailable();
      await requireWorkspace(actor, workspaceId, true);
      const current = await prisma.subscription.findUnique({ where: { workspaceId } });
      if (!current || !current.currentPeriodEnd)
        throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'No paid subscription was found');
      if (current.cancelAtPeriodEnd)
        return { cancelAtPeriodEnd: true, effectiveAt: current.currentPeriodEnd };
      if (current.pendingSubscriptionCode && current.pendingManageTokenCiphertext) {
        await paystack.disableSubscription({
          code: current.pendingSubscriptionCode,
          token: decryptProviderToken(
            current.pendingManageTokenCiphertext,
            config.paystackEncryptionKey,
          ),
        });
      }
      if (current.providerSubscriptionCode && current.providerManageTokenCiphertext) {
        await paystack.disableSubscription({
          code: current.providerSubscriptionCode,
          token: decryptProviderToken(
            current.providerManageTokenCiphertext,
            config.paystackEncryptionKey,
          ),
        });
      }
      const updated = await prisma.subscription.update({
        where: { workspaceId },
        data: {
          status: 'NON_RENEWING',
          cancelAtPeriodEnd: true,
          cancelledAt: current.currentPeriodEnd,
          pendingSubscriptionCode: null,
          pendingManageTokenCiphertext: null,
          pendingPlan: null,
          pendingInterval: null,
          pendingBillableSeats: null,
          pendingEffectiveAt: null,
        },
      });
      return {
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        effectiveAt: updated.currentPeriodEnd,
      };
    },
    async listPayments({ actor, workspaceId }) {
      await requireWorkspace(actor, workspaceId, false);
      return prisma.billingPayment.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          providerReference: true,
          amountSubunit: true,
          currency: true,
          status: true,
          paidAt: true,
          periodStart: true,
          periodEnd: true,
          createdAt: true,
        },
      });
    },
    async processWebhook({
      event,
      eventKey,
      reference,
      subscriptionCode,
      amount,
      currency,
      paidAt,
    }) {
      const alreadyHandled = await prisma.billingWebhookEvent.findUnique({ where: { eventKey } });
      if (alreadyHandled) return;
      if (event === 'charge.success' && reference) {
        const checkout = await prisma.billingCheckout.findUnique({ where: { reference } });
        if (checkout && checkout.status !== 'PAID') {
          const transaction: PaystackTransaction = await paystack.verify(reference);
          if (
            transaction.status === 'success' &&
            transaction.amount === checkout.amountSubunit &&
            transaction.currency === 'USD'
          ) {
            await verifyAndFulfill(checkout.workspaceId, reference);
          }
        }
        if (!checkout && subscriptionCode) {
          const subscription = await prisma.subscription.findFirst({
            where: {
              OR: [
                { providerSubscriptionCode: subscriptionCode },
                { pendingSubscriptionCode: subscriptionCode },
              ],
            },
          });
          if (subscription && amount !== undefined && currency === 'USD') {
            const isPendingSubscription = subscription.pendingSubscriptionCode === subscriptionCode;
            const expectedAmount = getTargetCycleChargeCents({
              plan:
                isPendingSubscription && subscription.pendingPlan
                  ? subscription.pendingPlan
                  : asPlan(subscription.plan),
              interval:
                isPendingSubscription && subscription.pendingInterval
                  ? subscription.pendingInterval
                  : asInterval(subscription.interval),
              billableSeats:
                isPendingSubscription && subscription.pendingBillableSeats
                  ? subscription.pendingBillableSeats
                  : subscription.billableSeats,
            });
            if (amount !== expectedAmount) {
              throw new AppError(
                409,
                'PAYMENT_AMOUNT_MISMATCH',
                'The recurring payment does not match the expected subscription amount',
              );
            }
            const paid = paidAt ? new Date(paidAt) : now();
            const end = nextPeriod(
              paid,
              asInterval(
                subscription.pendingSubscriptionCode === subscriptionCode &&
                  subscription.pendingInterval
                  ? subscription.pendingInterval
                  : subscription.interval,
              ),
            );
            await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
              await tx.billingPayment.upsert({
                where: { providerReference: reference },
                create: {
                  workspaceId: subscription.workspaceId,
                  subscriptionId: subscription.id,
                  providerReference: reference,
                  providerEventKey: eventKey,
                  amountSubunit: amount,
                  currency: 'USD',
                  status: 'SUCCESS',
                  paidAt: paid,
                  periodStart: paid,
                  periodEnd: end,
                },
                update: {},
              });
              const stalePayment = Boolean(
                subscription.currentPeriodStart && paid <= subscription.currentPeriodStart,
              );
              const pendingNotEffective = Boolean(
                subscription.pendingSubscriptionCode === subscriptionCode &&
                  subscription.pendingEffectiveAt &&
                  paid < subscription.pendingEffectiveAt,
              );
              if (stalePayment || pendingNotEffective) return;
              if (
                subscription.pendingSubscriptionCode === subscriptionCode &&
                subscription.pendingPlan &&
                subscription.pendingInterval &&
                subscription.pendingBillableSeats
              ) {
                await tx.subscription.update({
                  where: { id: subscription.id },
                  data: {
                    providerSubscriptionCode: subscription.pendingSubscriptionCode,
                    providerManageTokenCiphertext: subscription.pendingManageTokenCiphertext,
                    pendingSubscriptionCode: null,
                    pendingManageTokenCiphertext: null,
                    plan: subscription.pendingPlan,
                    interval: subscription.pendingInterval,
                    billableSeats: subscription.pendingBillableSeats,
                    pendingPlan: null,
                    pendingInterval: null,
                    pendingBillableSeats: null,
                    pendingEffectiveAt: null,
                    status: 'ACTIVE',
                    cancelAtPeriodEnd: false,
                    currentPeriodStart: paid,
                    currentPeriodEnd: end,
                  },
                });
              } else {
                await tx.subscription.update({
                  where: { id: subscription.id },
                  data: { currentPeriodStart: paid, currentPeriodEnd: end, status: 'ACTIVE' },
                });
              }
            });
          }
        }
      }
      if (
        (event === 'subscription.disable' || event === 'subscription.not_renew') &&
        subscriptionCode
      ) {
        const subscription = await prisma.subscription.findFirst({
          where: {
            OR: [
              { providerSubscriptionCode: subscriptionCode },
              { pendingSubscriptionCode: subscriptionCode },
            ],
          },
        });
        if (subscription) {
          // Disabling the old recurring subscription is part of a scheduled
          // replacement. Its delayed webhook must not cancel the Nexus plan.
          if (
            subscription.providerSubscriptionCode === subscriptionCode &&
            subscription.pendingSubscriptionCode
          ) {
            await prisma.billingWebhookEvent
              .create({ data: { eventKey, eventType: event } })
              .catch(async (error: unknown) => {
                const exists = await prisma.billingWebhookEvent.findUnique({ where: { eventKey } });
                if (!exists) throw error;
              });
            return;
          }
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status:
                subscription.currentPeriodEnd && subscription.currentPeriodEnd > now()
                  ? 'NON_RENEWING'
                  : 'CANCELLED',
              cancelAtPeriodEnd: Boolean(
                subscription.currentPeriodEnd && subscription.currentPeriodEnd > now(),
              ),
              cancelledAt: subscription.currentPeriodEnd ?? now(),
              ...(subscription.pendingSubscriptionCode === subscriptionCode
                ? {
                    pendingSubscriptionCode: null,
                    pendingManageTokenCiphertext: null,
                    pendingPlan: null,
                    pendingInterval: null,
                    pendingBillableSeats: null,
                    pendingEffectiveAt: null,
                  }
                : {}),
            },
          });
        }
      }
      await prisma.billingWebhookEvent
        .create({ data: { eventKey, eventType: event } })
        .catch(async (error: unknown) => {
          const exists = await prisma.billingWebhookEvent.findUnique({ where: { eventKey } });
          if (!exists) throw error;
        });
      // Failed-payment policy is deferred: record status only; do not revoke access or retry.
      if (event === 'invoice.payment_failed' && reference) {
        await prisma.billingPayment.updateMany({
          where: { providerReference: reference, status: { not: 'SUCCESS' } },
          data: { status: 'FAILED' },
        });
      }
    },
  };
}