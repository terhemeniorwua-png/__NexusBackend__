-- BE-4: project-scoped checklists, items and item feedback.
-- Applies after 20261120140000_be3_attachment_versions. New tables only; no backfill.

-- CreateTable
CREATE TABLE "Checklist" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "signedOffById" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItemFeedback" (
    "id" TEXT NOT NULL,
    "checklistItemId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChecklistItemFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Checklist_workspaceId_projectId_idx" ON "Checklist"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "Checklist_projectId_createdAt_id_idx" ON "Checklist"("projectId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_position_idx" ON "ChecklistItem"("checklistId", "position");

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_createdAt_id_idx" ON "ChecklistItem"("checklistId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_deletedAt_idx" ON "ChecklistItem"("checklistId", "deletedAt");

-- CreateIndex
CREATE INDEX "ChecklistItemFeedback_checklistItemId_createdAt_idx" ON "ChecklistItemFeedback"("checklistItemId", "createdAt");

-- CreateIndex
CREATE INDEX "ChecklistItemFeedback_authorId_idx" ON "ChecklistItemFeedback"("authorId");

-- AddForeignKey
ALTER TABLE "Checklist" ADD CONSTRAINT "Checklist_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checklist" ADD CONSTRAINT "Checklist_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checklist" ADD CONSTRAINT "Checklist_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "Checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_signedOffById_fkey" FOREIGN KEY ("signedOffById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItemFeedback" ADD CONSTRAINT "ChecklistItemFeedback_checklistItemId_fkey" FOREIGN KEY ("checklistItemId") REFERENCES "ChecklistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItemFeedback" ADD CONSTRAINT "ChecklistItemFeedback_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Check constraints (raw SQL; Prisma schema cannot express CHECK)
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_position_nonnegative" CHECK ("position" >= 0);
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_text_length" CHECK (char_length("text") BETWEEN 1 AND 500);
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_text_nonblank" CHECK (btrim("text") <> '');
ALTER TABLE "ChecklistItemFeedback" ADD CONSTRAINT "ChecklistItemFeedback_body_length" CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "ChecklistItemFeedback" ADD CONSTRAINT "ChecklistItemFeedback_body_nonblank" CHECK (btrim("body") <> '');
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_signedOffAt_requires_completedAt" CHECK ("signedOffAt" IS NULL OR "completedAt" IS NOT NULL);
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_completedById_iff_completedAt" CHECK (("completedById" IS NULL) = ("completedAt" IS NULL));
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_signedOffById_iff_signedOffAt" CHECK (("signedOffById" IS NULL) = ("signedOffAt" IS NULL));
