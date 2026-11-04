import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  addInstitutionGroupMemberSchema,
  createInstitutionGroupSchema,
  updateCompanyProfileSchema,
  updateInstitutionProfileSchema,
} from '../src/modules/organizations/organization.schemas';

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
});
