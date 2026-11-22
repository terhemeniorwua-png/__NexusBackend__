-- CreateEnum
CREATE TYPE "RepositoryAccessLevel" AS ENUM ('NONE', 'METADATA', 'READ', 'LINK');

-- CreateTable
CREATE TABLE "ProjectRepositoryMember" (
    "id" TEXT NOT NULL,
    "projectRepositoryId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" "RepositoryAccessLevel" NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRepositoryMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepositoryMember_projectRepositoryId_userId_key" ON "ProjectRepositoryMember"("projectRepositoryId", "userId");
CREATE INDEX "ProjectRepositoryMember_userId_projectId_idx" ON "ProjectRepositoryMember"("userId", "projectId");
CREATE INDEX "ProjectRepositoryMember_projectRepositoryId_level_idx" ON "ProjectRepositoryMember"("projectRepositoryId", "level");

-- AddForeignKey
ALTER TABLE "ProjectRepositoryMember" ADD CONSTRAINT "ProjectRepositoryMember_projectRepositoryId_fkey" FOREIGN KEY ("projectRepositoryId") REFERENCES "ProjectRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectRepositoryMember" ADD CONSTRAINT "ProjectRepositoryMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectRepositoryMember" ADD CONSTRAINT "ProjectRepositoryMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectRepositoryMember" ADD CONSTRAINT "ProjectRepositoryMember_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
