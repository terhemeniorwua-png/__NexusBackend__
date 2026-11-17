-- CreateEnum
CREATE TYPE "DevLinkType" AS ENUM ('BRANCH', 'PULL_REQUEST', 'COMMIT');

-- CreateTable
CREATE TABLE "TaskDevLink" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectRepositoryId" TEXT,
    "provider" "DevIntegrationProvider" NOT NULL,
    "externalType" "DevLinkType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalNumber" INTEGER,
    "title" TEXT,
    "url" TEXT,
    "ref" TEXT,
    "headRef" TEXT,
    "baseRef" TEXT,
    "state" TEXT,
    "repositoryFullName" TEXT,
    "linkedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskDevLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskDevLink_taskId_provider_externalType_externalId_key" ON "TaskDevLink"("taskId", "provider", "externalType", "externalId");

-- CreateIndex
CREATE INDEX "TaskDevLink_taskId_idx" ON "TaskDevLink"("taskId");

-- CreateIndex
CREATE INDEX "TaskDevLink_projectId_idx" ON "TaskDevLink"("projectId");

-- CreateIndex
CREATE INDEX "TaskDevLink_projectRepositoryId_idx" ON "TaskDevLink"("projectRepositoryId");

-- CreateIndex
CREATE INDEX "TaskDevLink_linkedById_idx" ON "TaskDevLink"("linkedById");

-- AddForeignKey
ALTER TABLE "TaskDevLink" ADD CONSTRAINT "TaskDevLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDevLink" ADD CONSTRAINT "TaskDevLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDevLink" ADD CONSTRAINT "TaskDevLink_projectRepositoryId_fkey" FOREIGN KEY ("projectRepositoryId") REFERENCES "ProjectRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDevLink" ADD CONSTRAINT "TaskDevLink_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
