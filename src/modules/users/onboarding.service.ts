import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { recordSecurityEvent, SecurityAction } from '../auth/security-events';
import {
  CURRENT_LEGAL_VERSIONS,
  getRequiredLegalDocuments,
  isKnownLegalDocumentType,
  ONBOARDING_STEP_ORDER,
  ONBOARDING_STEPS,
  OPTIONAL_ONBOARDING_STEPS,
  SKIPPABLE_ONBOARDING_STEPS,
  type OnboardingStep,
} from './onboarding.config';
import type {
  AcceptLegalDocumentInput,
  AdvanceOnboardingStepInput,
} from './onboarding.schemas';

export interface OnboardingStatus {
  required: boolean;
  currentStep: OnboardingStep | null;
  completedAt: string | null;
  pendingLegal: Array<{ documentType: string; version: string }>;
  aiAccessEnabled: boolean;
  skippedSteps: string[];
}

export interface OnboardingService {
  getStatus(userId: string): Promise<OnboardingStatus>;
  acceptLegalDocument(
    userId: string,
    input: AcceptLegalDocumentInput,
    context?: { ip?: string; userAgent?: string },
  ): Promise<OnboardingStatus>;
  advanceStep(
    userId: string,
    input: AdvanceOnboardingStepInput,
  ): Promise<OnboardingStatus>;
  updateAiAccess(
    userId: string,
    enabled: boolean,
    context?: { ip?: string; userAgent?: string },
  ): Promise<{ aiAccessEnabled: boolean; aiAccessUpdatedAt: string | null }>;
  complete(userId: string): Promise<OnboardingStatus>;
}

function stepIndex(step: string): number {
  return ONBOARDING_STEP_ORDER.indexOf(step as OnboardingStep);
}

function nextStep(step: string): OnboardingStep {
  const index = stepIndex(step);
  if (index < 0 || index >= ONBOARDING_STEP_ORDER.length - 1) {
    return ONBOARDING_STEPS.DONE;
  }
  return ONBOARDING_STEP_ORDER[index + 1] as OnboardingStep;
}

function isStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEP_ORDER as readonly string[]).includes(value);
}

type UserWithOnboarding = Prisma.UserGetPayload<{
  select: {
    id: true;
    deletedAt: true;
    aiAccessEnabled: true;
    aiAccessUpdatedAt: true;
    profile: { select: { id: true } };
    workspaceMemberships: { select: { id: true }; take: 1 };
    ownedWorkspaces: { select: { id: true }; take: 1 };
    onboardingState: true;
  };
}>;

