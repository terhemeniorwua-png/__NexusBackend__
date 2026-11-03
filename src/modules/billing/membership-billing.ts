import type { PrismaClient, UserStatus } from '@prisma/client';
import { subscriptionCatalog, type PaidPlanId } from './pricing';

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
  prisma: PrismaClient,
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

export async function getWorkspaceSeatBillingSummary(
  prisma: PrismaClient,
  input: { workspaceId: string; plan: PaidPlanId },
): Promise<{
  activeMemberCount: number;
  includedMemberCount: number;
  additionalMemberCount: number;
  additionalMemberMonthlyChargeCents: number;
}> {
  const activeMemberCount = (await getWorkspaceBillableMemberIds(prisma, input.workspaceId)).length;
  const plan = subscriptionCatalog[input.plan];
  const additionalMemberCount = Math.max(0, activeMemberCount - plan.includedMembers);

  return {
    activeMemberCount,
    includedMemberCount: plan.includedMembers,
    additionalMemberCount,
    additionalMemberMonthlyChargeCents: additionalMemberCount * plan.additionalMemberMonthlyCents,
  };
}
