export type PaidPlanId = 'PRO' | 'BUSINESS';
export type BaseBillingInterval = 'MONTHLY' | 'ANNUAL';

export interface PlanPrice {
  readonly monthlyBaseCents: number;
  readonly annualBaseCents: number;
  readonly includedMembers: number;
  readonly additionalMemberMonthlyCents: number;
  readonly additionalMemberAnnualCents: number;
}

/** Server-owned catalog. A client must never submit these prices as authority. */
export const subscriptionCatalog: Readonly<Record<PaidPlanId, PlanPrice>> = {
  PRO: {
    monthlyBaseCents: 1_000,
    annualBaseCents: 5_000,
    includedMembers: 15,
    additionalMemberMonthlyCents: 50,
    additionalMemberAnnualCents: 50,
  },
  BUSINESS: {
    monthlyBaseCents: 1_500,
    annualBaseCents: 7_000,
    includedMembers: 25,
    additionalMemberMonthlyCents: 100,
    additionalMemberAnnualCents: 100,
  },
};

export function getBasePriceCents(plan: PaidPlanId, interval: BaseBillingInterval): number {
  const price = subscriptionCatalog[plan];
  return interval === 'MONTHLY' ? price.monthlyBaseCents : price.annualBaseCents;
}
