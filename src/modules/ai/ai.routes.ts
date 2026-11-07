import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { z } from 'zod';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { getPrismaClient } from '../../db/prisma';

export interface AiRouterOptions { config: AppConfig }

const uuid = z.string().uuid();
const analyzeTextSchema = z.object({ text: z.string().trim().min(1).max(50_000), features: z.array(z.enum(['GRAMMAR', 'SPELLING', 'CLARITY', 'TONE', 'SUMMARY', 'REWRITE'])).min(1) }).strict();
const aiQuerySchema = z.object({ workspaceId: uuid.optional(), query: z.string().trim().min(1).max(2000), context: z.string().max(10_000).optional() }).strict();
const aiActionApprovalSchema = z.object({ workspaceId: uuid, actionType: z.string().min(1).max(100), payload: z.record(z.string(), z.unknown()), approvedAt: z.string().datetime({ offset: true }) }).strict();

function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth.userId; }

export function createAiRouter({ config }: AiRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();
  const prisma = getPrismaClient();

  /**
   * POST /ai/analyze — Nexus Write text analysis (Phase 22)
   * The actual AI processing is delegated to the independent Python service.
   * Express validates inputs, checks account status, and never sends raw text
   * to any other party without the user's explicit request.
   */
  router.post('/analyze', requireAuth, requireActive, validate({ body: analyzeTextSchema }), async (req, res) => {
    const { text, features } = req.validated!.body as { text: string; features: string[] };
    // TODO: Forward to Python AI service endpoint when configured. For now
    // return a structured placeholder that conforms to the documented contract
    // so the frontend can integrate against the shape.
    sendSuccess(res, {
      text,
      suggestions: [],
      summary: features.includes('SUMMARY') ? null : undefined,
      rewrite: features.includes('REWRITE') ? null : undefined,
      message: 'AI service not yet configured. Connect the Python AI service to enable analysis.',
    });
  });

  /**
   * POST /ai/query — Contextual AI assistance (Phase 21)
   * Express prepares authorized workspace context before forwarding to the AI
   * service. The AI service must not bypass this authorization layer.
   */
  router.post('/query', requireAuth, requireActive, validate({ body: aiQuerySchema }), async (req, res) => {
    const { workspaceId, query } = req.validated!.body as { workspaceId?: string; query: string; context?: string };

    if (workspaceId) {
      await requireWorkspaceAccess(prisma, { userId: userId(req), workspaceId, capability: WorkspaceCapability.ViewWorkspace });
    }

    sendSuccess(res, {
      query,
      answer: null,
      references: [],
      message: 'AI service not yet configured. Connect the Python AI service to enable queries.',
    });
  });

  /**
   * POST /ai/actions/approve — AI action approval and execution (Phase 23)
   * Users must explicitly approve AI-proposed mutations. Express re-validates
   * permissions immediately before executing any approved action.
   */
  router.post('/actions/approve', requireAuth, requireActive, validate({ body: aiActionApprovalSchema }), async (req, res) => {
    const { workspaceId, actionType, approvedAt } = req.validated!.body as {
      workspaceId: string; actionType: string; approvedAt: string;
    };

    // Re-validate workspace access before executing
    await requireWorkspaceAccess(prisma, { userId: userId(req), workspaceId, capability: WorkspaceCapability.ViewWorkspace });

    // Approval window: 5 minutes
    const approvalAge = Date.now() - new Date(approvedAt).getTime();
    if (approvalAge > 5 * 60 * 1000) {
      throw new AppError(409, 'AI_APPROVAL_EXPIRED', 'The AI action approval has expired');
    }

    sendSuccess(res, {
      actionType,
      executed: false,
      message: 'AI action execution not yet implemented. The approval was valid.',
    });
  });

  return router;
}
