CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_workspaceId_userId_type_key"
  ON "NotificationPreference"("workspaceId", "userId", "type");
CREATE INDEX "NotificationPreference_userId_workspaceId_idx"
  ON "NotificationPreference"("userId", "workspaceId");

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_workspaceId_userId_fkey"
  FOREIGN KEY ("workspaceId", "userId")
  REFERENCES "WorkspaceMembership"("workspaceId", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;
