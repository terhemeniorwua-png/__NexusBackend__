-- Phase 25: per-channel notification preferences.
--
-- Email is a separate channel from in-app delivery. Existing rows keep email
-- enabled so nobody silently stops receiving notifications after deployment.
ALTER TABLE "NotificationPreference"
  ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT true;
