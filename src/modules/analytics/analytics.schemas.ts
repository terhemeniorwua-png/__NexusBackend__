import { z } from 'zod';

const uuid = z.string().uuid();

const analyticsRangeSchema = z.enum(['7d', '30d', '90d', 'custom']);

export const analyticsQuerySchema = z.object({
  workspaceId: uuid.optional(),
  projectId: uuid.optional(),
  range: analyticsRangeSchema.default('30d'),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const analyticsScopedQuerySchema = z.object({
  workspaceId: uuid,
  projectId: uuid.optional(),
  range: analyticsRangeSchema.default('30d'),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type AnalyticsScopedQuery = z.infer<typeof analyticsScopedQuerySchema>;
