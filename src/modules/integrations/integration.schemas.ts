import { z } from 'zod';

const uuid = z.string().uuid();
const providerEnum = z.enum(['GOOGLE_DRIVE', 'ONEDRIVE', 'DROPBOX', 'GMAIL', 'OUTLOOK', 'SLACK', 'GITHUB', 'GITLAB', 'GOOGLE_CALENDAR', 'OUTLOOK_CALENDAR']);

export const listIntegrationsQuerySchema = z.object({
  workspaceId: uuid.optional(),
});

export const connectIntegrationSchema = z.object({
  provider: providerEnum,
  workspaceId: uuid.optional().nullable(),
  accessToken: z.string().min(1).max(4000),
  refreshToken: z.string().max(4000).optional().nullable(),
  tokenExpiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  scopes: z.array(z.string()).optional().default([]),
  externalUserId: z.string().max(200).optional().nullable(),
  externalEmail: z.string().email().max(200).optional().nullable(),
}).strict();

export const disconnectParamsSchema = z.object({ integrationId: uuid });

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
export type ListIntegrationsQuery = z.infer<typeof listIntegrationsQuerySchema>;
