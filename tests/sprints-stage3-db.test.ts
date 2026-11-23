/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { SprintService } from '../src/modules/sprints/sprint.service';
import { AppError } from '../src/utils/errors';
import { AUDIT_TRAIL_EPOCH } from '../src/modules/sprints/sprint-report.constants';

const DB_FLAG = 'RUN_S3_SPRINTS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('S3 sprints board/report DB tests', () =>
    test('skipped — set RUN_S3_SPRINTS_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('S3 sprints board/report DB tests', () => {
    let prisma: any;
    let sprints: SprintService;
    const ids = {} as { admin: string; member: string; outsider: string; ws: string; projectSprints: string; projectBacklog: string };
    const cleanup: Array<() => Promise<void>> = [];
    const reqCtx = { ip: '127.0.0.1', userAgent: 'test' } as any;

    async function createUser(name: string) {
      const u = await prisma.user.create({ data: { email: `${name}-${Date.now()}-${Math.random()}@example.test`, passwordHash: 'x', name } });
      cleanup.push(async () => { await prisma.user.delete({ where: { id: u.id } }).catch(() => undefined); });
      return u;
    }
    async function createWorkspace(ownerId: string) {
      const ws = await prisma.workspace.create({ data: { name: 'WS', slug: `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`, ownerId, type: 'COMPANY' } });
      cleanup.push(async () => { await prisma.workspace.delete({ where: { id: ws.id } }).catch(() => undefined); });
      return ws;
    }
    async function addMembership(workspaceId: string, userId: string, role = 'MEMBER') {
      const m = await prisma.workspaceMembership.create({ data: { workspaceId, userId, role, status: 'ACTIVE' } });
      cleanup.push(async () => { await prisma.workspaceMembership.delete({ where: { id: m.id } }).catch(() => undefined); });
      return m;
    }
    async function createProject(workspaceId: string, ownerId: string, workflowMode: 'SPRINTS' | 'BACKLOG_ONLY' = 'SPRINTS', visibility: 'WORKSPACE' | 'PRIVATE' = 'WORKSPACE') {
      const p = await prisma.project.create({
        data: { workspaceId, name: `P-${Math.random().toString(36).slice(2)}`, key: `P${Math.random().toString(36).toUpperCase().slice(2, 8)}`, ownerId, visibility, workflowMode },
      });
      cleanup.push(async () => { await prisma.project.delete({ where: { id: p.id } }).catch(() => undefined); });
      return p;
    }
    async function addProjectMember(projectId: string, userId: string, role = 'MEMBER') {
      const pm = await prisma.projectMembership.create({ data: { projectId, userId, role } });
      cleanup.push(async () => { await prisma.projectMembership.delete({ where: { id: pm.id } }).catch(() => undefined); });
      return pm;
    }
    async function createTask(projectId: string, creatorId: string, opts: any = {}) {
      const count = await prisma.task.count({ where: { projectId } });
      const t = await prisma.task.create({
        data: {
          projectId, key: `T-${count + 1}-${Math.random().toString(36).slice(2, 6)}`, title: opts.title ?? `Task ${count + 1}`,
          status: opts.status ?? 'ASSIGNED', creatorId, position: opts.position ?? count,
          sprintId: opts.sprintId ?? null, sprintPosition: opts.sprintPosition ?? null,
          completedAt: opts.completedAt ?? null,
        },
      });
      cleanup.push(async () => { await prisma.task.delete({ where: { id: t.id } }).catch(() => undefined); });
      return t;
    }

    async function expectAppError(p: Promise<any>, status: number, code: string) {
      await assert.rejects(p, (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, status);
        assert.equal(err.code, code);
        return true;
      });
    }

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;
      sprints = new SprintService(prisma);
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
      Object.assign(ids, { admin: admin.id, member: member.id, outsider: outsider.id, ws: ws.id, projectSprints: projectSprints.id, projectBacklog: projectBacklog.id });
    });

    after(async () => {
      for (const fn of cleanup.reverse()) await fn();
      await prisma.$disconnect().catch(() => undefined);
    });

    test('auth/404/409 behavior mirrors R1 for all three routes', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectSprints, actorUserId: ids.admin };
      const sprint = await sprints.create({ ...base, name: 'S3 Auth' }, reqCtx);

      // cross-project sprint 404
      const p2 = await createProject(ids.ws, ids.admin, 'SPRINTS');
      await addProjectMember(p2.id, ids.admin, 'PROJECT_MANAGER');
      for (const fn of [
        () => sprints.board({ workspaceId: ids.ws, projectId: p2.id, sprintId: sprint.id, actorUserId: ids.admin }),
        () => sprints.reportSummary({ workspaceId: ids.ws, projectId: p2.id, sprintId: sprint.id, actorUserId: ids.admin }),
        () => sprints.reportBurndown({ workspaceId: ids.ws, projectId: p2.id, sprintId: sprint.id, actorUserId: ids.admin }),
      ]) await expectAppError(fn(), 404, 'SPRINT_NOT_FOUND');

      // non-member/private 404
      const priv = await createProject(ids.ws, ids.admin, 'SPRINTS', 'PRIVATE');
      await addProjectMember(priv.id, ids.admin, 'PROJECT_MANAGER');
      const sPriv = await sprints.create({ workspaceId: ids.ws, projectId: priv.id, actorUserId: ids.admin, name: 'Priv' }, reqCtx);
      const nonMember = await createUser('nomem3');
      await addMembership(ids.ws, nonMember.id, 'MEMBER');
      for (const fn of [
        () => sprints.board({ workspaceId: ids.ws, projectId: priv.id, sprintId: sPriv.id, actorUserId: nonMember.id }),
        () => sprints.reportSummary({ workspaceId: ids.ws, projectId: priv.id, sprintId: sPriv.id, actorUserId: nonMember.id }),
        () => sprints.reportBurndown({ workspaceId: ids.ws, projectId: priv.id, sprintId: sPriv.id, actorUserId: nonMember.id }),
      ]) await expectAppError(fn(), 404, 'PROJECT_NOT_FOUND');

      // BACKLOG_ONLY 409
      const sb = await prisma.sprint.create({ data: { projectId: ids.projectBacklog, name: 'B', status: 'PLANNED', createdById: ids.admin } });
      cleanup.push(async () => { await prisma.sprint.delete({ where: { id: sb.id } }).catch(() => undefined); });
      for (const fn of [
        () => sprints.board({ workspaceId: ids.ws, projectId: ids.projectBacklog, sprintId: sb.id, actorUserId: ids.admin }),
        () => sprints.reportSummary({ workspaceId: ids.ws, projectId: ids.projectBacklog, sprintId: sb.id, actorUserId: ids.admin }),
        () => sprints.reportBurndown({ workspaceId: ids.ws, projectId: ids.projectBacklog, sprintId: sb.id, actorUserId: ids.admin }),
      ]) await expectAppError(fn(), 409, 'SPRINTS_DISABLED_FOR_PROJECT');
    });

    test('board returns ordered columns, counts, current state', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectSprints, actorUserId: ids.admin };
      const s = await sprints.create({ ...base, name: 'Board' }, reqCtx);
      const t1 = await createTask(ids.projectSprints, ids.admin, { status: 'ASSIGNED', sprintId: s.id, sprintPosition: 1 });
      const t2 = await createTask(ids.projectSprints, ids.admin, { status: 'APPROVED', sprintId: s.id, sprintPosition: 2, completedAt: new Date() });
      const res = await sprints.board({ ...base, sprintId: s.id });
      assert.equal(res.columns.length, 7);
      assert.deepEqual(res.columns.map((c: any) => c.status), ['ASSIGNED','AWAITING_CLARIFICATION','IN_PROGRESS','SUBMITTED','UNDER_REVIEW','CHANGES_REQUESTED','APPROVED']);
      const assigned = res.columns.find((c: any) => c.status === 'ASSIGNED');
      assert.ok(assigned);
      assert.equal(assigned.count, 1);
      assert.equal(assigned.tasks[0]?.id, t1.id);
      const approved = res.columns.find((c: any) => c.status === 'APPROVED');
      assert.ok(approved);
      assert.equal(approved.count, 1);
      assert.equal(res.totals.taskCount, 2);
      assert.equal(res.totals.doneCount, 1);
      assert.ok(t2.id);
    });

    test('COMPLETED sprint carry-over to BACKLOG and NEXT_SPRINT; invariants', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectSprints, actorUserId: ids.admin };
      // BACKLOG target
      const s1 = await sprints.create({ ...base, name: 'C-BL' }, reqCtx);
      const tDone = await createTask(ids.projectSprints, ids.admin, { status: 'APPROVED', completedAt: new Date('2026-11-23T10:00:00Z') });
      const tCarry = await createTask(ids.projectSprints, ids.admin, { status: 'IN_PROGRESS' });
      await sprints.addTasks({ ...base, sprintId: s1.id, taskIds: [tDone.id, tCarry.id] }, reqCtx);
      await sprints.start({ ...base, sprintId: s1.id }, reqCtx);
      await sprints.complete({ ...base, sprintId: s1.id, target: 'BACKLOG' }, reqCtx);
      const sum1 = await sprints.reportSummary({ ...base, sprintId: s1.id });
      assert.equal(sum1.scopeReconstructable, true);
      assert.ok(sum1.summary);
      assert.equal(sum1.summary.totalTasks, 2);
      assert.equal(sum1.summary.doneTasks, 1);
      assert.equal(sum1.summary.remainingTasks, 1);
      const bd1 = await sprints.reportBurndown({ ...base, sprintId: s1.id });
      assert.equal(bd1.scopeReconstructable, true);
      const last1 = bd1.series[bd1.series.length - 1];
      assert.ok(last1);
      assert.equal(last1.remaining, sum1.summary.remainingTasks);
      assert.equal(last1.completed, sum1.summary.doneTasks);

      // NEXT_SPRINT carry-in
      const sA = await sprints.create({ ...base, name: 'C-NS-A' }, reqCtx);
      const sB = await sprints.create({ ...base, name: 'C-NS-B' }, reqCtx);
      const tA1 = await createTask(ids.projectSprints, ids.admin, { status: 'APPROVED', completedAt: new Date('2026-11-23T10:00:00Z') });
      const tA2 = await createTask(ids.projectSprints, ids.admin, { status: 'IN_PROGRESS' });
      await sprints.addTasks({ ...base, sprintId: sA.id, taskIds: [tA1.id, tA2.id] }, reqCtx);
      await sprints.start({ ...base, sprintId: sA.id }, reqCtx);
      await sprints.complete({ ...base, sprintId: sA.id, target: 'NEXT_SPRINT', nextSprintId: sB.id }, reqCtx);
      await sprints.start({ ...base, sprintId: sB.id }, reqCtx);
      const sumB = await sprints.reportSummary({ ...base, sprintId: sB.id });
      assert.equal(sumB.scopeReconstructable, true);
      assert.ok(sumB.summary);
      assert.equal(sumB.summary.totalTasks, 1); // carried-in tA2
      assert.equal(sumB.summary.doneTasks, 0);
      const bdB = await sprints.reportBurndown({ ...base, sprintId: sB.id });
      assert.equal(bdB.scopeReconstructable, true);
      const lastB = bdB.series[bdB.series.length - 1];
      assert.ok(lastB);
      assert.equal(lastB.remaining, sumB.summary.remainingTasks);
      assert.equal(lastB.completed, sumB.summary.doneTasks);
    });

    test('legacy sprint before AUDIT_TRAIL_EPOCH returns scopeReconstructable false', async () => {
      const base = { workspaceId: ids.ws, projectId: ids.projectSprints, actorUserId: ids.admin };
      const s = await sprints.create({ ...base, name: 'Legacy' }, reqCtx);
      await prisma.sprint.update({ where: { id: s.id }, data: { createdAt: new Date('2026-11-20T00:00:00Z') } });
      const sum = await sprints.reportSummary({ ...base, sprintId: s.id });
      // PLANNED/ACTIVE: summary exact current state, burndown unavailable
      assert.equal(sum.scopeReconstructable, true);
      assert.ok(sum.summary);
      const bd = await sprints.reportBurndown({ ...base, sprintId: s.id });
      assert.equal(bd.scopeReconstructable, false);
      assert.deepEqual(bd.series, []);
      assert.ok(bd.reason);
      assert.ok(AUDIT_TRAIL_EPOCH);
    });
  });
}
