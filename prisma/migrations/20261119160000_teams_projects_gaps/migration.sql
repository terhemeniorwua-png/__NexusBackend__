-- Additive schema changes for team and project management gaps.
-- Safe to run on an existing database: only adds nullable columns, new tables,
-- indexes (including partial unique indexes), and foreign keys. No drops,
-- renames, or type changes.

-- Team responsibilities/scope text (additive, nullable).
ALTER TABLE "Team" ADD COLUMN "responsibilities" TEXT;

-- Case-insensitive unique team name per workspace among non-deleted teams.
CREATE UNIQUE INDEX "Team_workspaceId_name_ci_active_key"
  ON "Team" ("workspaceId", lower("name"))
  WHERE "deletedAt" IS NULL;

-- Project objectives (structured data) and completion/archive audit fields.
ALTER TABLE "Project" ADD COLUMN "objectives" JSONB;
ALTER TABLE "Project" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "completedById" TEXT;
ALTER TABLE "Project" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "archivedById" TEXT;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_archivedById_fkey"
  FOREIGN KEY ("archivedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Project_completedById_idx" ON "Project"("completedById");
CREATE INDEX "Project_archivedById_idx" ON "Project"("archivedById");
CREATE INDEX "Project_completedAt_idx" ON "Project"("completedAt");
CREATE INDEX "Project_archivedAt_idx" ON "Project"("archivedAt");

-- Many teams per project (additive join table). Existing Project.teamId is retained.
CREATE TABLE "ProjectTeam" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectTeam_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectTeam_projectId_teamId_key" ON "ProjectTeam"("projectId", "teamId");
CREATE INDEX "ProjectTeam_projectId_idx" ON "ProjectTeam"("projectId");
CREATE INDEX "ProjectTeam_teamId_idx" ON "ProjectTeam"("teamId");

ALTER TABLE "ProjectTeam"
  ADD CONSTRAINT "ProjectTeam_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectTeam"
  ADD CONSTRAINT "ProjectTeam_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill join table from existing single team association so existing projects
-- remain visible in many-team queries without changing Project.teamId.
INSERT INTO "ProjectTeam" ("id", "projectId", "teamId", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || "id"), "id", "teamId", CURRENT_TIMESTAMP
FROM "Project"
WHERE "teamId" IS NOT NULL
ON CONFLICT ("projectId", "teamId") DO NOTHING;

-- Task to milestone linking (additive nullable FK).
ALTER TABLE "Task" ADD COLUMN "milestoneId" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_milestoneId_fkey"
  FOREIGN KEY ("milestoneId") REFERENCES "ProjectMilestone"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Task_milestoneId_idx" ON "Task"("milestoneId");
CREATE INDEX "Task_projectId_milestoneId_idx" ON "Task"("projectId", "milestoneId");
