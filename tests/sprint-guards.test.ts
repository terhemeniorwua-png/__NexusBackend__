import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ProjectWorkflowMode } from '@prisma/client';
import { requireSprintsEnabled } from '../src/modules/sprints/sprint.guards';
import { AppError } from '../src/utils/errors';

describe('requireSprintsEnabled', () => {
  test('allows SPRINTS projects', () => {
    assert.doesNotThrow(() =>
      requireSprintsEnabled({ id: 'project-1', workflowMode: ProjectWorkflowMode.SPRINTS }),
    );
  });

  test('throws 409 SPRINTS_DISABLED_FOR_PROJECT for BACKLOG_ONLY projects', () => {
    assert.throws(
      () => requireSprintsEnabled({ id: 'project-1', workflowMode: ProjectWorkflowMode.BACKLOG_ONLY }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        const appError = error as AppError;
        assert.equal(appError.statusCode, 409);
        assert.equal(appError.code, 'SPRINTS_DISABLED_FOR_PROJECT');
        assert.equal(appError.message, 'Sprints are disabled for this project.');
        assert.deepEqual(appError.details, {
          projectId: 'project-1',
          workflowMode: 'BACKLOG_ONLY',
        });
        return true;
      },
    );
  });
});
