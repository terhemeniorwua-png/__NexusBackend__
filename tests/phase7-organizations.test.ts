import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  addInstitutionGroupMemberSchema,
  createInstitutionGroupSchema,
  updateNotificationPreferencesSchema,
  updateCompanyProfileSchema,
  updateInstitutionProfileSchema,
} from '../src/modules/organizations/organization.schemas';
import { updateDepartmentSchema } from '../src/modules/workspaces/workspace.schemas';

describe('Phase 7 organization profiles and institution groups', () => {
  test('company profiles accept company fields and reject institution-only fields', () => {
    assert.equal(
      updateCompanyProfileSchema.safeParse({ industryCategory: 'Software' }).success,
      true,
    );
    assert.equal(
      updateCompanyProfileSchema.safeParse({ institutionType: 'SCHOOL' }).success,
      false,
    );
    assert.equal(
      updateCompanyProfileSchema.safeParse({ officialWebsite: 'not a URL' }).success,
      false,
    );
  });

  test('institution profiles validate their own type and contact fields', () => {
    assert.equal(
      updateInstitutionProfileSchema.safeParse({ institutionType: 'UNIVERSITY' }).success,
      true,
    );
    assert.equal(
      updateInstitutionProfileSchema.safeParse({ businessEmail: 'x@example.com' }).success,
      false,
    );
    assert.equal(
      updateInstitutionProfileSchema.safeParse({ contactInformation: { phone: 4 } }).success,
      false,
    );
  });

  test('institution groups reject unknown fields and require an assigned role', () => {
    assert.equal(createInstitutionGroupSchema.safeParse({ name: 'Research Group' }).success, true);
    assert.equal(
      createInstitutionGroupSchema.safeParse({ name: 'Research Group', departmentId: 'x' }).success,
      false,
    );
    assert.deepEqual(
      addInstitutionGroupMemberSchema.parse({ userId: '00000000-0000-4000-8000-000000000001' })
        .role,
      'MEMBER',
    );
  });

  test('notification preferences accept unique in-app notification types only', () => {
    assert.equal(
      updateNotificationPreferencesSchema.safeParse({
        preferences: [{ type: 'MEMBERSHIP_CHANGED', inAppEnabled: false }],
      }).success,
      true,
    );
    assert.equal(
      updateNotificationPreferencesSchema.safeParse({
        preferences: [
          { type: 'MEMBERSHIP_CHANGED', inAppEnabled: false },
          { type: 'MEMBERSHIP_CHANGED', inAppEnabled: true },
        ],
      }).success,
      false,
    );
    assert.equal(
      updateNotificationPreferencesSchema.safeParse({
        preferences: [{ type: 'MESSAGE_RECEIVED', inAppEnabled: false }],
      }).success,
      false,
    );
  });

  test('department settings allow a validated rename only', () => {
    assert.equal(updateDepartmentSchema.safeParse({ name: 'Research' }).success, true);
    assert.equal(updateDepartmentSchema.safeParse({ name: 'R' }).success, false);
    assert.equal(
      updateDepartmentSchema.safeParse({ name: 'Research', workspaceId: 'other' }).success,
      false,
    );
  });
});
