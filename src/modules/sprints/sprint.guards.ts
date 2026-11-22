import type { ProjectWorkflowMode } from '@prisma/client';
import { AppError } from '../../utils/errors';

export function requireSprintsEnabled(project: {
  id: string;
  workflowMode: ProjectWorkflowMode;
}): void {
  if (project.workflowMode !== 'SPRINTS') {
    throw new AppError(409, 'SPRINTS_DISABLED_FOR_PROJECT', 'Sprints are disabled for this project.', {
      details: {
        projectId: project.id,
        workflowMode: project.workflowMode,
      },
    });
  }
}