export function createOnboardingService(prisma?: PrismaClient): OnboardingService {
  const client = prisma ?? getPrismaClient();

  async function loadUser(userId: string): Promise<UserWithOnboarding> {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        deletedAt: true,
        aiAccessEnabled: true,
        aiAccessUpdatedAt: true,
        profile: { select: { id: true } },
        workspaceMemberships: { select: { id: true }, take: 1 },
        ownedWorkspaces: { select: { id: true }, take: 1 },
        onboardingState: true,
      },
    });

    if (!user || user.deletedAt) {
      throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
    }

    return user;
  }

  function hasExistingFootprint(user: UserWithOnboarding): boolean {
    return (
      Boolean(user.profile) ||
      user.workspaceMemberships.length > 0 ||
      user.ownedWorkspaces.length > 0
    );
  }

  async function getAcceptedCurrentVersionKeys(userId: string): Promise<Set<string>> {
    const required = getRequiredLegalDocuments();
    if (required.length === 0) {
      return new Set();
    }

    const acceptances = await client.userLegalAcceptance.findMany({
      where: {
        userId,
        OR: required.map((doc) => ({ documentType: doc.documentType, version: doc.version })),
      },
      select: { documentType: true, version: true },
    });

    return new Set(acceptances.map((a) => `${a.documentType}::${a.version}`));
  }

  async function computePendingLegal(userId: string): Promise<Array<{ documentType: string; version: string }>> {
    const acceptedKeys = await getAcceptedCurrentVersionKeys(userId);
    return getRequiredLegalDocuments().filter(
      (doc) => !acceptedKeys.has(`${doc.documentType}::${doc.version}`),
    );
  }

  function normalizeSkippedSteps(raw: string[] | null | undefined): string[] {
    const values = Array.isArray(raw) ? raw : [];
    const unique = new Set(values.filter(isStep));
    return ONBOARDING_STEP_ORDER.filter((step) => unique.has(step));
  }

  function effectiveCurrentStep(
    storedCurrent: string,
    completedAt: Date | null,
    optionalSatisfied: boolean,
  ): OnboardingStep {
    if (completedAt) {
      return ONBOARDING_STEPS.DONE;
    }

    let step: OnboardingStep = isStep(storedCurrent) ? storedCurrent : ONBOARDING_STEPS.WELCOME;

    if (optionalSatisfied) {
      while (OPTIONAL_ONBOARDING_STEPS.has(step) && step !== ONBOARDING_STEPS.DONE) {
        step = nextStep(step);
      }
    }

    return step;
  }

  async function buildStatus(user: UserWithOnboarding): Promise<OnboardingStatus> {
    const pendingLegal = await computePendingLegal(user.id);
    const state = user.onboardingState;
    const optionalSatisfied = hasExistingFootprint(user);
    const completedAt = state?.completedAt ?? null;
    const storedCurrent = state?.currentStep ?? ONBOARDING_STEPS.WELCOME;
    const skippedSteps = normalizeSkippedSteps(state?.skippedSteps);
    const currentStep = effectiveCurrentStep(storedCurrent, completedAt, optionalSatisfied);
    const required = completedAt === null;

    return {
      required,
      currentStep,
      completedAt: completedAt?.toISOString() ?? null,
      pendingLegal,
      aiAccessEnabled: user.aiAccessEnabled,
      skippedSteps,
    };
  }

  async function ensureState(userId: string): Promise<void> {
    await client.userOnboardingState.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  async function loadStateOrDefault(userId: string): Promise<{
    currentStep: string;
    completedAt: Date | null;
    skippedSteps: string[];
  }> {
    const state = await client.userOnboardingState.findUnique({ where: { userId } });
    return {
      currentStep: state?.currentStep ?? ONBOARDING_STEPS.WELCOME,
      completedAt: state?.completedAt ?? null,
      skippedSteps: normalizeSkippedSteps(state?.skippedSteps),
    };
  }

  async function requireAdvanceableToStep(
    user: UserWithOnboarding,
    targetStep: OnboardingStep,
  ): Promise<{ optionalSatisfied: boolean; effectiveStep: OnboardingStep }> {
    const state = await loadStateOrDefault(user.id);
    if (state.completedAt) {
      throw new AppError(409, 'ONBOARDING_ALREADY_COMPLETED', 'Onboarding has already been completed');
    }

    const optionalSatisfied = hasExistingFootprint(user);
    const effectiveStep = effectiveCurrentStep(state.currentStep, state.completedAt, optionalSatisfied);

    if (effectiveStep !== targetStep) {
      throw new AppError(
        409,
        'ONBOARDING_STEP_OUT_OF_ORDER',
        `The current onboarding step is ${effectiveStep}`,
      );
    }

    return { optionalSatisfied, effectiveStep };
  }

  async function assertLegalRequirementsSatisfiedForStep(
    userId: string,
    step: OnboardingStep,
  ): Promise<void> {
    if (step === ONBOARDING_STEPS.TERMS) {
      const terms = CURRENT_LEGAL_VERSIONS.TERMS;
      if (!terms) return;
      const accepted = await client.userLegalAcceptance.findUnique({
        where: {
          userId_documentType_version: {
            userId,
            documentType: 'terms',
            version: terms.version,
          },
        },
        select: { id: true },
      });
      if (!accepted) {
        throw new AppError(
          400,
          'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED',
          'You must accept the current Terms of Service before continuing',
        );
      }
      return;
    }

    if (step === ONBOARDING_STEPS.PRIVACY) {
      const pending = await computePendingLegal(userId);
      if (pending.length > 0) {
        throw new AppError(
          400,
          'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED',
          'You must accept all current required legal documents before continuing',
          { details: { pendingLegal: pending } },
        );
      }
    }
  }

  async function assertNoPendingRequiredLegalBeforeStep(
    userId: string,
    step: OnboardingStep,
  ): Promise<void> {
    const index = stepIndex(step);
    const termsIndex = stepIndex(ONBOARDING_STEPS.TERMS);
    const privacyIndex = stepIndex(ONBOARDING_STEPS.PRIVACY);

    if (index > termsIndex) {
      const terms = CURRENT_LEGAL_VERSIONS.terms;
      if (terms?.required) {
        const accepted = await client.userLegalAcceptance.findUnique({
          where: {
            userId_documentType_version: {
              userId,
              documentType: 'terms',
              version: terms.version,
            },
          },
          select: { id: true },
        });
        if (!accepted) {
          throw new AppError(
            400,
            'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED',
            'You must accept the current Terms of Service before continuing',
          );
        }
      }
    }

    if (index > privacyIndex) {
      const pending = await computePendingLegal(userId);
      if (pending.length > 0) {
        throw new AppError(
          400,
          'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED',
          'You must accept all current required legal documents before continuing',
          { details: { pendingLegal: pending } },
        );
      }
    }
  }

  return {
    async getStatus(userId: string): Promise<OnboardingStatus> {
      const user = await loadUser(userId);
      return buildStatus(user);
    },

    async acceptLegalDocument(userId, input, context): Promise<OnboardingStatus> {
      await loadUser(userId);

      if (!isKnownLegalDocumentType(input.documentType)) {
        throw new AppError(400, 'UNKNOWN_LEGAL_DOCUMENT', 'Unknown legal document type');
      }

      const current = CURRENT_LEGAL_VERSIONS[input.documentType as keyof typeof CURRENT_LEGAL_VERSIONS];
      if (!current || input.version !== current.version) {
        throw new AppError(
          400,
          'STALE_LEGAL_DOCUMENT_VERSION',
          'The provided document version is not current',
        );
      }

      await client.userLegalAcceptance.upsert({
        where: {
          userId_documentType_version: {
            userId,
            documentType: input.documentType,
            version: input.version,
          },
        },
        update: {},
        create: {
          userId,
          documentType: input.documentType,
          version: input.version,
          ...(context?.ip ? { ipAddress: context.ip.slice(0, 128) } : {}),
          ...(context?.userAgent ? { userAgent: context.userAgent.slice(0, 512) } : {}),
        },
      });

      const user = await loadUser(userId);
      return buildStatus(user);
    },

    async advanceStep(userId, input): Promise<OnboardingStatus> {
      const user = await loadUser(userId);
      await ensureState(userId);

      const step = input.step as OnboardingStep;
      if (!isStep(step)) {
        throw new AppError(400, 'INVALID_ONBOARDING_STEP', 'Invalid onboarding step');
      }

      if (step === ONBOARDING_STEPS.DONE) {
        throw new AppError(
          400,
          'INVALID_ONBOARDING_ACTION',
          'Use the complete endpoint to finish onboarding',
        );
      }

      const { effectiveStep } = await requireAdvanceableToStep(user, step);

      if (input.action === 'skip') {
        if (!SKIPPABLE_ONBOARDING_STEPS.has(effectiveStep)) {
          throw new AppError(
            400,
            'ONBOARDING_STEP_NOT_SKIPPABLE',
            'This onboarding step cannot be skipped',
          );
        }
      }

      // Ensure required legal prerequisites are satisfied before acting on/leaving steps.
      await assertNoPendingRequiredLegalBeforeStep(userId, effectiveStep);
      await assertLegalRequirementsSatisfiedForStep(userId, effectiveStep);

      const state = await loadStateOrDefault(userId);
      const skipped = new Set(normalizeSkippedSteps(state.skippedSteps));
      if (input.action === 'skip') {
        skipped.add(effectiveStep);
      } else {
        skipped.delete(effectiveStep);
      }

      const newCurrent = nextStep(effectiveStep);
      await client.userOnboardingState.update({
        where: { userId },
        data: {
          currentStep: newCurrent,
          skippedSteps: ONBOARDING_STEP_ORDER.filter((s) => skipped.has(s)),
        },
      });

      const refreshed = await loadUser(userId);
      return buildStatus(refreshed);
    },

    async updateAiAccess(
      userId,
      enabled,
      context,
    ): Promise<{ aiAccessEnabled: boolean; aiAccessUpdatedAt: string | null }> {
      await loadUser(userId);
      const now = new Date();
      const updated = await client.user.update({
        where: { id: userId },
        data: {
          aiAccessEnabled: enabled,
          aiAccessUpdatedAt: now,
        },
        select: { aiAccessEnabled: true, aiAccessUpdatedAt: true },
      });

      await recordSecurityEvent(client, {
        action: enabled ? SecurityAction.AiAccessEnabled : SecurityAction.AiAccessDisabled,
        targetType: 'User',
        targetId: userId,
        actorId: userId,
        metadata: { enabled },
        ...(context?.ip ? { ip: context.ip } : {}),
        ...(context?.userAgent ? { userAgent: context.userAgent } : {}),
      });

      return {
        aiAccessEnabled: updated.aiAccessEnabled,
        aiAccessUpdatedAt: updated.aiAccessUpdatedAt?.toISOString() ?? null,
      };
    },

    async complete(userId: string): Promise<OnboardingStatus> {
      const user = await loadUser(userId);
      await ensureState(userId);

      const state = await loadStateOrDefault(userId);
      if (state.completedAt) {
        return buildStatus(await loadUser(userId));
      }

      const pending = await computePendingLegal(userId);
      if (pending.length > 0) {
        throw new AppError(
          400,
          'ONBOARDING_LEGAL_ACCEPTANCE_REQUIRED',
          'You must accept all current required legal documents before completing onboarding',
          { details: { pendingLegal: pending } },
        );
      }

      const optionalSatisfied = hasExistingFootprint(user);
      const effectiveStep = effectiveCurrentStep(state.currentStep, null, optionalSatisfied);
      if (effectiveStep !== ONBOARDING_STEPS.DONE) {
        throw new AppError(
          409,
          'ONBOARDING_INCOMPLETE',
          'Complete all required onboarding steps before finishing',
          { details: { currentStep: effectiveStep } },
        );
      }

      await client.userOnboardingState.update({
        where: { userId },
        data: {
          currentStep: ONBOARDING_STEPS.DONE,
          completedAt: new Date(),
        },
      });

      return buildStatus(await loadUser(userId));
    },
  };
}
