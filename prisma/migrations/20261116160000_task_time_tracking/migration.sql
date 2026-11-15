-- Feature C: task time tracking and workspace time-tracking toggle (additive)

ALTER TABLE "Workspace"
  ADD COLUMN "timeTrackingEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "TaskTimeEntry" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskTimeEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskTimeEntry_taskId_idx" ON "TaskTimeEntry"("taskId");
CREATE INDEX "TaskTimeEntry_taskId_userId_idx" ON "TaskTimeEntry"("taskId", "userId");
CREATE INDEX "TaskTimeEntry_userId_idx" ON "TaskTimeEntry"("userId");
CREATE INDEX "TaskTimeEntry_startedAt_idx" ON "TaskTimeEntry"("startedAt");

ALTER TABLE "TaskTimeEntry"
  ADD CONSTRAINT "TaskTimeEntry_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskTimeEntry"
  ADD CONSTRAINT "TaskTimeEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
