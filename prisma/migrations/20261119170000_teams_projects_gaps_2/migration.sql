-- Pass 2 additive schema changes for teams/projects gaps.
-- Safe to run on an existing database: only adds enum values/types, nullable
-- columns with defaults that preserve existing behaviour, indexes, and
-- idempotent reconciliation. No drops, renames, or type changes.

-- Task 3: team visibility (default WORKSPACE preserves current workspace-visible behaviour).
CREATE TYPE "TeamVisibility" AS ENUM ('PRIVATE', 'DEPARTMENT_TEAM', 'WORKSPACE');

ALTER TABLE "Team"
  ADD COLUMN "visibility" "TeamVisibility" NOT NULL DEFAULT 'WORKSPACE';

-- Helpful indexes for team listing/detail filters (workspace-scoped).
CREATE INDEX "Team_workspaceId_visibility_status_idx"
  ON "Team" ("workspaceId", "visibility", "status");
