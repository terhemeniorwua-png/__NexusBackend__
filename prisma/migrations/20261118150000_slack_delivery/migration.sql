-- Slack delivery: reconnect notices for revoked tokens and an explicit
-- "post to Slack" automation action (POST_MESSAGE remains internal chat only).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INTEGRATION_RECONNECT_REQUIRED';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'SEND_SLACK_MESSAGE';
