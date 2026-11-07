-- Phase 4: retain deletion requests for a 30-day recovery period and mark
-- personal workspaces independently from ordinary INDIVIDUAL workspaces.
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING_DELETION';

ALTER TABLE "User"
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "scheduledDeletionAt" TIMESTAMP(3);

CREATE INDEX "User_status_scheduledDeletionAt_idx"
  ON "User"("status", "scheduledDeletionAt");

ALTER TABLE "Workspace"
  ADD COLUMN "isPersonal" BOOLEAN NOT NULL DEFAULT false;

-- Keep an existing individual workspace as the user's personal workspace
-- where one already exists. The oldest one is chosen deterministically.
WITH existing_personal AS (
  SELECT DISTINCT ON (w."ownerId") w."id"
  FROM "Workspace" w
  JOIN "User" u ON u."id" = w."ownerId"
  WHERE w."type" = 'INDIVIDUAL'
    AND w."deletedAt" IS NULL
    AND u."status" = 'ACTIVE'
    AND u."deletedAt" IS NULL
  ORDER BY w."ownerId", w."createdAt", w."id"
)
UPDATE "Workspace" w
SET "isPersonal" = true
FROM existing_personal p
WHERE w."id" = p."id";

-- Provision a private personal workspace for existing active accounts that
-- do not already own an individual workspace.
WITH accounts AS (
  SELECT u."id", u."name"
  FROM "User" u
  WHERE u."status" = 'ACTIVE'
    AND u."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Workspace" w
      WHERE w."ownerId" = u."id"
        AND w."type" = 'INDIVIDUAL'
        AND w."deletedAt" IS NULL
    )
), created AS (
  INSERT INTO "Workspace" (
    "id", "name", "slug", "type", "isPersonal", "visibility", "status",
    "ownerId", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid(),
    a."name" || '''s Personal Workspace',
    'personal-' || a."id",
    'INDIVIDUAL',
    true,
    'PRIVATE',
    'ACTIVE',
    a."id",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM accounts a
  RETURNING "id", "ownerId"
)
INSERT INTO "WorkspaceMembership" (
  "id", "workspaceId", "userId", "role", "status", "joinedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), c."id", c."ownerId", 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM created c;

INSERT INTO "WorkspaceMembership" (
  "id", "workspaceId", "userId", "role", "status", "joinedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), w."id", w."ownerId", 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE w."isPersonal" = true
ON CONFLICT ("workspaceId", "userId") DO UPDATE
SET "role" = 'OWNER', "status" = 'ACTIVE', "updatedAt" = CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "Workspace_one_personal_workspace_per_owner_idx"
  ON "Workspace"("ownerId")
  WHERE "isPersonal" = true AND "deletedAt" IS NULL;
