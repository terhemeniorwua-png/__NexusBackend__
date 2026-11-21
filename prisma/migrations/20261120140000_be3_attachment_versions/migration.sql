-- BE-3: attachment versions and version feedback.
-- Applies after 20261120130000_add_project_type. No legacy column is dropped.

-- CreateTable
CREATE TABLE "AttachmentVersion" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "changeNote" TEXT,
    "extractedText" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AttachmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentVersionFeedback" (
    "id" TEXT NOT NULL,
    "attachmentVersionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AttachmentVersionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentVersion_storageKey_key" ON "AttachmentVersion"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentVersion_attachmentId_versionNumber_key" ON "AttachmentVersion"("attachmentId", "versionNumber");

-- CreateIndex: at most one current, live version per attachment.
CREATE UNIQUE INDEX "AttachmentVersion_attachmentId_current_live_key"
    ON "AttachmentVersion"("attachmentId") WHERE "isCurrent" = true AND "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "AttachmentVersion_attachmentId_createdAt_idx" ON "AttachmentVersion"("attachmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AttachmentVersion_uploadedById_idx" ON "AttachmentVersion"("uploadedById");

-- CreateIndex
CREATE INDEX "AttachmentVersionFeedback_attachmentVersionId_createdAt_idx" ON "AttachmentVersionFeedback"("attachmentVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "AttachmentVersionFeedback_authorId_idx" ON "AttachmentVersionFeedback"("authorId");

-- AddForeignKey
ALTER TABLE "AttachmentVersion" ADD CONSTRAINT "AttachmentVersion_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "FileAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentVersion" ADD CONSTRAINT "AttachmentVersion_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentVersionFeedback" ADD CONSTRAINT "AttachmentVersionFeedback_attachmentVersionId_fkey" FOREIGN KEY ("attachmentVersionId") REFERENCES "AttachmentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentVersionFeedback" ADD CONSTRAINT "AttachmentVersionFeedback_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Check constraints (raw SQL; Prisma schema cannot express CHECK)
ALTER TABLE "AttachmentVersion" ADD CONSTRAINT "AttachmentVersion_versionNumber_positive" CHECK ("versionNumber" > 0);
ALTER TABLE "AttachmentVersion" ADD CONSTRAINT "AttachmentVersion_sizeBytes_nonnegative" CHECK ("sizeBytes" >= 0);
ALTER TABLE "AttachmentVersionFeedback" ADD CONSTRAINT "AttachmentVersionFeedback_body_length" CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "AttachmentVersionFeedback" ADD CONSTRAINT "AttachmentVersionFeedback_body_nonblank" CHECK (btrim("body") <> '');

-- Backfill: one idempotent, set-based INSERT ... SELECT. Re-running inserts nothing.
-- Legacy and v1 share the FileAttachment.storageKey. Soft-deleted attachments
-- get a soft-deleted, non-current v1 with the deletedAt timestamp copied.
INSERT INTO "AttachmentVersion" (
    "id", "attachmentId", "versionNumber", "isCurrent", "fileName", "mimeType",
    "sizeBytes", "storageKey", "changeNote", "extractedText", "uploadedById",
    "createdAt", "updatedAt", "deletedAt"
)
SELECT
    gen_random_uuid()::text,
    f."id",
    1,
    (f."deletedAt" IS NULL),
    f."fileName",
    f."mimeType",
    f."sizeBytes",
    f."storageKey",
    NULL,
    f."extractedText",
    f."uploadedById",
    f."createdAt",
    f."updatedAt",
    f."deletedAt"
FROM "FileAttachment" f
WHERE NOT EXISTS (
    SELECT 1 FROM "AttachmentVersion" v
    WHERE v."attachmentId" = f."id" AND v."versionNumber" = 1
);
