-- Slack notifications: explicit "needs reconnect" state for revoked tokens.
ALTER TABLE "Integration" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;
