-- Feature B: task blocker reports (additive)

CREATE TYPE "TaskBlockerStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_BLOCKER_REPORTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_BLOCKER_RESOLVED';

CREATE TABLE "TaskBlocker" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "status" "TaskBlockerStatus" NOT NULL DEFAULT 'OPEN',
  "description" TEXT NOT NULL,
  "reportedById" TEXT NOT NULL,
  "notifyUserId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskBlocker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskBlocker_taskId_idx" ON "TaskBlocker"("taskId");
CREATE INDEX "TaskBlocker_taskId_status_idx" ON "TaskBlocker"("taskId", "status");
CREATE INDEX "TaskBlocker_reportedById_idx" ON "TaskBlocker"("reportedById");
CREATE INDEX "TaskBlocker_notifyUserId_idx" ON "TaskBlocker"("notifyUserId");

ALTER TABLE "TaskBlocker"
  ADD CONSTRAINT "TaskBlocker_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskBlocker"
  ADD CONSTRAINT "TaskBlocker_reportedById_fkey"
  FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TaskBlocker"
  ADD CONSTRAINT "TaskBlocker_notifyUserId_fkey"
  FOREIGN KEY ("notifyUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TaskBlocker"
  ADD CONSTRAINT "TaskBlocker_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
