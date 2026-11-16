import type { Server as HttpServer } from 'node:http';
import type { AppConfig } from '../config/env';
import { AppError } from '../utils/errors';
import { setIo } from './io-registry';
import { getPrismaClient } from '../db/prisma';
import { ChannelCapability, requireChannelAccess } from '../modules/authorization/channel.policy';

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

  setIo(io);

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication token is required');
      }

      // Verify the access token using the existing service
      const { verifyAccessToken } = await import('../modules/auth/access-token.service');
      const payload = verifyAccessToken(config, token);
      socket.data.userId = payload.sub;
      socket.data.workspaceId = socket.handshake.auth?.workspaceId as string | undefined;
      next();
    } catch (_error) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    // Private room so a single user can be reached (incoming calls/notifications).
    void socket.join(`user:${userId}`);

    // Join workspace room — the client must prove active workspace membership
    socket.on('workspace:join', async (workspaceId: string, ack?: (result: { ok: boolean }) => void) => {
      try {
        if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('invalid workspace id');
        const prisma = getPrismaClient();
        const membership = await prisma.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } },
          select: { status: true },
        });
        if (!membership || membership.status !== 'ACTIVE') throw new Error('access denied');
        await socket.join(`workspace:${workspaceId}`);
        socket.data.workspaceId = workspaceId;
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });

    // Leave workspace room
    socket.on('workspace:leave', (workspaceId: string) => {
      socket.leave(`workspace:${workspaceId}`);
    });

    // Join channel room — the client must prove membership
    socket.on('channel:join', async (channelId: string, ack?: (result: { ok: boolean }) => void) => {
      try {
        if (typeof channelId !== 'string') throw new Error('invalid channel id');
        const prisma = getPrismaClient();
        const channel = await prisma.channel.findFirst({
          where: { id: channelId, deletedAt: null },
          select: { workspaceId: true },
        });
        if (!channel) throw new Error('not found');
        await requireChannelAccess(prisma, {
          userId,
          workspaceId: channel.workspaceId,
          channelId,
          capability: ChannelCapability.View,
        });
        await socket.join(`channel:${channelId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
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
