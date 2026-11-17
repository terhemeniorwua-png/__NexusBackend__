-- Additive integration sync/import support (Phase 19 extensions)

-- AlterTable
ALTER TABLE "Integration"
ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "syncState" JSONB NOT NULL DEFAULT '{}';

-- CreateEnum
CREATE TYPE "IntegrationSyncJobType" AS ENUM ('SYNC', 'INBOUND_WEBHOOK', 'OUTBOUND_EVENT');

-- AlterTable
ALTER TABLE "IntegrationSyncJob"
ADD COLUMN "type" "IntegrationSyncJobType" NOT NULL DEFAULT 'SYNC',
ADD COLUMN "dedupeKey" TEXT,
ADD COLUMN "payload" JSONB,
ADD COLUMN "result" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSyncJob_integrationId_dedupeKey_key" ON "IntegrationSyncJob"("integrationId", "dedupeKey");

-- CreateTable
CREATE TABLE "IntegrationEventLink" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "workspaceId" TEXT,
    "externalType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "localType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationEventLink_pkey" PRIMARY KEY ("id")
);

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('CLICKUP', 'TRELLO', 'CSV');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PREVIEWED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportJobMode" AS ENUM ('DRY_RUN', 'EXECUTE');

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "mode" "ImportJobMode" NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "report" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportExternalId" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "externalType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "localType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportExternalId_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationEventLink_integrationId_externalType_externalId_key" ON "IntegrationEventLink"("integrationId", "externalType", "externalId");

-- CreateIndex
CREATE INDEX "IntegrationEventLink_provider_workspaceId_localType_localId_idx" ON "IntegrationEventLink"("provider", "workspaceId", "localType", "localId");

-- CreateIndex
CREATE INDEX "IntegrationEventLink_workspaceId_provider_idx" ON "IntegrationEventLink"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJob_workspaceId_idempotencyKey_key" ON "ImportJob"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ImportJob_workspaceId_source_createdAt_idx" ON "ImportJob"("workspaceId", "source", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_status_createdAt_idx" ON "ImportJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportExternalId_workspaceId_source_externalType_externalId_key" ON "ImportExternalId"("workspaceId", "source", "externalType", "externalId");

-- CreateIndex
CREATE INDEX "ImportExternalId_jobId_idx" ON "ImportExternalId"("jobId");

-- CreateIndex
CREATE INDEX "ImportExternalId_workspaceId_source_idx" ON "ImportExternalId"("workspaceId", "source");

-- AddForeignKey
ALTER TABLE "IntegrationEventLink" ADD CONSTRAINT "IntegrationEventLink_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEventLink" ADD CONSTRAINT "IntegrationEventLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportExternalId" ADD CONSTRAINT "ImportExternalId_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportExternalId" ADD CONSTRAINT "ImportExternalId_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
