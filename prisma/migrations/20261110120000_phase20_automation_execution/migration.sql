-- Phase 20: automation execution engine support.
-- Adds idempotency keys, queued payloads and retry scheduling to AutomationRun.

ALTER TABLE "AutomationRun" ADD COLUMN "eventKey" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "payload" JSONB;
ALTER TABLE "AutomationRun" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "AutomationRun_automationId_eventKey_key" ON "AutomationRun"("automationId", "eventKey");
CREATE INDEX "AutomationRun_status_nextAttemptAt_idx" ON "AutomationRun"("status", "nextAttemptAt");
