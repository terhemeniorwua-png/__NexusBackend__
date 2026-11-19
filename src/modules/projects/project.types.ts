import type { ProjectRole, ProjectStatus, ProjectVisibility } from '@prisma/client';

/**
 * Response shapes returned by the project service.
 */

export interface ProjectOwnerSummary {
  id: string;
  name: string;
  email?: string;
}

export interface ProjectTeamSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  teamId: string | null;
  teamIds: string[];
  teams: ProjectTeamSummary[];
  departmentId: string | null;
  name: string;
  key: string;
  description: string | null;
  objectives: unknown;
  category: string | null;
  labels: string[];
  status: ProjectStatus;
  visibility: ProjectVisibility;
  commentPolicy: string;
  startDate: Date | null;
  dueDate: Date | null;
  ownerId: string;
  owner: ProjectOwnerSummary;
  completedAt: Date | null;
  completedById: string | null;
  archivedAt: Date | null;
  archivedById: string | null;
  memberCount: number;
  taskCount: number;
  myRole: ProjectRole | null;
  overdue: boolean;
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
  id?: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  name?: string;
  email?: string;
  joinedAt?: Date;
  createdAt?: Date;
  user?: { id: string; name: string; email: string };
}

export interface ProjectActivityActor {
  id: string;
  name: string;
  email?: string;
}

export interface ProjectActivityEntry {
  id: string;
  action: string;
  targetType?: string;
  targetId?: string;
  actorId: string | null;
  actor: ProjectActivityActor | null;
  metadata: unknown;
  createdAt: Date;
  timestamp: Date;
}

export interface ProjectActivityResult {
  items: ProjectActivityEntry[];
  pagination?: Pagination;
  nextCursor?: string | null;
}

export interface ProjectOverview {
  total: number;
  byStatus: Record<ProjectStatus, number>;
  byVisibility: Record<ProjectVisibility, number>;
  overdue: number;
  dueSoon: number;
}

export interface ProjectMilestoneProgress {
  completedTasks: number;
  totalTasks: number;
  percentComplete: number;
}

export interface ProjectMilestoneSummary {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: Date | null;
  completedAt: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  progress: ProjectMilestoneProgress;
}

export interface ProjectProgress {
  projectId: string;
  taskCountsByStatus: Record<string, number>;
  totalTasks: number;
  completedTasks: number;
  percentComplete: number;
  overdueCount: number;
  upcomingDeadlines: Array<{
    id: string;
    key: string;
    title: string;
    dueDate: Date | null;
    status: string;
    priority: string;
  }>;
  milestones: Array<{
    id: string;
    name: string;
    dueDate: Date | null;
    completedAt: Date | null;
    progress: ProjectMilestoneProgress;
  }>;
}

export interface BulkAddProjectMembersByTeamResult {
  teamId: string;
  added: Array<{ userId: string; role: ProjectRole }>;
  skipped: Array<{ userId: string; reason: string }>;
}