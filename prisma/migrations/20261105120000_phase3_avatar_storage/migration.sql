ALTER TABLE "UserProfile"
  ADD COLUMN "avatarStorageKey" TEXT;

CREATE UNIQUE INDEX "UserProfile_avatarStorageKey_key"
  ON "UserProfile"("avatarStorageKey");
