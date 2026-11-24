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

export const projectRepoMemberParamsSchema = projectRepoParamsSchema.extend({
  userId: z.string().uuid(),
});

export const repositoryAccessLevelSchema = z.enum(['NONE', 'METADATA', 'READ', 'LINK']);

export const setRepositoryMemberOverrideSchema = z.object({
  level: repositoryAccessLevelSchema,
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

export const devActivityCommitsQuerySchema = z.object({
  // Opaque base64url cursor produced by listDevActivityCommits, not a UUID.
  cursor: z.string().trim().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  repositoryId: z.string().uuid().optional(),
  authorLogin: z.string().trim().min(1).max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export const devActivityDevelopersQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    repositoryId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const from = new Date(value.from);
    const to = new Date(value.to);
    if (!(from < to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'from must be before to',
        path: ['from'],
      });
    }
    const maxRangeMs = 90 * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > maxRangeMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'range must be 90 days or less',
        path: ['to'],
      });
    }
  });