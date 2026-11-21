import { z } from 'zod';

const uuid = z.string().uuid();

const title = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, { message: 'Checklist title cannot be blank' });

const description = z
  .string()
  .max(2000)
  .refine((value) => value.trim().length > 0, { message: 'Checklist description cannot be blank' })
  .nullable()
  .optional();

export const checklistProjectParamsSchema = z.object({ workspaceId: uuid, projectId: uuid });
export const checklistParamsSchema = checklistProjectParamsSchema.extend({ checklistId: uuid });
export const checklistItemParamsSchema = checklistParamsSchema.extend({ itemId: uuid });
export const checklistFeedbackParamsSchema = checklistItemParamsSchema.extend({ feedbackId: uuid });

export const listChecklistsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createChecklistSchema = z.object({
  title,
  description,
});

export const updateChecklistSchema = z
  .object({
    title: title.optional(),
    description,
  })
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: 'At least one field must be provided',
  });

const itemText = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim().length > 0, { message: 'Item text cannot be blank' });

export const createItemSchema = z.object({ text: itemText });
export const updateItemSchema = z.object({ text: itemText });
export const reorderItemsSchema = z.object({ itemIds: z.array(uuid) });

export const listFeedbackQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const feedbackBody = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.trim().length > 0, { message: 'Feedback cannot be blank' });

export const createFeedbackSchema = z.object({ body: feedbackBody });
export const updateFeedbackSchema = z.object({ body: feedbackBody });

export type ListChecklistsQuery = z.infer<typeof listChecklistsQuerySchema>;
export type CreateChecklistInput = z.infer<typeof createChecklistSchema>;
export type UpdateChecklistInput = z.infer<typeof updateChecklistSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ReorderItemsInput = z.infer<typeof reorderItemsSchema>;
export type ListFeedbackQuery = z.infer<typeof listFeedbackQuerySchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
