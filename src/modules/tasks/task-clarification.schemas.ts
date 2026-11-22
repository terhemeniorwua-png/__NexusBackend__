import { z } from 'zod';
import { taskParamsSchema } from './task.schemas';

const uuid = z.string().uuid();
const clarificationText = z.string().trim().min(1).max(2000);

export const askClarificationSchema = z
  .object({
    question: clarificationText,
  })
  .strict();

export const answerClarificationSchema = z
  .object({
    answer: clarificationText,
  })
  .strict();

export const clarificationParamsSchema = taskParamsSchema.extend({
  clarificationId: uuid,
});

export const listClarificationsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type AskClarificationInput = z.infer<typeof askClarificationSchema>;
export type AnswerClarificationInput = z.infer<typeof answerClarificationSchema>;
export type ClarificationParams = z.infer<typeof clarificationParamsSchema>;
export type ListClarificationsQuery = z.infer<typeof listClarificationsQuerySchema>;
