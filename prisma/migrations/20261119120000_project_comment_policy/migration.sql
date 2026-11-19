-- CreateEnum
CREATE TYPE "ProjectCommentPolicy" AS ENUM ('ASSIGNEES_ONLY', 'TEAM_MEMBERS', 'ALL_VIEWERS');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "commentPolicy" "ProjectCommentPolicy" NOT NULL DEFAULT 'ASSIGNEES_ONLY';
