-- DropIndex
DROP INDEX "EmailWebhookEvent_providerEventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "EmailWebhookEvent_provider_providerEventId_key" ON "EmailWebhookEvent"("provider", "providerEventId");
