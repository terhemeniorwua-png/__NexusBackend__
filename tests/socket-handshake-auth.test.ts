import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnv } from '../src/config/env';
import { signAccessToken } from '../src/modules/auth/access-token.service';
import { createSocketAuthMiddleware } from '../src/realtime/socket-server';

function makeSocket(auth: Record<string, unknown>) {
  return {
    handshake: { auth },
    data: {} as Record<string, unknown>,
  };
}

test('socket handshake auth accepts a valid short-lived access token in auth.token', async () => {
  const config = loadEnv({ ...process.env, NODE_ENV: 'test' });
  const { token } = signAccessToken(config, { userId: 'user-123', sessionId: 'session-456' });
  const socket = makeSocket({ token, workspaceId: 'ws-789' });

  let err: Error | undefined;
  await createSocketAuthMiddleware(config)(socket, (e) => {
    err = e;
  });

  assert.equal(err, undefined);
  assert.equal(socket.data.userId, 'user-123');
  assert.equal(socket.data.workspaceId, 'ws-789');
});

test('socket handshake auth rejects missing token (does not depend on cookies)', async () => {
  const config = loadEnv({ ...process.env, NODE_ENV: 'test' });
  const socket = makeSocket({});

  let err: Error | undefined;
  await createSocketAuthMiddleware(config)(socket, (e) => {
    err = e;
  });

  assert.ok(err instanceof Error);
  assert.equal(err?.message, 'Authentication failed');
  assert.equal(socket.data.userId, undefined);
});

test('socket handshake auth rejects invalid token', async () => {
  const config = loadEnv({ ...process.env, NODE_ENV: 'test' });
  const socket = makeSocket({ token: 'not-a-valid-jwt' });

  let err: Error | undefined;
  await createSocketAuthMiddleware(config)(socket, (e) => {
    err = e;
  });

  assert.ok(err instanceof Error);
  assert.equal(err?.message, 'Authentication failed');
});
