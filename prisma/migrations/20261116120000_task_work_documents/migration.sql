-- Feature A: task work documents and versioned JSON content (additive)
CREATE TABLE "TaskDocument" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "TaskDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskDocumentVersion" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "content" JSONB NOT NULL,
  "savedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskDocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskDocument_taskId_idx" ON "TaskDocument"("taskId");
CREATE INDEX "TaskDocument_taskId_deletedAt_idx" ON "TaskDocument"("taskId", "deletedAt");
CREATE INDEX "TaskDocument_createdById_idx" ON "TaskDocument"("createdById");

CREATE UNIQUE INDEX "TaskDocumentVersion_documentId_version_key" ON "TaskDocumentVersion"("documentId", "version");
CREATE INDEX "TaskDocumentVersion_documentId_createdAt_idx" ON "TaskDocumentVersion"("documentId", "createdAt");
CREATE INDEX "TaskDocumentVersion_savedById_idx" ON "TaskDocumentVersion"("savedById");

ALTER TABLE "TaskDocument"
  ADD CONSTRAINT "TaskDocument_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskDocument"
  ADD CONSTRAINT "TaskDocument_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TaskDocumentVersion"
  ADD CONSTRAINT "TaskDocumentVersion_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "TaskDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskDocumentVersion"
  ADD CONSTRAINT "TaskDocumentVersion_savedById_fkey"
  FOREIGN KEY ("savedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
