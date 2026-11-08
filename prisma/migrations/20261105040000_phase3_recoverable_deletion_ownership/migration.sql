ALTER TYPE "WorkspaceStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';

ALTER TABLE "User"
  ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Workspace"
  ADD COLUMN "deletionSuspendedAt" TIMESTAMP(3);

ALTER TABLE "Subscription"
  ADD COLUMN "billingOwnerId" TEXT;
ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_billingOwnerId_fkey"
  FOREIGN KEY ("billingOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WorkspaceOwnershipTransfer" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "initiatedById" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "previousOwnerRole" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "billingAcceptedAt" TIMESTAMP(3),
  "billingAcceptedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspaceOwnershipTransfer_workspaceId_status_idx"
  ON "WorkspaceOwnershipTransfer"("workspaceId", "status");
CREATE INDEX "WorkspaceOwnershipTransfer_recipientUserId_status_idx"
  ON "WorkspaceOwnershipTransfer"("recipientUserId", "status");
CREATE INDEX "WorkspaceOwnershipTransfer_expiresAt_idx"
  ON "WorkspaceOwnershipTransfer"("expiresAt");

ALTER TABLE "WorkspaceOwnershipTransfer"
  ADD CONSTRAINT "WorkspaceOwnershipTransfer_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceOwnershipTransfer"
  ADD CONSTRAINT "WorkspaceOwnershipTransfer_initiatedById_fkey"
  FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceOwnershipTransfer"
  ADD CONSTRAINT "WorkspaceOwnershipTransfer_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceOwnershipTransfer"
  ADD CONSTRAINT "WorkspaceOwnershipTransfer_billingAcceptedById_fkey"
  FOREIGN KEY ("billingAcceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
