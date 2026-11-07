CREATE TYPE "PrivacyRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'ERASURE', 'REDACTION');
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED');

CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "PrivacyRequestType" NOT NULL,
  "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
  "description" TEXT,
  "targetType" TEXT,
  "targetId" TEXT,
  "reviewedById" TEXT,
  "decisionNote" TEXT,
  "outcome" TEXT,
  "decidedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrivacyRequest_userId_createdAt_idx" ON "PrivacyRequest"("userId", "createdAt");
CREATE INDEX "PrivacyRequest_status_createdAt_idx" ON "PrivacyRequest"("status", "createdAt");
CREATE INDEX "PrivacyRequest_reviewedById_idx" ON "PrivacyRequest"("reviewedById");
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
