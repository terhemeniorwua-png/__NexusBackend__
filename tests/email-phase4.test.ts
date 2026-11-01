import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv, type AppConfig } from '../src/config/env';
import {
  buildEmailBrand,
  buildEmailChangeEmail,
  buildMeetingInvitationEmail,
  buildMessageId,
  buildMentionEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildSecurityNotificationEmail,
  buildTaskAssignmentEmail,
  buildVerificationEmail,
  buildWorkspaceInvitationEmail,
  createLoggingEmailSender,
  deliveryIdFromMessageId,
  deriveIdempotencyKey,
  normalizeMessageId,
  retryDelayMs,
  verifyWebhookToken,
  type EmailMessage,
} from '../src/services/email';
import { redactEmailAddresses, summarizeErrorForLog } from '../src/services/email/log-privacy';
import { createConsoleTransport, createEmailTransport } from '../src/services/providers/email';
import { captureLogs } from './helpers/test-logger';
import {
  mapProviderEvent,
  normalizeEventType,
  verifyWebhookSignature,
} from '../src/services/email/webhook.service';
import { classifyTransportError } from '../src/services/providers/email/error-classification';
import { createHmac } from 'node:crypto';

/**
 * Phase 4 unit tests.
 *
 * These cover the template rendering, the idempotency key derivation, the
 * retry schedule, the webhook signature verification and the provider event
 * mapping without touching PostgreSQL or a provider.
 */

const config: AppConfig = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
  REDIS_URL: 'redis://localhost:6379/15',
  JWT_ACCESS_SECRET: 'phase4-unit-test-access-secret-value-that-is-long',
  EMAIL_SUPPORT_ADDRESS: 'support@example.com',
});

const brand = buildEmailBrand(config);

function message(input: Partial<EmailMessage> & { to: string; subject: string }): EmailMessage {
  return {
    template: 'account_verification',
    text: 'text',
    ...input,
  };
}

