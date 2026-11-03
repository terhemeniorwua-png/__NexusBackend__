import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { createErrorHandler } from '../src/middleware/error-handler';
import { createRequestLogger } from '../src/middleware/request-logger';
import { Logger } from '../src/utils/logger';
import { redactSensitivePath, redactSensitiveText } from '../src/utils/log-redaction';

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

test('request logs never include an authentication token from the query string', () => {
  const token = 'authentication-code-secret-token';
  const entry = captureRequestLog(
    `/api/v1/auth/password-reset/confirm?token=${token}&email=user%40example.com`,
  );

  assert.equal(entry.path, '/api/v1/auth/password-reset/confirm');
  assert.equal(JSON.stringify(entry).includes(token), false);
  assert.equal(JSON.stringify(entry).includes('user@example.com'), false);
});

test('error logs redact tokens and addresses from paths, messages and stacks', () => {
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
    originalUrl: `/api/v1/invitations/${invitationToken}/accept?token=${invitationToken}`,
  } as unknown as Request;
  const response = {
    headersSent: false,
    status: () => response,
    json: () => response,
  } as unknown as Response;
  const handler = createErrorHandler(logger, { isProduction: true });

  handler(
    new Error(
      `Failed to process ${address}: /api/v1/invitations/${invitationToken}/accept and /api/v1/webhooks/email/${webhookToken}?token=${webhookToken}`,
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

test('redaction helpers leave ordinary operational text intact', () => {
  const path = '/api/v1/workspaces/ws_123/projects/proj_456';
  const text = 'email_delivery_failed deliveryId=eml_123 provider=brevo attempt=2';

  assert.equal(redactSensitivePath(path), path);
  assert.equal(redactSensitiveText(text), text);
});
