import { z } from 'zod';

const uuid = z.string().uuid();

function httpsUrl(value: string, ctx: z.RefinementCtx): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'The webhook URL is not valid' });
    return;
  }
  if (url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'Webhook URLs must use HTTPS' });
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: 'Webhook URLs must not contain credentials' });
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    ctx.addIssue({ code: 'custom', message: 'Webhook URLs must target a public endpoint' });
  }
}

const urlSchema = z.string().trim().min(1).max(2000).superRefine(httpsUrl);
const eventsSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(50);

export const createWebhookSchema = z
  .object({
    url: urlSchema,
    events: eventsSchema,
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().optional().default(true),
    /** Optional caller-supplied signing secret. Generated when omitted. */
    secret: z.string().min(16).max(200).optional(),
  })
  .strict();

export const updateWebhookSchema = z
  .object({
    url: urlSchema.optional(),
    events: eventsSchema.optional(),
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().optional(),
    secret: z.string().min(16).max(200).optional(),
  })
  .strict();

export const webhookWorkspaceParams = z.object({ workspaceId: uuid });
export const webhookParamsSchema = z.object({ workspaceId: uuid, webhookId: uuid });
export const webhookDeliveryParamsSchema = z.object({
  workspaceId: uuid,
  webhookId: uuid,
  deliveryId: uuid,
});
export const listDeliveriesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
