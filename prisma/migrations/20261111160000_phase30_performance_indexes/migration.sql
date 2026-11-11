-- Phase 30: index additions for analytics and audit query patterns.
--
-- Analytics snapshots filter tasks by creation/completion time across a
-- workspace, and the audit prune worker scans AuditLog by createdAt.
-- These indexes keep those read-only aggregation queries from scanning
-- large tables as the workspace grows.

CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_completedAt_idx" ON "Task"("completedAt");
CREATE INDEX "FileAttachment_workspaceId_createdAt_idx" ON "FileAttachment"("workspaceId", "createdAt");
