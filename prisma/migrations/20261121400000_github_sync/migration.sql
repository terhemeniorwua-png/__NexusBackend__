-- BE-6 GitHub sync: PR merge -> task review-ready, PR review state on TaskDevLink
ALTER TABLE "TaskDevLink" ADD COLUMN "reviewState" TEXT;
ALTER TABLE "TaskDevLink" ADD COLUMN "reviewerLogin" TEXT;
ALTER TABLE "TaskDevLink" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "TaskDevLink" ADD COLUMN "mergedAt" TIMESTAMP(3);

-- Raw SQL CHECK: only allowed review states
ALTER TABLE "TaskDevLink" ADD CONSTRAINT "TaskDevLink_reviewState_check"
  CHECK ("reviewState" IS NULL OR "reviewState" IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'));
