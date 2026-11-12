import { z } from 'zod';

const uuid = z.string().uuid();
const dateInput = z.string().datetime({ offset: true });

export const aiChatBodySchema = z
  .object({
    workspaceId: uuid.optional(),
    conversationId: uuid.optional(),
    query: z.string().trim().min(1).max(4_000),
    projectId: uuid.optional(),
    taskId: uuid.optional(),
    documentId: uuid.optional(),
    meetingId: uuid.optional(),
    contextType: z.string().trim().max(60).optional(),
    contextId: uuid.optional(),
  })
  .strict();

export const aiConversationParamsSchema = z.object({ conversationId: uuid });

export const aiConversationQuerySchema = z
  .object({
    workspaceId: uuid.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const aiUsageQuerySchema = z.object({ workspaceId: uuid.optional() }).strict();

const writingFeatures = z.enum([
  'SPELLING',
  'GRAMMAR',
  'PUNCTUATION',
  'CLARITY',
  'VOCABULARY',
  'TONE',
  'STYLE',
]);

export const aiWritingAnalyzeSchema = z
  .object({
    workspaceId: uuid.optional(),
    text: z.string().min(1).max(50_000),
    features: z
      .array(writingFeatures)
      .min(1)
      .max(7)
      .default(['SPELLING', 'GRAMMAR', 'PUNCTUATION', 'CLARITY', 'TONE']),
    language: z.string().trim().min(2).max(20).optional(),
    toneTarget: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const aiWritingRewriteSchema = z
  .object({
    workspaceId: uuid.optional(),
    text: z.string().min(1).max(50_000),
    instruction: z.string().trim().min(1).max(1_000),
    tone: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const aiWritingSessionParamsSchema = z.object({ sessionId: uuid });

export const aiWritingAcceptSchema = z
  .object({
    suggestionIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  })
  .strict();

// ---------------------------------------------------------------------------
// AI task generator (Phase 22)
// ---------------------------------------------------------------------------

export const aiTaskGenerateSchema = z
  .object({
    workspaceId: uuid,
    projectId: uuid,
    prompt: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const aiTaskPreviewSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(10_000).optional(),
    status: z
      .enum([
        'ASSIGNED',
        'IN_PROGRESS',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'CHANGES_REQUESTED',
      ])
      .optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    category: z.string().trim().max(80).optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    dueDate: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

export const aiTaskConfirmSchema = z
  .object({
    workspaceId: uuid,
    projectId: uuid,
    preview: aiTaskPreviewSchema,
  })
  .strict();

export type AiTaskGenerateBody = z.infer<typeof aiTaskGenerateSchema>;
export type AiTaskPreview = z.infer<typeof aiTaskPreviewSchema>;
export type AiTaskConfirmBody = z.infer<typeof aiTaskConfirmSchema>;

// ---------------------------------------------------------------------------
// AI summarization (Phase 22)
// ---------------------------------------------------------------------------

export const aiSummarizeSchema = z
  .object({
    workspaceId: uuid,
    contextType: z.enum(['channel', 'project', 'task', 'document', 'meeting']),
    contextId: uuid.optional(),
    channelId: uuid.optional(),
    from: dateInput.optional(),
    to: dateInput.optional(),
    maxMessages: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict()
  .refine(
    (value) =>
      value.contextType === 'channel'
        ? Boolean(value.channelId)
        : Boolean(value.contextId),
    {
      message: 'channelId is required for channels; contextId is required for other context types',
      path: ['contextId'],
    },
  )
  .refine(
    (value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to),
    {
      message: 'from must be on or before to',
      path: ['to'],
    },
  );

export type AiSummarizeBody = z.infer<typeof aiSummarizeSchema>;

// ---------------------------------------------------------------------------
// AI project intelligence (Phase 22)
// ---------------------------------------------------------------------------

export const aiProjectIntelligenceSchema = z
  .object({
    workspaceId: uuid,
    projectId: uuid,
  })
  .strict();

export type AiProjectIntelligenceBody = z.infer<typeof aiProjectIntelligenceSchema>;

// ---------------------------------------------------------------------------
// AI action proposals (Phase 23)
// ---------------------------------------------------------------------------

const createTaskPayloadSchema = z
  .object({
    projectId: uuid,
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(10_000).optional(),
    status: z
      .enum([
        'ASSIGNED',
        'IN_PROGRESS',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'CHANGES_REQUESTED',
      ])
      .optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    category: z.string().trim().max(80).optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    startDate: dateInput.optional(),
    dueDate: dateInput.optional(),
    assigneeIds: z.array(uuid).max(50).optional(),
    parentTaskId: uuid.optional(),
  })
  .strict();

const addTaskCommentPayloadSchema = z
  .object({
    projectId: uuid,
    taskId: uuid,
    body: z.string().trim().min(1).max(10_000),
    parentId: uuid.optional(),
  })
  .strict();

const completeTaskPayloadSchema = z
  .object({
    projectId: uuid,
    taskId: uuid,
  })
  .strict();

const createDocumentPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    content: z.string().max(500_000).optional(),
    projectId: uuid.optional().nullable(),
    taskId: uuid.optional().nullable(),
  })
  .strict();

const sendNotificationPayloadSchema = z
  .object({
    recipientId: uuid,
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const aiActionTypeSchema = z.enum([
  'CREATE_TASK',
  'ADD_TASK_COMMENT',
  'COMPLETE_TASK',
  'CREATE_DOCUMENT',
  'SEND_NOTIFICATION',
]);

export type AiActionTypeValue = z.infer<typeof aiActionTypeSchema>;

const actionPayloadSchemas = {
  CREATE_TASK: createTaskPayloadSchema,
  ADD_TASK_COMMENT: addTaskCommentPayloadSchema,
  COMPLETE_TASK: completeTaskPayloadSchema,
  CREATE_DOCUMENT: createDocumentPayloadSchema,
  SEND_NOTIFICATION: sendNotificationPayloadSchema,
} as const;

export type AiActionPayload = z.infer<
  (typeof actionPayloadSchemas)[keyof typeof actionPayloadSchemas]
>;

export function validateActionPayload(actionType: AiActionTypeValue, payload: unknown) {
  const result = actionPayloadSchemas[actionType].safeParse(payload);
  if (!result.success) {
    return { success: false as const, issues: result.error.issues };
  }
  return { success: true as const, data: result.data };
}

const proposalBase = z.object({
  workspaceId: uuid,
  conversationId: uuid.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  sourceReferences: z
    .array(
      z
        .object({
          type: z.string().trim().min(1).max(60),
          id: z.string().trim().min(1).max(120),
          title: z.string().trim().min(1).max(300),
        })
        .strict(),
    )
    .max(50)
    .optional(),
});

export const aiActionProposalSchema = z.discriminatedUnion('actionType', [
  proposalBase
    .extend({ actionType: z.literal('CREATE_TASK'), payload: createTaskPayloadSchema })
    .strict(),
  proposalBase
    .extend({ actionType: z.literal('ADD_TASK_COMMENT'), payload: addTaskCommentPayloadSchema })
    .strict(),
  proposalBase
    .extend({ actionType: z.literal('COMPLETE_TASK'), payload: completeTaskPayloadSchema })
    .strict(),
  proposalBase
    .extend({ actionType: z.literal('CREATE_DOCUMENT'), payload: createDocumentPayloadSchema })
    .strict(),
  proposalBase
    .extend({ actionType: z.literal('SEND_NOTIFICATION'), payload: sendNotificationPayloadSchema })
    .strict(),
]);

export const aiActionListQuerySchema = z
  .object({
    workspaceId: uuid,
    status: z
      .enum([
        'PROPOSED',
        'APPROVED',
        'REJECTED',
        'EXECUTING',
        'EXECUTED',
        'FAILED',
        'CANCELLED',
        'EXPIRED',
      ])
      .optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const aiActionParamsSchema = z.object({ proposalId: uuid });

export const aiActionDecisionSchema = z
  .object({ note: z.string().trim().max(1_000).optional() })
  .strict();

export type AiChatBody = z.infer<typeof aiChatBodySchema>;
export type AiWritingAnalyzeBody = z.infer<typeof aiWritingAnalyzeSchema>;
export type AiWritingRewriteBody = z.infer<typeof aiWritingRewriteSchema>;
export type AiActionProposalBody = z.infer<typeof aiActionProposalSchema>;
