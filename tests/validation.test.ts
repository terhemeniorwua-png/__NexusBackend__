import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';
import express, { type Express } from 'express';
import Joi from 'joi';
import { z } from 'zod';
import { billingTargetSchema } from '../src/modules/billing/billing.schemas';
import { createErrorHandler } from '../src/middleware/error-handler';
import { notFoundHandler } from '../src/middleware/not-found';
import { requestId } from '../src/middleware/request-id';
import { validateBody } from '../src/middleware/validation';
import { Logger } from '../src/utils/logger';

function createTestApp(): Express {
  const app = express();
  const schema = z.object({
    name: z.string().trim().min(2),
    email: z.string().email(),
  });

  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  app.post('/echo', validateBody(schema), (req, res) => {
    res.json({ success: true, data: req.body });
  });
  app.post(
    '/joi',
    validateBody(Joi.object({ displayName: Joi.string().trim().min(2).required() }).unknown(false)),
    (req, res) => {
      res.json({ success: true, data: req.body });
    },
  );
  app.post('/billing-target', validateBody(billingTargetSchema), (req, res) => {
    res.json({ success: true, data: req.body });
  });
  app.get('/boom', () => {
    throw new Error('internal database failure');
  });
  app.use(notFoundHandler);
  app.use(createErrorHandler(new Logger('silent'), { isProduction: true }));

  return app;
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1') as Server;
  await once(server, 'listening');

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
      server.closeAllConnections();
    });
  }
}

test('validation middleware accepts and normalizes valid request bodies', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Ada  ', email: 'ada@example.com' }),
    });
    const body = (await response.json()) as { data: { name: string } };

    assert.equal(response.status, 200);
    assert.equal(body.data.name, 'Ada');
  });
});

test('validation middleware returns field-level errors', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'not-an-email' }),
    });
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; details: Array<{ field: string; message: string }> };
    };

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.some((issue) => issue.field === 'body.name'));
    assert.ok(body.error.details.some((issue) => issue.field === 'body.email'));
  });
});

test('Joi validation normalizes input and rejects unrecognized fields', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/joi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '  Ada  ' }),
    });
    const acceptedBody = (await accepted.json()) as { data: { displayName: string } };

    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.data.displayName, 'Ada');

    const rejected = await fetch(`${baseUrl}/joi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ada', role: 'OWNER' }),
    });
    const rejectedBody = (await rejected.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };

    assert.equal(rejected.status, 400);
    assert.equal(rejectedBody.error.code, 'VALIDATION_ERROR');
    assert.ok(rejectedBody.error.details.some((issue) => issue.message.includes('role')));

    const forgedBillingTarget = await fetch(`${baseUrl}/billing-target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'PRO', interval: 'MONTHLY', billableSeats: 1 }),
    });

    assert.equal(forgedBillingTarget.status, 400);
  });
});

test('malformed JSON returns a safe error response', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const body = (await response.json()) as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'INVALID_JSON');
  });
});

test('oversized request bodies are rejected', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(2_000), email: 'ada@example.com' }),
    });
    const body = (await response.json()) as { error: { code: string } };

    assert.equal(response.status, 413);
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('internal errors do not expose implementation details', async () => {
  await withServer(createTestApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/boom`);
    const body = (await response.json()) as { error: { code: string; message: string } };

    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred');
    assert.equal(body.error.message.includes('database'), false);
  });
});
