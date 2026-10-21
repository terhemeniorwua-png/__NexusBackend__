-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'MANUAL');

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "headers" JSONB,
    "metadata" JSONB,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "complainedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "provider" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_idempotencyKey_key" ON "EmailDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_nextAttemptAt_idx" ON "EmailDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_toAddress_idx" ON "EmailDelivery"("toAddress");

-- CreateIndex
CREATE INDEX "EmailDelivery_template_idx" ON "EmailDelivery"("template");

-- CreateIndex
CREATE INDEX "EmailDelivery_providerMessageId_idx" ON "EmailDelivery"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_emailAddress_key" ON "EmailSuppression"("emailAddress");

-- CreateIndex
CREATE UNIQUE INDEX "EmailWebhookEvent_providerEventId_key" ON "EmailWebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "EmailWebhookEvent_provider_type_idx" ON "EmailWebhookEvent"("provider", "type");

-- CreateIndex
CREATE INDEX "EmailWebhookEvent_processedAt_idx" ON "EmailWebhookEvent"("processedAt");

