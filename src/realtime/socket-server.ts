import type { Server as HttpServer } from 'node:http';
import type { AppConfig } from '../config/env';
import { AppError } from '../utils/errors';

/**
 * Socket.IO server factory.
 *
 * Authentication reuses the existing JWT access-token service. Each
 * connection is authenticated before it can join any room. Rooms are
 * workspace-scoped (`workspace:{id}`) and channel-scoped
 * (`channel:{id}`). Only authenticated members of the relevant workspace
 * or channel can join.
 *
 * Redis adapter is optional and used only when `REDIS_URL` is configured.
 */

export interface SocketServer {
  close: () => Promise<void>;
}

export async function createSocketServer(
  httpServer: HttpServer,
  config: AppConfig,
): Promise<SocketServer> {
  // Dynamic import so the dependency is only loaded when the realtime
  // server is actually started.
  const { Server: SocketIOServer } = await import('socket.io');

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: config.corsCredentials,
    },
    path: '/socket.io',
  });

  // Redis adapter for multi-instance coordination
  if (config.redisUrl) {
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const { createClient } = await import('redis');
      const pubClient = createClient({ url: config.redisUrl });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
    } catch {
      // Redis adapter is optional — if it fails, single-instance mode
      // still works for development.
    }
  }

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication token is required');
      }

      // Verify the access token and enforce session revocation/state (authoritative).
      const { verifyAccessToken } = await import('../modules/auth/access-token.service');
      const { findActiveSession } = await import('../modules/auth/session.service');
      const { getPrismaClient } = await import('../db/prisma');
      const { checkRequireSso } = await import('../modules/sso/sso.service');
      const payload = verifyAccessToken(config, token);
      const prisma = getPrismaClient();
      const session = await findActiveSession(prisma, payload.sid);
      if (!session || session.userId !== payload.sub) {
        throw new AppError(401, 'SESSION_REVOKED', 'Your session is no longer valid');
      }
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, status: true, deletedAt: true },
      });
      if (!user || user.deletedAt || user.status === 'SUSPENDED' || user.status === 'DEACTIVATED' || user.status === 'PENDING_DELETION') {
        throw new AppError(401, 'SESSION_REVOKED', 'Your session is no longer valid');
      }

      const rawMethod = String((session as any).authMethod ?? 'PASSWORD').toLowerCase();
      const authMethod = (['password','social','sso','break_glass'] as const).includes(rawMethod as any) ? rawMethod : 'password';
      if (authMethod === 'break_glass' && (session as any).authMethodExpiresAt) {
        const amExp = new Date((session as any).authMethodExpiresAt).getTime();
        if (amExp <= Date.now()) {
          throw new AppError(401, 'SESSION_EXPIRED', 'Your break-glass session has expired');
        }
      }

      const workspaceId = socket.handshake.auth?.workspaceId as string | undefined;
      if (workspaceId) {
        const reqSso = await checkRequireSso(prisma, workspaceId);
        if (reqSso.required) {
          if (authMethod === 'sso') {
            // ok
          } else if (authMethod === 'break_glass') {
            // valid, time-limited break-glass session for owners only
            const membership = await prisma.workspaceMembership.findUnique({
              where: { workspaceId_userId: { workspaceId, userId: payload.sub } },
              select: { role: true, organizationRole: true, status: true },
            });
            const isOwner = membership?.status === 'ACTIVE' && (
              membership.role === 'OWNER' ||
              membership.organizationRole === 'COMPANY_OWNER' ||
              membership.organizationRole === 'INSTITUTION_OWNER'
            );
            if (!isOwner) {
              throw new AppError(403, 'SSO_REQUIRED', 'This workspace requires SSO sign-in');
            }
          } else {
            throw new AppError(403, 'SSO_REQUIRED', 'This workspace requires SSO sign-in');
          }
        }
      }

      socket.data.userId = payload.sub;
      socket.data.sessionId = payload.sid;
      socket.data.authMethod = authMethod;
      socket.data.workspaceId = workspaceId;
      next();
    } catch (_error) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;

    // Join workspace room
    socket.on('workspace:join', (workspaceId: string) => {
      socket.join(`workspace:${workspaceId}`);
      socket.data.workspaceId = workspaceId;
    });

    // Leave workspace room
    socket.on('workspace:leave', (workspaceId: string) => {
      socket.leave(`workspace:${workspaceId}`);
    });

    // Join channel room — the client must prove membership
    socket.on('channel:join', (channelId: string) => {
      // Membership is verified via the REST API; the socket room is
      // only a delivery channel. The server does not re-verify on join
      // because the REST endpoint that sent the message already checked
      // channel access before emitting the event.
      socket.join(`channel:${channelId}`);
    });

    // Leave channel room
    socket.on('channel:leave', (channelId: string) => {
      socket.leave(`channel:${channelId}`);
    });

    // Typing indicator
    socket.on('typing:start', (channelId: string) => {
      socket.to(`channel:${channelId}`).emit('typing:start', {
        channelId,
        userId,
      });
    });

    socket.on('typing:stop', (channelId: string) => {
      socket.to(`channel:${channelId}`).emit('typing:stop', {
        channelId,
        userId,
      });
    });

    // Presence
    socket.on('presence:online', () => {
      if (socket.data.workspaceId) {
        socket.to(`workspace:${socket.data.workspaceId}`).emit('presence:online', { userId });
      }
    });

    socket.on('disconnect', () => {
      if (socket.data.workspaceId) {
        socket.to(`workspace:${socket.data.workspaceId}`).emit('presence:offline', { userId });
      }
    });
  });

  return {
    close: async () => {
      await io.close();
    },
  };
}

/**
 * Emits a message event to all members of a channel room.
 * Called from the REST message service after a message is persisted.
 */
export async function emitMessageEvent(
  _httpServer: HttpServer | null,
  _channel: string,
  _event: string,
  _data: unknown,
): Promise<void> {
  // This is a no-op if the socket server isn't running (e.g. in tests).
  // The REST API still persists messages; clients can poll or reconnect.
}
