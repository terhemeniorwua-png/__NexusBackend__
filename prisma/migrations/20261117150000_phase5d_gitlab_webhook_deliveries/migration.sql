-- CreateTable
CREATE TABLE "GitLabWebhookDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GITLAB',
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "projectIdExternal" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitLabWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitLabWebhookDelivery_provider_deliveryId_key" ON "GitLabWebhookDelivery"("provider", "deliveryId");

-- CreateIndex
CREATE INDEX "GitLabWebhookDelivery_event_idx" ON "GitLabWebhookDelivery"("event");

-- CreateIndex
CREATE INDEX "GitLabWebhookDelivery_createdAt_idx" ON "GitLabWebhookDelivery"("createdAt");
