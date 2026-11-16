/**
 * Avatar file-upload integration tests.
 *
 * These tests exercise the full HTTP stack (Express + Prisma + fake S3) for
 * POST /api/v1/users/me/avatar and DELETE /api/v1/users/me/avatar.
 *
 * Gate: RUN_PHASE8_DB_TESTS=true  (same flag as calendar/meeting tests)
 *
 * The fake object-storage server stores blobs in a Map so that tests never
 * touch a real S3-compatible bucket. It listens on a random port on
 * 127.0.0.1 and is shut down after every suite run.
 *
 * Syntax checked by: npx esbuild tests/avatar-upload.test.ts --log-level=error
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { after, before, describe } from 'node:test';
import sharp from 'sharp';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { getPrismaClient } from '../src/db/prisma';
import { parseEnv } from '../src/config/env';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { jsonRequest, startServer, type RunningServer } from './helpers/test-server';

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Avatar upload tests', () =>
    test('skipped — set RUN_PHASE8_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid PNG buffer (1×1 pixel). */
async function makePng(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
}

/** Build a minimal valid JPEG buffer. */
async function makeJpeg(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#336699' },
  })
    .jpeg()
    .toBuffer();
}

/** Build a minimal valid WebP buffer. */
async function makeWebp(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#336699' },
  })
    .webp()
    .toBuffer();
}

