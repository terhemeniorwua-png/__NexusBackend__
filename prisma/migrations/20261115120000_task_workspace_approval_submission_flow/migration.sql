-- Phase 3: task working environment approval/submission support.
-- Additive, non-destructive: adds task approval flags and latest submission/review state.
-- Existing rows keep requiresApproval=false and NULL submission/review fields.

ALTER TABLE "Task"
  ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "expectedDeliverables" JSONB,
  ADD COLUMN "submissionSummary" TEXT,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "submittedById" TEXT,
  ADD COLUMN "reviewFeedback" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT;

CREATE INDEX "Task_submittedById_idx" ON "Task"("submittedById");
CREATE INDEX "Task_reviewedById_idx" ON "Task"("reviewedById");

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
