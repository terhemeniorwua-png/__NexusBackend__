-- BE task-target reviews: add task target, artwork URL, and decisions.
-- Extends BE-2 Review. Existing attachment/checklist rows remain valid.

-- AlterTable
ALTER TABLE "Review"
  ADD COLUMN "taskId" TEXT,
  ADD COLUMN "artworkUrl" VARCHAR(2048),
  ADD COLUMN "decisions" JSONB;

-- CreateIndex
CREATE INDEX "Review_taskId_idx" ON "Review"("taskId");

-- CreateIndex: at most one open review per task.
CREATE UNIQUE INDEX "Review_task_open_key"
  ON "Review"("taskId")
  WHERE "status" IN ('SUBMITTED', 'UNDER_REVIEW');

-- AddForeignKey
ALTER TABLE "Review"
  ADD CONSTRAINT "Review_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Replace two-way target CHECK with a three-way target CHECK.
ALTER TABLE "Review" DROP CONSTRAINT "Review_exactly_one_target";
ALTER TABLE "Review" ADD CONSTRAINT "Review_exactly_one_target" CHECK (
  (
    (CASE WHEN "attachmentVersionId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "checklistId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "taskId" IS NOT NULL THEN 1 ELSE 0 END)
  ) = 1
);

-- Task-only metadata: artworkUrl/decisions are only valid for task-target reviews.
ALTER TABLE "Review" ADD CONSTRAINT "Review_task_metadata_only_for_task_target" CHECK (
  "taskId" IS NOT NULL OR ("artworkUrl" IS NULL AND "decisions" IS NULL)
);
