-- CreateEnum
CREATE TYPE "ScimTokenStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "ScimToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "ScimTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ScimGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScimToken_tokenHash_key" ON "ScimToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ScimToken_workspaceId_idx" ON "ScimToken"("workspaceId");

-- CreateIndex
CREATE INDEX "ScimToken_workspaceId_status_idx" ON "ScimToken"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScimGroup_workspaceId_displayName_key" ON "ScimGroup"("workspaceId", "displayName");

-- CreateIndex
CREATE INDEX "ScimGroup_workspaceId_idx" ON "ScimGroup"("workspaceId");

-- CreateIndex
CREATE INDEX "ScimGroup_teamId_idx" ON "ScimGroup"("teamId");

-- AddForeignKey
ALTER TABLE "ScimToken" ADD CONSTRAINT "ScimToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimToken" ADD CONSTRAINT "ScimToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimGroup" ADD CONSTRAINT "ScimGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimGroup" ADD CONSTRAINT "ScimGroup_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
