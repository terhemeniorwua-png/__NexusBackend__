-- CreateTable
CREATE TABLE "GitHubWebhookDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GITHUB',
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "installationId" TEXT,
    "repositoryFullName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWebhookDelivery_provider_deliveryId_key" ON "GitHubWebhookDelivery"("provider", "deliveryId");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_event_idx" ON "GitHubWebhookDelivery"("event");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_installationId_idx" ON "GitHubWebhookDelivery"("installationId");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_createdAt_idx" ON "GitHubWebhookDelivery"("createdAt");
