-- Add AI-access fields to User
ALTER TABLE "User" ADD COLUMN "aiAccessEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "aiAccessUpdatedAt" TIMESTAMP(3);

-- CreateTable: UserOnboardingState
CREATE TABLE "UserOnboardingState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStep" TEXT NOT NULL DEFAULT 'WELCOME',
    "completedAt" TIMESTAMP(3),
    "skippedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserOnboardingState_pkey" PRIMARY KEY ("id")
);

-- CreateTable: UserLegalAcceptance
CREATE TABLE "UserLegalAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLegalAcceptance_pkey" PRIMARY KEY ("id")
);

-- Backfill: existing users (created before this deploy) are treated as already
-- completed so they are not forced through onboarding. Only accounts created
-- after this deploy get required: true (no UserOnboardingState row exists yet).
INSERT INTO "UserOnboardingState" ("id", "userId", "currentStep", "completedAt", "skippedSteps", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'DONE', now(), ARRAY[]::TEXT[], now(), now()
FROM "User"
WHERE NOT EXISTS (
    SELECT 1 FROM "UserOnboardingState" WHERE "UserOnboardingState"."userId" = "User"."id"
);

-- CreateIndex
CREATE UNIQUE INDEX "UserOnboardingState_userId_key" ON "UserOnboardingState"("userId");
CREATE INDEX "UserOnboardingState_userId_idx" ON "UserOnboardingState"("userId");

CREATE UNIQUE INDEX "UserLegalAcceptance_userId_documentType_version_key" ON "UserLegalAcceptance"("userId", "documentType", "version");
CREATE INDEX "UserLegalAcceptance_userId_documentType_idx" ON "UserLegalAcceptance"("userId", "documentType");
CREATE INDEX "UserLegalAcceptance_userId_idx" ON "UserLegalAcceptance"("userId");

-- AddForeignKey
ALTER TABLE "UserOnboardingState" ADD CONSTRAINT "UserOnboardingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserLegalAcceptance" ADD CONSTRAINT "UserLegalAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
