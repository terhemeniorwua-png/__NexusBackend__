import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { loadEnv, type AppConfig } from './config/env';
import { connectDatabase, disconnectDatabase } from './db/prisma';
import { connectRedis, disconnectRedis } from './db/redis';
import { logger as baseLogger, type Logger } from './utils/logger';

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

  try {
    await listen(server, config.port);
  } catch (error) {
    logger.error('server_listen_failed', { error, port: config.port });
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

    const closeServer = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });

      server.closeIdleConnections();
    });

    const results = await Promise.allSettled([
      closeServer,
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
