import type { EmailMessage } from '../types';
import { renderEmailDocument, type EmailBrand } from './layout';

/**
 * Billing and subscription templates.
 *
 * Billing notices are transactional: they explain a change that has already
 * happened to the workspace's payment account. They are not gated by the
 * notification preference channels because a member must still receive a
 * receipt or a failed-payment warning even if they turned off optional email.
 */

export interface BillingEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  idempotencyKey?: string | undefined;
  workspaceName: string;
  billingUrl: string;
}

export interface BillingReceiptEmailInput extends BillingEmailInput {
  amountSubunit: number;
  currency: string;
  paidAt: Date;
  plan?: string | null | undefined;
  periodEnd?: Date | null | undefined;
}

export interface BillingPaymentFailedEmailInput extends BillingEmailInput {
  amountSubunit?: number | undefined;
  currency?: string | undefined;
}

export interface BillingSubscriptionEmailInput extends BillingEmailInput {
  /** When a non-renewing subscription ends. */
  accessEndsAt?: Date | null | undefined;
}

function formatAmount(amountSubunit: number, currency: string): string {
  const amount = (amountSubunit / 100).toFixed(2);

  return `${amount} ${currency.toUpperCase()}`;
}

export function buildBillingReceiptEmail(input: BillingReceiptEmailInput): EmailMessage {
  const plan = input.plan ? ` for the ${input.plan} plan` : '';
  const period = input.periodEnd
    ? ` Your next period starts on ${input.periodEnd.toUTCString()}.`
    : '';

  const { html, text } = renderEmailDocument(
    {
      heading: 'Payment received',
      preheader: `We received your payment for ${input.workspaceName}.`,
      paragraphs: [
        `Hi ${input.name},`,
        `We received a payment of ${formatAmount(input.amountSubunit, input.currency)}${plan} for the ${input.workspaceName} workspace on ${input.paidAt.toUTCString()}.${period}`,
        'You can download the payment history from the billing area.',
      ],
      action: { label: 'Open billing', url: input.billingUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Payment received for ${input.workspaceName}`,
    template: 'billing_receipt',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: {
      workspaceName: input.workspaceName,
      amountSubunit: input.amountSubunit,
      currency: input.currency.toUpperCase(),
    },
  };
}

export function buildBillingPaymentFailedEmail(
  input: BillingPaymentFailedEmailInput,
): EmailMessage {
  const amount =
    input.amountSubunit !== undefined && input.currency
      ? ` of ${formatAmount(input.amountSubunit, input.currency)}`
      : '';

  const { html, text } = renderEmailDocument(
    {
      heading: 'Payment failed',
      preheader: `A payment for ${input.workspaceName} could not be collected.`,
      paragraphs: [
        `Hi ${input.name},`,
        `A recurring payment${amount} for the ${input.workspaceName} workspace could not be collected.`,
        'Update your payment method to avoid losing access when the current billing period ends.',
      ],
      action: { label: 'Update payment method', url: input.billingUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Payment failed for ${input.workspaceName}`,
    template: 'billing_payment_failed',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName },
  };
}

export function buildBillingSubscriptionCancelledEmail(
  input: BillingSubscriptionEmailInput,
): EmailMessage {
  const ends = input.accessEndsAt
    ? ` You keep access until ${input.accessEndsAt.toUTCString()}.`
    : '';

  const { html, text } = renderEmailDocument(
    {
      heading: 'Subscription cancelled',
      preheader: `The subscription for ${input.workspaceName} was cancelled.`,
      paragraphs: [
        `Hi ${input.name},`,
        `The paid subscription for the ${input.workspaceName} workspace was cancelled.${ends}`,
        'You can resubscribe at any time from the billing area.',
      ],
      action: { label: 'Open billing', url: input.billingUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Subscription cancelled for ${input.workspaceName}`,
    template: 'billing_subscription_cancelled',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName },
  };
}

export function buildBillingSubscriptionNotRenewingEmail(
  input: BillingSubscriptionEmailInput,
): EmailMessage {
  const ends = input.accessEndsAt
    ? ` The subscription will not renew and access ends on ${input.accessEndsAt.toUTCString()}.`
    : ' The subscription will not renew.';

  const { html, text } = renderEmailDocument(
    {
      heading: 'Subscription will not renew',
      preheader: `The subscription for ${input.workspaceName} will not renew.`,
      paragraphs: [
        `Hi ${input.name},`,
        `Automatic renewal for the ${input.workspaceName} workspace has been turned off.${ends}`,
        'You can turn renewal back on from the billing area before the period ends.',
      ],
      action: { label: 'Open billing', url: input.billingUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Subscription will not renew for ${input.workspaceName}`,
    template: 'billing_subscription_not_renewing',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName },
  };
}
