-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "category" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];
