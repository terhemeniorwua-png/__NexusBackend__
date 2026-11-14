import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireChannelAccess, ChannelCapability } from '../authorization/channel.policy';
import { emitToChannel } from '../../realtime/io-registry';

export interface MessageSummary {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  body: string;
  parentId: string | null;
  editedAt: string | null;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  replyCount: number;
  reactionCount: number;
  reactions: { emoji: string; userIds: string[] }[];
  type: 'TEXT' | 'VOICE';
  audioMime: string | null;
  audioDurationMs: number | null;
}

function toSummary(row: {
  id: string;
  channelId: string;
  authorId: string;
  body: string;
  parentId: string | null;
  editedAt: Date | null;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  author: { name: string };
  _count?: { replies: number; reactions: number };
  replies?: { id: string }[];
  reactions?: { emoji: string; userId: string }[];
  type?: string;
  audioMime?: string | null;
  audioDurationMs?: number | null;
}): MessageSummary {
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    authorName: row.author.name,
    body: row.body,
    parentId: row.parentId,
    editedAt: row.editedAt?.toISOString() ?? null,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    replyCount: row._count?.replies ?? row.replies?.length ?? 0,
    reactionCount: row._count?.reactions ?? row.reactions?.length ?? 0,
    reactions: Object.entries(
      (row.reactions ?? []).reduce<Record<string, string[]>>((acc, r) => {
        (acc[r.emoji] ??= []).push(r.userId);
        return acc;
      }, {}),
    ).map(([emoji, userIds]) => ({ emoji, userIds })),
    type: row.type === 'VOICE' ? 'VOICE' : 'TEXT',
    audioMime: row.audioMime ?? null,
    audioDurationMs: row.audioDurationMs ?? null,
  };
}

type Input = { userId: string; workspaceId: string };

// Managers are workspace owners and project managers, matching requireChannelAccess.
export function assertCanPost(access: { channel: { postPolicy: string }; workspaceRole: string }): void {
  if (access.channel.postPolicy === 'MANAGERS_ONLY' && !['OWNER', 'PROJECT_MANAGER'].includes(access.workspaceRole)) {
    throw new AppError(403, 'CHANNEL_READ_ONLY', 'Only workspace managers can post in this channel');
  }
}

