-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SECURITY_ALERT';

-- CreateIndex
CREATE INDEX "ScimToken_tokenHash_idx" ON "ScimToken"("tokenHash");
