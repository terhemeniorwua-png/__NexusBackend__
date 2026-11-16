import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { updateProfileSchema } from '../src/modules/users/users.schemas';
import { normalizeAvatarImage } from '../src/modules/users/avatar-image';
import {
  createTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  verifyTotp,
  totpAt,
} from '../src/modules/auth/totp';
import {
  twoFactorChallengeSchema,
  twoFactorDisableSchema,
  recoveryCodeRegenerateSchema,
} from '../src/modules/auth/auth.schemas';

const encryptionKey = Buffer.alloc(32, 7).toString('base64url');

test('TOTP follows RFC 6238 six-digit SHA-1 vectors and accepts one-step drift', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpAt(secret, 59_000), '287082');
  assert.equal(verifyTotp(secret, '287082', 59_000), 1);
  assert.equal(verifyTotp(secret, totpAt(secret, 89_000), 59_000), 2);
  assert.equal(verifyTotp(secret, '000000', 59_000), null);
});

test('TOTP secrets are authenticated-encrypted and tampering is rejected', () => {
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret, encryptionKey);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptTotpSecret(encrypted, encryptionKey), secret);
  const parts = encrypted.split('.');
  parts[3] = `${parts[3]!.startsWith('A') ? 'B' : 'A'}${parts[3]!.slice(1)}`;
  assert.throws(() => decryptTotpSecret(parts.join('.'), encryptionKey));
  assert.match(
    createTotpUri({ secret, account: 'person@example.test', issuer: 'Nexus' }),
    /^otpauth:\/\/totp\//,
  );
});

test('profile updates reject client-supplied avatar URLs', () => {
  assert.equal(updateProfileSchema.safeParse({ name: 'Ada' }).success, true);
  assert.equal(
    updateProfileSchema.safeParse({ avatarUrl: 'https://attacker.example/a.png' }).success,
    false,
  );
});

test('MFA request schemas require exactly one verification proof', () => {
  assert.equal(
    twoFactorChallengeSchema.safeParse({ challengeToken: 'x'.repeat(32), code: '123456' }).success,
    true,
  );
  assert.equal(
    twoFactorChallengeSchema.safeParse({
      challengeToken: 'x'.repeat(32),
      code: '123456',
      recoveryCode: 'A'.repeat(32),
    }).success,
    false,
  );
  assert.equal(
    twoFactorDisableSchema.safeParse({ currentPassword: 'p', recoveryCode: 'A'.repeat(32) })
      .success,
    true,
  );
  assert.equal(recoveryCodeRegenerateSchema.safeParse({ currentPassword: 'p' }).success, true);
  assert.equal(recoveryCodeRegenerateSchema.safeParse({}).success, false);
});

test('avatar image validation uses signatures, rejects corrupt input and enforces dimension limits', async () => {
  const validPng = await sharp({
    create: { width: 3, height: 2, channels: 3, background: '#345678' },
  })
    .png()
    .toBuffer();
  const normalized = await normalizeAvatarImage(validPng, { maxDimension: 10, maxPixels: 100 });
  // All inputs are re-encoded to WebP regardless of the original format.
  assert.equal(normalized.contentType, 'image/webp');
  await assert.rejects(
    () => normalizeAvatarImage(Buffer.from('<html>'), { maxDimension: 10, maxPixels: 100 }),
    { code: 'AVATAR_INVALID_TYPE' },
  );
  await assert.rejects(
    () =>
      normalizeAvatarImage(Buffer.from([0xff, 0xd8, 0xff, 0, 1]), {
        maxDimension: 10,
        maxPixels: 100,
      }),
    { code: 'AVATAR_IMAGE_INVALID' },
  );
  await assert.rejects(() => normalizeAvatarImage(validPng, { maxDimension: 2, maxPixels: 100 }), {
    code: 'AVATAR_DIMENSIONS_TOO_LARGE',
  });
  await assert.rejects(() => normalizeAvatarImage(validPng, { maxDimension: 10, maxPixels: 5 }), {
    code: 'AVATAR_DIMENSIONS_TOO_LARGE',
  });
});

test('avatar re-encoding removes EXIF metadata', async () => {
  const source = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#abcdef' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const normalized = await normalizeAvatarImage(source, { maxDimension: 16, maxPixels: 256 });
  const result = await sharp(normalized.body).metadata();
  assert.equal(result.exif, undefined);
  assert.equal(result.orientation, undefined);
});
