-- Feature E: task deadline notifications (additive)

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_DUE_SOON';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_OVERDUE';

ALTER TABLE "Task"
  ADD COLUMN "dueSoonNotifiedAt" TIMESTAMP(3),
  ADD COLUMN "overdueNotifiedAt" TIMESTAMP(3);
