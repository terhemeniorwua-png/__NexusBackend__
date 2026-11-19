-- CreateEnum
CREATE TYPE "RecentItemType" AS ENUM ('TASK', 'DOCUMENT', 'FILE', 'BOOKMARK');

-- CreateTable
CREATE TABLE "ResourceFolder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ResourceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceBookmark" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceBookmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceRecentItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemType" "RecentItemType" NOT NULL,
    "itemId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceRecentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceDashboardPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cards" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceDashboardPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceFolder_workspaceId_idx" ON "ResourceFolder"("workspaceId");
CREATE INDEX "ResourceFolder_projectId_idx" ON "ResourceFolder"("projectId");
CREATE INDEX "ResourceFolder_parentId_idx" ON "ResourceFolder"("parentId");
CREATE INDEX "ResourceFolder_createdById_idx" ON "ResourceFolder"("createdById");
CREATE INDEX "ResourceFolder_workspaceId_projectId_parentId_idx" ON "ResourceFolder"("workspaceId", "projectId", "parentId");

-- Duplicate sibling folder names are not allowed. Handle NULL projectId/parentId correctly in Postgres.
CREATE UNIQUE INDEX "ResourceFolder_ws_root_name_key"
  ON "ResourceFolder"("workspaceId", "name")
  WHERE "projectId" IS NULL AND "parentId" IS NULL;
CREATE UNIQUE INDEX "ResourceFolder_ws_child_name_key"
  ON "ResourceFolder"("workspaceId", "parentId", "name")
  WHERE "projectId" IS NULL AND "parentId" IS NOT NULL;
CREATE UNIQUE INDEX "ResourceFolder_project_root_name_key"
  ON "ResourceFolder"("workspaceId", "projectId", "name")
  WHERE "projectId" IS NOT NULL AND "parentId" IS NULL;
CREATE UNIQUE INDEX "ResourceFolder_project_child_name_key"
  ON "ResourceFolder"("workspaceId", "projectId", "parentId", "name")
  WHERE "projectId" IS NOT NULL AND "parentId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ResourceFile_storageKey_key" ON "ResourceFile"("storageKey");
CREATE INDEX "ResourceFile_workspaceId_idx" ON "ResourceFile"("workspaceId");
CREATE INDEX "ResourceFile_projectId_idx" ON "ResourceFile"("projectId");
CREATE INDEX "ResourceFile_folderId_idx" ON "ResourceFile"("folderId");
CREATE INDEX "ResourceFile_uploadedById_idx" ON "ResourceFile"("uploadedById");
CREATE INDEX "ResourceFile_workspaceId_projectId_createdAt_idx" ON "ResourceFile"("workspaceId", "projectId", "createdAt");
CREATE INDEX "ResourceFile_deletedAt_idx" ON "ResourceFile"("deletedAt");

-- CreateIndex
CREATE INDEX "ResourceBookmark_workspaceId_idx" ON "ResourceBookmark"("workspaceId");
CREATE INDEX "ResourceBookmark_projectId_idx" ON "ResourceBookmark"("projectId");
CREATE INDEX "ResourceBookmark_createdById_idx" ON "ResourceBookmark"("createdById");
CREATE INDEX "ResourceBookmark_workspaceId_projectId_createdAt_idx" ON "ResourceBookmark"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceRecentItem_userId_projectId_itemType_itemId_key" ON "ResourceRecentItem"("userId", "projectId", "itemType", "itemId");
CREATE INDEX "ResourceRecentItem_userId_projectId_openedAt_idx" ON "ResourceRecentItem"("userId", "projectId", "openedAt");
CREATE INDEX "ResourceRecentItem_projectId_idx" ON "ResourceRecentItem"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceDashboardPreference_userId_projectId_key" ON "ResourceDashboardPreference"("userId", "projectId");
CREATE INDEX "ResourceDashboardPreference_projectId_idx" ON "ResourceDashboardPreference"("projectId");

-- AddForeignKey
ALTER TABLE "ResourceFolder" ADD CONSTRAINT "ResourceFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceFolder" ADD CONSTRAINT "ResourceFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceFolder" ADD CONSTRAINT "ResourceFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ResourceFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceFolder" ADD CONSTRAINT "ResourceFolder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceFile" ADD CONSTRAINT "ResourceFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceFile" ADD CONSTRAINT "ResourceFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceFile" ADD CONSTRAINT "ResourceFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ResourceFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResourceFile" ADD CONSTRAINT "ResourceFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceBookmark" ADD CONSTRAINT "ResourceBookmark_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBookmark" ADD CONSTRAINT "ResourceBookmark_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBookmark" ADD CONSTRAINT "ResourceBookmark_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceRecentItem" ADD CONSTRAINT "ResourceRecentItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceRecentItem" ADD CONSTRAINT "ResourceRecentItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResourceDashboardPreference" ADD CONSTRAINT "ResourceDashboardPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceDashboardPreference" ADD CONSTRAINT "ResourceDashboardPreference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
