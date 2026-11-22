-- BE-7 task clarification (additive)

ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'AWAITING_CLARIFICATION';

-- CreateTable
CREATE TABLE "TaskClarification" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "askedById" TEXT NOT NULL,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answer" TEXT,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "TaskClarification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaskClarification_round_positive" CHECK ("round" > 0),
    CONSTRAINT "TaskClarification_question_length" CHECK (char_length(btrim("question")) BETWEEN 1 AND 2000),
    CONSTRAINT "TaskClarification_answer_length" CHECK ("answer" IS NULL OR char_length(btrim("answer")) BETWEEN 1 AND 2000),
    CONSTRAINT "TaskClarification_answered_fields_complete" CHECK (
        ("answer" IS NULL AND "answeredById" IS NULL AND "answeredAt" IS NULL)
        OR ("answer" IS NOT NULL AND "answeredById" IS NOT NULL AND "answeredAt" IS NOT NULL)
    ),
    CONSTRAINT "TaskClarification_not_answered_and_cancelled" CHECK (
        NOT ("answeredAt" IS NOT NULL AND "cancelledAt" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskClarification_taskId_round_key" ON "TaskClarification"("taskId", "round");
CREATE INDEX "TaskClarification_taskId_askedAt_idx" ON "TaskClarification"("taskId", "askedAt");
CREATE INDEX "TaskClarification_taskId_answeredAt_idx" ON "TaskClarification"("taskId", "answeredAt");

-- Only one clarification may be open per task. Answered and cancelled rounds
-- are excluded so the asker can start a fresh round after either outcome.
CREATE UNIQUE INDEX "TaskClarification_one_open_per_task"
    ON "TaskClarification"("taskId")
    WHERE "answeredAt" IS NULL AND "cancelledAt" IS NULL;

-- AddForeignKey
ALTER TABLE "TaskClarification" ADD CONSTRAINT "TaskClarification_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskClarification" ADD CONSTRAINT "TaskClarification_askedById_fkey"
    FOREIGN KEY ("askedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskClarification" ADD CONSTRAINT "TaskClarification_answeredById_fkey"
    FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
