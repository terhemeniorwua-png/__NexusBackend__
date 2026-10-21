-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "previousRefreshTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Session_previousRefreshTokenHash_key" ON "Session"("previousRefreshTokenHash");
