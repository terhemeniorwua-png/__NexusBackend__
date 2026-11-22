/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client is mocked with partial delegates; `any` keeps tests focused on resolver behavior. */
// @ts-expect-error vitest types are provided by the vitest runner, not tsconfig.test.json types
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../authorization/project.authorization', () => ({
  resolveProjectAuthorization: vi.fn(),
}));

import { resolveRepositoryAccess } from './repository-access.resolver';
import { resolveProjectAuthorization } from '../authorization/project.authorization';

describe('resolveRepositoryAccess (stage 1)', () => {
  const baseClient = () => {
    return {
      projectRepository: { findFirst: vi.fn() },
      project: { findFirst: vi.fn() },
      projectRepositoryMember: { findUnique: vi.fn() },
    } as any;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns NONE when repository does not belong to project', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue(null);
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('NONE');
  });

  it('returns NONE when project access cannot be resolved', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue({ id: 'r1' });
    client.project.findFirst.mockResolvedValue({ workspaceId: 'w1' });
    (resolveProjectAuthorization as any).mockRejectedValue(new Error('no access'));
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('NONE');
  });

  it('defaults VIEWER to READ with no override', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue({ id: 'r1' });
    client.project.findFirst.mockResolvedValue({ workspaceId: 'w1' });
    (resolveProjectAuthorization as any).mockResolvedValue({ projectRole: 'VIEWER', accessSource: 'project_role', permissions: [] });
    client.projectRepositoryMember.findUnique.mockResolvedValue(null);
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('READ');
  });

  it('defaults non-VIEWER project roles to LINK with no override', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue({ id: 'r1' });
    client.project.findFirst.mockResolvedValue({ workspaceId: 'w1' });
    (resolveProjectAuthorization as any).mockResolvedValue({ projectRole: 'MEMBER', accessSource: 'project_role', permissions: [] });
    client.projectRepositoryMember.findUnique.mockResolvedValue(null);
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('LINK');
  });

  it('uses explicit override when present', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue({ id: 'r1' });
    client.project.findFirst.mockResolvedValue({ workspaceId: 'w1' });
    (resolveProjectAuthorization as any).mockResolvedValue({ projectRole: 'VIEWER', accessSource: 'project_role', permissions: [] });
    client.projectRepositoryMember.findUnique.mockResolvedValue({ level: 'LINK' });
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('LINK');
  });

  it('allows override NONE to restrict (returns NONE)', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue({ id: 'r1' });
    client.project.findFirst.mockResolvedValue({ workspaceId: 'w1' });
    (resolveProjectAuthorization as any).mockResolvedValue({ projectRole: 'MEMBER', accessSource: 'project_role', permissions: [] });
    client.projectRepositoryMember.findUnique.mockResolvedValue({ level: 'NONE' });
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('NONE');
  });

  it('workspace_member with no projectRole defaults to READ', async () => {
    const client = baseClient();
    client.projectRepository.findFirst.mockResolvedValue({ id: 'r1' });
    client.project.findFirst.mockResolvedValue({ workspaceId: 'w1' });
    (resolveProjectAuthorization as any).mockResolvedValue({ projectRole: null, accessSource: 'workspace_member', permissions: [] });
    client.projectRepositoryMember.findUnique.mockResolvedValue(null);
    const res = await resolveRepositoryAccess(client, { projectId: 'p1', repositoryId: 'r1', userId: 'u1' });
    expect(res).toBe('READ');
  });
});
