import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { loadEnv, type AppConfig } from './config/env';
import { connectDatabase, disconnectDatabase, getPrismaClient } from './db/prisma';
import { connectRedis, disconnectRedis } from './db/redis';
import {
  createEmailWorker,
  getEmailDeliveryService,
  installOutboxEmailSender,
} from './services/email';
import { logger as baseLogger, type Logger } from './utils/logger';
import { createAccountDeletionWorker } from './modules/auth/account-deletion.service';
import { createBillingService } from './modules/billing/billing.service';
import { createBillingSeatSyncWorker } from './modules/billing/seat-sync.worker';
import { createS3CompatibleObjectStorage } from './services/storage/private-object-storage';
import { createSocketServer, type SocketServer } from './realtime/socket-server';

export interface RunningServer {
  server: Server;
  config: AppConfig;
  logger: Logger;
  shutdown: (signal: string) => Promise<void>;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

export async function startServer(): Promise<RunningServer> {
  const config = loadEnv();
  const logger = baseLogger.child({ environment: config.nodeEnv });
  logger.setLevel(config.logLevel);

  logger.info('server_starting', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    version: config.appVersion,
  });

  try {
    await connectDatabase(config);
    logger.info('database_connected');
  } catch (error) {
    logger.error('database_connection_failed', { error });
    throw error;
  }

  try {
    await connectRedis(config);
    logger.info('redis_connected');
  } catch (error) {
    logger.warn('redis_unavailable', { error });
  }

  const app = createApp({ config, logger });
  const server = createServer(app);

  // Realtime (Socket.IO) shares the HTTP server. A failure here must not stop
  // the REST API from serving requests.
  let socketServer: SocketServer | null = null;
  try {
    socketServer = await createSocketServer(server, config);
    logger.info('socket_server_started');
  } catch (error) {
    logger.error('socket_server_failed', { error });
  }

  // Every transactional email is written to the outbox before the provider is
  // contacted, and the worker delivers the queued messages.
  installOutboxEmailSender(config);

  const emailWorker = createEmailWorker({
    service: getEmailDeliveryService(config),
    config,
    logger,
  });

  if (config.emailWorkerEnabled) {
    emailWorker.start();
  }

  const accountDeletionWorker = createAccountDeletionWorker({
    prisma: getPrismaClient(),
    logger,
    bcryptSaltRounds: config.bcryptSaltRounds,
    storage: createS3CompatibleObjectStorage({
      endpoint: config.objectStorageEndpoint,
      bucket: config.objectStorageBucket,
      region: config.objectStorageRegion,
      accessKeyId: config.objectStorageAccessKeyId,
      secretAccessKey: config.objectStorageSecretAccessKey,
      requestTimeoutMs: config.objectStorageRequestTimeoutMs,
    }),
  });
  accountDeletionWorker.start();

  const billingSeatSyncWorker = createBillingSeatSyncWorker({
    prisma: getPrismaClient(),
    service: createBillingService(config, { prisma: getPrismaClient() }),
    logger,
  });
  billingSeatSyncWorker.start();

  try {
    await listen(server, config.port);
  } catch (error) {
    logger.error('server_listen_failed', { error, port: config.port });
    await Promise.all([
      emailWorker.stop(),
      accountDeletionWorker.stop(),
      billingSeatSyncWorker.stop(),
    ]);
    await Promise.allSettled([disconnectRedis(), disconnectDatabase()]);
    throw error;
  }

  logger.info('server_listening', { port: config.port });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    const timeout = setTimeout(() => {
      logger.error('shutdown_timed_out', { timeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs);

    timeout.unref();

    await socketServer?.close().catch(() => undefined);

    const closeServer = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }

        resolve();
      });

      server.closeIdleConnections();
    });

    const results = await Promise.allSettled([
      closeServer,
      emailWorker.stop(),
      accountDeletionWorker.stop(),
      billingSeatSyncWorker.stop(),
      disconnectRedis(),
      disconnectDatabase(),
    ]);

    clearTimeout(timeout);

    const failures = results.filter((result) => result.status === 'rejected');

    if (failures.length > 0) {
      logger.error('shutdown_incomplete', { failures });
      process.exitCode = 1;
      return;
    }

    logger.info('shutdown_complete');
  };

  return { server, config, logger, shutdown };
}

export function registerProcessHandlers(running: RunningServer): void {
  const handleSignal = (signal: NodeJS.Signals) => {
    void running.shutdown(signal);
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  process.on('unhandledRejection', (reason) => {
    running.logger.error('unhandled_rejection', { error: reason });
    void running.shutdown('unhandledRejection').finally(() => process.exit(1));
  });

  process.on('uncaughtException', (error) => {
    running.logger.error('uncaught_exception', { error });
    void running.shutdown('uncaughtException').finally(() => process.exit(1));
  });
}

if (require.main === module) {
  startServer()
    .then(registerProcessHandlers)
    .catch((error) => {
      baseLogger.error('server_start_failed', { error });
      process.exit(1);
    });
}
