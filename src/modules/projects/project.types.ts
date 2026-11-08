import type { ProjectRole, ProjectStatus, ProjectVisibility } from '@prisma/client';

/**
 * Response shapes returned by the project service.
 *
 * These are the data contracts the HTTP layer hands to the client. They only
 * expose safe fields and never include internal relations that the caller is
 * not allowed to see.
 */

export interface ProjectOwnerSummary {
  id: string;
  name: string;
  email: string;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  teamId: string | null;
  name: string;
  key: string;
  description: string | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  startDate: Date | null;
  dueDate: Date | null;
  ownerId: string;
  owner: ProjectOwnerSummary;
  settings: unknown;
  memberCount: number;
  taskCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ProjectListResult {
  items: ProjectSummary[];
  pagination: Pagination;
}

export interface ProjectMemberSummary {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  name: string;
  email: string;
  joinedAt: Date;
}

export interface ProjectActivityEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actor: ProjectOwnerSummary | null;
  metadata: unknown;
  createdAt: Date;
}

export interface ProjectActivityResult {
  items: ProjectActivityEntry[];
  pagination: Pagination;
}

export interface ProjectOverview {
  total: number;
  byStatus: Record<ProjectStatus, number>;
  byVisibility: Record<ProjectVisibility, number>;
  overdue: number;
  dueSoon: number;
}

export interface ProjectDetailSummary extends ProjectSummary {
  memberRoles: Record<ProjectRole, number>;
  completedTaskCount: number;
  recentActivity: ProjectActivityEntry[];
}
