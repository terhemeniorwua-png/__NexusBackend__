
CREATE TABLE IF NOT EXISTS  "BillingSeatSync" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "requestedSeats" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "providerSubscriptionCode" TEXT,
  "providerManageTokenCiphertext" TEXT,
  "previousSubscriptionCode" TEXT,
  "previousManageTokenCiphertext" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingSeatSync_pkey" PRIMARY KEY ("id")
);



CREATE UNIQUE INDEX "BillingSeatSync_workspaceId_key" ON "BillingSeatSync"("workspaceId");

CREATE INDEX "BillingSeatSync_status_nextAttemptAt_idx" ON "BillingSeatSync"("status", "nextAttemptAt");


ALTER TABLE "BillingSeatSync" ADD CONSTRAINT "BillingSeatSync_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;