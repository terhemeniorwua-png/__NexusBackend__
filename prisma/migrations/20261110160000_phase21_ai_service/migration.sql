-- Phase 21-23: AI service conversations, usage, actions and writing sessions.

CREATE TYPE "AiConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "AiMessageStatus" AS ENUM ('COMPLETED', 'FAILED');
CREATE TYPE "AiUsageStatus" AS ENUM ('SUCCESS', 'FAILURE');
CREATE TYPE "AiActionType" AS ENUM ('CREATE_TASK', 'ADD_TASK_COMMENT', 'COMPLETE_TASK', 'CREATE_DOCUMENT', 'SEND_NOTIFICATION');
CREATE TYPE "AiActionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "AiWritingStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'DISMISSED', 'EXPIRED');

CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "title" TEXT NOT NULL,
    "status" "AiConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "contextType" TEXT,
    "contextId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "AiMessageStatus" NOT NULL DEFAULT 'COMPLETED',
    "model" TEXT,
    "tokenCount" INTEGER,
    "references" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiUsageRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "conversationId" TEXT,
    "operation" TEXT NOT NULL,
    "model" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "status" "AiUsageStatus" NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiActionProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "actionType" "AiActionType" NOT NULL,
    "status" "AiActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "payload" JSONB NOT NULL,
    "sourceReferences" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "executionResult" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiActionProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiActionApproval" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiActionApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiWritingSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "status" "AiWritingStatus" NOT NULL DEFAULT 'ACTIVE',
    "originalText" TEXT NOT NULL,
    "suggestions" JSONB NOT NULL,
    "detectedTone" TEXT,
    "summary" TEXT,
    "acceptedSuggestionIds" JSONB,
    "dismissedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiWritingSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiActionProposal_idempotencyKey_key" ON "AiActionProposal"("idempotencyKey");
CREATE INDEX "AiConversation_userId_updatedAt_idx" ON "AiConversation"("userId", "updatedAt");
CREATE INDEX "AiConversation_workspaceId_updatedAt_idx" ON "AiConversation"("workspaceId", "updatedAt");
CREATE INDEX "AiConversation_status_idx" ON "AiConversation"("status");
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");
CREATE INDEX "AiUsageRecord_userId_createdAt_idx" ON "AiUsageRecord"("userId", "createdAt");
CREATE INDEX "AiUsageRecord_workspaceId_createdAt_idx" ON "AiUsageRecord"("workspaceId", "createdAt");
CREATE INDEX "AiUsageRecord_operation_createdAt_idx" ON "AiUsageRecord"("operation", "createdAt");
CREATE INDEX "AiUsageRecord_status_createdAt_idx" ON "AiUsageRecord"("status", "createdAt");
CREATE INDEX "AiActionProposal_workspaceId_status_idx" ON "AiActionProposal"("workspaceId", "status");
CREATE INDEX "AiActionProposal_userId_createdAt_idx" ON "AiActionProposal"("userId", "createdAt");
CREATE INDEX "AiActionProposal_status_expiresAt_idx" ON "AiActionProposal"("status", "expiresAt");
CREATE INDEX "AiActionApproval_proposalId_createdAt_idx" ON "AiActionApproval"("proposalId", "createdAt");
CREATE INDEX "AiActionApproval_userId_idx" ON "AiActionApproval"("userId");
CREATE INDEX "AiWritingSession_userId_createdAt_idx" ON "AiWritingSession"("userId", "createdAt");
CREATE INDEX "AiWritingSession_status_expiresAt_idx" ON "AiWritingSession"("status", "expiresAt");

ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsageRecord" ADD CONSTRAINT "AiUsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsageRecord" ADD CONSTRAINT "AiUsageRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiActionProposal" ADD CONSTRAINT "AiActionProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiActionProposal" ADD CONSTRAINT "AiActionProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiActionProposal" ADD CONSTRAINT "AiActionProposal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiActionApproval" ADD CONSTRAINT "AiActionApproval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "AiActionProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiActionApproval" ADD CONSTRAINT "AiActionApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiWritingSession" ADD CONSTRAINT "AiWritingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiWritingSession" ADD CONSTRAINT "AiWritingSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
