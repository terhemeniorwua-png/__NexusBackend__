-- CreateEnum
CREATE TYPE "DevIntegrationProvider" AS ENUM ('GITHUB', 'GITLAB');

-- CreateEnum
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISCONNECTED', 'ERROR');

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "provider" "DevIntegrationProvider" NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "externalAccountId" TEXT,
    "externalAccountLogin" TEXT,
    "externalAccountName" TEXT,
    "encryptedCredentials" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "lastError" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRepository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "DevIntegrationProvider" NOT NULL,
    "externalRepoId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRepository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_workspaceId_provider_key" ON "IntegrationConnection"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "IntegrationConnection_workspaceId_status_idx" ON "IntegrationConnection"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "IntegrationConnection_createdById_idx" ON "IntegrationConnection"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepository_projectId_provider_externalRepoId_key" ON "ProjectRepository"("projectId", "provider", "externalRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepository_connectionId_externalRepoId_key" ON "ProjectRepository"("connectionId", "externalRepoId");

-- CreateIndex
CREATE INDEX "ProjectRepository_projectId_idx" ON "ProjectRepository"("projectId");

-- CreateIndex
CREATE INDEX "ProjectRepository_connectionId_idx" ON "ProjectRepository"("connectionId");

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepository" ADD CONSTRAINT "ProjectRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepository" ADD CONSTRAINT "ProjectRepository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
