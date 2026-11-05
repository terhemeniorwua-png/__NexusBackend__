import { z } from 'zod';

const uuid = z.string().uuid();
export const channelWorkspaceParams = z.object({ workspaceId: uuid });
export const channelParams = z.object({ workspaceId: uuid, channelId: uuid });
export const channelMemberParams = z.object({ workspaceId: uuid, channelId: uuid, userId: uuid });
export const createChannelSchema = z.object({
  type: z.enum(['WORKSPACE', 'TEAM', 'DEPARTMENT', 'PROJECT', 'PRIVATE']),
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable().optional(),
  teamId: uuid.optional(), departmentId: uuid.optional(), projectId: uuid.optional(),
}).strict();
export const updateChannelSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(500).nullable().optional() }).strict().refine((x) => Object.keys(x).length > 0);
export const addChannelMemberSchema = z.object({ userId: uuid }).strict();
export const listChannelsSchema = z.object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
