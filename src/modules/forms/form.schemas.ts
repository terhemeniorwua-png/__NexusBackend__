import { z } from 'zod';
const uuid = z.string().uuid();

export const formWorkspaceParams = z.object({ workspaceId: uuid });
export const formParamsSchema = z.object({ workspaceId: uuid, formId: uuid });

export const createFormSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  isPublic: z.boolean().optional().default(false),
}).strict();

export const updateFormSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(5000).optional().nullable(),
  isPublic: z.boolean().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED']).optional(),
}).strict();

export const formFieldSchema = z.object({
  label: z.string().trim().min(1).max(200),
  type: z.enum(['TEXT', 'TEXTAREA', 'NUMBER', 'EMAIL', 'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'DATE', 'RATING', 'SCALE']),
  required: z.boolean().optional().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(20).optional().default([]),
  placeholder: z.string().max(200).optional().nullable(),
  position: z.number().int().min(0).optional().default(0),
}).strict();

export const submitResponseSchema = z.object({
  answers: z.array(z.object({
    fieldId: uuid,
    value: z.string().max(10000),
  })).min(1).max(100),
}).strict();

export const listFormsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED']).optional(),
});

export type CreateFormInput = z.infer<typeof createFormSchema>;
export type UpdateFormInput = z.infer<typeof updateFormSchema>;
export type FormFieldInput = z.infer<typeof formFieldSchema>;
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;
export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>;
