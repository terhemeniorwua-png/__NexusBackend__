-- Phase 26: audit security classification and retention pruning support.
--
-- Adds a `securityEvent` flag to `AuditLog` so security-relevant actions
-- (ownership transfer, role/permission changes, member removal, join-code
-- rotation, etc.) can be queried and monitored separately from routine audit
-- entries. Existing rows are not security events by default.
ALTER TABLE "AuditLog"
  ADD COLUMN "securityEvent" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AuditLog_securityEvent_idx" ON "AuditLog"("securityEvent");
CREATE INDEX "AuditLog_workspaceId_securityEvent_createdAt_idx" ON "AuditLog"("workspaceId", "securityEvent", "createdAt");
