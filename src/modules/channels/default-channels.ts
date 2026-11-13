import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

export const DEFAULT_CHANNELS = [
  {
    systemKey: 'ANNOUNCEMENTS',
    name: 'announcements',
    description: 'Workspace announcements. Everyone can read; only managers can post.',
    postPolicy: 'MANAGERS_ONLY',
  },
  {
    systemKey: 'GENERAL',
    name: 'general',
    description: 'General chat for everyone in the workspace.',
    postPolicy: 'ALL_MEMBERS',
  },
] as const;

/**
 * Idempotent. Creates the default channels, or adopts an existing channel of
 * the same name so the per-workspace name uniqueness index is never violated.
 */
export async function ensureDefaultChannels(db: Db, workspaceId: string, createdById: string): Promise<void> {
  for (const def of DEFAULT_CHANNELS) {
    const byKey = await db.channel.findUnique({
      where: { workspaceId_systemKey: { workspaceId, systemKey: def.systemKey } },
      select: { id: true },
    });
    if (byKey) continue;

    const sameName = await db.channel.findFirst({
      where: { workspaceId, name: { equals: def.name, mode: 'insensitive' } },
      select: { id: true, type: true, deletedAt: true },
    });
    if (sameName) {
      if (sameName.type === 'WORKSPACE' && !sameName.deletedAt) {
        await db.channel.update({
          where: { id: sameName.id },
          data: { systemKey: def.systemKey, isDefault: true, postPolicy: def.postPolicy },
        });
      }
      if (sameName.type !== 'WORKSPACE' || sameName.deletedAt) {
        console.warn(`default channel "${def.name}" skipped for workspace ${workspaceId}: name held by a ${sameName.deletedAt ? 'deleted' : sameName.type} channel`);
      }
      continue; // an existing channel owns the name; never collide with it
    }

    await db.channel.create({
      data: {
        workspaceId,
        type: 'WORKSPACE',
        name: def.name,
        description: def.description,
        createdById,
        isDefault: true,
        systemKey: def.systemKey,
        postPolicy: def.postPolicy,
      },
    });
  }
}
