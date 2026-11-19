import type { ProjectStatus, ProjectVisibility, TeamRole } from '@prisma/client';

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
  responsibilities: string | null;
  departmentId: string | null;
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

export interface TeamProjectSummary {
  id: string;
  name: string;
  key: string;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  dueDate: Date | null;
}

export interface TeamTaskCountsByStatus {
  ASSIGNED: number;
  IN_PROGRESS: number;
  SUBMITTED: number;
  UNDER_REVIEW: number;
  APPROVED: number;
  CHANGES_REQUESTED: number;
}

export interface TeamOverview {
  team: TeamSummary;
  members: TeamMemberSummary[];
  leads: TeamMemberSummary[];
  projects: TeamProjectSummary[];
  taskCountsByStatus: TeamTaskCountsByStatus;
}

export interface TeamActivityItem {
  id: string;
  action: string;
  actorId: string | null;
  targetType: string;
  targetId: string;
  metadata: unknown;
  createdAt: Date;
}

export interface TeamActivityResult {
  items: TeamActivityItem[];
  nextCursor: string | null;
}

export interface BulkAddTeamMembersResult {
  added: TeamMemberSummary[];
  skipped: Array<{ userId: string; reason: string }>;
}
