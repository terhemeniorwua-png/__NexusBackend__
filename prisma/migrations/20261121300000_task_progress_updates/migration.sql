-- BE-8: task progress updates (additive)
-- Append-only progress updates recorded against a task. No edit/delete routes.

CREATE TABLE "TaskProgressUpdate" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "percent" INTEGER,
  "clientRequestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TaskProgressUpdate_pkey" PRIMARY KEY ("id")
);

-- Self-reported percent never changes computeProgress, project progress,
-- analytics or task status; it is informational only.
ALTER TABLE "TaskProgressUpdate"
  ADD CONSTRAINT "TaskProgressUpdate_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskProgressUpdate"
  ADD CONSTRAINT "TaskProgressUpdate_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- note: 1 to 2000 trimmed characters
ALTER TABLE "TaskProgressUpdate"
  ADD CONSTRAINT "TaskProgressUpdate_note_length_chk"
  CHECK (char_length(trim("note")) >= 1 AND char_length(trim("note")) <= 2000);

-- percent: nullable 0..100
ALTER TABLE "TaskProgressUpdate"
  ADD CONSTRAINT "TaskProgressUpdate_percent_range_chk"
  CHECK ("percent" IS NULL OR ("percent" >= 0 AND "percent" <= 100));

-- clientRequestId: optional, at most 64 characters
ALTER TABLE "TaskProgressUpdate"
  ADD CONSTRAINT "TaskProgressUpdate_client_request_id_length_chk"
  CHECK ("clientRequestId" IS NULL OR char_length("clientRequestId") <= 64);

-- Lookup a task's updates in reverse-chronological order.
CREATE INDEX "TaskProgressUpdate_taskId_createdAt_idx"
  ON "TaskProgressUpdate"("taskId", "createdAt" DESC);

-- Idempotency key: one posted update per (task, author, clientRequestId).
CREATE UNIQUE INDEX "TaskProgressUpdate_taskId_authorId_clientRequestId_key"
  ON "TaskProgressUpdate"("taskId", "authorId", "clientRequestId")
  WHERE "clientRequestId" IS NOT NULL;
