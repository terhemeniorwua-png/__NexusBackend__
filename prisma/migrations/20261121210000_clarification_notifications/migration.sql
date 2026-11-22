-- BE-7 clarification notifications (additive; runs after BE-5 and BE-7 task clarification)

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_CLARIFICATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_CLARIFICATION_ANSWERED';
