import type { ProjectStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * Archived projects are read-only for all project-scoped data. Reads and the
 * explicit archive/restore endpoints remain allowed for authorised users.
 *
 * COMPLETED projects keep their existing behaviour unless a specific endpoint
 * already restricts writes; this guard only enforces the archived read-only
 * rule required by Pass 2.
 */
export function assertProjectWritable(project: { status: ProjectStatus | string }): void {
  if (project.status === 'ARCHIVED') {
    throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
  }
}