/** Post a file to POST /api/v1/users/me/avatar using multipart/form-data. */
async function uploadAvatar(
  baseUrl: string,
  token: string,
  fileBuffer: Buffer,
  mimeType: string,
  filename = 'image.bin',
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  return fetch(`${baseUrl}/api/v1/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

function runTests(rawDbUrl: string): void {
  const tag = `${process.pid}-${Date.now()}`;

  // Fake S3 state shared across tests within the suite.
  const storedObjects = new Map<string, { body: Buffer; contentType: string }>();
  const deletedKeys: string[] = [];

  let objectStorageEndpoint = '';
  let fakeS3Server: ReturnType<typeof createServer> | undefined;
  let appServer: RunningServer;
  let baseUrl: string;

  // ---------------------------------------------------------------------------
  // before / after
  // ---------------------------------------------------------------------------

  before(async () => {
    // 1. Connect to the test database and run migrations.
    const db = await connectTestDatabase(rawDbUrl);
    getPrismaClient(db.url);
    await db.prisma.$disconnect();

    // 2. Start the fake S3 HTTP server.
    fakeS3Server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      // Strip /<bucket>/ prefix to get the object key.
      const objectKey = pathname.replace(/^\/[^/]+\//, '');

      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          storedObjects.set(objectKey, {
            body: Buffer.concat(chunks),
            contentType: req.headers['content-type'] ?? 'application/octet-stream',
          });
          res.statusCode = 200;
          res.end();
        });
        return;
      }

      if (req.method === 'DELETE') {
        deletedKeys.push(objectKey);
        storedObjects.delete(objectKey);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'HEAD') {
        if (storedObjects.has(objectKey)) {
          const obj = storedObjects.get(objectKey)!;
          res.setHeader('content-type', obj.contentType);
          res.setHeader('content-length', obj.body.length);
          res.statusCode = 200;
        } else {
          res.statusCode = 404;
        }
        res.end();
        return;
      }

      // GET
      const obj = storedObjects.get(objectKey);
      if (!obj) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', obj.contentType);
      res.setHeader('content-length', obj.body.length);
      res.statusCode = 200;
      res.end(req.method === 'HEAD' ? undefined : obj.body);
    });

    fakeS3Server.listen(0, '127.0.0.1');
    await once(fakeS3Server, 'listening');
    const addr = fakeS3Server.address();
    assert.ok(addr && typeof addr !== 'string');
    objectStorageEndpoint = `http://127.0.0.1:${addr.port}`;

    // 3. Parse config with fake storage wired in.
    const config = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: rawDbUrl,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'avatar-test-secret-value-that-is-long-enough',
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
      BCRYPT_SALT_ROUNDS: '4',
      RATE_LIMIT_MAX: '100000',
      AUTH_LOGIN_RATE_LIMIT_MAX: '1000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      AUTH_PASSWORD_RATE_LIMIT_MAX: '1000',
      AUTH_VERIFICATION_RATE_LIMIT_MAX: '1000',
      // Set the file limit to 2 MiB and dimension limit to 512 to match contract.
      AVATAR_MAX_FILE_SIZE_BYTES: String(2 * 1024 * 1024),
      AVATAR_MAX_DIMENSION: '512',
      AVATAR_MAX_PIXELS: String(512 * 512),
      AVATAR_RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_NAMESPACE: `avatar-upload-test-${tag}`,
      OBJECT_STORAGE_ENDPOINT: objectStorageEndpoint,
      OBJECT_STORAGE_BUCKET: 'nexus-test-private',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    });

    try {
      await connectRedis(config);
    } catch {
      // Rate-limit falls back safely when Redis is unreachable in CI.
    }

    appServer = await startServer(createApp({ config }));
    baseUrl = appServer.baseUrl;
  });

  after(async () => {
    await appServer?.close();
    if (fakeS3Server?.listening) {
      await new Promise<void>((resolve, reject) =>
        fakeS3Server!.close((err) => (err ? reject(err) : resolve())),
      );
    }
    await disconnectRedis();
  });

  // ---------------------------------------------------------------------------
  // Shared helper: register + activate a fresh user and log in.
  // ---------------------------------------------------------------------------

  interface ActiveUser {
    id: string;
    email: string;
    token: string;
  }

  async function registerAndActivate(suffix: string): Promise<ActiveUser> {
    const email = `avatar-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';

    const reg = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name: `Avatar ${suffix}`, email, password }),
    });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);

    // Activate directly via Prisma.
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await db.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();

    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);
    const token = (login.body.data as { accessToken: string }).accessToken;

    // Retrieve the canonical userId.
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const id = (me.body.data as { user: { id: string } }).user.id;

    return { id, email, token };
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Avatar upload tests', () => {
    test('valid PNG upload succeeds, response has avatarUrl, user record is updated', async () => {
      const user = await registerAndActivate('png-ok');
      const png = await makePng();

      const res = await uploadAvatar(baseUrl, user.token, png, 'image/png', 'photo.png');
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);

      const body = (await res.json()) as {
        success: boolean;
        data: { avatarUrl: string };
      };
      assert.equal(body.success, true);
      assert.ok(
        body.data.avatarUrl && typeof body.data.avatarUrl === 'string',
        'response must contain avatarUrl',
      );

      // The DB row must have the storage key set.
      const db = await connectTestDatabase(rawDbUrl);
      const profile = await db.prisma.userProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      await db.prisma.$disconnect();

      assert.ok(profile.avatarStorageKey, 'avatarStorageKey must be set after upload');
      assert.match(
        profile.avatarStorageKey,
        new RegExp(`^avatars/${user.id}/[0-9a-f-]+\\.webp$`),
        'storage key must end in .webp',
      );
      assert.equal(profile.avatarUrl, null, 'legacy avatarUrl must be cleared after upload');

      // The stored object must be present in the fake S3 bucket.
      assert.ok(
        storedObjects.has(profile.avatarStorageKey),
        'uploaded object must be in fake bucket',
      );
      const stored = storedObjects.get(profile.avatarStorageKey)!;
      assert.equal(stored.contentType, 'image/webp', 'stored object must be WebP');
    });

    test('valid JPEG upload succeeds and stores as WebP', async () => {
      const user = await registerAndActivate('jpeg-ok');
      const jpeg = await makeJpeg();

      const res = await uploadAvatar(baseUrl, user.token, jpeg, 'image/jpeg', 'photo.jpg');
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);

      const body = (await res.json()) as { success: boolean; data: { avatarUrl: string } };
      assert.equal(body.success, true);
      assert.ok(body.data.avatarUrl);

      const db = await connectTestDatabase(rawDbUrl);
      const profile = await db.prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
      await db.prisma.$disconnect();

      assert.match(
        profile.avatarStorageKey ?? '',
        /\.webp$/,
        'JPEG input must also be stored as .webp',
      );
    });

    test('valid WebP upload succeeds and stores as WebP', async () => {
      const user = await registerAndActivate('webp-ok');
      const webp = await makeWebp();

      const res = await uploadAvatar(baseUrl, user.token, webp, 'image/webp', 'photo.webp');
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);

      const db = await connectTestDatabase(rawDbUrl);
      const profile = await db.prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
      await db.prisma.$disconnect();

      assert.match(profile.avatarStorageKey ?? '', /\.webp$/);
    });

    test('GET /me after upload returns avatarUrl pointing at the proxy route', async () => {
      const user = await registerAndActivate('get-me');
      const png = await makePng();

      await uploadAvatar(baseUrl, user.token, png, 'image/png');

      const me = await jsonRequest(`${baseUrl}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      assert.equal(me.status, 200);
      const profile = (me.body.data as { profile: { avatarUrl: string } }).profile;
      assert.equal(
        profile.avatarUrl,
        '/api/v1/users/me/avatar',
        'profile.avatarUrl must be the proxy path',
      );
    });

    test('file over 2 MiB is rejected with AVATAR_TOO_LARGE (413)', async () => {
      const user = await registerAndActivate('too-large');
      // 2 MiB + 1 byte — all zeros (not a valid image, rejected at the multer
      // layer before sharp even runs).
      const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0);

      const res = await uploadAvatar(baseUrl, user.token, oversized, 'image/png', 'big.png');
      assert.equal(res.status, 413, `expected 413, got ${res.status}`);

      const body = (await res.json()) as { error?: { code: string } };
      assert.equal(body.error?.code, 'AVATAR_TOO_LARGE');
    });

    test('text file renamed to .png is rejected with AVATAR_INVALID_TYPE (415)', async () => {
      const user = await registerAndActivate('text-png');
      const text = Buffer.from('<html>not an image</html>');

      const res = await uploadAvatar(baseUrl, user.token, text, 'image/png', 'fake.png');
      assert.equal(res.status, 415, `expected 415, got ${res.status}`);

      const body = (await res.json()) as { error?: { code: string } };
      assert.equal(body.error?.code, 'AVATAR_INVALID_TYPE');
    });

    test('SVG file is rejected with AVATAR_INVALID_TYPE (415)', async () => {
      const user = await registerAndActivate('svg-reject');
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

      const res = await uploadAvatar(baseUrl, user.token, svg, 'image/svg+xml', 'icon.svg');
      assert.equal(res.status, 415, `expected 415, got ${res.status}`);

      const body = (await res.json()) as { error?: { code: string } };
      assert.equal(body.error?.code, 'AVATAR_INVALID_TYPE');
    });

    test('GIF magic bytes are rejected with AVATAR_INVALID_TYPE (415)', async () => {
      const user = await registerAndActivate('gif-reject');
      // Minimal GIF89a header.
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);

      const res = await uploadAvatar(baseUrl, user.token, gif, 'image/gif', 'anim.gif');
      assert.equal(res.status, 415, `expected 415, got ${res.status}`);

      const body = (await res.json()) as { error?: { code: string } };
      assert.equal(body.error?.code, 'AVATAR_INVALID_TYPE');
    });

    test('request with no file is rejected with AVATAR_MISSING_FILE (400)', async () => {
      const user = await registerAndActivate('no-file');

      // POST multipart with an empty form (no file field).
      const form = new FormData();
      const res = await fetch(`${baseUrl}/api/v1/users/me/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: form,
      });
      assert.equal(res.status, 400, `expected 400, got ${res.status}`);

      const body = (await res.json()) as { error?: { code: string } };
      assert.equal(body.error?.code, 'AVATAR_MISSING_FILE');
    });

    test('unauthenticated POST is rejected with 401', async () => {
      const png = await makePng();
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'photo.png');

      const res = await fetch(`${baseUrl}/api/v1/users/me/avatar`, {
        method: 'POST',
        body: form,
      });
      assert.equal(res.status, 401);
    });

    test('unauthenticated DELETE is rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/api/v1/users/me/avatar`, { method: 'DELETE' });
      assert.equal(res.status, 401);
    });

    test('user A cannot change user B avatar via the upload endpoint', async () => {
      // The endpoint is /me — each authenticated user can only modify their own
      // avatar. There is no route that allows specifying another user's ID.
      // We verify that uploading as A does not affect B's profile.
      const a = await registerAndActivate('cross-a');
      const b = await registerAndActivate('cross-b');

      const png = await makePng();
      const res = await uploadAvatar(baseUrl, a.token, png, 'image/png');
      assert.equal(res.status, 200);

      // B's profile must not have an avatar storage key.
      const db = await connectTestDatabase(rawDbUrl);
      const profileB = await db.prisma.userProfile.findUnique({ where: { userId: b.id } });
      await db.prisma.$disconnect();

      assert.ok(
        !profileB?.avatarStorageKey,
        'user B must not have an avatar after user A uploads',
      );
    });

    test('replacing the avatar deletes the previous object from storage', async () => {
      const user = await registerAndActivate('replace');
      const png1 = await makePng(8, 8);
      const png2 = await makePng(12, 12);

      // First upload.
      const res1 = await uploadAvatar(baseUrl, user.token, png1, 'image/png');
      assert.equal(res1.status, 200);

      const db = await connectTestDatabase(rawDbUrl);
      const profile1 = await db.prisma.userProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      await db.prisma.$disconnect();
      const firstKey = profile1.avatarStorageKey!;

      // Second upload — should supersede the first.
      const res2 = await uploadAvatar(baseUrl, user.token, png2, 'image/png');
      assert.equal(res2.status, 200);

      // The first key must have been deleted from fake S3.
      assert.ok(deletedKeys.includes(firstKey), 'previous avatar object must be deleted on replace');

      // The new key must still be in the bucket.
      const db2 = await connectTestDatabase(rawDbUrl);
      const profile2 = await db2.prisma.userProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      await db2.prisma.$disconnect();
      assert.ok(storedObjects.has(profile2.avatarStorageKey!), 'new avatar must be in fake bucket');
    });

    test('DELETE removes the stored object and returns avatarUrl: null', async () => {
      const user = await registerAndActivate('delete-ok');
      const png = await makePng();

      // Upload first.
      const up = await uploadAvatar(baseUrl, user.token, png, 'image/png');
      assert.equal(up.status, 200);

      const db = await connectTestDatabase(rawDbUrl);
      const profileBefore = await db.prisma.userProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      await db.prisma.$disconnect();
      const key = profileBefore.avatarStorageKey!;
      assert.ok(key, 'must have a storage key before delete');

      // Now delete.
      const del = await jsonRequest(`${baseUrl}/api/v1/users/me/avatar`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.token}` },
      });
      assert.equal(del.status, 200, `DELETE failed: ${JSON.stringify(del.body)}`);

      const delBody = del.body.data as { avatarUrl: unknown };
      assert.equal(delBody.avatarUrl, null, 'DELETE must return avatarUrl: null');

      // Storage key must be cleared in the DB.
      const db2 = await connectTestDatabase(rawDbUrl);
      const profileAfter = await db2.prisma.userProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      await db2.prisma.$disconnect();
      assert.equal(profileAfter.avatarStorageKey, null, 'avatarStorageKey must be null after delete');

      // Object must have been deleted from fake S3.
      assert.ok(deletedKeys.includes(key), 'deleted key must appear in fake S3 delete log');
    });

    test('profile-update endpoint does not accept an external avatarUrl', async () => {
      const user = await registerAndActivate('no-url-patch');

      const res = await jsonRequest(`${baseUrl}/api/v1/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ avatarUrl: 'https://attacker.example/avatar.png' }),
      });
      // The schema is strict so unknown keys → 400.
      assert.equal(res.status, 400, `expected 400 for avatarUrl in PATCH, got ${res.status}`);
    });
  });
}
