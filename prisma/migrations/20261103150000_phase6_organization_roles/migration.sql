CREATE TYPE "OrganizationRole" AS ENUM (
  'COMPANY_OWNER',
  'COMPANY_ADMIN',
  'COMPANY_PROJECT_MANAGER',
  'COMPANY_MEMBER',
  'COMPANY_COLLABORATOR',
  'COMPANY_VIEWER',
  'INSTITUTION_OWNER',
  'INSTITUTION_ADMIN',
  'INSTITUTION_DEPARTMENT_HEAD',
  'INSTITUTION_LECTURER_STAFF',
  'INSTITUTION_STUDENT',
  'INSTITUTION_COLLABORATOR',
  'INSTITUTION_VIEWER'
);

CREATE TYPE "DepartmentMembershipRole" AS ENUM ('HEAD', 'MEMBER');

ALTER TABLE "WorkspaceMembership"
ADD COLUMN "organizationRole" "OrganizationRole";

CREATE INDEX "WorkspaceMembership_workspaceId_organizationRole_idx"
ON "WorkspaceMembership"("workspaceId", "organizationRole");

UPDATE "WorkspaceMembership" AS membership
SET "organizationRole" = CASE workspace."type"::text
  WHEN 'COMPANY' THEN 'COMPANY_OWNER'::"OrganizationRole"
  WHEN 'INSTITUTION' THEN 'INSTITUTION_OWNER'::"OrganizationRole"
  ELSE NULL
END
FROM "Workspace" AS workspace
WHERE membership."workspaceId" = workspace."id"
  AND workspace."type" IN ('COMPANY', 'INSTITUTION')
  AND membership."userId" = workspace."ownerId"
  AND membership."role" = 'OWNER'
  AND membership."organizationRole" IS NULL;

ALTER TABLE "Invitation"
ADD COLUMN "organizationRole" "OrganizationRole";

ALTER TABLE "JoinRequest"
ADD COLUMN "organizationRole" "OrganizationRole";

CREATE TABLE "Department" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DepartmentMembership" (
  "id" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "DepartmentMembershipRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DepartmentMembership_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Team"
ADD COLUMN "departmentId" TEXT;

ALTER TABLE "Project"
ADD COLUMN "departmentId" TEXT;

CREATE UNIQUE INDEX "Department_workspaceId_name_key" ON "Department"("workspaceId", "name");
CREATE INDEX "Department_workspaceId_idx" ON "Department"("workspaceId");
CREATE UNIQUE INDEX "DepartmentMembership_departmentId_userId_key" ON "DepartmentMembership"("departmentId", "userId");
CREATE INDEX "DepartmentMembership_userId_idx" ON "DepartmentMembership"("userId");
CREATE INDEX "Team_departmentId_idx" ON "Team"("departmentId");
CREATE INDEX "Project_departmentId_idx" ON "Project"("departmentId");

ALTER TABLE "Department"
ADD CONSTRAINT "Department_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DepartmentMembership"
ADD CONSTRAINT "DepartmentMembership_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "DepartmentMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Team"
ADD CONSTRAINT "Team_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Project"
ADD CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
