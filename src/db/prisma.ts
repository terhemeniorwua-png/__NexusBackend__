import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env';
import { withTimeout } from '../utils/timeout';

let prismaClient: PrismaClient | null = null;
let configuredUrl: string | null = null;

export function getPrismaClient(databaseUrl?: string): PrismaClient {
  const url = databaseUrl ?? configuredUrl;

  if (!prismaClient || (url && url !== configuredUrl)) {
    if (prismaClient) {
      void prismaClient.$disconnect();
    }

    configuredUrl = url ?? null;
    prismaClient = new PrismaClient(
      url
        ? {
            datasources: {
              db: { url },
            },
          }
        : undefined,
    );
  }

  return prismaClient;
}

export async function connectDatabase(config: Pick<AppConfig, 'databaseUrl'>): Promise<void> {
  const client = getPrismaClient(config.databaseUrl);
  await client.$connect();
}

export async function checkDatabase(timeoutMs: number): Promise<void> {
  const client = getPrismaClient();
  await withTimeout(client.$queryRaw`SELECT 1`, timeoutMs, 'Database health check timed out');
}

export async function disconnectDatabase(): Promise<void> {
  const client = prismaClient;
  prismaClient = null;
  configuredUrl = null;

  if (client) {
    await client.$disconnect();
  }
}
