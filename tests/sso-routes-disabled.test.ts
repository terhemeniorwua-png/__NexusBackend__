import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const SSO_ROUTES: Array<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string }> = [
  { method: 'get', path: '/sso/workspaces/ws1/configs' },
  { method: 'get', path: '/sso/workspaces/ws1/configs/cfg1' },
  { method: 'post', path: '/sso/workspaces/ws1/configs' },
  { method: 'patch', path: '/sso/workspaces/ws1/configs/cfg1' },
  { method: 'post', path: '/sso/workspaces/ws1/configs/cfg1/domains' },
  { method: 'post', path: '/sso/workspaces/ws1/domains/dom1/verify' },
  { method: 'post', path: '/sso/workspaces/ws1/configs/cfg1/break-glass-codes' },
  { method: 'post', path: '/sso/workspaces/ws1/break-glass/login' },
  { method: 'post', path: '/sso/workspaces/ws1/break-glass/consume' },
  { method: 'get', path: '/sso/workspaces/ws1/requirement' },
  { method: 'post', path: '/sso/workspaces/ws1/configs/cfg1/disable' },
  { method: 'delete', path: '/sso/workspaces/ws1/configs/cfg1' },
  { method: 'get', path: '/sso/workspaces/ws1/oidc/cfg1/authorize' },
  { method: 'get', path: '/sso/oidc/callback' },
];

async function request(
  server: http.Server,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: method.toUpperCase(),
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body: unknown = data;
          try {
            body = data ? JSON.parse(data) : undefined;
          } catch {
            // keep raw
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (method !== 'get' && method !== 'delete') req.write('{}');
    req.end();
  });
}

describe('SSO routes fail closed when SSO_ENABLED is false', () => {
  test('every SSO route returns 404 SSO_DISABLED when SSO_ENABLED is false/unset', async () => {
    const prev = process.env.SSO_ENABLED;
    delete process.env.SSO_ENABLED;
    try {
      const mod = await import('../src/modules/sso/sso.routes');
      const ssoRouter = mod.default;
      const app = express();
      app.use(express.json());
      const root = express.Router();
      root.use('/sso', ssoRouter);
      app.use(root);
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
        const status = e?.statusCode ?? e?.status ?? 500;
        res.status(status).json({ error: { code: e?.code, message: e?.message } });
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        for (const route of SSO_ROUTES) {
          const res = await request(server, route.method, route.path);
          assert.equal(
            res.status,
            404,
            `${route.method.toUpperCase()} ${route.path} should return 404 when SSO is disabled`,
          );
          const body = res.body as { error?: { code?: string } } | undefined;
          assert.equal(
            body?.error?.code,
            'SSO_DISABLED',
            `${route.method.toUpperCase()} ${route.path} should return SSO_DISABLED`,
          );
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      }
    } finally {
      if (prev === undefined) delete process.env.SSO_ENABLED;
      else process.env.SSO_ENABLED = prev;
    }
  });
});
