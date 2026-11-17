-- CreateEnum
CREATE TYPE "SessionAuthMethod" AS ENUM ('PASSWORD', 'SOCIAL', 'SSO', 'BREAK_GLASS');

-- AlterTable
ALTER TABLE "Session"
ADD COLUMN "authMethod" "SessionAuthMethod" NOT NULL DEFAULT 'PASSWORD',
ADD COLUMN "authMethodExpiresAt" TIMESTAMP(3);
