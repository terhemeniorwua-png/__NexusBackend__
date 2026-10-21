import { type PrismaClient } from '@prisma/client';

/**
 * Address suppression.
 *
 * A hard bounce or a spam complaint adds the address to the suppression
 * list. The delivery worker skips suppressed addresses, which protects the
 * sending reputation of the domain and avoids sending to an address that has
 * explicitly complained.
 */

export type SuppressionReason = 'HARD_BOUNCE' | 'COMPLAINT' | 'MANUAL';

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export async function isAddressSuppressed(prisma: PrismaClient, address: string): Promise<boolean> {
  const record = await prisma.emailSuppression.findUnique({
    where: { emailAddress: normalizeAddress(address) },
    select: { id: true },
  });

  return record !== null;
}

/**
 * Adds an address to the suppression list.
 *
 * A complaint always wins over a bounce, because a complaint is a stronger
 * signal that the address must never be contacted again.
 */
export async function suppressAddress(
  prisma: PrismaClient,
  input: {
    emailAddress: string;
    reason: SuppressionReason;
    provider?: string | undefined;
    detail?: string | undefined;
  },
): Promise<void> {
  const emailAddress = normalizeAddress(input.emailAddress);

  const existing = await prisma.emailSuppression.findUnique({
    where: { emailAddress },
    select: { id: true, reason: true },
  });

  if (existing) {
    const keepExisting =
      existing.reason === 'COMPLAINT' ||
      (existing.reason === 'HARD_BOUNCE' && input.reason !== 'COMPLAINT');

    if (keepExisting) {
      return;
    }
  }

  await prisma.emailSuppression.upsert({
    where: { emailAddress },
    create: {
      emailAddress,
      reason: input.reason,
      provider: input.provider ?? null,
      detail: input.detail ?? null,
    },
    update: {
      reason: input.reason,
      provider: input.provider ?? null,
      detail: input.detail ?? null,
    },
  });
}

/**
 * Removes an address from the suppression list.
 */
export async function releaseAddress(prisma: PrismaClient, address: string): Promise<void> {
  await prisma.emailSuppression.deleteMany({
    where: { emailAddress: normalizeAddress(address) },
  });
}
