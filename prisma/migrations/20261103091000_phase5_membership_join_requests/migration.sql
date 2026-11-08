-- Phase 5: organisation discovery, join requests and membership suspension.
--
-- Discovery and join links are opt-in. Every workspace starts PRIVATE and
-- without a join code, so existing workspaces do not become discoverable.
-- Membership rows start ACTIVE, preserving the previous behaviour.

CREATE TYPE "WorkspaceVisibility" AS ENUM ('PRIVATE', 'PUBLIC');
CREATE TYPE "WorkspaceMembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

ALTER TABLE "Workspace" ADD COLUMN "visibility" "WorkspaceVisibility" NOT NULL DEFAULT 'PRIVATE';
ALTER TABLE "Workspace" ADD COLUMN "joinCodeHash" TEXT;

CREATE UNIQUE INDEX "Workspace_joinCodeHash_key" ON "Workspace"("joinCodeHash");
CREATE INDEX "Workspace_visibility_idx" ON "Workspace"("visibility");

ALTER TABLE "WorkspaceMembership" ADD COLUMN "status" "WorkspaceMembershipStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "WorkspaceMembership_workspaceId_status_idx" ON "WorkspaceMembership"("workspaceId", "status");

CREATE TABLE "JoinRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "teamId" TEXT,
    "message" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pendingKey" TEXT,

    CONSTRAINT "JoinRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JoinRequest_pendingKey_key" ON "JoinRequest"("pendingKey");
CREATE INDEX "JoinRequest_workspaceId_status_idx" ON "JoinRequest"("workspaceId", "status");
CREATE INDEX "JoinRequest_userId_status_idx" ON "JoinRequest"("userId", "status");
CREATE INDEX "JoinRequest_status_expiresAt_idx" ON "JoinRequest"("status", "expiresAt");
CREATE INDEX "JoinRequest_reviewedById_idx" ON "JoinRequest"("reviewedById");
CREATE INDEX "JoinRequest_teamId_idx" ON "JoinRequest"("teamId");

ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Notification categories for the join-request and suspension workflows.
ALTER TYPE "NotificationType" ADD VALUE 'MEMBERSHIP_SUSPENDED';
ALTER TYPE "NotificationType" ADD VALUE 'MEMBERSHIP_RESTORED';
ALTER TYPE "NotificationType" ADD VALUE 'JOIN_REQUEST_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'JOIN_REQUEST_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'JOIN_REQUEST_REJECTED';
