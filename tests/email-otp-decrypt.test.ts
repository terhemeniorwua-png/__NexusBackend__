import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decryptOtpBody, encryptOtpBody } from '../src/services/email/otp-body-encryption';

const SECRET = 'test-secret-test-secret-test-secret-123456';

test('OTP body encryption round-trips to the plaintext code', () => {
  const body = 'Your Nexus password reset code is 123456';
  const stored = encryptOtpBody(body, SECRET);
  assert.ok(stored.startsWith('otpenc:v1:'), 'stored form must be encrypted');
  assert.ok(!stored.includes('123456'), 'stored form must not contain the code');
  assert.equal(decryptOtpBody(stored, SECRET), body);
});

test('delivery service decrypts OTP bodies before handing them to the provider', () => {
  const src = readFileSync('src/services/email/delivery.service.ts', 'utf8');
  assert.match(src, /import \{[^}]*decryptOtpBody[^}]*\} from '\.\/otp-body-encryption'/);
  assert.match(src, /decryptOtpBody\(delivery\.textBody/);
  assert.match(src, /decryptOtpBody\(delivery\.htmlBody/);
});
