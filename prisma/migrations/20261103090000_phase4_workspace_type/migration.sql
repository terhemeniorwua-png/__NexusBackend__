-- Phase 4 completion: a workspace now records which of the three product
-- workspace types it is. Existing rows are treated as COMPANY, which is the
-- least surprising default for workspaces created before the type existed.
CREATE TYPE "WorkspaceType" AS ENUM ('INDIVIDUAL', 'COMPANY', 'INSTITUTION');

ALTER TABLE "Workspace" ADD COLUMN "type" "WorkspaceType" NOT NULL DEFAULT 'COMPANY';

CREATE INDEX "Workspace_type_idx" ON "Workspace"("type");