test('the verification template renders both an HTML and a plain text version', () => {
  const email = buildVerificationEmail({
    to: 'ada@example.com',
    name: 'Ada Lovelace',
    brand,
    verificationUrl: 'http://localhost:3000/verify-email?token=abc123',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  assert.equal(email.template, 'account_verification');
  assert.ok(email.html);
  assert.match(email.html as string, /^<!doctype html>/);
  assert.match(email.html as string, /Verify email address/);
  assert.match(email.text, /token=abc123/);
  assert.match(email.text, /expires in 60 minutes/);
  assert.ok(email.text.includes('http://localhost:3000/verify-email?token=abc123'));
});

test('templates escape user supplied values in the HTML version', () => {
  const email = buildVerificationEmail({
    to: 'ada@example.com',
    name: '<script>alert("x")</script>',
    brand,
    verificationUrl: 'http://localhost:3000/verify-email?token=abc123',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  assert.ok(email.html);
  assert.equal((email.html as string).includes('<script>'), false);
  assert.match(email.html as string, /&lt;script&gt;/);
  assert.equal(email.text.includes('<script>'), true);
});

test('templates never put a single use link in the subject line', () => {
  const email = buildVerificationEmail({
    to: 'ada@example.com',
    name: 'Ada Lovelace',
    brand,
    verificationUrl: 'http://localhost:3000/verify-email?token=super-secret-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  assert.equal(email.subject.includes('super-secret-token'), false);
  assert.equal(email.subject.includes('token='), false);
});

test('the account templates cover the whole account lifecycle', () => {
  const reset = buildPasswordResetEmail({
    to: 'ada@example.com',
    name: 'Ada Lovelace',
    brand,
    resetUrl: 'http://localhost:3000/reset-password?token=reset123',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  assert.equal(reset.template, 'password_reset');
  assert.match(reset.text, /token=reset123/);

  const changed = buildPasswordChangedEmail({
    to: 'ada@example.com',
    name: 'Ada Lovelace',
    brand,
    changedAt: new Date('2026-01-01T10:00:00.000Z'),
    resetUrl: 'http://localhost:3000/reset-password',
  });

  assert.equal(changed.template, 'password_changed');
  assert.match(changed.text, /password was changed/i);

  const emailChange = buildEmailChangeEmail({
    to: 'new@example.com',
    name: 'Ada Lovelace',
    brand,
    verificationUrl: 'http://localhost:3000/settings/email?token=change123',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    newEmail: 'new@example.com',
  });

  assert.equal(emailChange.template, 'email_change_verification');
  assert.match(emailChange.text, /new@example\.com/);

  const security = buildSecurityNotificationEmail({
    to: 'ada@example.com',
    name: 'Ada Lovelace',
    brand,
    subject: 'A new sign in',
    detail: 'Your account was used to sign in from a new device.',
  });

  assert.equal(security.template, 'security_notification');
  assert.match(security.text, /new sign in/i);
});

test('the collaboration templates cover invitations, assignments, mentions and meetings', () => {
  const invitation = buildWorkspaceInvitationEmail({
    to: 'grace@example.com',
    name: 'Grace Hopper',
    brand,
    inviterName: 'Ada Lovelace',
    workspaceName: 'Analytical Engines',
    acceptUrl: 'http://localhost:3000/invitations/accept?token=invite123',
    role: 'MEMBER',
  });

  assert.equal(invitation.template, 'workspace_invitation');
  assert.match(invitation.text, /token=invite123/);
  assert.match(invitation.text, /Analytical Engines/);

  const task = buildTaskAssignmentEmail({
    to: 'grace@example.com',
    name: 'Grace Hopper',
    brand,
    taskTitle: 'Write the compiler',
    projectName: 'ENGINES',
    assignedByName: 'Ada Lovelace',
    taskUrl: 'http://localhost:3000/tasks/42',
  });

  assert.equal(task.template, 'task_assignment');
  assert.match(task.text, /Write the compiler/);

  const mention = buildMentionEmail({
    to: 'grace@example.com',
    name: 'Grace Hopper',
    brand,
    mentionedByName: 'Ada Lovelace',
    context: 'the project channel',
    contextUrl: 'http://localhost:3000/conversations/7',
  });

  assert.equal(mention.template, 'mention');
  assert.match(mention.text, /mentioned you/i);

  const meeting = buildMeetingInvitationEmail({
    to: 'grace@example.com',
    name: 'Grace Hopper',
    brand,
    meetingTitle: 'Planning',
    organizerName: 'Ada Lovelace',
    startsAt: new Date('2026-01-01T10:00:00.000Z'),
    durationMinutes: 30,
    joinUrl: 'http://localhost:3000/meetings/3/join',
  });

  assert.equal(meeting.template, 'meeting_invitation');
  assert.match(meeting.text, /join/i);
});

test('an idempotency key is stable for the same message and differs for another one', () => {
  const first = message({ to: 'ada@example.com', subject: 'Hello' });
  const second = message({ to: 'ada@example.com', subject: 'Hello' });
  const other = message({ to: 'grace@example.com', subject: 'Hello' });

  assert.equal(deriveIdempotencyKey(first), deriveIdempotencyKey(second));
  assert.notEqual(deriveIdempotencyKey(first), deriveIdempotencyKey(other));
  assert.match(
    deriveIdempotencyKey(first),
    /^auto:account_verification:ada@example\.com:[a-f0-9]{64}$/,
  );
});

test('the retry schedule grows and stays inside the configured maximum', () => {
  const first = retryDelayMs(1, config);
  const second = retryDelayMs(2, config);
  const tenth = retryDelayMs(10, config);

  assert.ok(first >= config.emailRetryBaseDelayMs * 0.9);
  assert.ok(second > first);
  assert.ok(tenth <= config.emailRetryMaxDelayMs * 1.1);
});

test('a webhook signature is only accepted for the exact raw body', () => {
  const body = Buffer.from('{"id":"evt_1"}', 'utf8');
  const secret = 'a'.repeat(32);
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(
    verifyWebhookSignature({
      rawBody: body,
      signature: `sha256=${signature}`,
      secret,
      toleranceSeconds: 300,
    }),
    true,
  );

  assert.equal(
    verifyWebhookSignature({
      rawBody: Buffer.from('{"id":"evt_2"}', 'utf8'),
      signature: `sha256=${signature}`,
      secret,
      toleranceSeconds: 300,
    }),
    false,
  );

  assert.equal(
    verifyWebhookSignature({
      rawBody: body,
      signature: `sha256=${signature}`,
      secret: 'b'.repeat(32),
      toleranceSeconds: 300,
    }),
    false,
  );

  assert.equal(
    verifyWebhookSignature({
      rawBody: body,
      signature: undefined,
      secret,
      toleranceSeconds: 300,
    }),
    false,
  );
});

test('a timestamped webhook signature is rejected after the tolerance window', () => {
  const body = Buffer.from('{"id":"evt_1"}', 'utf8');
  const secret = 'c'.repeat(32);
  const issuedAt = 1_800_000_000;
  const signature = createHmac('sha256', secret)
    .update(`${issuedAt}.${body.toString('utf8')}`)
    .digest('hex');

  assert.equal(
    verifyWebhookSignature({
      rawBody: body,
      signature: `t=${issuedAt},v1=${signature}`,
      secret,
      toleranceSeconds: 300,
      now: issuedAt + 10,
    }),
    true,
  );

  assert.equal(
    verifyWebhookSignature({
      rawBody: body,
      signature: `t=${issuedAt},v1=${signature}`,
      secret,
      toleranceSeconds: 300,
      now: issuedAt + 3_600,
    }),
    false,
  );
});

test('provider event names are normalized', () => {
  assert.equal(normalizeEventType('email.delivered'), 'delivered');
  assert.equal(normalizeEventType('email.bounced'), 'bounced');
  assert.equal(normalizeEventType('spam'), 'complained');
  assert.equal(normalizeEventType('email.delivery_delayed'), 'delayed');
  assert.equal(normalizeEventType('Delivery Failed'), 'failed');
  assert.equal(normalizeEventType('something else'), 'unknown');
});

test('the Brevo event names are understood', () => {
  assert.equal(normalizeEventType('delivered'), 'delivered');
  assert.equal(normalizeEventType('hard_bounce'), 'bounced');
  assert.equal(normalizeEventType('soft_bounce'), 'delayed');
  assert.equal(normalizeEventType('blocked'), 'bounced');
  assert.equal(normalizeEventType('spam'), 'complained');
  assert.equal(normalizeEventType('unsubscribe'), 'complained');
  assert.equal(normalizeEventType('sent'), 'sent');
  assert.equal(normalizeEventType('queued'), 'unknown');
});

test('a Brevo payload carries the message id, the recipient and the moment', () => {
  const event = mapProviderEvent({
    event: 'delivered',
    email: 'Ada@Example.com',
    message_id: '<3f0a1c2e@nexus.example>',
    ts: 1790000000,
    date: '2026-10-21 12:00:00',
  });

  assert.equal(event?.type, 'delivered');
  assert.equal(event?.providerMessageId, '3f0a1c2e@nexus.example');
  assert.deepEqual(event?.recipients, ['ada@example.com']);
  assert.equal(event?.eventTimestamp, 1790000000);
});

test('a message id identifies the delivery it belongs to', () => {
  const messageId = buildMessageId('d3l1v3ry', 'Nexus <noreply@example.com>');

  assert.equal(messageId, 'd3l1v3ry@example.com');
  assert.equal(deliveryIdFromMessageId(`<${messageId}>`), 'd3l1v3ry');
  assert.equal(normalizeMessageId(`<${messageId}>`), messageId);
  assert.equal(deliveryIdFromMessageId(undefined), undefined);
});

test('a webhook token is only accepted when it matches', () => {
  const expected = 'a-token-that-is-long-enough-for-the-test';

  assert.equal(verifyWebhookToken({ token: expected, expected }), true);
  assert.equal(verifyWebhookToken({ token: 'wrong-token', expected }), false);
  assert.equal(verifyWebhookToken({ token: undefined, expected }), false);
  assert.equal(verifyWebhookToken({ token: expected, expected: undefined }), false);
});

test('provider payloads are mapped onto one event shape', () => {
  const resendStyle = mapProviderEvent({
    id: 'evt_1',
    type: 'email.delivered',
    data: { email_id: 'msg_1', to: ['Ada@Example.com'] },
  });

  assert.equal(resendStyle?.eventId, 'evt_1');
  assert.equal(resendStyle?.type, 'delivered');
  assert.equal(resendStyle?.providerMessageId, 'msg_1');
  assert.deepEqual(resendStyle?.recipients, ['ada@example.com']);

  const sesStyle = mapProviderEvent({
    eventType: 'Bounce',
    mail: { messageId: '0100-msg-2' },
    bounce: { bounceType: 'Permanent' },
  });

  assert.equal(sesStyle?.type, 'bounced');
  assert.equal(sesStyle?.providerMessageId, '0100-msg-2');

  const brevoStyle = mapProviderEvent({
    event: 'hard_bounce',
    email: 'ada@example.com',
    message_id: 'msg-3',
  });

  assert.equal(brevoStyle?.type, 'bounced');
  assert.equal(brevoStyle?.providerMessageId, 'msg-3');
  assert.deepEqual(brevoStyle?.recipients, ['ada@example.com']);

  assert.equal(mapProviderEvent('not an object'), null);

  // A provider that does not send an event id still gets a stable one, so a
  // repeated event is recognised as a duplicate.
  const withoutId = mapProviderEvent({ type: 'email.delivered' });

  assert.ok(withoutId);
  assert.match(withoutId?.eventId ?? '', /^[a-f0-9]{64}$/);
  assert.equal(withoutId?.eventId, mapProviderEvent({ type: 'email.delivered' })?.eventId);
});

test('email addresses are removed from error text before it is logged', () => {
  const redacted = redactEmailAddresses('Rejected ada@example.com and grace.hopper@example.co.uk');

  assert.equal(redacted, 'Rejected [REDACTED_EMAIL] and [REDACTED_EMAIL]');

  const summary = summarizeErrorForLog(
    Object.assign(new Error('SMTP rejected ada@example.com'), { code: 'EENVELOPE' }),
  );

  assert.equal(JSON.stringify(summary).includes('ada@example.com'), false);
  assert.equal(summary.name, 'Error');
  assert.equal(summary.code, 'EENVELOPE');
  assert.match(summary.message as string, /\[REDACTED_EMAIL\]/);
  assert.match(summary.stack as string, /\[REDACTED_EMAIL\]/);
});

test('development transports log delivery metadata without the recipient address', async () => {
  const email = 'private.recipient@example.com';
  const request = {
    deliveryId: 'eml_privacy',
    to: email,
    from: 'Nexus <no-reply@example.com>',
    subject: `A message for ${email}`,
    text: 'Body',
  };

  const { logs } = await captureLogs(async () => {
    await createLoggingEmailSender().send(message({ to: email, subject: request.subject }));
    await createConsoleTransport().send(request);
    await createEmailTransport({ ...config, emailProvider: 'disabled' }).send(request);
  });

  assert.equal(logs.output.includes(email), false);

  const entries = logs.output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const logging = entries.find((entry) => entry.message === 'email_queued');
  const console = entries.find((entry) => entry.message === 'email_delivery_console');
  const disabled = entries.find((entry) => entry.message === 'email_delivery_disabled');

  assert.ok(logging);
  assert.equal(logging.template, 'account_verification');
  assert.equal('to' in logging, false);

  assert.ok(console);
  assert.equal(console.deliveryId, request.deliveryId);
  assert.equal('to' in console, false);

  assert.ok(disabled);
  assert.equal(disabled.deliveryId, request.deliveryId);
  assert.equal('to' in disabled, false);
});

test('provider errors are classified as permanent or transient', () => {
  const permanent = classifyTransportError({
    code: 'EENVELOPE',
    message: 'Recipient address rejected',
  });

  assert.equal(permanent.retryable, false);

  const transient = classifyTransportError({ code: 'ETIMEDOUT', message: 'Connection timed out' });

  assert.equal(transient.retryable, true);

  const serverError = classifyTransportError({
    responseCode: 421,
    message: 'Service not available',
  });

  assert.equal(serverError.retryable, true);

  const rejected = classifyTransportError({ responseCode: 550, message: 'Mailbox unavailable' });

  assert.equal(rejected.retryable, false);
});
