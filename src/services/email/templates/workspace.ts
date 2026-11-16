import type { EmailMessage } from '../types';
import { renderEmailDocument, type EmailBrand } from './layout';

/**
 * Workspace membership templates.
 *
 * These cover the applicant-facing outcome of a join request. The decision is
 * always made and persisted by an administrator first; this template only
 * communicates the stored decision, so it can never grant access on its own.
 */

export interface JoinRequestDecisionEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  idempotencyKey?: string | undefined;
  workspaceName: string;
  workspaceUrl: string;
  decisionNote?: string | null | undefined;
  role?: string | null | undefined;
}

export function buildJoinRequestApprovedEmail(input: JoinRequestDecisionEmailInput): EmailMessage {
  const roleSentence = input.role ? ` You joined with the ${input.role} role.` : '';
  const { html, text } = renderEmailDocument(
    {
      heading: `Welcome to ${input.workspaceName}`,
      preheader: `Your request to join ${input.workspaceName} was approved.`,
      paragraphs: [
        `Hi ${input.name},`,
        `Your request to join the ${input.workspaceName} workspace on ${input.brand.appName} was approved.${roleSentence}`,
        'Open the workspace to start collaborating with your team.',
      ],
      action: { label: 'Open workspace', url: input.workspaceUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Your request to join ${input.workspaceName} was approved`,
    template: 'join_request_approved',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName, role: input.role ?? null },
  };
}

export function buildJoinRequestRejectedEmail(input: JoinRequestDecisionEmailInput): EmailMessage {
  const note = input.decisionNote ? `The administrator added: ${input.decisionNote}` : '';
  const { html, text } = renderEmailDocument(
    {
      heading: `Your request to join ${input.workspaceName}`,
      preheader: `Your request to join ${input.workspaceName} was declined.`,
      paragraphs: [
        `Hi ${input.name},`,
        `An administrator declined your request to join the ${input.workspaceName} workspace on ${input.brand.appName}.`,
        note,
        'You can request to join again later if your circumstances change.',
      ].filter(Boolean),
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Your request to join ${input.workspaceName} was declined`,
    template: 'join_request_rejected',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName },
  };
}
