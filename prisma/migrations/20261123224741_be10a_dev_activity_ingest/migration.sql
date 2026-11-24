-- CreateEnum
CREATE TYPE "DevActivityPrEventAction" AS ENUM ('OPENED', 'MERGED');

-- CreateTable
CREATE TABLE "RepositoryCommit" (
    "id" TEXT NOT NULL,
    "provider" "DevIntegrationProvider" NOT NULL,
    "repositoryFullName" TEXT NOT NULL,
    "sha" VARCHAR(40) NOT NULL,
    "message" VARCHAR(4096) NOT NULL,
    "authorName" TEXT,
    "authorLogin" TEXT,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT,
    "branch" TEXT,
    "isDefaultBranch" BOOLEAN NOT NULL DEFAULT false,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeliveryId" TEXT,

    CONSTRAINT "RepositoryCommit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryPullRequestEvent" (
    "id" TEXT NOT NULL,
    "provider" "DevIntegrationProvider" NOT NULL,
    "repositoryFullName" TEXT NOT NULL,
    "externalPrId" TEXT NOT NULL,
    "prNumber" INTEGER,
    "action" "DevActivityPrEventAction" NOT NULL,
    "title" VARCHAR(500),
    "authorLogin" TEXT,
    "authorName" TEXT,
    "url" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeliveryId" TEXT,

    CONSTRAINT "RepositoryPullRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryReviewEvent" (
    "id" TEXT NOT NULL,
    "provider" "DevIntegrationProvider" NOT NULL,
    "repositoryFullName" TEXT NOT NULL,
    "externalReviewId" TEXT NOT NULL,
    "externalPrId" TEXT,
    "prNumber" INTEGER,
    "reviewState" TEXT,
    "reviewerLogin" TEXT,
    "reviewerName" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeliveryId" TEXT,

    CONSTRAINT "RepositoryReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepositoryCommit_provider_repositoryFullName_committedAt_id_idx" ON "RepositoryCommit"("provider", "repositoryFullName", "committedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "RepositoryCommit_provider_repositoryFullName_authorLogin_idx" ON "RepositoryCommit"("provider", "repositoryFullName", "authorLogin");

-- CreateIndex
CREATE INDEX "RepositoryCommit_authorLogin_idx" ON "RepositoryCommit"("authorLogin");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryCommit_provider_repositoryFullName_sha_key" ON "RepositoryCommit"("provider", "repositoryFullName", "sha");

-- CreateIndex
CREATE INDEX "RepositoryPullRequestEvent_provider_repositoryFullName_occu_idx" ON "RepositoryPullRequestEvent"("provider", "repositoryFullName", "occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "RepositoryPullRequestEvent_provider_repositoryFullName_auth_idx" ON "RepositoryPullRequestEvent"("provider", "repositoryFullName", "authorLogin");

-- CreateIndex
CREATE INDEX "RepositoryPullRequestEvent_authorLogin_idx" ON "RepositoryPullRequestEvent"("authorLogin");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryPullRequestEvent_provider_repositoryFullName_exte_key" ON "RepositoryPullRequestEvent"("provider", "repositoryFullName", "externalPrId", "action");

-- CreateIndex
CREATE INDEX "RepositoryReviewEvent_provider_repositoryFullName_submitted_idx" ON "RepositoryReviewEvent"("provider", "repositoryFullName", "submittedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "RepositoryReviewEvent_provider_repositoryFullName_reviewerL_idx" ON "RepositoryReviewEvent"("provider", "repositoryFullName", "reviewerLogin");

-- CreateIndex
CREATE INDEX "RepositoryReviewEvent_reviewerLogin_idx" ON "RepositoryReviewEvent"("reviewerLogin");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryReviewEvent_provider_repositoryFullName_externalR_key" ON "RepositoryReviewEvent"("provider", "repositoryFullName", "externalReviewId");
