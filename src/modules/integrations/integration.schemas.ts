import { z } from 'zod';

const uuid = z.string().uuid();
const providerEnum = z.enum([
  'GOOGLE_DRIVE',
  'ONEDRIVE',
  'DROPBOX',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'GITHUB',
  'GITLAB',
  'GOOGLE_CALENDAR',
  'OUTLOOK_CALENDAR',
]);

export const listIntegrationsQuerySchema = z.object({
  workspaceId: uuid.optional(),
});

export const connectIntegrationSchema = z
  .object({
    provider: providerEnum,
    workspaceId: uuid.optional().nullable(),
    accessToken: z.string().min(1).max(4000),
    refreshToken: z.string().max(4000).optional().nullable(),
    tokenExpiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    scopes: z.array(z.string()).optional().default([]),
    externalUserId: z.string().max(200).optional().nullable(),
    externalEmail: z.string().email().max(200).optional().nullable(),
  })
  .strict();

export const disconnectParamsSchema = z.object({ integrationId: uuid });

/** Workspace-scoped integration routes are mounted under `/workspaces/:workspaceId/integrations`. */
export const workspaceIntegrationParamsSchema = z.object({ workspaceId: uuid });

export const updateIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z
      .object({
        slackChannelId: z.string().min(1).max(100).optional(),
        slackChannelName: z.string().max(200).optional().nullable(),
        googleCalendarId: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.enabled !== undefined || value.config !== undefined, {
    message: 'At least one field must be provided',
  });

export const syncJobParamsSchema = z.object({
  integrationId: uuid,
  jobId: uuid,
});

export const listSyncJobsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
export type ListIntegrationsQuery = z.infer<typeof listIntegrationsQuerySchema>;
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;
export type ListSyncJobsQuery = z.infer<typeof listSyncJobsQuerySchema>;
