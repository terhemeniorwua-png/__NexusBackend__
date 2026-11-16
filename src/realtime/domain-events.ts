import { EventEmitter } from 'node:events';
import { emitToChannel, emitToUser, emitToWorkspace } from './io-registry';

/**
 * Central domain-event emitter used by application services.
 *
 * Services publish domain events after state changes; this module fans them out
 * to realtime Socket.IO rooms (best-effort, no-op when realtime is not running).
 * Room membership is permission-checked on join, so emissions target only the
 * correct room scopes (workspace:{id}, channel:{id}, user:{id}).
 */

export type DomainEventMap = {
  'message.created': {
    workspaceId: string;
    channelId: string;
    message: Record<string, unknown>;
  };
  'task.created': {
    workspaceId: string;
    projectId: string;
    taskId: string;
    task?: Record<string, unknown>;
    actorId?: string;
  };
  'task.updated': {
    workspaceId: string;
    projectId: string;
    taskId: string;
    changes?: string[];
    task?: Record<string, unknown>;
    actorId?: string;
  };
  'task.assigned': {
    workspaceId: string;
    projectId: string;
    taskId: string;
    assigneeId: string;
    actorId?: string;
  };
  'comment.created': {
    workspaceId: string;
    projectId: string;
    taskId: string;
    commentId: string;
    authorId: string;
    comment?: Record<string, unknown>;
  };
  'mention.created': {
    workspaceId: string;
    projectId: string;
    taskId: string;
    commentId: string;
    mentionedUserId: string;
    actorId: string;
  };
};

export type DomainEventName = keyof DomainEventMap;
export type DomainEventPayload<K extends DomainEventName> = DomainEventMap[K];

type Handler<K extends DomainEventName> = (payload: DomainEventPayload<K>) => void | Promise<void>;

class DomainEventBus extends EventEmitter {}

export const domainEvents = new DomainEventBus();
domainEvents.setMaxListeners(50);

export function emitDomainEvent<K extends DomainEventName>(
  event: K,
  payload: DomainEventPayload<K>,
): void {
  // Async-safe fire-and-forget; listeners must not throw into callers.
  queueMicrotask(() => {
    domainEvents.emit(event, payload);
  });
}

export function onDomainEvent<K extends DomainEventName>(
  event: K,
  handler: Handler<K>,
): () => void {
  const wrapped = (payload: DomainEventPayload<K>) => {
    Promise.resolve(handler(payload)).catch(() => {
      // Best-effort: domain event side effects must not crash the process.
    });
  };
  domainEvents.on(event, wrapped);
  return () => domainEvents.off(event, wrapped);
}

// Default realtime fan-out handlers. Registered once at module load.
let defaultsRegistered = false;

export function registerDefaultDomainEventHandlers(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;

  onDomainEvent('message.created', (payload) => {
    // Channel-scoped realtime message delivery (room access checked on join).
    emitToChannel(payload.channelId, 'message.created', payload);
    // Backward-compatible event name used by existing clients.
    emitToChannel(payload.channelId, 'message:new', payload);
  });

  onDomainEvent('task.created', (payload) => {
    emitToWorkspace(payload.workspaceId, 'task.created', payload);
  });

  onDomainEvent('task.updated', (payload) => {
    emitToWorkspace(payload.workspaceId, 'task.updated', payload);
  });

  onDomainEvent('task.assigned', (payload) => {
    // Notify assignee directly and workspace subscribers; room joins are permission-checked.
    emitToUser(payload.assigneeId, 'task.assigned', payload);
    emitToWorkspace(payload.workspaceId, 'task.assigned', payload);
  });

  onDomainEvent('comment.created', (payload) => {
    emitToWorkspace(payload.workspaceId, 'comment.created', payload);
  });

  onDomainEvent('mention.created', (payload) => {
    // Personal delivery only.
    emitToUser(payload.mentionedUserId, 'mention.created', payload);
  });
}

// Register on import so services can emit without explicit bootstrap ordering.
registerDefaultDomainEventHandlers();
