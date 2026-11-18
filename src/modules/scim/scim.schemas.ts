import { z } from 'zod';

/**
 * Validation for SCIM 2.0 requests.
 *
 * SCIM clients send JSON Patch (RFC 6902) bodies for `PATCH` operations and
 * full resource representations for `POST`/`PUT`. These schemas validate the
 * incoming payload shape before the service layer touches the database.
 */

/** SCIM user name sub-object. */
export const scimNameSchema = z
  .object({
    givenName: z.string().trim().max(100).optional().nullable(),
    familyName: z.string().trim().max(100).optional().nullable(),
    formatted: z.string().trim().max(200).optional().nullable(),
  })
  .strict()
  .refine(
    (value) => value.givenName !== null || value.familyName !== null || value.formatted !== null,
    { message: 'At least one name field is required' },
  );

/** SCIM email entry. */
export const scimEmailSchema = z
  .object({
    value: z.string().trim().email('Invalid email address'),
    type: z.string().trim().max(50).optional().nullable(),
    primary: z.boolean().optional(),
  })
  .strict();

export const createScimTokenSchema = z
  .object({
    name: z.string().trim().min(1, 'Token name is required').max(100),
    scopes: z.array(z.string().trim().min(1)).default(['scim:read', 'scim:write']),
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

export const provisionScimUserSchema = z
  .object({
    userName: z.string().trim().email('userName must be a valid email address'),
    externalId: z.string().trim().max(200).optional().nullable(),
    name: scimNameSchema.optional().nullable(),
    displayName: z.string().trim().max(200).optional().nullable(),
    emails: z.array(scimEmailSchema).optional(),
    active: z.boolean().optional(),
    password: z.string().min(8).max(128).optional().nullable(),
    role: z
      .enum(['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'VIEWER', 'COLLABORATOR'])
      .optional(),
  })
  .strict();

export const patchScimUserSchema = z
  .object({
    externalId: z.string().trim().max(200).optional().nullable(),
    displayName: z.string().trim().max(200).optional().nullable(),
    active: z.boolean().optional(),
    emails: z.array(scimEmailSchema).optional(),
  })
  .strict();

export const provisionScimGroupSchema = z
  .object({
    displayName: z.string().trim().min(1, 'displayName is required').max(200),
    externalId: z.string().trim().max(200).optional().nullable(),
    teamId: z.string().uuid().optional().nullable(),
    members: z.array(z.object({ userId: z.string().uuid() })).optional(),
  })
  .strict();

export const patchScimGroupSchema = z
  .object({
    displayName: z.string().trim().max(200).optional().nullable(),
    externalId: z.string().trim().max(200).optional().nullable(),
    members: z.array(z.object({ userId: z.string().uuid() })).optional().nullable(),
  })
  .strict();

export const scimListQuerySchema = z
  .object({
    startIndex: z.coerce.number().int().min(1).default(1),
    count: z.coerce.number().int().min(1).max(100).default(20),
    filter: z.string().optional(),
  })
  .strict();

export type CreateScimTokenInput = z.infer<typeof createScimTokenSchema>;
export type ProvisionScimUserInput = z.infer<typeof provisionScimUserSchema>;
export type PatchScimUserInput = z.infer<typeof patchScimUserSchema>;
export type ProvisionScimGroupInput = z.infer<typeof provisionScimGroupSchema>;
export type PatchScimGroupInput = z.infer<typeof patchScimGroupSchema>;
export type ScimListQuery = z.infer<typeof scimListQuerySchema>;
