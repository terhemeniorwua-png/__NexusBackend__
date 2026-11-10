-- Phase 18 search, Phase 19 integration lifecycle and outbound webhooks.

-- ---------------------------------------------------------------------------
-- Phase 18: searchable file text and per-user search history
-- ---------------------------------------------------------------------------

ALTER TABLE "FileAttachment" ADD COLUMN "extractedText" TEXT;
ALTER TABLE "FileAttachment" ADD COLUMN "textExtractedAt" TIMESTAMP(3);

CREATE TABLE "SearchHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "query" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SearchHistory_userId_createdAt_idx" ON "SearchHistory"("userId", "createdAt");
CREATE INDEX "SearchHistory_userId_query_idx" ON "SearchHistory"("userId", "query");
CREATE INDEX "SearchHistory_workspaceId_idx" ON "SearchHistory"("workspaceId");

ALTER TABLE "SearchHistory" ADD CONSTRAINT "SearchHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SearchHistory" ADD CONSTRAINT "SearchHistory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Trigram indexes accelerate the case-insensitive substring search used by the
-- central search service. They are created in SQL because Prisma does not
-- model expression/operator-class indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Project_name_trgm_idx" ON "Project" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Project_description_trgm_idx" ON "Project" USING GIN ("description" gin_trgm_ops);
CREATE INDEX "Project_key_trgm_idx" ON "Project" USING GIN ("key" gin_trgm_ops);
CREATE INDEX "Task_title_trgm_idx" ON "Task" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Task_description_trgm_idx" ON "Task" USING GIN ("description" gin_trgm_ops);
CREATE INDEX "Document_title_trgm_idx" ON "Document" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Document_content_trgm_idx" ON "Document" USING GIN ("content" gin_trgm_ops);
CREATE INDEX "FileAttachment_fileName_trgm_idx" ON "FileAttachment" USING GIN ("fileName" gin_trgm_ops);
CREATE INDEX "FileAttachment_extractedText_trgm_idx" ON "FileAttachment" USING GIN ("extractedText" gin_trgm_ops);
CREATE INDEX "Message_body_trgm_idx" ON "Message" USING GIN ("body" gin_trgm_ops);
CREATE INDEX "Channel_name_trgm_idx" ON "Channel" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Team_name_trgm_idx" ON "Team" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Department_name_trgm_idx" ON "Department" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Workspace_name_trgm_idx" ON "Workspace" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Workspace_slug_trgm_idx" ON "Workspace" USING GIN ("slug" gin_trgm_ops);
CREATE INDEX "Meeting_title_trgm_idx" ON "Meeting" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "User_email_trgm_idx" ON "User" USING GIN ("email" gin_trgm_ops);

-- Full-text expression indexes are the foundation for the next search stage.
CREATE INDEX "Document_fts_idx" ON "Document" USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("content", '')));
CREATE INDEX "Task_fts_idx" ON "Task" USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("description", '')));
CREATE INDEX "Message_fts_idx" ON "Message" USING GIN (to_tsvector('simple', coalesce("body", '')));

-- ---------------------------------------------------------------------------
-- Phase 19: integration lifecycle and durable sync jobs
-- ---------------------------------------------------------------------------

CREATE TYPE "IntegrationSyncStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "Integration" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Integration" ADD COLUMN "lastError" TEXT;
ALTER TABLE "Integration" ADD COLUMN "lastRefreshedAt" TIMESTAMP(3);
ALTER TABLE "Integration" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "Integration" ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "Integration_enabled_status_idx" ON "Integration"("enabled", "status");

CREATE TABLE "IntegrationSyncJob" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" "IntegrationSyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSyncJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrationSyncJob_status_nextAttemptAt_idx" ON "IntegrationSyncJob"("status", "nextAttemptAt");
CREATE INDEX "IntegrationSyncJob_integrationId_createdAt_idx" ON "IntegrationSyncJob"("integrationId", "createdAt");

ALTER TABLE "IntegrationSyncJob" ADD CONSTRAINT "IntegrationSyncJob_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Outbound webhook subscriptions and durable delivery queue
-- ---------------------------------------------------------------------------

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookSubscription_workspaceId_enabled_idx" ON "WebhookSubscription"("workspaceId", "enabled");
CREATE INDEX "WebhookSubscription_createdById_idx" ON "WebhookSubscription"("createdById");

ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId", "createdAt");

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
