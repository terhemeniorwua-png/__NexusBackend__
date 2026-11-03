import { subscriptionCatalog, type BaseBillingInterval, type PaidPlanId } from './pricing';

export interface BillingPeriod {
  startsAt: Date;
  endsAt: Date;
}

export interface ProratedCharge {
  amountCents: number;
  remainingFraction: number;
}

function remainingFraction(period: BillingPeriod, at: Date): number {
  const start = period.startsAt.getTime();
  const end = period.endsAt.getTime();
  const now = at.getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start) {
    throw new RangeError('The billing period must contain valid increasing dates');
  }

  return Math.max(0, Math.min(1, (end - now) / (end - start)));
}

export function prorateCents(amountCents: number, period: BillingPeriod, at: Date): ProratedCharge {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError('The amount must be a non-negative integer number of cents');
  }

  const fraction = remainingFraction(period, at);
  return { amountCents: Math.round(amountCents * fraction), remainingFraction: fraction };
}

/** Prepares an upgrade charge; the plan must remain unchanged until verified payment. */
export function prepareImmediateUpgrade(input: {
  currentPlan: PaidPlanId;
  targetPlan: PaidPlanId;
  interval: BaseBillingInterval;
  period: BillingPeriod;
  now: Date;
}): ProratedCharge & { effectiveWhen: 'verified-payment'; planToActivate: PaidPlanId } {
  const oldPrice =
    subscriptionCatalog[input.currentPlan][
      input.interval === 'MONTHLY' ? 'monthlyBaseCents' : 'annualBaseCents'
    ];
  const newPrice =
    subscriptionCatalog[input.targetPlan][
      input.interval === 'MONTHLY' ? 'monthlyBaseCents' : 'annualBaseCents'
    ];
  if (newPrice <= oldPrice)
    throw new RangeError('An immediate upgrade must increase the base price');

  return {
    ...prorateCents(newPrice - oldPrice, input.period, input.now),
    effectiveWhen: 'verified-payment',
    planToActivate: input.targetPlan,
  };
}

export function scheduleDowngrade(input: {
  targetPlan: PaidPlanId;
  periodEndsAt: Date;
  activeMemberCount: number;
}): {
  effectiveAt: Date;
  targetPlan: PaidPlanId;
  currentPlanRemainsActiveUntil: Date;
  seatLimitConflictCount: number;
  membersRemoved: false;
} {
  if (!Number.isInteger(input.activeMemberCount) || input.activeMemberCount < 0) {
    throw new RangeError('The active member count must be a non-negative integer');
  }
  const effectiveAt = new Date(input.periodEndsAt.getTime());
  return {
    effectiveAt,
    targetPlan: input.targetPlan,
    currentPlanRemainsActiveUntil: new Date(effectiveAt.getTime()),
    seatLimitConflictCount: Math.max(
      0,
      input.activeMemberCount - subscriptionCatalog[input.targetPlan].includedMembers,
    ),
    membersRemoved: false,
  };
}

/** Extra-seat charges always use a monthly period, regardless of base cadence. */
export function prepareAdditionalSeatIncrease(input: {
  plan: PaidPlanId;
  addedSeatCount: number;
  monthlySeatPeriod: BillingPeriod;
  now: Date;
}): ProratedCharge & {
  billingInterval: 'MONTHLY';
  effectiveWhen: 'verified-payment';
  addedSeatCount: number;
} {
  if (!Number.isInteger(input.addedSeatCount) || input.addedSeatCount <= 0) {
    throw new RangeError('The added seat count must be a positive integer');
  }

  const monthlyRate = subscriptionCatalog[input.plan].additionalMemberMonthlyCents;
  const charge = prorateCents(
    monthlyRate * input.addedSeatCount,
    input.monthlySeatPeriod,
    input.now,
  );
  return {
    ...charge,
    billingInterval: 'MONTHLY',
    effectiveWhen: 'verified-payment',
    addedSeatCount: input.addedSeatCount,
  };
}

export function scheduleAdditionalSeatReduction(input: {
  renewalAt: Date;
  reducedSeatCount: number;
}): {
  effectiveAt: Date;
  reducedSeatCount: number;
  automaticCreditCents: 0;
} {
  if (!Number.isInteger(input.reducedSeatCount) || input.reducedSeatCount <= 0) {
    throw new RangeError('The reduced seat count must be a positive integer');
  }
  return {
    effectiveAt: new Date(input.renewalAt.getTime()),
    reducedSeatCount: input.reducedSeatCount,
    automaticCreditCents: 0,
  };
}

export function scheduleCancellation(input: {
  periodEndsAt: Date;
  alreadyEffectiveAt: Date | null;
}): { effectiveAt: Date; benefitsRetainedUntil: Date; duplicateRequest: boolean } {
  const effectiveAt = input.alreadyEffectiveAt ?? input.periodEndsAt;
  return {
    effectiveAt: new Date(effectiveAt.getTime()),
    benefitsRetainedUntil: new Date(effectiveAt.getTime()),
    duplicateRequest: input.alreadyEffectiveAt !== null,
  };
}

export function assertBillingOwner(actorId: string, workspaceOwnerId: string): void {
  if (actorId !== workspaceOwnerId) {
    const error = new Error('Only the workspace owner may change the subscription');
    error.name = 'BillingAuthorizationError';
    throw error;
  }
}

export const refundPolicy = {
  automaticRefunds: false,
  handling: 'manual-request-under-approved-policy-and-applicable-law',
} as const;

export const failedPaymentPolicy = {
  retrySchedule: 'deferred',
  gracePeriod: 'deferred',
  accessRestrictionTimeline: 'deferred',
  notificationSchedule: 'deferred',
  additionalSeatTreatment: 'deferred',
  neverGrantPaidAccessWithoutVerifiedPayment: true,
  neverDeleteCustomerDataForPaymentFailure: true,
} as const;
