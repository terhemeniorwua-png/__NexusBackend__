CREATE TABLE "BillingCancellation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCancellation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingCancellation_workspaceId_key" ON "BillingCancellation"("workspaceId");
CREATE INDEX "BillingCancellation_status_nextAttemptAt_idx" ON "BillingCancellation"("status", "nextAttemptAt");
ALTER TABLE "BillingCancellation" ADD CONSTRAINT "BillingCancellation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
