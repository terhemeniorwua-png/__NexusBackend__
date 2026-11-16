-- Feature D: weighted subtasks (additive)

ALTER TABLE "Task"
  ADD COLUMN "weight" INTEGER NOT NULL DEFAULT 1;
