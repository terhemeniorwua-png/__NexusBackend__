import type { Server } from 'socket.io';

let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

/** Best-effort: does nothing when realtime is not running. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

/** Best-effort: delivers to sockets that joined `channel:<id>` (access is checked on join). */
export function emitToChannel(channelId: string, event: string, payload: unknown): void {
  io?.to(`channel:${channelId}`).emit(event, payload);
}
