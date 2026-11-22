import type { PrismaClient, WorkspaceRole } from '@prisma/client';
import { resolveProjectAuthorization } from '../authorization/project.authorization';

export type RepositoryAccessClient = Pick<
  PrismaClient,
  'projectRepository' | 'projectRepositoryMember' | 'project' | 'workspaceMembership' | 'organizationMembership'
>;

export type ResolveRepositoryAccessParams = {
  projectId: string;
  repositoryId: string;
  userId: string;
};

export type RepositoryAccessLevelValue = 'NONE' | 'METADATA' | 'READ' | 'LINK';

/**
 * Resolve effective repository access for a user on a linked project repository.
 *
 * Rules (stage 1):
 * - If the user has no project access to the project, return NONE.
 * - Default by resolved project context:
 *   - project role VIEWER => READ
 *   - otherwise (contributor/manager/admin contexts that have project access) => LINK
 * - An explicit ProjectRepositoryMember row overrides the default when present.
 * - Never grants more than project access allows (so none => NONE).
 *
 * Not wired to any route; used by later stages.
 */
export async function resolveRepositoryAccess(
  client: PrismaClient,
  params: ResolveRepositoryAccessParams,
): Promise<RepositoryAccessLevelValue> {
  const { projectId, repositoryId, userId } = params;

  // Confirm the repository belongs to the project (and exists).
  const repo = await client.projectRepository.findFirst({
    where: { id: repositoryId, projectId },
    select: { id: true },
  });
  if (!repo) {
    return 'NONE';
  }

  const project = await client.project.findFirst({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) {
    return 'NONE';
  }

  // Determine workspace membership role for authorization context.
  const membership = await client.workspaceMembership.findFirst({
    where: { workspaceId: project.workspaceId, userId, status: 'ACTIVE' },
    select: { role: true },
  });
  const orgMembership = await client.organizationMembership.findFirst({
    where: { workspaceId: project.workspaceId, userId, status: 'ACTIVE' },
    select: { role: true },
  });
  const workspaceRole: WorkspaceRole =
    (orgMembership?.role as WorkspaceRole | undefined) ?? membership?.role ?? 'VIEWER';

  let authorization;
  try {
    authorization = await resolveProjectAuthorization(
      client,
      { userId, workspaceId: project.workspaceId, workspaceRole },
      projectId,
    );
  } catch {
    return 'NONE';
  }

  // Compute default by role mapping (per user instruction):
  // viewer => READ; contributor and above => LINK; managers/admins => LINK
  let defaultLevel: RepositoryAccessLevelValue = 'LINK';
  if (authorization.projectRole === 'VIEWER') {
    defaultLevel = 'READ';
  } else if (authorization.accessSource === 'workspace_member' && authorization.projectRole === null) {
    // Workspace-wide read-only access with no explicit project role: treat as viewer-like for repo default.
    defaultLevel = 'READ';
  } else {
    defaultLevel = 'LINK';
  }

  // Explicit override
  const override = await client.projectRepositoryMember.findUnique({
    where: { projectRepositoryId_userId: { projectRepositoryId: repositoryId, userId } },
    select: { level: true },
  });
  if (override) {
    return override.level as RepositoryAccessLevelValue;
  }

  return defaultLevel;
}
