-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AuthToken" ADD COLUMN     "targetEmail" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
