import type { EmailMessage } from '../types';
import { renderEmailDocument, type EmailBrand } from './layout';

/**
 * Collaboration templates.
 *
 * These cover the events that reach a member of a workspace: an invitation to
 * a workspace, a team or a project, a task assignment, a mention and a
 * meeting invitation.
 *
 * The builders are intentionally independent of the modules that own the
 * business rules. The caller resolves the recipient, the permissions and the
 * link, so the same template can be used from an invitation service, a task
 * service or a notification service.
 */

export interface InvitationEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  idempotencyKey?: string | undefined;
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  role?: string | undefined;
  expiresAt?: Date | undefined;
}

export interface TaskAssignmentEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  idempotencyKey?: string | undefined;
  taskTitle: string;
  projectName?: string | undefined;
  assignedByName: string;
  dueAt?: Date | undefined;
  taskUrl: string;
}

export interface MentionEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  idempotencyKey?: string | undefined;
  mentionedByName: string;
  context: string;
  contextUrl: string;
}

export interface MeetingInvitationEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  idempotencyKey?: string | undefined;
  meetingTitle: string;
  organizerName: string;
  startsAt: Date;
  durationMinutes?: number | undefined;
  joinUrl: string;
  location?: string | undefined;
}

function expirySentence(expiresAt: Date | undefined): string {
  if (!expiresAt) {
    return '';
  }

  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));

  return ` This invitation expires in ${minutes} minutes.`;
}

function inviteParagraphs(input: InvitationEmailInput, subject: string): string[] {
  return [
    `Hi ${input.name},`,
    `${input.inviterName} invited you to ${subject} "${input.workspaceName}" on ${input.brand.appName}.${expirySentence(input.expiresAt)}`,
    input.role ? `You will join with the ${input.role} role.` : '',
    'Accept the invitation to get started.',
  ].filter(Boolean);
}

export function buildWorkspaceInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const { html, text } = renderEmailDocument(
    {
      heading: `Join ${input.workspaceName}`,
      preheader: `${input.inviterName} invited you to a workspace on ${input.brand.appName}.`,
      paragraphs: inviteParagraphs(input, 'the workspace'),
      action: { label: 'Accept invitation', url: input.acceptUrl },
      note: 'If you were not expecting this invitation, you can ignore this email.',
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `${input.inviterName} invited you to ${input.workspaceName} on ${input.brand.appName}`,
    template: 'workspace_invitation',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName, role: input.role ?? null },
  };
}

export function buildTeamInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const { html, text } = renderEmailDocument(
    {
      heading: `Join the ${input.workspaceName} team`,
      preheader: `${input.inviterName} invited you to a team on ${input.brand.appName}.`,
      paragraphs: inviteParagraphs(input, 'the team'),
      action: { label: 'Accept invitation', url: input.acceptUrl },
      note: 'If you were not expecting this invitation, you can ignore this email.',
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `${input.inviterName} invited you to a team in ${input.workspaceName}`,
    template: 'team_invitation',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName, role: input.role ?? null },
  };
}

export function buildProjectInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const { html, text } = renderEmailDocument(
    {
      heading: `Join ${input.workspaceName}`,
      preheader: `${input.inviterName} invited you to a project on ${input.brand.appName}.`,
      paragraphs: inviteParagraphs(input, 'the project'),
      action: { label: 'Accept invitation', url: input.acceptUrl },
      note: 'If you were not expecting this invitation, you can ignore this email.',
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `${input.inviterName} invited you to a project in ${input.workspaceName}`,
    template: 'project_invitation',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { workspaceName: input.workspaceName, role: input.role ?? null },
  };
}

export function buildTaskAssignmentEmail(input: TaskAssignmentEmailInput): EmailMessage {
  const project = input.projectName ? ` in ${input.projectName}` : '';
  const due = input.dueAt ? ` It is due on ${input.dueAt.toUTCString()}.` : '';

  const { html, text } = renderEmailDocument(
    {
      heading: `A task was assigned to you`,
      preheader: `${input.assignedByName} assigned you a task.`,
      paragraphs: [
        `Hi ${input.name},`,
        `${input.assignedByName} assigned you the task "${input.taskTitle}"${project}.${due}`,
        'Open the task to read the details and update its status.',
      ],
      action: { label: 'Open task', url: input.taskUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `${input.assignedByName} assigned you a task: ${input.taskTitle}`,
    template: 'task_assignment',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { taskTitle: input.taskTitle, projectName: input.projectName ?? null },
  };
}

export function buildMentionEmail(input: MentionEmailInput): EmailMessage {
  const { html, text } = renderEmailDocument(
    {
      heading: `${input.mentionedByName} mentioned you`,
      preheader: `You were mentioned in ${input.context}.`,
      paragraphs: [
        `Hi ${input.name},`,
        `${input.mentionedByName} mentioned you in ${input.context}.`,
        'Open the conversation to read the message and reply.',
      ],
      action: { label: 'View mention', url: input.contextUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `${input.mentionedByName} mentioned you in ${input.context}`,
    template: 'mention',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { context: input.context },
  };
}

export function buildMeetingInvitationEmail(input: MeetingInvitationEmailInput): EmailMessage {
  const duration = input.durationMinutes ? ` (${input.durationMinutes} minutes)` : '';
  const location = input.location ? ` Location: ${input.location}.` : '';

  const { html, text } = renderEmailDocument(
    {
      heading: `Invitation: ${input.meetingTitle}`,
      preheader: `${input.organizerName} invited you to a meeting.`,
      paragraphs: [
        `Hi ${input.name},`,
        `${input.organizerName} invited you to "${input.meetingTitle}" on ${input.startsAt.toUTCString()}${duration}.${location}`,
        'Use the link below to join the meeting.',
      ],
      action: { label: 'Join meeting', url: input.joinUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Invitation: ${input.meetingTitle}`,
    template: 'meeting_invitation',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { meetingTitle: input.meetingTitle, startsAt: input.startsAt.toISOString() },
  };
}
