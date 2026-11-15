import { z } from 'zod';

export const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const connectionParamsSchema = workspaceParamsSchema.extend({
  connectionId: z.string().uuid(),
});

export const projectParamsSchema = workspaceParamsSchema.extend({
  projectId: z.string().uuid(),
});

export const projectRepoParamsSchema = projectParamsSchema.extend({
  repositoryId: z.string().uuid(),
});

export const projectRepoResourceParamsSchema = projectParamsSchema.extend({
  repositoryId: z.string().uuid(),
});

export const taskParamsSchema = projectParamsSchema.extend({
  taskId: z.string().uuid(),
});

export const taskDevLinkParamsSchema = taskParamsSchema.extend({
  devLinkId: z.string().uuid(),
});

export const startGithubConnectQuerySchema = z.object({}).optional();

export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  installation_id: z.coerce.string().min(1).max(100).optional(),
  setup_action: z.string().max(100).optional(),
  state: z.string().min(1).max(4000),
});

export const linkRepositorySchema = z.object({
  connectionId: z.string().uuid(),
  externalRepoId: z.string().min(1).max(200),
  fullName: z.string().min(1).max(300),
  defaultBranch: z.string().max(250).nullable().optional(),
});

export const listAvailableReposQuerySchema = z.object({
  connectionId: z.string().uuid(),
  page: z.coerce.number().int().min(1).max(100).default(1).optional(),
  perPage: z.coerce.number().int().min(1).max(100).default(100).optional(),
});

export const listDevResourceQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10).optional(),
  perPage: z.coerce.number().int().min(1).max(100).optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
});

export const linkTaskDevLinkSchema = z.object({
  projectRepositoryId: z.string().uuid(),
  externalType: z.enum(['BRANCH', 'PULL_REQUEST', 'COMMIT']),
  externalId: z.string().min(1).max(300),
  externalNumber: z.number().int().positive().nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  url: z.string().url().max(2000).nullable().optional(),
  ref: z.string().max(500).nullable().optional(),
  headRef: z.string().max(500).nullable().optional(),
  baseRef: z.string().max(500).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
});