export function createMessageService(prisma: PrismaClient = getPrismaClient()) {
  const messageInclude = {
    author: { select: { name: true } },
    _count: { select: { replies: true, reactions: true } },
    reactions: { select: { emoji: true, userId: true } },
  } as const;

  return {
    async send(
      input: Input & { channelId: string; body: string; parentId?: string | null; clientTempId?: string },
    ): Promise<MessageSummary> {
      const access = await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      // Cannot send to archived channels
      if (access.channel.archivedAt) {
        throw new AppError(409, 'CHANNEL_ARCHIVED', 'Cannot send messages to an archived channel');
      }

      assertCanPost(access);

      // Validate parent message if provided
      if (input.parentId) {
        const parent = await prisma.message.findFirst({
          where: {
            id: input.parentId,
            channelId: input.channelId,
            deletedAt: null,
          },
          select: { id: true, parentId: true },
        });
        if (!parent) {
          throw new AppError(404, 'MESSAGE_NOT_FOUND', 'The parent message does not exist');
        }
        // Prevent nested replies — replies are one level deep
        if (parent.parentId) {
          throw new AppError(400, 'NESTED_REPLY_NOT_ALLOWED', 'Replies are limited to one level');
        }
      }

      const message = await prisma.message.create({
        data: {
          channelId: input.channelId,
          authorId: input.userId,
          body: input.body,
          parentId: input.parentId ?? null,
        },
        include: messageInclude,
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'message.created',
        targetType: 'Message',
        targetId: message.id,
        metadata: { channelId: input.channelId },
      });

      const summary = toSummary(message);
      if (!summary.parentId) emitToChannel(input.channelId, 'message:new', { channelId: input.channelId, message: { ...summary, clientTempId: input.clientTempId } });
      return summary;
    },

    async sendVoice(
      input: Input & { channelId: string; audio: Buffer; mime: string; durationMs: number },
    ): Promise<MessageSummary> {
      const access = await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });
      if (access.channel.archivedAt) {
        throw new AppError(409, 'CHANNEL_ARCHIVED', 'Cannot send messages to an archived channel');
      }
      assertCanPost(access);

      const message = await prisma.message.create({
        data: {
          channelId: input.channelId,
          authorId: input.userId,
          body: 'Voice message',
          type: 'VOICE',
          audioMime: input.mime,
          audioDurationMs: input.durationMs,
          audio: { create: { data: new Uint8Array(input.audio) } },
        },
        include: messageInclude,
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'message.created',
        targetType: 'Message',
        targetId: message.id,
        metadata: { channelId: input.channelId, voice: true },
      });
      const summary = toSummary(message);
      emitToChannel(input.channelId, 'message:new', { channelId: input.channelId, message: summary });
      return summary;
    },

    async getAudio(
      input: Input & { channelId: string; messageId: string },
    ): Promise<{ data: Buffer; mime: string }> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });
      const row = await prisma.message.findFirst({
        where: { id: input.messageId, channelId: input.channelId, type: 'VOICE', deletedAt: null },
        select: { audioMime: true, audio: { select: { data: true } } },
      });
      if (!row?.audio) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'That voice message does not exist');
      return { data: Buffer.from(row.audio.data), mime: row.audioMime ?? 'audio/webm' };
    },

    async list(
      input: Input & {
        channelId: string;
        cursor?: string;
        limit: number;
        includeDeleted?: boolean;
      },
    ): Promise<{ items: MessageSummary[]; nextCursor: string | null }> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      const messages = await prisma.message.findMany({
        where: {
          channelId: input.channelId,
          ...(input.includeDeleted ? {} : { deletedAt: null }),
          parentId: null, // Top-level messages; replies are included via _count
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor
          ? { cursor: { id: input.cursor }, skip: 1 }
          : {}),
        include: messageInclude,
      });

      const hasMore = messages.length > input.limit;
      const items = (hasMore ? messages.slice(0, input.limit) : messages).map(toSummary);
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

      return { items, nextCursor };
    },

    async getReplies(
      input: Input & { channelId: string; messageId: string },
    ): Promise<MessageSummary[]> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      const replies = await prisma.message.findMany({
        where: {
          parentId: input.messageId,
          channelId: input.channelId,
          deletedAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: messageInclude,
      });

      return replies.map(toSummary);
    },

    async edit(
      input: Input & { channelId: string; messageId: string; body: string },
    ): Promise<MessageSummary> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      const message = await prisma.message.findFirst({
        where: {
          id: input.messageId,
          channelId: input.channelId,
          deletedAt: null,
        },
      });
      if (!message) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'That message does not exist');
      }
      if (message.authorId !== input.userId) {
        throw new AppError(403, 'MESSAGE_EDIT_FORBIDDEN', 'You can only edit your own messages');
      }

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: { body: input.body, editedAt: new Date() },
        include: messageInclude,
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'message.edited',
        targetType: 'Message',
        targetId: message.id,
        metadata: { channelId: input.channelId },
      });

      return toSummary(updated);
    },

    async delete(
      input: Input & { channelId: string; messageId: string },
    ): Promise<void> {
      const access = await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      const message = await prisma.message.findFirst({
        where: {
          id: input.messageId,
          channelId: input.channelId,
          deletedAt: null,
        },
      });
      if (!message) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'That message does not exist');
      }

      // Author or channel admin / workspace manager can delete
      const isAuthor = message.authorId === input.userId;
      const isManager = access.workspaceRole === 'OWNER' || access.workspaceRole === 'PROJECT_MANAGER';
      const isChannelAdmin = access.membership?.role === 'ADMIN';
      if (!isAuthor && !isManager && !isChannelAdmin) {
        throw new AppError(403, 'MESSAGE_DELETE_FORBIDDEN', 'You can only delete your own messages');
      }

      await prisma.message.update({
        where: { id: message.id },
        data: { deletedAt: new Date() },
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'message.deleted',
        targetType: 'Message',
        targetId: message.id,
        metadata: { channelId: input.channelId },
      });
    },

    async pin(
      input: Input & { channelId: string; messageId: string },
    ): Promise<MessageSummary> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.Update,
      });

      const message = await prisma.message.findFirst({
        where: {
          id: input.messageId,
          channelId: input.channelId,
          deletedAt: null,
        },
      });
      if (!message) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'That message does not exist');
      }

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: { pinnedAt: new Date() },
        include: messageInclude,
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'message.pinned',
        targetType: 'Message',
        targetId: message.id,
        metadata: { channelId: input.channelId },
      });

      return toSummary(updated);
    },

    async unpin(
      input: Input & { channelId: string; messageId: string },
    ): Promise<MessageSummary> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.Update,
      });

      const message = await prisma.message.findFirst({
        where: {
          id: input.messageId,
          channelId: input.channelId,
          pinnedAt: { not: null },
        },
      });
      if (!message) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'That message is not pinned');
      }

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: { pinnedAt: null },
        include: messageInclude,
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'message.unpinned',
        targetType: 'Message',
        targetId: message.id,
        metadata: { channelId: input.channelId },
      });

      return toSummary(updated);
    },

    async addReaction(
      input: Input & { channelId: string; messageId: string; emoji: string },
    ): Promise<{ id: string }> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      const message = await prisma.message.findFirst({
        where: {
          id: input.messageId,
          channelId: input.channelId,
          deletedAt: null,
        },
      });
      if (!message) {
        throw new AppError(404, 'MESSAGE_NOT_FOUND', 'That message does not exist');
      }

      const reaction = await prisma.messageReaction.upsert({
        where: {
          messageId_userId_emoji: {
            messageId: input.messageId,
            userId: input.userId,
            emoji: input.emoji,
          },
        },
        create: {
          messageId: input.messageId,
          userId: input.userId,
          emoji: input.emoji,
        },
        update: {},
      });

      emitToChannel(input.channelId, 'message:reaction', {
        channelId: input.channelId, messageId: input.messageId, userId: input.userId, emoji: input.emoji, action: 'add',
      });
      return { id: reaction.id };
    },

    async removeReaction(
      input: Input & { channelId: string; messageId: string; emoji: string },
    ): Promise<void> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      await prisma.messageReaction.deleteMany({
        where: {
          messageId: input.messageId,
          userId: input.userId,
          emoji: input.emoji,
        },
      });
      emitToChannel(input.channelId, 'message:reaction', {
        channelId: input.channelId, messageId: input.messageId, userId: input.userId, emoji: input.emoji, action: 'remove',
      });
    },

    async markRead(
      input: Input & { channelId: string; messageId: string },
    ): Promise<void> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      // Upsert the read receipt for the channel — one per user per channel
      await prisma.messageReadReceipt.upsert({
        where: {
          channelId_userId: {
            channelId: input.channelId,
            userId: input.userId,
          },
        },
        create: {
          channelId: input.channelId,
          userId: input.userId,
          messageId: input.messageId,
        },
        update: {
          messageId: input.messageId,
          readAt: new Date(),
        },
      });
    },

    async getUnreadCount(
      input: Input & { channelId: string },
    ): Promise<{ unreadCount: number }> {
      await requireChannelAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        capability: ChannelCapability.View,
      });

      // Get the last read message for this user in this channel
      const receipt = await prisma.messageReadReceipt.findUnique({
        where: {
          channelId_userId: {
            channelId: input.channelId,
            userId: input.userId,
          },
        },
        select: { messageId: true },
      });

      if (!receipt) {
        // No read receipt — count all non-deleted messages
        const count = await prisma.message.count({
          where: {
            channelId: input.channelId,
            deletedAt: null,
            authorId: { not: input.userId }, // Don't count own messages
          },
        });
        return { unreadCount: count };
      }

      // Count messages after the last read message
      const lastRead = await prisma.message.findUnique({
        where: { id: receipt.messageId },
        select: { createdAt: true },
      });

      if (!lastRead) {
        // The read message was deleted — count all
        const count = await prisma.message.count({
          where: {
            channelId: input.channelId,
            deletedAt: null,
            authorId: { not: input.userId },
          },
        });
        return { unreadCount: count };
      }

      const count = await prisma.message.count({
        where: {
          channelId: input.channelId,
          deletedAt: null,
          authorId: { not: input.userId },
          createdAt: { gt: lastRead.createdAt },
        },
      });

      return { unreadCount: count };
    },
  };
}

export type MessageService = ReturnType<typeof createMessageService>;
