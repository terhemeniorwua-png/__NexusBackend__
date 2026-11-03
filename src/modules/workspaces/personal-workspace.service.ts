import type { Prisma, PrismaClient } from '@prisma/client';

type WorkspaceTransaction = Prisma.TransactionClient | PrismaClient;

/**
 * Ensures each activated account has exactly one private personal workspace.
 * Existing individual workspaces are adopted instead of duplicating them.
 */
export async function ensurePersonalWorkspace(
  tx: WorkspaceTransaction,
  user: { id: string; name: string },
): Promise<{ id: string }> {
  const existing = await tx.workspace.findFirst({
    where: { ownerId: user.id, isPersonal: true, deletedAt: null },
    select: { id: true },
  });

  if (existing) {
    await ensureOwnerMembership(tx, existing.id, user.id);
    return existing;
  }

  const existingIndividual = await tx.workspace.findFirst({
    where: { ownerId: user.id, type: 'INDIVIDUAL', deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  if (existingIndividual) {
    await tx.workspace.update({
      where: { id: existingIndividual.id },
      data: { isPersonal: true, visibility: 'PRIVATE' },
    });

    await ensureOwnerMembership(tx, existingIndividual.id, user.id);

    return existingIndividual;
  }

  const workspace = await tx.workspace.create({
    data: {
      name: `${user.name}'s Personal Workspace`,
      slug: `personal-${user.id}`,
      type: 'INDIVIDUAL',
      isPersonal: true,
      visibility: 'PRIVATE',
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'OWNER' } },
    },
    select: { id: true },
  });

  return workspace;
}

async function ensureOwnerMembership(
  tx: WorkspaceTransaction,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await tx.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role: 'OWNER', status: 'ACTIVE' },
    update: { role: 'OWNER', status: 'ACTIVE' },
  });
}
