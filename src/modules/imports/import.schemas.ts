import { z } from 'zod';

const uuid = z.string().uuid();

export const importSourceSchema = z.enum(['CLICKUP', 'TRELLO', 'CSV']);

export const importUploadSchema = z
  .object({
    workspaceId: uuid,
    source: importSourceSchema,
    /** CSV content (UTF-8) when source=CSV. */
    csv: z.string().max(5_000_000).optional(),
    /** External API token for ClickUp/Trello imports (not stored in report). */
    apiToken: z.string().max(4000).optional(),
    /** Source-specific options, e.g. { listId } for ClickUp/Trello. */
    options: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === 'CSV' && !value.csv) {
      ctx.addIssue({ code: 'custom', path: ['csv'], message: 'CSV content is required' });
    }
    if ((value.source === 'CLICKUP' || value.source === 'TRELLO') && !value.apiToken) {
      ctx.addIssue({ code: 'custom', path: ['apiToken'], message: 'An API token is required' });
    }
  });

export const importJobParamsSchema = z.object({ importId: uuid }).strict();

export const importConfirmSchema = z
  .object({
    /** Client-supplied idempotency key; reusing it returns the same execution. */
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .strict();

export const listImportsQuerySchema = z
  .object({
    workspaceId: uuid,
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ImportUploadInput = z.infer<typeof importUploadSchema>;
export type ImportConfirmInput = z.infer<typeof importConfirmSchema>;
