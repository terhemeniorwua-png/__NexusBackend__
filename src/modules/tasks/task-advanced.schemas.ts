import { z } from 'zod';

const uuid = z.string().uuid();

export const customFieldTypeSchema = z.enum([
  'TEXT',
  'NUMBER',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'USER',
  'CHECKBOX',
]);

const customFieldOptionSchema = z
  .object({
    value: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    color: z.string().trim().max(30).optional(),
  })
  .strict();

export const customFieldParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  fieldId: uuid,
});

export const createCustomFieldSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    key: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Key must start with a letter and contain only letters, numbers, _ or -')
      .optional(),
    type: customFieldTypeSchema,
    description: z.string().trim().max(500).optional().nullable(),
    options: z.array(customFieldOptionSchema).max(100).optional().nullable(),
    required: z.boolean().optional().default(false),
    position: z.number().int().min(0).optional().default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.type === 'SELECT' || value.type === 'MULTI_SELECT') && (!value.options || value.options.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Options are required for select fields', path: ['options'] });
    }
    if (value.options) {
      const values = value.options.map((o) => o.value);
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Option values must be unique', path: ['options'] });
      }
    }
  });

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    options: z.array(customFieldOptionSchema).max(100).optional().nullable(),
    required: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export const taskCustomFieldValueItemSchema = z
  .object({
    fieldId: uuid,
    value: z.unknown().optional().nullable(),
  })
  .strict();

export const setTaskCustomFieldValuesSchema = z
  .object({
    values: z.array(taskCustomFieldValueItemSchema).max(200),
  })
  .strict();

export type SetTaskCustomFieldValuesInput = z.infer<typeof setTaskCustomFieldValuesSchema>;

// Saved views
const MAX_CONFIG_BYTES = 32 * 1024;

function jsonSizeLimit(value: unknown, maxBytes: number, ctx: z.RefinementCtx, path: (string | number)[] = []) {
  try {
    const size = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
    if (size > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Config exceeds maximum size of ${maxBytes} bytes`, path });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Config must be JSON-serializable', path });
  }
}

const savedViewConfigBaseSchema = z
  .object({
    version: z.literal(1),
    filters: z.record(z.string(), z.unknown()).default({}),
    sort: z.record(z.string(), z.unknown()).nullable().default(null),
    group: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();

export const savedViewConfigSchema = savedViewConfigBaseSchema.superRefine((val, ctx) => {
  jsonSizeLimit(val, MAX_CONFIG_BYTES, ctx);
});

const savedViewConfigUpdateSchema = z
  .object({
    version: z.literal(1),
    filters: z.record(z.string(), z.unknown()).optional(),
    sort: z.record(z.string(), z.unknown()).nullable().optional(),
    group: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    jsonSizeLimit(val, MAX_CONFIG_BYTES, ctx);
  });

export const savedViewParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  viewId: uuid,
});

export const createSavedViewSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    isShared: z.boolean().optional().default(false),
    config: savedViewConfigSchema.default({ version: 1, filters: {}, sort: null, group: null }),
  })
  .strict();

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;

export const updateSavedViewSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isShared: z.boolean().optional(),
    config: savedViewConfigUpdateSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;

// Recurrence
export const recurrenceParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
});

export const upsertRecurrenceSchema = z
  .object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    interval: z.number().int().min(1).max(365).optional().default(1),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional().default([]),
    dayOfMonth: z.number().int().min(1).max(31).optional().nullable(),
    endsAt: z.string().datetime({ offset: true }).optional().nullable(),
    maxOccurrences: z.number().int().min(1).max(1000).optional().nullable(),
    nextRunAt: z.string().datetime({ offset: true }).optional().nullable(),
    active: z.boolean().optional().default(true),
  })
  .strict();

export type UpsertRecurrenceInput = z.infer<typeof upsertRecurrenceSchema>;

// Task templates
const MAX_BLUEPRINT_BYTES = 64 * 1024;

const taskTemplateDataSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().max(200).optional(),
    description: z.string().max(10000).nullable().optional(),
    status: z.string().max(40).optional(),
    priority: z.string().max(40).optional(),
    category: z.string().max(80).nullable().optional(),
    labels: z.array(z.string().max(40)).max(30).optional(),
    startDate: z.string().datetime({ offset: true }).nullable().optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
    customFieldValues: z.array(z.object({ fieldId: uuid, value: z.unknown().nullable().optional() }).strict()).max(200).optional(),
    subtasks: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    jsonSizeLimit(val, MAX_BLUEPRINT_BYTES, ctx);
  });

const taskTemplateDataUpdateSchema = taskTemplateDataSchema; // full versioned blueprint on update

export const taskTemplateParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  templateId: uuid,
});

export const createTaskTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    data: taskTemplateDataSchema.default({ version: 1 }),
  })
  .strict();

export type CreateTaskTemplateInput = z.infer<typeof createTaskTemplateSchema>;

export const updateTaskTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    data: taskTemplateDataUpdateSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type UpdateTaskTemplateInput = z.infer<typeof updateTaskTemplateSchema>;

export const createTaskFromTemplateSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    assigneeIds: z.array(uuid).max(50).optional(),
    startDate: z.string().datetime({ offset: true }).optional().nullable(),
    dueDate: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

// Project templates
const projectTemplateDataSchema = z
  .object({
    version: z.literal(1),
    description: z.string().max(10000).nullable().optional(),
    status: z.string().max(40).optional(),
    visibility: z.string().max(40).optional(),
    customFields: z
      .array(
        z
          .object({
            name: z.string().max(120),
            key: z.string().max(80).optional(),
            type: customFieldTypeSchema,
            description: z.string().max(500).nullable().optional(),
            options: z.array(customFieldOptionSchema).max(100).nullable().optional(),
            required: z.boolean().optional(),
            position: z.number().int().optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    taskTemplates: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
    tasks: z
      .array(
        z
          .object({
            title: z.string().max(200),
            description: z.string().max(10000).nullable().optional(),
            status: z.string().max(40).optional(),
            priority: z.string().max(40).optional(),
            labels: z.array(z.string().max(40)).max(30).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    jsonSizeLimit(val, MAX_BLUEPRINT_BYTES, ctx);
  });

export const projectTemplateParamsSchema = z.object({
  workspaceId: uuid,
  templateId: uuid,
});

export const createProjectTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    data: projectTemplateDataSchema.default({ version: 1 }),
  })
  .strict();

export type CreateProjectTemplateInput = z.infer<typeof createProjectTemplateSchema>;

export const updateProjectTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    data: projectTemplateDataSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type UpdateProjectTemplateInput = z.infer<typeof updateProjectTemplateSchema>;

export const createProjectFromTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    key: z.string().trim().min(2).max(12).regex(/^[A-Z0-9]+$/),
    description: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();
