-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('GENERAL', 'ENGINEERING', 'DESIGN', 'OPERATIONS', 'MARKETING', 'HR');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "type" "ProjectType" NOT NULL DEFAULT 'GENERAL';

-- CreateIndex
CREATE INDEX "Project_workspaceId_type_idx" ON "Project"("workspaceId", "type");
