import { Prisma, type TaskStatus } from '@prisma/client';

export interface TaskOverdueShape {
  dueDate: Date | null;
  status: TaskStatus;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

export function isTaskOverdue(task: TaskOverdueShape, now: Date = new Date()): boolean {
  return (
    task.dueDate != null &&
    task.dueDate.getTime() < now.getTime() &&
    task.status !== 'APPROVED' &&
    task.archivedAt == null &&
    task.deletedAt == null
  );
}

export function taskOverdueWhere(now: Date = new Date()): Prisma.TaskWhereInput {
  return {
    dueDate: { lt: now },
    status: { not: 'APPROVED' },
    archivedAt: null,
    deletedAt: null,
  };
}

export function taskNotOverdueWhere(now: Date = new Date()): Prisma.TaskWhereInput {
  return {
    NOT: taskOverdueWhere(now),
  };
}
