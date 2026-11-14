-- Phase 8: project-level role privileges.
--
-- Adds the COLLABORATOR project role and backfills project memberships so that
-- every project has at least one manager and its owner is a manager.
--
-- Safe/idempotent:
--   * The enum value is added with IF NOT EXISTS.
--   * Existing membership rows are never deleted.
--   * Only the project owner is promoted and only missing rows are inserted.
--
-- Rollback note: PostgreSQL cannot drop a value from an enum type in place.
-- Reverting this migration requires recreating the "ProjectRole" type without
-- COLLABORATOR after converting any COLLABORATOR rows to VIEWER. The backfilled
-- manager rows are additive and safe to keep.

ALTER TYPE "ProjectRole" ADD VALUE IF NOT EXISTS 'COLLABORATOR';

-- The project owner must always hold the project-manager role.
UPDATE "ProjectMembership" pm
SET "role" = 'PROJECT_MANAGER',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Project" p
WHERE pm."projectId" = p."id"
  AND pm."userId" = p."ownerId"
  AND pm."role" <> 'PROJECT_MANAGER';

-- If a project has no manager at all, make its owner the manager.
INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       p."id",
       p."ownerId",
       'PROJECT_MANAGER',
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "Project" p
WHERE NOT EXISTS (
    SELECT 1
    FROM "ProjectMembership" pm
    WHERE pm."projectId" = p."id"
      AND pm."role" = 'PROJECT_MANAGER'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "ProjectMembership" pm
    WHERE pm."projectId" = p."id"
      AND pm."userId" = p."ownerId"
  );
