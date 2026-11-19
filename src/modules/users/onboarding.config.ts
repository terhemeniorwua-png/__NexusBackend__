/**
 * Onboarding flow configuration.
 *
 * `CURRENT_LEGAL_VERSIONS` is the single source of truth for which legal
 * documents exist and which version is current. Publishing a new version only
 * requires changing the version string here; users will be asked to accept the
 * document again only when their accepted version no longer matches.
 */

export const ONBOARDING_STEPS = {
  WELCOME: 'welcome',
  TERMS: 'terms',
  PRIVACY: 'privacy',
  PROFILE: 'profile',
  INVITE: 'invite',
  AI: 'ai',
  DONE: 'done',
} as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[keyof typeof ONBOARDING_STEPS];

export const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = [
  ONBOARDING_STEPS.WELCOME,
  ONBOARDING_STEPS.TERMS,
  ONBOARDING_STEPS.PRIVACY,
  ONBOARDING_STEPS.PROFILE,
  ONBOARDING_STEPS.INVITE,
  ONBOARDING_STEPS.AI,
  ONBOARDING_STEPS.DONE,
] as const;

export const OPTIONAL_ONBOARDING_STEPS = new Set<OnboardingStep>([
  ONBOARDING_STEPS.PROFILE,
  ONBOARDING_STEPS.INVITE,
  ONBOARDING_STEPS.AI,
]);

export const SKIPPABLE_ONBOARDING_STEPS = new Set<OnboardingStep>([
  ONBOARDING_STEPS.PROFILE,
  ONBOARDING_STEPS.INVITE,
  ONBOARDING_STEPS.AI,
]);

export const REQUIRED_ONBOARDING_STEPS = new Set<OnboardingStep>([
  ONBOARDING_STEPS.TERMS,
  ONBOARDING_STEPS.PRIVACY,
]);

export interface LegalDocumentVersion {
  /** Current published version string for this document. */
  version: string;
  /** When true, acceptance at the current version is required to complete onboarding. */
  required: boolean;
}

/**
 * Current legal document versions.
 *
 * Keys are document type identifiers (e.g. terms, privacy). Add new required
 * policies here to require acceptance during onboarding.
 */
export const CURRENT_LEGAL_VERSIONS: Readonly<Record<string, LegalDocumentVersion>> = {
  terms: { version: '1.0', required: true },
  privacy: { version: '1.0', required: true },
};

export function isKnownLegalDocumentType(documentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENT_LEGAL_VERSIONS, documentType);
}

export function getRequiredLegalDocuments(): Array<{ documentType: string; version: string }> {
  return Object.entries(CURRENT_LEGAL_VERSIONS)
    .filter(([, config]) => config.required)
    .map(([documentType, config]) => ({ documentType, version: config.version }));
}
