import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../src/config/env';
import {
  consumeOneTimeCode,
  hashOneTimeCode,
  issueOneTimeCode,
} from '../src/modules/auth/one-time-code.service';
import { decryptOtpBody, encryptOtpBody } from '../src/services/email/otp-body-encryption';

const config = {
  otpHmacSecret: 'unit-test-otp-hmac-secret-that-is-at-least-32-chars',
} as AppConfig;

test('OTP HMAC is stable and bound to user and purpose', () => {
  const base = { code: '000123', userId: 'user-1', purpose: 'EMAIL_VERIFICATION' as const };
  assert.equal(hashOneTimeCode(config, base), hashOneTimeCode(config, base));
  assert.notEqual(
    hashOneTimeCode(config, base),
    hashOneTimeCode(config, { ...base, userId: 'user-2' }),
  );
  assert.notEqual(
    hashOneTimeCode(config, base),
    hashOneTimeCode(config, { ...base, purpose: 'PASSWORD_RESET' }),
  );
});

test('OTP transactional email bodies are encrypted at rest and authenticate tampering', () => {
  const secret = 'unit-test-otp-hmac-secret-that-is-at-least-32-chars';
  const ciphertext = encryptOtpBody('Your code is 001234', secret);
  assert.doesNotMatch(ciphertext, /001234/);
  assert.equal(decryptOtpBody(ciphertext, secret), 'Your code is 001234');
  const tampered = ciphertext.replace(
    /:([^:]+)$/,
    (_match, body: string) => `:${body[0] === 'a' ? 'b' : 'a'}${body.slice(1)}`,
  );
  assert.throws(() => decryptOtpBody(tampered, secret));
});

function consumeClient(input: { attempts?: number; expiresAt?: Date; code?: string } = {}) {
  const userId = 'user-1';
  const purpose = 'EMAIL_VERIFICATION' as const;
  const record = {
    id: 'code-1',
    userId,
    purpose,
    codeHash: hashOneTimeCode(config, { code: input.code ?? '123456', userId, purpose }),
    attempts: input.attempts ?? 0,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
  };
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const prisma = {
    user: { findUnique: async () => ({ id: userId }) },
    authOneTimeCode: {
      findFirst: async () => record,
      updateMany: async (args: { data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, updates, userId };
}

test('a valid code is consumed once', async () => {
  const { prisma, updates, userId } = consumeClient();
  assert.deepEqual(
    await consumeOneTimeCode(prisma, config, {
      email: 'user@example.com',
      code: '123456',
      purpose: 'EMAIL_VERIFICATION',
    }),
    { userId },
  );
  assert.ok(updates[0]?.data.consumedAt instanceof Date);
});

test('wrong codes increment attempts and the fifth invalidates the code', async () => {
  const { prisma, updates } = consumeClient();
  await assert.rejects(
    consumeOneTimeCode(prisma, config, {
      email: 'user@example.com',
      code: '000000',
      purpose: 'EMAIL_VERIFICATION',
    }),
    { code: 'INVALID_OR_EXPIRED_CODE' },
  );
  assert.equal(updates[0]?.data.attempts, 1);

  const maxed = consumeClient({ attempts: 4 });
  await assert.rejects(
    consumeOneTimeCode(maxed.prisma, config, {
      email: 'user@example.com',
      code: '000000',
      purpose: 'EMAIL_VERIFICATION',
    }),
    { code: 'TOO_MANY_ATTEMPTS' },
  );
  assert.ok(maxed.updates[0]?.data.consumedAt instanceof Date);
});

test('expired codes are rejected and resend cooldown is enforced', async () => {
  const expired = consumeClient({ expiresAt: new Date(Date.now() - 1_000) });
  await assert.rejects(
    consumeOneTimeCode(expired.prisma, config, {
      email: 'user@example.com',
      code: '123456',
      purpose: 'EMAIL_VERIFICATION',
    }),
    { code: 'INVALID_OR_EXPIRED_CODE' },
  );

  const prisma = {
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        $queryRaw: async () => [],
        authOneTimeCode: {
          findFirst: async () => ({ lastSentAt: new Date() }),
          updateMany: async () => ({ count: 0 }),
          create: async () => assert.fail('cooldown must prevent issuing'),
        },
      }),
  } as unknown as PrismaClient;
  assert.equal(
    await issueOneTimeCode(prisma, config, { userId: 'user-1', purpose: 'PASSWORD_RESET' }),
    null,
  );
});
