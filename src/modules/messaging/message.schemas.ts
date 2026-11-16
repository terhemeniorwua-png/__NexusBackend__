import { z } from 'zod';

const uuid = z.string().uuid();

export const messageParamsSchema = z.object({
  workspaceId: uuid,
  channelId: uuid,
  messageId: uuid,
});

export const channelMessageParamsSchema = z.object({
  workspaceId: uuid,
  channelId: uuid,
});

export const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    parentId: uuid.optional().nullable(),
    clientTempId: z.string().max(64).optional(),
  })
  .strict();

export const editMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const listMessagesQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const addReactionSchema = z
  .object({
    emoji: z.string().trim().min(1).max(32),
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type AddReactionInput = z.infer<typeof addReactionSchema>;
