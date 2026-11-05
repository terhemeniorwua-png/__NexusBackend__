import { z } from 'zod';

export const projectOrganizationParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
});

export const updateProjectOrganizationAccessSchema = z
  .object({
    teamId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one organizational relationship to update',
  );

export type UpdateProjectOrganizationAccessInput = z.infer<
  typeof updateProjectOrganizationAccessSchema
>;
