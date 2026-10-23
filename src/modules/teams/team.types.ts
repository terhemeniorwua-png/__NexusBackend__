import type { TeamRole } from '@prisma/client';

/**
 * Response shapes returned by the team service.
 *
 * These are the data contracts the HTTP layer hands to the client. They are
 * derived from the Prisma models but only expose safe fields.
 */

export interface TeamSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  leadId: string | null;
  lead: TeamLeadSummary | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamLeadSummary {
  id: string;
  name: string;
  email: string;
}

export interface TeamMemberSummary {
  id: string;
  userId: string;
  teamId: string;
  role: TeamRole;
  name: string;
  email: string;
  joinedAt: Date;
}
