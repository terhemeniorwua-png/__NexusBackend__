/* eslint-disable @typescript-eslint/no-explicit-any -- test DB/prisma client shapes */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { SprintService } from '../src/modules/sprints/sprint.service';
import { createProjectService } from '../src/modules/projects/project.service';
import { AppError } from '../src/utils/errors';

const DB_FLAG = 'RUN_S2_SPRINTS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('S2 sprints routes/workflow DB tests', () =>
    test('skipped — set RUN_S2_SPRINTS_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('S2 sprints routes/workflow DB tests', () => {
    let prisma: any;
    let sprints: SprintService;
    let projects: ReturnType<typeof createProjectService>;

    const ids = {} as {
      admin: string;
      member: string;
      outsider: string;
      ws: string;
      projectSprints: string;
      projectBacklog: string;
    };
    const cleanup: Array<() => Promise<void>> = [];

    const reqCtx = { ip: '127.0.0.1', userAgent: 'test' } as any;

    async function createUser(name: string) {
      const u = await prisma.user.create({
        data: { email: `${name}-${Date.now()}-${Math.random()}@example.test`, passwordHash: 'x', name },
      });
      cleanup.push(async () => { await prisma.user.delete({ where: { id: u.id } }).catch(() => undefined); });
      return u;
    }

    async function createWorkspace(ownerId: string, name = 'WS') {
      const ws = await prisma.workspace.create({
        data: { name, slug: `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`, ownerId, type: 'COMPANY' },
      });
      cleanup.push(async () => { await prisma.workspace.delete({ where: { id: ws.id } }).catch(() => undefined); });
      return ws;
    }

    async function addMembership(workspaceId: string, userId: string, role = 'MEMBER') {
      const m = await prisma.workspaceMembership.create({
        data: { workspaceId, userId, role, status: 'ACTIVE' },
      });
      cleanup.push(async () => { await prisma.workspaceMembership.delete({ where: { id: m.id } }).catch(() => undefined); });
      return m;
    }

    async function createProject(workspaceId: string, ownerId: string, workflowMode: 'SPRINTS' | 'BACKLOG_ONLY' = 'SPRINTS') {
      const p = await prisma.project.create({
        data: {
          workspaceId,
          name: `P-${Math.random().toString(36).slice(2)}`,
          key: `P${Math.random().toString(36).toUpperCase().slice(2, 8)}`,
          ownerId,
          visibility: 'WORKSPACE',
          workflowMode,
        },
      });
      cleanup.push(async () => { await prisma.project.delete({ where: { id: p.id } }).catch(() => undefined); });
      return p;
    }

    async function addProjectMember(projectId: string, userId: string, role = 'MEMBER') {
      const pm = await prisma.projectMembership.create({
        data: { projectId, userId, role },
      });
      cleanup.push(async () => { await prisma.projectMembership.delete({ where: { id: pm.id } }).catch(() => undefined); });
      return pm;
    }

    async function createTask(projectId: string, creatorId: string, opts: any = {}) {
      const count = await prisma.task.count({ where: { projectId } });
      const t = await prisma.task.create({
        data: {
          projectId,
          key: `T-${count + 1}-${Math.random().toString(36).slice(2, 6)}`,
          title: opts.title ?? `Task ${count + 1}`,
          status: opts.status ?? 'ASSIGNED',
          creatorId,
          position: opts.position ?? count,
          sprintId: opts.sprintId ?? null,
          sprintPosition: opts.sprintPosition ?? null,
          archivedAt: opts.archivedAt ?? null,
          deletedAt: opts.deletedAt ?? null,
        },
      });
      cleanup.push(async () => { await prisma.task.delete({ where: { id: t.id } }).catch(() => undefined); });
      return t;
    }

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;
      sprints = new SprintService(prisma);
      projects = createProjectService(prisma);

      const admin = await createUser('admin');
      const member = await createUser('member');
      const outsider = await createUser('outsider');
      const ws = await createWorkspace(admin.id);
      await addMembership(ws.id, admin.id, 'OWNER');
      await addMembership(ws.id, member.id, 'MEMBER');
      await addMembership(ws.id, outsider.id, 'MEMBER');

      const projectSprints = await createProject(ws.id, admin.id, 'SPRINTS');
      const projectBacklog = await createProject(ws.id, admin.id, 'BACKLOG_ONLY');

      await addProjectMember(projectSprints.id, admin.id, 'PROJECT_MANAGER');
      await addProjectMember(projectSprints.id, member.id, 'MEMBER');
      await addProjectMember(projectSprints.id, outsider.id, 'VIEWER');

      await addProjectMember(projectBacklog.id, admin.id, 'PROJECT_MANAGER');
      await addProjectMember(projectBacklog.id, member.id, 'MEMBER');

      Object.assign(ids, {
        admin: admin.id,
        member: member.id,
        outsider: outsider.id,
        ws: ws.id,
        projectSprints: projectSprints.id,
        projectBacklog: projectBacklog.id,
      });
    });

    after(async () => {
      for (const fn of cleanup.reverse()) await fn();
      await prisma.$disconnect().catch(() => undefined);
    });

    async function expectAppError(p: Promise<any>, status: number, code: string) {
      await assert.rejects(p, (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, status);
        assert.equal(err.code, code);
        return true;
      });
    }

    // --- 409 matrix: every sprint route in BACKLOG_ONLY except history ---
    test('409 SPRINTS_DISABLED_FOR_PROJECT for every sprint route in BACKLOG_ONLY except history', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectBacklog, actorUserId: ids.admin };
      const fakeSprintId = '00000000-0000-4000-8000-000000000001';
      const fakeTaskId = '00000000-0000-4000-8000-000000000002';
      const cases: Array<{ name: string; run: () => Promise<any> }> = [
        { name: 'R1 list', run: () => sprints.list({ ...base, limit: 25 }) },
        { name: 'R2 create', run: () => sprints.create({ ...base, name: 'S' }, reqCtx) },
        { name: 'R3 update', run: () => sprints.update({ ...base, sprintId: fakeSprintId, name: 'S' }, reqCtx) },
        { name: 'R4 start', run: () => sprints.start({ ...base, sprintId: fakeSprintId }, reqCtx) },
        { name: 'R5 complete', run: () => sprints.complete({ ...base, sprintId: fakeSprintId, target: 'BACKLOG' }, reqCtx) },
        { name: 'R6 restore', run: () => sprints.restore({ ...base, sprintId: fakeSprintId }, reqCtx) },
        { name: 'R7 add tasks', run: () => sprints.addTasks({ ...base, sprintId: fakeSprintId, taskIds: [fakeTaskId] }, reqCtx) },
        { name: 'R8 remove task', run: () => sprints.removeTask({ ...base, sprintId: fakeSprintId, taskId: fakeTaskId }, reqCtx) },
      ];
      for (const c of cases) {
        await expectAppError(c.run(), 409, 'SPRINTS_DISABLED_FOR_PROJECT');
      }
      // R9 history works in both modes
      const h = await sprints.history({ ...base, limit: 25 });
      assert.deepEqual(h.items, []);
    });

    // --- permission denial per route ---
    test('permission denial per route', async () => {
      const ws = ids.ws;
      const pid = ids.projectSprints;
      // create a sprint as admin for routes needing existing sprint
      const sprint = await sprints.create({ workspaceId: ws, projectId: pid, actorUserId: ids.admin, name: 'Perm Sprint' }, reqCtx);
      cleanup.push(async () => { await prisma.sprint.delete({ where: { id: sprint.id } }).catch(() => undefined); });
      const task = await createTask(pid, ids.admin);

      // R1 View: user with no project access gets 404 (PRIVATE project).
      const privateProject = await createProject(ws, ids.admin, 'SPRINTS');
      await prisma.project.update({ where: { id: privateProject.id }, data: { visibility: 'PRIVATE' } });
      await addProjectMember(privateProject.id, ids.admin, 'PROJECT_MANAGER');
      const nonMember = await createUser('nomem');
      await addMembership(ws, nonMember.id, 'MEMBER');
      await expectAppError(
        sprints.list({ workspaceId: ws, projectId: privateProject.id, actorUserId: nonMember.id, limit: 25 }),
        404,
        'PROJECT_NOT_FOUND',
      );

      // R2-R6, R10(Update) require ProjectPermission.Update - MEMBER lacks it
      await expectAppError(sprints.create({ workspaceId: ws, projectId: pid, actorUserId: ids.member, name: 'X' }, reqCtx), 403, 'PERMISSION_DENIED');
      await expectAppError(sprints.update({ workspaceId: ws, projectId: pid, sprintId: sprint.id, actorUserId: ids.member, name: 'X' }, reqCtx), 403, 'PERMISSION_DENIED');
      await expectAppError(sprints.start({ workspaceId: ws, projectId: pid, sprintId: sprint.id, actorUserId: ids.member }, reqCtx), 403, 'PERMISSION_DENIED');
      await expectAppError(sprints.complete({ workspaceId: ws, projectId: pid, sprintId: sprint.id, actorUserId: ids.member, target: 'BACKLOG' }, reqCtx), 403, 'PERMISSION_DENIED');
      await expectAppError(sprints.restore({ workspaceId: ws, projectId: pid, sprintId: sprint.id, actorUserId: ids.member }, reqCtx), 403, 'PERMISSION_DENIED');

      // R7/R8 require TaskUpdate - VIEWER (outsider) lacks it, MEMBER has it
      await expectAppError(
        sprints.addTasks({ workspaceId: ws, projectId: pid, sprintId: sprint.id, actorUserId: ids.outsider, taskIds: [task.id] }, reqCtx),
        403,
        'PERMISSION_DENIED',
      );
      // put task in sprint as admin for remove test
      await sprints.addTasks({ workspaceId: ws, projectId: pid, sprintId: sprint.id, actorUserId: ids.admin, taskIds: [task.id] }, reqCtx);
      await expectAppError(
        sprints.removeTask({ workspaceId: ws, projectId: pid, sprintId: sprint.id, taskId: task.id, actorUserId: ids.outsider }, reqCtx),
        403,
        'PERMISSION_DENIED',
      );

      // R9 history - non-manager 403 in both modes
      await expectAppError(sprints.history({ workspaceId: ws, projectId: pid, actorUserId: ids.member, limit: 25 }), 403, 'PERMISSION_DENIED');
      await expectAppError(sprints.history({ workspaceId: ids.ws, projectId: ids.projectBacklog, actorUserId: ids.member, limit: 25 }), 403, 'PERMISSION_DENIED');
    });

    test('start with existing ACTIVE sprint -> 409 ACTIVE_SPRINT_EXISTS', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectSprints, actorUserId: ids.admin };
      const s1 = await sprints.create({ ...base, name: 'Active1' }, reqCtx);
      const s2 = await sprints.create({ ...base, name: 'Active2' }, reqCtx);
      await sprints.start({ ...base, sprintId: s1.id }, reqCtx);
      await expectAppError(sprints.start({ ...base, sprintId: s2.id }, reqCtx), 409, 'ACTIVE_SPRINT_EXISTS');
      // cleanup by completing s1
      await sprints.complete({ ...base, sprintId: s1.id, target: 'BACKLOG' }, reqCtx);
    });

    test('complete to BACKLOG and to NEXT_SPRINT', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectSprints, actorUserId: ids.admin };
      const s1 = await sprints.create({ ...base, name: 'C1' }, reqCtx);
      const s2 = await sprints.create({ ...base, name: 'C2' }, reqCtx);
      const t1 = await createTask(ids.projectSprints, ids.admin, { status: 'IN_PROGRESS' });
      const tApproved = await createTask(ids.projectSprints, ids.admin, { status: 'APPROVED' });
      const tArchived = await createTask(ids.projectSprints, ids.admin, { status: 'ASSIGNED', archivedAt: new Date() });
      await sprints.addTasks({ ...base, sprintId: s1.id, taskIds: [t1.id, tApproved.id, tArchived.id] }, reqCtx);
      await sprints.start({ ...base, sprintId: s1.id }, reqCtx);
      const r1 = await sprints.complete({ ...base, sprintId: s1.id, target: 'NEXT_SPRINT', nextSprintId: s2.id }, reqCtx);
      assert.equal(r1.movedTaskCount, 2); // t1 + archived unfinished
      assert.equal(r1.archivedUnfinishedMovedCount, 1);
      assert.equal(r1.destination.type, 'NEXT_SPRINT');
      assert.equal(r1.destination.nextSprintId, s2.id);
      const t1After = await prisma.task.findUnique({ where: { id: t1.id } });
      const tApprovedAfter = await prisma.task.findUnique({ where: { id: tApproved.id } });
      assert.equal(t1After.sprintId, s2.id);
      assert.ok(t1After.sprintPosition > 0);
      assert.equal(tApprovedAfter.sprintId, s1.id); // retains membership

      // complete s2 to BACKLOG
      await sprints.start({ ...base, sprintId: s2.id }, reqCtx);
      const r2 = await sprints.complete({ ...base, sprintId: s2.id, target: 'BACKLOG' }, reqCtx);
      assert.equal(r2.destination.type, 'BACKLOG');
      const t1Backlog = await prisma.task.findUnique({ where: { id: t1.id } });
      assert.equal(t1Backlog.sprintId, null);
      assert.equal(t1Backlog.sprintPosition, null);
      assert.ok(t1Backlog.position > 0);
    });

    test('wrong-project sprint 404', async () => {
      const p2 = await createProject(ids.ws, ids.admin, 'SPRINTS');
      await addProjectMember(p2.id, ids.admin, 'PROJECT_MANAGER');
      const sOther = await sprints.create({ workspaceId: ids.ws, projectId: p2.id, actorUserId: ids.admin, name: 'Other' }, reqCtx);
      await expectAppError(
        sprints.start({ workspaceId: ids.ws, projectId: ids.projectSprints, sprintId: sOther.id, actorUserId: ids.admin }, reqCtx),
        404,
        'SPRINT_NOT_FOUND',
      );
    });

    test('workflowMode switch both directions with tasks and history preserved', async () => {
      const p = await createProject(ids.ws, ids.admin, 'SPRINTS');
      await addProjectMember(p.id, ids.admin, 'PROJECT_MANAGER');
      const base = { workspaceId: ids.ws, projectId: p.id, actorUserId: ids.admin };
      const s = await sprints.create({ ...base, name: 'Switch Sprint' }, reqCtx);
      const tUnfinished = await createTask(p.id, ids.admin, { status: 'IN_PROGRESS' });
      const tApproved = await createTask(p.id, ids.admin, { status: 'APPROVED' });
      await sprints.addTasks({ ...base, sprintId: s.id, taskIds: [tUnfinished.id, tApproved.id] }, reqCtx);
      await sprints.start({ ...base, sprintId: s.id }, reqCtx);

      // SPRINTS -> BACKLOG_ONLY requires confirmation when active sprint exists
      await expectAppError(
        projects.update({ userId: ids.admin, workspaceId: ids.ws, projectId: p.id, workflowMode: 'BACKLOG_ONLY' } as any, reqCtx),
        409,
        'ACTIVE_SPRINT_EXISTS',
      );

      const switched = await projects.update(
        { userId: ids.admin, workspaceId: ids.ws, projectId: p.id, workflowMode: 'BACKLOG_ONLY', confirmActiveSprintCompletion: true } as any,
        reqCtx,
      );
      assert.equal((switched as any).workflowMode, 'BACKLOG_ONLY');
      const sprintAfter = await prisma.sprint.findUnique({ where: { id: s.id } });
      assert.equal(sprintAfter.status, 'COMPLETED');
      const tUnfinishedAfter = await prisma.task.findUnique({ where: { id: tUnfinished.id } });
      const tApprovedAfter = await prisma.task.findUnique({ where: { id: tApproved.id } });
      assert.equal(tUnfinishedAfter.sprintId, null);
      assert.equal(tApprovedAfter.sprintId, s.id); // approved retains membership

      const history = await sprints.history({ workspaceId: ids.ws, projectId: p.id, actorUserId: ids.admin, limit: 25 });
      assert.ok(history.items.some((i: any) => i.id === s.id && i.status === 'COMPLETED'));

      // BACKLOG_ONLY -> SPRINTS: preserves sprints/history, starts nothing
      const switchedBack = await projects.update(
        { userId: ids.admin, workspaceId: ids.ws, projectId: p.id, workflowMode: 'SPRINTS' } as any,
        reqCtx,
      );
      assert.equal((switchedBack as any).workflowMode, 'SPRINTS');
      const sprintAfterBack = await prisma.sprint.findUnique({ where: { id: s.id } });
      assert.equal(sprintAfterBack.status, 'COMPLETED');
      const active = await prisma.sprint.findFirst({ where: { projectId: p.id, status: 'ACTIVE' } });
      assert.equal(active, null);
    });

    test('history route in both modes', async () => {
      const p = await createProject(ids.ws, ids.admin, 'SPRINTS');
      await addProjectMember(p.id, ids.admin, 'PROJECT_MANAGER');
      await addProjectMember(p.id, ids.member, 'MEMBER');
      const base = { workspaceId: ids.ws, projectId: p.id, actorUserId: ids.admin };
      const s = await sprints.create({ ...base, name: 'H1' }, reqCtx);
      await sprints.start({ ...base, sprintId: s.id }, reqCtx);
      await sprints.complete({ ...base, sprintId: s.id, target: 'BACKLOG' }, reqCtx);
      const hSprints = await sprints.history({ workspaceId: ids.ws, projectId: p.id, actorUserId: ids.admin, limit: 25 });
      assert.ok(hSprints.items.length >= 1);
      // switch to BACKLOG_ONLY
      await projects.update({ userId: ids.admin, workspaceId: ids.ws, projectId: p.id, workflowMode: 'BACKLOG_ONLY' } as any, reqCtx);
      const hBacklog = await sprints.history({ workspaceId: ids.ws, projectId: p.id, actorUserId: ids.admin, limit: 25 });
      assert.ok(hBacklog.items.some((i: any) => i.id === s.id));
      // non-manager 403 in both modes
      await expectAppError(sprints.history({ workspaceId: ids.ws, projectId: p.id, actorUserId: ids.member, limit: 25 }), 403, 'PERMISSION_DENIED');
    });

    test('concurrent start race: one succeeds, other gets clean 409', async () => {
      const p = await createProject(ids.ws, ids.admin, 'SPRINTS');
      await addProjectMember(p.id, ids.admin, 'PROJECT_MANAGER');
      const base = { workspaceId: ids.ws, projectId: p.id, actorUserId: ids.admin };
      const s1 = await sprints.create({ ...base, name: 'R1' }, reqCtx);
      const s2 = await sprints.create({ ...base, name: 'R2' }, reqCtx);
      const results = await Promise.allSettled([
        sprints.start({ ...base, sprintId: s1.id }, reqCtx),
        sprints.start({ ...base, sprintId: s2.id }, reqCtx),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const err = rejected[0]!.reason;
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.ok(['ACTIVE_SPRINT_EXISTS', 'SPRINT_ALREADY_ACTIVE'].includes(err.code));
    });
  });
}
