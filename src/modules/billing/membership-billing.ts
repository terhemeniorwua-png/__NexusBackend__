import type { Prisma, PrismaClient, UserStatus } from '@prisma/client';
import {
  getBasePriceCents,
  subscriptionCatalog,
  type BaseBillingInterval,
  type PaidPlanId,
} from './pricing';
import { AppError } from '../../utils/errors';

export type BillingMembershipStatus =
  'ACTIVE' | 'PENDING' | 'PENDING_INVITATION' | 'SUSPENDED' | 'REMOVED' | 'DEACTIVATED';

export interface MembershipBillingRecord {
  workspaceId: string;
  userId: string;
  membershipStatus: BillingMembershipStatus;
  userStatus: UserStatus | 'ACTIVE' | 'DEACTIVATED';
}

/** Pure policy helper used by the database-backed count and its tests. */
export function getBillableMemberIds(input: {
  workspaceId: string;
  ownerId: string;
  ownerStatus: UserStatus | 'ACTIVE' | 'DEACTIVATED';
  memberships: readonly MembershipBillingRecord[];
}): string[] {
  const memberIds = new Set<string>();

  if (input.ownerStatus === 'ACTIVE') memberIds.add(input.ownerId);

  for (const membership of input.memberships) {
    if (
      membership.workspaceId === input.workspaceId &&
      membership.membershipStatus === 'ACTIVE' &&
      membership.userStatus === 'ACTIVE'
    ) {
      memberIds.add(membership.userId);
    }
  }

  return [...memberIds];
}

/**
 * Reads authoritative state for one workspace. The workspace owner is counted
 * once when their account is active, even if a membership row is also present.
 */
export async function getWorkspaceBillableMemberIds(
  prisma: Pick<PrismaClient, 'workspace'>,
  workspaceId: string,
): Promise<string[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      ownerId: true,
      owner: { select: { status: true } },
      members: {
        where: { status: 'ACTIVE', user: { status: 'ACTIVE' } },
        select: { userId: true },
      },
    },
  });

  if (!workspace) return [];

  return getBillableMemberIds({
    workspaceId,
    ownerId: workspace.ownerId,
    ownerStatus: workspace.owner.status,
    memberships: workspace.members.map((member) => ({
      workspaceId,
      userId: member.userId,
      membershipStatus: 'ACTIVE',
      userStatus: 'ACTIVE',
    })),
  });
}

/** Prevents activation from exceeding seats already paid for in this workspace. */
export async function assertWorkspaceSeatCapacity(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string },
): Promise<void> {
  const [subscription, memberIds] = await Promise.all([
    tx.subscription.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { status: true, billableSeats: true },
    }),
    getWorkspaceBillableMemberIds(tx, input.workspaceId),
  ]);
  if (!subscription || !['ACTIVE', 'NON_RENEWING'].includes(subscription.status)) return;
  const nextSeatCount = new Set([...memberIds, input.userId]).size;
  if (nextSeatCount > subscription.billableSeats) {
    throw new AppError(
      409,
      'PAID_SEAT_REQUIRED',
      'Purchase an additional seat before activating this workspace member',
    );
  }
}

/**
 * Queues a post-commit provider sync when active seats fall below the current
 * recurring quantity. The unique workspace row coalesces rapid member changes.
 */
export async function enqueueWorkspaceSeatReduction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  const subscription = await tx.subscription.findUnique({
    where: { workspaceId },
    select: {
      status: true,
      billableSeats: true,
      pendingBillableSeats: true,
      pendingSubscriptionCode: true,
      cancelAtPeriodEnd: true,
    },
  });
  if (
    !subscription ||
    !['ACTIVE', 'NON_RENEWING'].includes(subscription.status) ||
    subscription.cancelAtPeriodEnd
  ) {
    return;
  }

  const activeSeats = (await getWorkspaceBillableMemberIds(tx, workspaceId)).length;
  const committedSeats = subscription.pendingBillableSeats ?? subscription.billableSeats;
  const existingSync = await tx.billingSeatSync.findUnique({
    where: { workspaceId },
    select: { id: true },
  });
  if (
    activeSeats >= committedSeats &&
    !existingSync &&
    !subscription.pendingSubscriptionCode
  ) return;

  await tx.billingSeatSync.upsert({
    where: { workspaceId },
    create: { workspaceId, requestedSeats: activeSeats },
    update: {
      requestedSeats: activeSeats,
      generation: { increment: 1 },
      status: 'PENDING',
      nextAttemptAt: new Date(),
      lastError: null,
      providerSubscriptionCode: null,
      providerManageTokenCiphertext: null,
      previousSubscriptionCode: null,
      previousManageTokenCiphertext: null,
    },
  });
}

export async function getWorkspaceSeatBillingSummary(
  prisma: PrismaClient,
  input: { workspaceId: string; plan: PaidPlanId; interval?: BaseBillingInterval },
): Promise<{
  activeMemberCount: number;
  includedMemberCount: number;
  additionalMemberCount: number;
  additionalMemberMonthlyChargeCents: number;
  additionalMemberChargeCents: number;
  additionalMemberBillingInterval: BaseBillingInterval;
  totalSubscriptionChargeCents: number;
}> {
  const activeMemberCount = (await getWorkspaceBillableMemberIds(prisma, input.workspaceId)).length;
  const plan = subscriptionCatalog[input.plan];
  const interval = input.interval ?? 'MONTHLY';
  const additionalMemberCount = Math.max(0, activeMemberCount - plan.includedMembers);
  const additionalSeatUnitCents =
    interval === 'MONTHLY' ? plan.additionalMemberMonthlyCents : plan.additionalMemberAnnualCents;

  return {
    activeMemberCount,
    includedMemberCount: plan.includedMembers,
    additionalMemberCount,
    additionalMemberMonthlyChargeCents: additionalMemberCount * plan.additionalMemberMonthlyCents,
    additionalMemberChargeCents: additionalMemberCount * additionalSeatUnitCents,
    additionalMemberBillingInterval: interval,
    totalSubscriptionChargeCents:
      getBasePriceCents(input.plan, interval) + additionalMemberCount * additionalSeatUnitCents,
  };
}

export function getRecurringSubscriptionChargeCents(input: {
  plan: PaidPlanId;
  interval: BaseBillingInterval;
  billableSeats: number;
}): number {
  const catalog = subscriptionCatalog[input.plan];
  const extraSeats = Math.max(0, input.billableSeats - catalog.includedMembers);
  const extraSeatPrice =
    input.interval === 'MONTHLY'
      ? catalog.additionalMemberMonthlyCents
      : catalog.additionalMemberAnnualCents;
  return getBasePriceCents(input.plan, input.interval) + extraSeats * extraSeatPrice;
}
