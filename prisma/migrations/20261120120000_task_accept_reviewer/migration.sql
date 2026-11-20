-- CreateEnum
CREATE TYPE "TaskAssigneeAcceptanceStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TASK_DECLINED';

-- AlterTable
ALTER TABLE "TaskAssignee"
ADD COLUMN "acceptanceStatus" "TaskAssigneeAcceptanceStatus" NOT NULL DEFAULT 'ACCEPTED',
ADD COLUMN "acceptedAt" TIMESTAMP(3),
ADD COLUMN "declinedAt" TIMESTAMP(3),
ADD COLUMN "declineReason" TEXT;

-- New assignee rows default to PENDING; existing rows were backfilled as ACCEPTED above.
ALTER TABLE "TaskAssignee" ALTER COLUMN "acceptanceStatus" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Task"
ADD COLUMN "reviewerId" TEXT,
ADD COLUMN "startedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Task_reviewerId_idx" ON "Task"("reviewerId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
