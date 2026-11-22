-- BE-5 in-app notification fan-out (additive)

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_STARTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_CHANGES_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_RESUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CHECKLIST_SIGNED_OFF';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTACHMENT_VERSION_ADDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GITHUB_PR_MERGED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GITHUB_PR_REVIEW_RECEIVED';

-- Expression-backed dedupe key for in-app notification fan-out. Prisma cannot
-- express this partial expression index in schema.prisma, so it is maintained
-- here. Rows without a dedupeKey are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_userId_dedupeKey_key"
  ON "Notification" ("userId", (data->>'dedupeKey'))
  WHERE (data->>'dedupeKey') IS NOT NULL;
