import { z } from 'zod';

const name = z.string().trim().min(2).max(120);
const description = z.string().trim().max(2000).nullable();
const website = z.string().trim().url().max(500).nullable();
const email = z.string().trim().toLowerCase().email().max(254).nullable();
const contactInformation = z
  .record(z.string().max(60), z.string().trim().max(250))
  .refine((value) => Object.keys(value).length <= 20)
  .nullable();
const optional = <T extends z.ZodType>(schema: T) => schema.optional();

export const organizationParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const updateCompanyProfileSchema = z
  .object({
    name: optional(name),
    description: optional(description),
    industryCategory: optional(z.string().trim().max(120).nullable()),
    officialWebsite: optional(website),
    businessEmail: optional(email),
    contactInformation: optional(contactInformation),
    country: optional(z.string().trim().max(100).nullable()),
    location: optional(z.string().trim().max(250).nullable()),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const updateInstitutionProfileSchema = z
  .object({
    name: optional(name),
    description: optional(description),
    institutionType: optional(
      z.enum(['UNIVERSITY', 'COLLEGE', 'SCHOOL', 'RESEARCH_INSTITUTION', 'OTHER']).nullable(),
    ),
    officialWebsite: optional(website),
    institutionalEmail: optional(email),
    contactInformation: optional(contactInformation),
    country: optional(z.string().trim().max(100).nullable()),
    location: optional(z.string().trim().max(250).nullable()),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const createInstitutionGroupSchema = z
  .object({
    name: name,
    description: z.string().trim().max(500).nullable().optional(),
    leadId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateInstitutionGroupSchema = z
  .object({
    name: optional(name),
    description: optional(z.string().trim().max(500).nullable()),
    leadId: optional(z.string().uuid().nullable()),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const institutionGroupParamsSchema = organizationParamsSchema.extend({
  groupId: z.string().uuid(),
});

export const institutionGroupMemberParamsSchema = institutionGroupParamsSchema.extend({
  userId: z.string().uuid(),
});

export const addInstitutionGroupMemberSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(['LEAD', 'MEMBER']).default('MEMBER'),
  })
  .strict();

export const updateInstitutionGroupMemberSchema = z
  .object({
    role: z.enum(['LEAD', 'MEMBER']),
  })
  .strict();

export type UpdateCompanyProfileInput = z.infer<typeof updateCompanyProfileSchema>;
export type UpdateInstitutionProfileInput = z.infer<typeof updateInstitutionProfileSchema>;
export type CreateInstitutionGroupInput = z.infer<typeof createInstitutionGroupSchema>;
export type UpdateInstitutionGroupInput = z.infer<typeof updateInstitutionGroupSchema>;
