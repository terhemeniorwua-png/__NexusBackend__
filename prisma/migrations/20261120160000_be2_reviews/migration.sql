-- BE-2: shared project-scoped submission reviews and append-only decisions.
-- Applies after 20261120150000_be4_checklists. New tables only; no backfill.

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "ReviewDecisionType" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED');

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "attachmentVersionId" TEXT,
    "checklistId" TEXT,
    "checklistRevision" INTEGER,
    "status" "ReviewStatus" NOT NULL DEFAULT 'SUBMITTED',
    "round" INTEGER NOT NULL DEFAULT 1,
    "submittedById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewDecision" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "decision" "ReviewDecisionType" NOT NULL,
    "note" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Review_workspaceId_projectId_idx" ON "Review"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "Review_projectId_createdAt_id_idx" ON "Review"("projectId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Review_attachmentVersionId_idx" ON "Review"("attachmentVersionId");

-- CreateIndex
CREATE INDEX "Review_checklistId_checklistRevision_idx" ON "Review"("checklistId", "checklistRevision");

-- CreateIndex
CREATE INDEX "Review_submittedById_idx" ON "Review"("submittedById");

-- CreateIndex
CREATE INDEX "Review_assigneeId_idx" ON "Review"("assigneeId");

-- CreateIndex
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

-- CreateIndex: at most one open review per attachment version.
CREATE UNIQUE INDEX "Review_attachmentVersion_open_key"
    ON "Review"("attachmentVersionId")
    WHERE "status" IN ('SUBMITTED', 'UNDER_REVIEW');

-- CreateIndex: at most one open review per checklist revision.
CREATE UNIQUE INDEX "Review_checklist_open_key"
    ON "Review"("checklistId", "checklistRevision")
    WHERE "status" IN ('SUBMITTED', 'UNDER_REVIEW');

-- CreateIndex
CREATE UNIQUE INDEX "ReviewDecision_reviewId_round_key" ON "ReviewDecision"("reviewId", "round");

-- CreateIndex
CREATE INDEX "ReviewDecision_decidedById_idx" ON "ReviewDecision"("decidedById");

-- CreateIndex
CREATE INDEX "ReviewDecision_reviewId_decidedAt_idx" ON "ReviewDecision"("reviewId", "decidedAt");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_attachmentVersionId_fkey" FOREIGN KEY ("attachmentVersionId") REFERENCES "AttachmentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "Checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Check constraints (raw SQL; Prisma schema cannot express CHECK)
ALTER TABLE "Review" ADD CONSTRAINT "Review_exactly_one_target" CHECK (("attachmentVersionId" IS NULL) <> ("checklistId" IS NULL));
ALTER TABLE "Review" ADD CONSTRAINT "Review_round_positive" CHECK ("round" > 0);
ALTER TABLE "Review" ADD CONSTRAINT "Review_checklistRevision_positive" CHECK ("checklistRevision" IS NULL OR "checklistRevision" > 0);
ALTER TABLE "Review" ADD CONSTRAINT "Review_checklistRevision_iff_checklist" CHECK (("checklistRevision" IS NULL) = ("checklistId" IS NULL));
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_round_positive" CHECK ("round" > 0);
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_note_length" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 2000);
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_note_nonblank" CHECK ("note" IS NULL OR btrim("note") <> '');
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_note_required_for_negative_decisions" CHECK ("decision" = 'APPROVED' OR "note" IS NOT NULL);
