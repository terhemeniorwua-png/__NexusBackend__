CREATE TYPE "AuthOneTimeCodePurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

CREATE TABLE "AuthOneTimeCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "purpose" "AuthOneTimeCodePurpose" NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthOneTimeCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthOneTimeCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AuthOneTimeCode_one_active_per_user_purpose" ON "AuthOneTimeCode" ("userId", "purpose") WHERE "consumedAt" IS NULL;
CREATE INDEX "AuthOneTimeCode_userId_purpose_consumedAt_idx" ON "AuthOneTimeCode"("userId", "purpose", "consumedAt");
CREATE INDEX "AuthOneTimeCode_expiresAt_idx" ON "AuthOneTimeCode"("expiresAt");
