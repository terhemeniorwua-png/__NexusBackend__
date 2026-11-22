import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { repositoryAccessLevelSchema, setRepositoryMemberOverrideSchema } from '../src/modules/dev-integrations/dev-integration.schemas';

describe('BE-9 repository access member API schemas', () => {
  test('accepts only NONE, METADATA, READ, LINK', () => {
    for (const level of ['NONE', 'METADATA', 'READ', 'LINK']) {
      assert.equal(repositoryAccessLevelSchema.safeParse(level).success, true);
      assert.equal(setRepositoryMemberOverrideSchema.safeParse({ level }).success, true);
    }
  });

  test('rejects old level names and unknown values', () => {
    for (const level of ['METADATA_ONLY', 'ACCESS', 'FULL', 'READ_ONLY', 'ADMIN', '', null, undefined, 1]) {
      assert.equal(repositoryAccessLevelSchema.safeParse(level).success, false);
      assert.equal(setRepositoryMemberOverrideSchema.safeParse({ level }).success, false);
    }
  });
});
