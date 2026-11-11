import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../src/config/env';
import { parseEnv } from '../src/config/env';
import {
  buildBillingPaymentFailedEmail,
  buildBillingReceiptEmail,
  buildBillingSubscriptionCancelledEmail,
  buildBillingSubscriptionNotRenewingEmail,
  buildEmailBrand,
  buildJoinRequestApprovedEmail,
  buildJoinRequestRejectedEmail,
} from '../src/services/email';
import { isEmailNotificationEnabled } from '../src/services/notification-preferences';
import { updatePreferenceSchema } from '../src/modules/notifications/notification.schemas';
import { updateNotificationPreferencesSchema } from '../src/modules/organizations/organization.schemas';

/**
 * Phase 25 unit tests.
 *
 * These cover the email preference helper, the join-request and billing
 * templates, and the request schemas that expose the new `emailEnabled`
 * channel. None of them touch PostgreSQL or a provider.
 */

const config: AppConfig = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
  REDIS_URL: 'redis://localhost:6379/15',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
  FRONTEND_URL: 'https://app.nexus.test',
});

const brand = buildEmailBrand(config);

function fakePreferenceClient(result: { emailEnabled: boolean } | null) {
  const calls: unknown[] = [];
  const client = {
    notificationPreference: {
      findUnique: async (args: unknown) => {
        calls.push(args);
        return result;
      },
    },
  };
  return { client, calls };
}

test('email preference defaults to enabled when no row exists', async () => {
  const { client } = fakePreferenceClient(null);

  const enabled = await isEmailNotificationEnabled(client as never, {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    type: 'TASK_ASSIGNED',
  });

  assert.equal(enabled, true);
});

test('email preference honours an explicit disabled row', async () => {
  const { client, calls } = fakePreferenceClient({ emailEnabled: false });

  const enabled = await isEmailNotificationEnabled(client as never, {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    type: 'MENTION',
  });

  assert.equal(enabled, false);
  assert.deepEqual(calls[0], {
    where: {
      workspaceId_userId_type: {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        type: 'MENTION',
      },
    },
    select: { emailEnabled: true },
  });
});

test('join request approved template renders workspace and role', () => {
  const message = buildJoinRequestApprovedEmail({
    to: 'applicant@example.test',
    name: 'Ada',
    brand,
    workspaceName: 'Analytical Engines',
    workspaceUrl: 'https://app.nexus.test/workspaces/ws-1',
    role: 'MEMBER',
    idempotencyKey: 'join-request:approved:req-1',
  });

  assert.equal(message.template, 'join_request_approved');
  assert.match(message.subject, /approved/i);
  assert.match(message.text, /Analytical Engines/);
  assert.match(message.text, /MEMBER/);
  assert.equal(message.idempotencyKey, 'join-request:approved:req-1');
  assert.equal(message.metadata?.workspaceName, 'Analytical Engines');
  assert.match(message.html ?? '', /https:\/\/app\.nexus\.test\/workspaces\/ws-1/);
});

test('join request rejected template includes the decision note', () => {
  const message = buildJoinRequestRejectedEmail({
    to: 'applicant@example.test',
    name: 'Ada',
    brand,
    workspaceName: 'Analytical Engines',
    workspaceUrl: 'https://app.nexus.test/workspaces/ws-1',
    decisionNote: 'We are not onboarding contractors right now.',
    idempotencyKey: 'join-request:rejected:req-1',
  });

  assert.equal(message.template, 'join_request_rejected');
  assert.match(message.subject, /declined/i);
  assert.match(message.text, /contractors/);
  assert.equal(message.metadata?.workspaceName, 'Analytical Engines');
});

test('billing receipt template formats the amount and currency', () => {
  const message = buildBillingReceiptEmail({
    to: 'owner@example.test',
    name: 'Grace',
    brand,
    workspaceName: 'Analytical Engines',
    billingUrl: 'https://app.nexus.test/workspaces/ws-1/billing',
    amountSubunit: 4_900,
    currency: 'usd',
    paidAt: new Date('2026-11-01T00:00:00.000Z'),
    plan: 'TEAM',
    idempotencyKey: 'billing:charge.success:evt-1',
  });

  assert.equal(message.template, 'billing_receipt');
  assert.match(message.subject, /Payment received/);
  assert.match(message.text, /49\.00 USD/);
  assert.match(message.text, /TEAM/);
  assert.equal(message.metadata?.amountSubunit, 4_900);
  assert.equal(message.metadata?.currency, 'USD');
  assert.equal(message.idempotencyKey, 'billing:charge.success:evt-1');
});

test('billing payment failed template tolerates missing amount', () => {
  const message = buildBillingPaymentFailedEmail({
    to: 'owner@example.test',
    name: 'Grace',
    brand,
    workspaceName: 'Analytical Engines',
    billingUrl: 'https://app.nexus.test/workspaces/ws-1/billing',
  });

  assert.equal(message.template, 'billing_payment_failed');
  assert.match(message.subject, /Payment failed/);
  assert.match(message.text, /could not be collected/);
});

test('billing cancellation and non-renewal templates describe access end', () => {
  const base = {
    to: 'owner@example.test',
    name: 'Grace',
    brand,
    workspaceName: 'Analytical Engines',
    billingUrl: 'https://app.nexus.test/workspaces/ws-1/billing',
    accessEndsAt: new Date('2026-12-01T00:00:00.000Z'),
  };

  const cancelled = buildBillingSubscriptionCancelledEmail(base);
  const notRenewing = buildBillingSubscriptionNotRenewingEmail(base);

  assert.equal(cancelled.template, 'billing_subscription_cancelled');
  assert.match(cancelled.subject, /cancelled/i);
  assert.match(cancelled.text, /2026/);

  assert.equal(notRenewing.template, 'billing_subscription_not_renewing');
  assert.match(notRenewing.subject, /will not renew/i);
  assert.match(notRenewing.text, /2026/);
});

test('notification preference schema accepts a single email channel update', () => {
  assert.equal(
    updatePreferenceSchema.safeParse({ type: 'TASK_ASSIGNED', emailEnabled: false }).success,
    true,
  );
});

test('notification preference schema rejects an empty update', () => {
  assert.equal(updatePreferenceSchema.safeParse({ type: 'TASK_ASSIGNED' }).success, false);
});

test('notification preference schema still accepts an in-app only update', () => {
  assert.equal(
    updatePreferenceSchema.safeParse({ type: 'TASK_ASSIGNED', inAppEnabled: false }).success,
    true,
  );
});

test('organization preference list accepts the email channel', () => {
  assert.equal(
    updateNotificationPreferencesSchema.safeParse({
      preferences: [{ type: 'MEETING_INVITE', emailEnabled: false }],
    }).success,
    true,
  );
});

test('organization preference list rejects an empty channel update', () => {
  assert.equal(
    updateNotificationPreferencesSchema.safeParse({
      preferences: [{ type: 'MEETING_INVITE' }],
    }).success,
    false,
  );
});

test('organization preference list rejects message notification types', () => {
  assert.equal(
    updateNotificationPreferencesSchema.safeParse({
      preferences: [{ type: 'MESSAGE_RECEIVED', emailEnabled: false }],
    }).success,
    false,
  );
});
