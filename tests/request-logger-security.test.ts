import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { createErrorHandler } from '../src/middleware/error-handler';
import { createRequestLogger } from '../src/middleware/request-logger';
import { Logger } from '../src/utils/logger';

function captureRequestLog(originalUrl: string): Record<string, unknown> {
  let finish: (() => void) | undefined;
  let entry: Record<string, unknown> | undefined;
  const logger = new Logger('info', {}, (line) => {
    entry = JSON.parse(line) as Record<string, unknown>;
  });
  const request = {
    originalUrl,
    requestId: 'request-1',
    method: 'GET',
    ip: '127.0.0.1',
    header: () => undefined,
  } as unknown as Request;
  const response = {
    statusCode: 200,
    on: (_event: string, callback: () => void) => {
      finish = callback;
    },
  } as unknown as Response;

  createRequestLogger(logger)(request, response, () => undefined);
  finish?.();

  assert.ok(entry);
  return entry;
}

test('request logs redact invitation tokens from preview and acceptance paths', () => {
  const token = 'single-use-invitation-secret-token';

  for (const suffix of ['', '/accept']) {
    const entry = captureRequestLog(`/api/v1/invitations/${token}${suffix}`);

    assert.equal(entry.path, `/api/v1/invitations/[REDACTED]${suffix}`);
    assert.equal(JSON.stringify(entry).includes(token), false);
  }
});

test('request logs redact email webhook URL tokens', () => {
  const token = 'provider-shared-secret-token';
  const entry = captureRequestLog(`/api/v1/webhooks/email/${token}`);

  assert.equal(entry.path, '/api/v1/webhooks/email/[REDACTED]');
  assert.equal(JSON.stringify(entry).includes(token), false);
});

test('error logs redact tokens and addresses from paths and error messages', () => {
  const invitationToken = 'single-use-invitation-secret-token';
  const webhookToken = 'provider-shared-secret-token';
  const address = 'invitee@example.com';
  const entries: Record<string, unknown>[] = [];
  const logger = new Logger('info', {}, (line) => {
    entries.push(JSON.parse(line) as Record<string, unknown>);
  });
  const request = {
    requestId: 'request-error-1',
    method: 'GET',
    originalUrl: `/api/v1/invitations/${invitationToken}/accept`,
  } as unknown as Request;
  const response = {
    headersSent: false,
    status: () => response,
    json: () => response,
  } as unknown as Response;
  const handler = createErrorHandler(logger, { isProduction: true });

  handler(
    new Error(
      `Failed to process ${address}: /api/v1/invitations/${invitationToken}/accept and /api/v1/webhooks/email/${webhookToken}`,
    ),
    request,
    response,
    () => undefined,
  );

  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries[0]);
  assert.equal(serialized.includes(invitationToken), false);
  assert.equal(serialized.includes(webhookToken), false);
  assert.equal(serialized.includes(address), false);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /\[REDACTED_EMAIL\]/);
});
