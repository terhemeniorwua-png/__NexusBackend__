import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { validateOrganizationLogo } from '../src/modules/organizations/organization.routes';
import { createS3CompatibleObjectStorage } from '../src/services/storage/private-object-storage';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test('organization logo validation checks size, signature and declared media type', () => {
  assert.deepEqual(validateOrganizationLogo(png, 'image/png; charset=binary'), {
    body: png,
    contentType: 'image/png',
    extension: 'png',
  });
  assert.throws(() => validateOrganizationLogo(png, 'image/jpeg'));
  assert.throws(() => validateOrganizationLogo(Buffer.from('<svg/>'), 'image/svg+xml'));
  assert.throws(() => validateOrganizationLogo(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png'));
});

test('private organization logo storage signs requests and bounds reads', async (t) => {
  const objects = new Map<string, Buffer>();
  const requests: Array<{ method: string; authorization: string | undefined }> = [];
  let oversized = false;
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', authorization: req.headers.authorization });
    const key = (req.url ?? '').split('/').slice(2).join('/');
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === 'GET') {
      if (oversized) {
        res
          .writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(2 * 1024 * 1024 + 1),
          })
          .end();
      } else {
        res.writeHead(200, { 'content-type': 'image/png' }).end(objects.get(key) ?? png);
      }
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(objects.has(key) ? 200 : 404).end();
      return;
    }
    if (req.method === 'DELETE') {
      if (!objects.has(key)) {
        res.writeHead(404).end();
        return;
      }
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const storage = createS3CompatibleObjectStorage({
    endpoint: `http://127.0.0.1:${address.port}/storage`,
    bucket: 'private-assets',
    region: 'us-east-1',
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
    requestTimeoutMs: 2_000,
  });
  const key = 'organization-logos/workspace-id/logo.png';

  await storage.put({ key, body: png, contentType: 'image/png' });
  assert.equal(await storage.exists(key), true);
  assert.equal(await storage.exists('organization-logos/workspace-id/missing.png'), false);
  assert.deepEqual((await storage.get(key)).body, png);
  await storage.delete(key);
  await storage.delete(key); // Deleting an already absent key is idempotent.
  assert.deepEqual(
    requests.map(({ method }) => method),
    ['PUT', 'HEAD', 'HEAD', 'GET', 'DELETE', 'DELETE'],
  );
  assert.ok(requests.every(({ authorization }) => authorization?.startsWith('AWS4-HMAC-SHA256 ')));
  await assert.rejects(storage.get('../private'));

  oversized = true;
  await assert.rejects(storage.get(key), /Stored logo exceeds the supported size/);
});
