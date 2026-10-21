-- The unique index on (workspaceId, email) blocked a new invitation for an
-- address that already had one, even after it was accepted, revoked or
-- expired. The pending key replaces it: it is only set while an invitation
-- is pending and is cleared when the invitation leaves that state, so a
-- pending invitation is still unique per address and a settled one never
-- blocks the next invitation.
DROP INDEX "Invitation_workspaceId_email_key";

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN "pendingKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_pendingKey_key" ON "Invitation"("pendingKey");

-- The accepting account is now protected by a foreign key, so a deleted
-- account cannot leave a dangling reference behind.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
