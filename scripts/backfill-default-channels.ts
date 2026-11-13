import { getPrismaClient } from '../src/db/prisma';
import { ensureDefaultChannels } from '../src/modules/channels/default-channels';

async function main() {
  const prisma = getPrismaClient();
  const workspaces = await prisma.workspace.findMany({ select: { id: true, ownerId: true, type: true } });
  let ok = 0, skipped = 0, failed = 0;
  for (const w of workspaces) {
    if (String(w.type) === 'PERSONAL') { skipped++; continue; }
    try {
      await prisma.$transaction((tx) => ensureDefaultChannels(tx, w.id, w.ownerId), { timeout: 30000, maxWait: 10000 });
      ok++;
    } catch (e) {
      failed++;
      console.error('failed for workspace', w.id, e instanceof Error ? e.message : e);
    }
  }
  console.log({ total: workspaces.length, ok, skipped, failed });
  await prisma.$disconnect();
}
main();
