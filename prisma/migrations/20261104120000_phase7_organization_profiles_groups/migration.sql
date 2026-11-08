CREATE TYPE "InstitutionType" AS ENUM (
  'UNIVERSITY',
  'COLLEGE',
  'SCHOOL',
  'RESEARCH_INSTITUTION',
  'OTHER'
);

CREATE TYPE "InstitutionGroupRole" AS ENUM ('LEAD', 'MEMBER');

CREATE TABLE "CompanyProfile" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "logoReference" TEXT,
  "description" TEXT,
  "industryCategory" TEXT,
  "officialWebsite" TEXT,
  "businessEmail" TEXT,
  "contactInformation" JSONB,
  "country" TEXT,
  "location" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstitutionProfile" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "logoReference" TEXT,
  "description" TEXT,
  "institutionType" "InstitutionType",
  "officialWebsite" TEXT,
  "institutionalEmail" TEXT,
  "contactInformation" JSONB,
  "country" TEXT,
  "location" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstitutionProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstitutionGroup" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "leadId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "InstitutionGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstitutionGroupMembership" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "InstitutionGroupRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstitutionGroupMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyProfile_workspaceId_key" ON "CompanyProfile"("workspaceId");
CREATE UNIQUE INDEX "InstitutionProfile_workspaceId_key" ON "InstitutionProfile"("workspaceId");
CREATE UNIQUE INDEX "InstitutionGroup_workspaceId_name_key" ON "InstitutionGroup"("workspaceId", "name");
CREATE INDEX "InstitutionGroup_workspaceId_idx" ON "InstitutionGroup"("workspaceId");
CREATE INDEX "InstitutionGroup_leadId_idx" ON "InstitutionGroup"("leadId");
CREATE UNIQUE INDEX "InstitutionGroupMembership_groupId_userId_key" ON "InstitutionGroupMembership"("groupId", "userId");
CREATE INDEX "InstitutionGroupMembership_userId_idx" ON "InstitutionGroupMembership"("userId");

ALTER TABLE "CompanyProfile" ADD CONSTRAINT "CompanyProfile_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstitutionProfile" ADD CONSTRAINT "InstitutionProfile_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstitutionGroup" ADD CONSTRAINT "InstitutionGroup_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstitutionGroup" ADD CONSTRAINT "InstitutionGroup_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InstitutionGroupMembership" ADD CONSTRAINT "InstitutionGroupMembership_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "InstitutionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstitutionGroupMembership" ADD CONSTRAINT "InstitutionGroupMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve a usable starting profile for existing organization workspaces.
INSERT INTO "CompanyProfile" ("id", "workspaceId", "name", "updatedAt")
SELECT gen_random_uuid()::text, "id", "name", CURRENT_TIMESTAMP
FROM "Workspace" WHERE "type" = 'COMPANY' AND "deletedAt" IS NULL;

INSERT INTO "InstitutionProfile" ("id", "workspaceId", "name", "updatedAt")
SELECT gen_random_uuid()::text, "id", "name", CURRENT_TIMESTAMP
FROM "Workspace" WHERE "type" = 'INSTITUTION' AND "deletedAt" IS NULL;
