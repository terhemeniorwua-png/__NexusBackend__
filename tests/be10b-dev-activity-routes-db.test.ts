/* eslint-disable @typescript-eslint/no-explicit-any -- test DB/prisma client shapes */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { resolveTestDatabaseUrl, connectTestDatabase } from './helpers/test-database';
import { createDevIntegrationService } from '../src/modules/dev-integrations/dev-integration.service';
import { devActivityCommitsQuerySchema } from '../src/modules/dev-integrations/dev-integration.schemas';

const DB_FLAG = 'RUN_BE10B_DEV_ACTIVITY_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-10b dev activity routes DB tests', () =>
    test(`skipped — set ${DB_FLAG}=true to run`, () => {}));
} else {
  runTests(databaseUrl);
}

function runTests(rawDbUrl: string): void {
  describe('BE-10b dev activity routes DB tests', () => {
    let prisma: any;
    let svc: any;
    const config: any = { frontendUrl: 'http://localhost:3000', corsOrigins: ['http://localhost:3000'] };
    const created: any = { users: [], workspaces: [], memberships: [], projects: [], projectMemberships: [], connections: [], repos: [], repoMembers: [], commits: [], prs: [], reviews: [] };

    let ownerId: string;
    let viewerId: string;
    let outsiderId: string;
    let wsId: string;
    let ws2Id: string;
    let projectId: string;
    let project2Id: string;
    let otherProjectId: string;
    let repoReadId: string;
    let repoLinkId: string;
    let repoNoneId: string;
    let repoMetaId: string;
    let repoOtherProjectId: string;
    let repoWs2Id: string;

    const from = '2026-11-01T00:00:00.000Z';
    const to = '2026-11-30T23:59:59.000Z';

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;
      svc = createDevIntegrationService(config, prisma);
      const suffix = Date.now().toString(36);

      const owner = await prisma.user.create({ data: { email: `be10b-owner-${suffix}@example.test`, passwordHash: 'x', name: 'Owner User' } });
      const viewer = await prisma.user.create({ data: { email: `be10b-viewer-${suffix}@example.test`, passwordHash: 'x', name: 'Viewer User' } });
      const outsider = await prisma.user.create({ data: { email: `be10b-outsider-${suffix}@example.test`, passwordHash: 'x', name: 'Outsider' } });
      const mapped = await prisma.user.create({ data: { email: `be10b-mapped-${suffix}@example.test`, passwordHash: 'x', name: 'Mapped Dev' } });
      created.users.push(owner.id, viewer.id, outsider.id, mapped.id);
      ownerId = owner.id; viewerId = viewer.id; outsiderId = outsider.id;

      const ws = await prisma.workspace.create({ data: { name: 'BE10B WS', slug: `be10b-ws-${suffix}`, ownerId: owner.id, type: 'COMPANY' } });
      const ws2 = await prisma.workspace.create({ data: { name: 'BE10B WS2', slug: `be10b-ws2-${suffix}`, ownerId: outsider.id, type: 'COMPANY' } });
      created.workspaces.push(ws.id, ws2.id);
      wsId = ws.id; ws2Id = ws2.id;

      for (const [wid, uid, role] of [[wsId, ownerId, 'OWNER'], [wsId, viewerId, 'MEMBER'], [wsId, mapped.id, 'MEMBER'], [ws2Id, outsiderId, 'OWNER']] as any[]) {
        const m = await prisma.workspaceMembership.create({ data: { workspaceId: wid, userId: uid, role, status: 'ACTIVE' } });
        created.memberships.push(m.id);
      }

      const p1 = await prisma.project.create({ data: { workspaceId: wsId, name: 'P1', key: `B1${suffix.toUpperCase()}`.slice(0, 10), ownerId, visibility: 'PRIVATE' } });
      const p2 = await prisma.project.create({ data: { workspaceId: wsId, name: 'P2', key: `B2${suffix.toUpperCase()}`.slice(0, 10), ownerId, visibility: 'PRIVATE' } });
      const pOther = await prisma.project.create({ data: { workspaceId: ws2Id, name: 'P3', key: `B3${suffix.toUpperCase()}`.slice(0, 10), ownerId: outsiderId, visibility: 'PRIVATE' } });
      created.projects.push(p1.id, p2.id, pOther.id);
      projectId = p1.id; project2Id = p2.id; otherProjectId = pOther.id;

      for (const [pid, uid, role] of [[projectId, ownerId, 'PROJECT_MANAGER'], [projectId, viewerId, 'VIEWER'], [project2Id, ownerId, 'PROJECT_MANAGER'], [otherProjectId, outsiderId, 'PROJECT_MANAGER']] as any[]) {
        const pm = await prisma.projectMembership.create({ data: { projectId: pid, userId: uid, role } });
        created.projectMemberships.push(pm.id);
      }

      const conn = await prisma.integrationConnection.create({ data: { workspaceId: wsId, provider: 'GITHUB', externalAccountId: `acc-${suffix}`, encryptedCredentials: 'enc', createdById: mapped.id, status: 'ACTIVE', externalAccountLogin: 'mappeddev' } });
      const conn2 = await prisma.integrationConnection.create({ data: { workspaceId: ws2Id, provider: 'GITHUB', externalAccountId: `acc2-${suffix}`, encryptedCredentials: 'enc', createdById: outsiderId, status: 'ACTIVE', externalAccountLogin: 'outsidergh' } });
      created.connections.push(conn.id, conn2.id);

      async function mkRepo(projectIdLocal: string, connectionId: string, fullName: string, ext: string) {
        const r = await prisma.projectRepository.create({ data: { projectId: projectIdLocal, connectionId, provider: 'GITHUB', externalRepoId: ext, fullName, defaultBranch: 'main' } });
        created.repos.push(r.id);
        return r.id;
      }
      repoReadId = await mkRepo(projectId, conn.id, 'Acme/RepoRead', `rr-${suffix}`);
      repoLinkId = await mkRepo(projectId, conn.id, 'acme/repolink', `rl-${suffix}`);
      repoNoneId = await mkRepo(projectId, conn.id, 'acme/reponone', `rn-${suffix}`);
      repoMetaId = await mkRepo(projectId, conn.id, 'acme/repometa', `rm-${suffix}`);
      repoOtherProjectId = await mkRepo(project2Id, conn.id, 'acme/repoRead', `rr2-${suffix}`); // same repo name, different project
      repoWs2Id = await mkRepo(otherProjectId, conn2.id, 'acme/repoRead', `rr3-${suffix}`); // same name, different workspace

      async function override(repoId: string, pid: string, uid: string, level: 'NONE'|'METADATA'|'READ'|'LINK') {
        const row = await prisma.projectRepositoryMember.create({ data: { projectRepositoryId: repoId, projectId: pid, userId: uid, level, grantedById: ownerId } });
        created.repoMembers.push(row.id);
      }
      // owner is PROJECT_MANAGER - default LINK; set explicit for clarity
      for (const uid of [ownerId, viewerId]) {
        await override(repoReadId, projectId, uid, 'READ');
        await override(repoLinkId, projectId, uid, 'LINK');
        await override(repoNoneId, projectId, uid, 'NONE');
        await override(repoMetaId, projectId, uid, 'METADATA');
      }
      await override(repoOtherProjectId, project2Id, ownerId, 'READ');
      await override(repoWs2Id, otherProjectId, outsiderId, 'READ');

      async function mkCommit(repoFullName: string, sha: string, authorLogin: string | null, committedAt: string, msg = 'msg', branch = 'main', isDefault = true, ingestedAt = '2026-11-01T00:00:00.000Z') {
        const c = await prisma.repositoryCommit.create({ data: { provider: 'GITHUB', repositoryFullName: repoFullName, sha, message: msg, authorName: authorLogin, authorLogin, committedAt: new Date(committedAt), url: `https://ex/${sha}`, branch, isDefaultBranch: isDefault, ingestedAt: new Date(ingestedAt) } });
        created.commits.push(c.id);
        return c;
      }
      async function mkPR(repoFullName: string, externalPrId: string, action: 'OPENED'|'MERGED', authorLogin: string|null, occurredAt: string, ingestedAt = '2026-11-01T00:00:00.000Z') {
        const p = await prisma.repositoryPullRequestEvent.create({ data: { provider: 'GITHUB', repositoryFullName: repoFullName, externalPrId, action, authorLogin, authorName: authorLogin, occurredAt: new Date(occurredAt), ingestedAt: new Date(ingestedAt) } });
        created.prs.push(p.id);
        return p;
      }
      async function mkReview(repoFullName: string, externalReviewId: string, externalPrId: string|null, reviewerLogin: string|null, submittedAt: string, ingestedAt = '2026-11-01T00:00:00.000Z', reviewState: string | null = null) {
        const r = await prisma.repositoryReviewEvent.create({ data: { provider: 'GITHUB', repositoryFullName: repoFullName, externalReviewId, externalPrId, reviewState, reviewerLogin, reviewerName: reviewerLogin, submittedAt: new Date(submittedAt), ingestedAt: new Date(ingestedAt) } });
        created.reviews.push(r.id);
        return r;
      }

      // Commits: READ has 3, LINK has 1, NONE has 1 (must never leak), METADATA has 1 (must never leak)
      await mkCommit('acme/reporead', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'mappeddev', '2026-11-10T10:00:00.000Z', 'read-1');
      await mkCommit('acme/reporead', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'unmapped', '2026-11-11T10:00:00.000Z', 'read-2');
      await mkCommit('acme/reporead', 'cccccccccccccccccccccccccccccccccccccccc', 'mappeddev', '2026-11-12T10:00:00.000Z', 'read-3');
      await mkCommit('acme/repolink', 'dddddddddddddddddddddddddddddddddddddddd', 'mappeddev', '2026-11-13T10:00:00.000Z', 'link-1');
      await mkCommit('acme/reponone', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'secret', '2026-11-14T10:00:00.000Z', 'none-1', 'main', true, '2026-10-01T00:00:00.000Z');
      await mkCommit('acme/repometa', 'ffffffffffffffffffffffffffffffffffffffff', 'secret', '2026-11-15T10:00:00.000Z', 'meta-1', 'main', true, '2026-10-01T00:00:00.000Z');
      // casing variant dedupe: same sha different casing repo name
      await mkCommit('Acme/RepoRead', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'mappeddev', '2026-11-09T10:00:00.000Z', 'dupe-casing');
      // dedicated casing-dedupe developer: two mirror rows, same repo+sha, different casing
      await mkCommit('acme/reporead', 'cafebabecafebabecafebabecafebabecafebabe', 'casedev', '2026-11-08T10:00:00.000Z', 'case-lower');
      await mkCommit('Acme/RepoRead', 'cafebabecafebabecafebabecafebabecafebabe', 'casedev', '2026-11-07T10:00:00.000Z', 'case-upper');
      // other project same repo name
      await mkCommit('acme/reporead', '1111111111111111111111111111111111111111', 'otherproj', '2026-11-16T10:00:00.000Z', 'other-proj');
      // other workspace same repo name
      await mkCommit('acme/reporead', '2222222222222222222222222222222222222222', 'otherws', '2026-11-17T10:00:00.000Z', 'other-ws');

      // PR events
      await mkPR('acme/reporead', 'pr-1', 'OPENED', 'mappeddev', '2026-11-10T11:00:00.000Z');
      await mkPR('acme/reporead', 'pr-1', 'MERGED', 'mappeddev', '2026-11-10T12:00:00.000Z');
      await mkPR('acme/repolink', 'pr-2', 'OPENED', 'unmapped', '2026-11-11T11:00:00.000Z');
      await mkPR('acme/reponone', 'pr-secret', 'OPENED', 'secret', '2026-11-11T11:00:00.000Z', '2026-10-01T00:00:00.000Z');

      // Reviews: reviewer2 reviews pr-1 (mappeddev author) -> counts; mappeddev self-review pr-1 -> excluded
      await mkReview('acme/reporead', 'rev-1', 'pr-1', 'reviewer2', '2026-11-10T13:00:00.000Z');
      await mkReview('acme/reporead', 'rev-2', 'pr-1', 'mappeddev', '2026-11-10T14:00:00.000Z'); // self-review
      await mkReview('acme/repolink', 'rev-3', 'pr-2', 'reviewer3', '2026-11-11T14:00:00.000Z', '2026-11-01T00:00:00.000Z', 'CHANGES_REQUESTED');
      await mkReview('acme/reponone', 'rev-secret', 'pr-secret', 'secret', '2026-11-10T14:00:00.000Z', '2026-10-01T00:00:00.000Z');
    });

    after(async () => {
      for (const r of created.reviews) await prisma.repositoryReviewEvent.delete({ where: { id: r } }).catch(() => undefined);
      for (const p of created.prs) await prisma.repositoryPullRequestEvent.delete({ where: { id: p } }).catch(() => undefined);
      for (const c of created.commits) await prisma.repositoryCommit.delete({ where: { id: c } }).catch(() => undefined);
      for (const id of created.repoMembers) await prisma.projectRepositoryMember.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.repos) await prisma.projectRepository.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.connections) await prisma.integrationConnection.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.projectMemberships) await prisma.projectMembership.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.projects) await prisma.project.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.memberships) await prisma.workspaceMembership.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.workspaces) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
      for (const id of created.users) await prisma.user.delete({ where: { id } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    });

    function noEmail(obj: any): void {
      const s = JSON.stringify(obj);
      assert.ok(!s.includes('@example.test'), 'response must not contain email');
      assert.ok(!s.includes('"email"'), 'response must not contain email field');
    }

    test('commits: READ/LINK included, NONE/METADATA omitted; no email; dedupes casing variants', async () => {
      const res = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, limit: 100 });
      noEmail(res);
      const shas = res.items.map((i: any) => i.sha);
      assert.ok(shas.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
      assert.ok(shas.includes('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
      assert.ok(shas.includes('cccccccccccccccccccccccccccccccccccccccc'));
      assert.ok(shas.includes('dddddddddddddddddddddddddddddddddddddddd'));
      assert.ok(!shas.includes('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')); // NONE
      assert.ok(!shas.includes('ffffffffffffffffffffffffffffffffffffffff')); // METADATA
      // casing dedupe: same sha acme/reporead vs Acme/RepoRead should appear once
      const aCount = shas.filter((s: string) => s === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').length;
      assert.equal(aCount, 1);
      for (const item of res.items) {
        assert.ok(['id','repositoryId','repositoryFullName','sha','message','authorName','authorLogin','authorUser','committedAt','url','branch'].every(k => k in item));
        assert.ok(!('email' in item));
        assert.ok(!('taskLinks' in item));
      }
    });

    test('commits: repositoryId filter for unreadable repo returns 404', async () => {
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: repoNoneId }),
        (e: any) => e?.status === 404 || e?.statusCode === 404,
      );
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: repoMetaId }),
        (e: any) => e?.status === 404 || e?.statusCode === 404,
      );
    });

    test('commits: non-member gets 403/404', async () => {
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: outsiderId, workspaceId: wsId, projectId }),
        (e: any) => [403, 404].includes(e?.status ?? e?.statusCode),
      );
    });

    test('commits: cursor stability across pages and rows inserted between pages', async () => {
      const page1 = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, limit: 2 });
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextCursor);
      // insert row between pages
      const inserted = await prisma.repositoryCommit.create({ data: { provider: 'GITHUB', repositoryFullName: 'acme/reporead', sha: '3333333333333333333333333333333333333333', message: 'inserted', authorLogin: 'mappeddev', committedAt: new Date('2026-11-18T10:00:00.000Z'), isDefaultBranch: true, ingestedAt: new Date() } });
      created.commits.push(inserted.id);
      const page2 = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, limit: 2, cursor: page1.nextCursor });
      const ids1 = new Set(page1.items.map((i: any) => i.id));
      for (const item of page2.items) assert.ok(!ids1.has(item.id), 'no overlap across pages');
      // inserted row (newer than cursor window) should not appear as duplicate; cursor pagination remains stable
      noEmail(page2);
    });

    test('commits: opaque cursor passes route validation and malformed cursors are rejected', async () => {
      const page = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, limit: 2 });
      assert.ok(page.nextCursor);
      const parsed = devActivityCommitsQuerySchema.parse({ cursor: page.nextCursor, limit: '2' });
      assert.equal(parsed.cursor, page.nextCursor);
      assert.equal(parsed.limit, 2);
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, cursor: 'not-a-cursor' }),
        (e: any) => (e?.statusCode ?? e?.status) === 400,
      );
    });

    test('commits: READ and LINK repos contribute; NONE and METADATA are hidden', async () => {
      const read = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: repoReadId, limit: 100 });
      const link = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: repoLinkId, limit: 100 });
      assert.ok(read.items.length > 0);
      assert.ok(link.items.length > 0);
      assert.ok(read.items.every((item: any) => item.repositoryId === repoReadId));
      assert.ok(link.items.every((item: any) => item.repositoryId === repoLinkId));
      noEmail(read);
      noEmail(link);
      for (const repoId of [repoNoneId, repoMetaId]) {
        await assert.rejects(
          () => svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: repoId }),
          (e: any) => (e?.statusCode ?? e?.status) === 404,
        );
      }
    });

    test('developers: READ and LINK repos contribute; NONE and METADATA are hidden', async () => {
      const read = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to, repositoryId: repoReadId });
      const link = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to, repositoryId: repoLinkId });
      assert.ok(read.developers.length > 0);
      assert.ok(link.developers.length > 0);
      assert.ok(!read.developers.some((d: any) => d.providerLogin === 'secret'));
      assert.ok(!link.developers.some((d: any) => d.providerLogin === 'secret'));
      noEmail(read);
      noEmail(link);
      for (const repoId of [repoNoneId, repoMetaId]) {
        await assert.rejects(
          () => svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to, repositoryId: repoId }),
          (e: any) => (e?.statusCode ?? e?.status) === 404,
        );
      }
    });

    test('repositoryId filter for an unlinked repository returns 404 on both routes', async () => {
      const unlinkedId = randomUUID();
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: unlinkedId }),
        (e: any) => (e?.statusCode ?? e?.status) === 404,
      );
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to, repositoryId: unlinkedId }),
        (e: any) => (e?.statusCode ?? e?.status) === 404,
      );
    });

    test('developers: casing variants dedupe by repository+sha', async () => {
      const res = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to });
      const cased = res.developers.find((d: any) => d.providerLogin === 'casedev');
      assert.ok(cased);
      assert.equal(cased.commits, 1);
    });

    test('commits: page boundaries unaffected by hidden rows', async () => {
      // NONE/METADATA repos have commits in same time window; they must not affect page size/cursor.
      const res = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, limit: 10 });
      assert.ok(res.items.length <= 10);
      for (const item of res.items) {
        assert.ok(item.repositoryId !== repoNoneId);
        assert.ok(item.repositoryId !== repoMetaId);
      }
      // verify totals by fetching all
      const all = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, limit: 100 });
      const hidden = all.items.filter((i: any) => [repoNoneId, repoMetaId].includes(i.repositoryId));
      assert.equal(hidden.length, 0);
    });

    test('developers: READ/LINK contribute, NONE/METADATA never change totals or coverageStartedAt; mapped/unmapped; self-review excluded; no email', async () => {
      const res = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to });
      noEmail(res);
      // Hidden NONE/METADATA repositories were ingested earlier (2026-10-01),
      // but coverage must reflect only READ/LINK repositories (2026-11-01).
      assert.equal(res.coverageStartedAt, '2026-11-01T00:00:00.000Z');
      assert.ok(Array.isArray(res.developers));

      const mapped = res.developers.find((d: any) => d.providerLogin === 'mappeddev');
      assert.ok(mapped);
      assert.equal(mapped.type, 'workspace_user');
      assert.equal(mapped.user.name, 'Mapped Dev');
      assert.ok(mapped.commits >= 3); // read-1, read-3, link-1, plus inserted 3333
      assert.ok(mapped.pullRequestsOpened >= 1);
      assert.ok(mapped.pullRequestsMerged >= 1);

      const unmapped = res.developers.find((d: any) => d.providerLogin === 'unmapped');
      assert.ok(unmapped);
      assert.equal(unmapped.type, 'unmapped');
      assert.equal(unmapped.user, null);

      // self-review by mappeddev on pr-1 excluded; reviewer2 counted
      const reviewer2 = res.developers.find((d: any) => d.providerLogin === 'reviewer2');
      assert.ok(reviewer2);
      assert.equal(reviewer2.reviewsGiven, 1);
      // mappeddev should not get self-review counted
      assert.equal(mapped.reviewsGiven, 0);
      // all submitted states count, including CHANGES_REQUESTED
      const reviewer3 = res.developers.find((d: any) => d.providerLogin === 'reviewer3');
      assert.ok(reviewer3);
      assert.equal(reviewer3.reviewsGiven, 1);

      // no secret/none/meta authors
      assert.ok(!res.developers.some((d: any) => d.providerLogin === 'secret'));

      // range and coverageStartedAt present
      assert.equal(res.range.from, new Date(from).toISOString());
      assert.equal(res.range.to, new Date(to).toISOString());
    });

    test('developers: NONE/METADATA repos never change totals or coverageStartedAt (mixed-repo)', async () => {
      const withHidden = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to });
      // remove hidden repos and verify same result
      await prisma.projectRepositoryMember.updateMany({ where: { projectRepositoryId: { in: [repoNoneId, repoMetaId] }, userId: ownerId }, data: { level: 'NONE' } });
      // totals/coverage for READ/LINK should be same; we didn't change READ/LINK
      const again = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to });
      assert.equal(JSON.stringify(again.developers), JSON.stringify(withHidden.developers));
      assert.equal(again.coverageStartedAt, withHidden.coverageStartedAt);
      // restore (not necessary, but clean)
      await prisma.projectRepositoryMember.updateMany({ where: { projectRepositoryId: repoMetaId, userId: ownerId }, data: { level: 'METADATA' } });
    });

    test('developers: viewer without report permission gets 403', async () => {
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: viewerId, workspaceId: wsId, projectId, from, to }),
        (e: any) => (e?.status ?? e?.statusCode) === 403,
      );
    });

    test('developers: non-member gets 403/404', async () => {
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: outsiderId, workspaceId: wsId, projectId, from, to }),
        (e: any) => [403, 404].includes(e?.status ?? e?.statusCode),
      );
    });

    test('developers: repositoryId filter on unreadable repo returns 404', async () => {
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from, to, repositoryId: repoNoneId }),
        (e: any) => (e?.status ?? e?.statusCode) === 404,
      );
    });

    test('two projects linking same repository stay isolated', async () => {
      // project2 links same repo name acme/reporead with its own ProjectRepository row and different commit visibility
      const p1 = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, repositoryId: repoReadId, limit: 100 });
      const p2 = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId: project2Id, repositoryId: repoOtherProjectId, limit: 100 });
      // p2's repo link is to same fullName but different ProjectRepository; commit '1111...' is in mirror but both projects see by repo name - isolation is by ProjectRepository link and access.
      // The key isolation: project2 should not get project1-only private data beyond what's in the same mirror repo; but they share mirror repo name. Spec says "two projects linking the same repository stay isolated" - ensure repositoryId scoping and access are per project.
      assert.ok(p1.items.every((i: any) => i.repositoryId === repoReadId));
      assert.ok(p2.items.every((i: any) => i.repositoryId === repoOtherProjectId));
      // project2 cannot query project1's repositoryId
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId: project2Id, repositoryId: repoReadId, limit: 10 }),
        (e: any) => (e?.status ?? e?.statusCode) === 404,
      );
    });

    test('two workspaces sharing a repository name never see each other\'s data', async () => {
      // ws2 has repoWs2Id linked to acme/reporead but different workspace; its owner can only see their project's mirror rows through their own link
      const ws2Res = await svc.listDevActivityCommits({ userId: outsiderId, workspaceId: ws2Id, projectId: otherProjectId, limit: 100 });
      assert.ok(ws2Res.items.every((i: any) => i.repositoryId === repoWs2Id));
      // ws2 owner must not access ws1 project
      await assert.rejects(
        () => svc.listDevActivityCommits({ userId: outsiderId, workspaceId: wsId, projectId, limit: 10 }),
        (e: any) => [403, 404].includes(e?.status ?? e?.statusCode),
      );
    });

    test('developers: range validation (missing, reversed, over 90 days)', async () => {
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from: to, to: from }),
        (e: any) => (e?.status ?? e?.statusCode) === 400,
      );
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' }),
        (e: any) => (e?.status ?? e?.statusCode) === 400,
      );
      await assert.rejects(
        () => svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from: '', to } as any),
        (e: any) => [400, 500].includes(e?.status ?? e?.statusCode), // service validates; missing caught by schema in route, service may throw 400
      );
    });

    test('empty results', async () => {
      const res = await svc.listDevActivityCommits({ userId: ownerId, workspaceId: wsId, projectId, authorLogin: 'no-such-author', limit: 10 });
      assert.deepEqual(res.items, []);
      assert.equal(res.nextCursor, null);
      const dev = await svc.listDevActivityDevelopers({ userId: ownerId, workspaceId: wsId, projectId, from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
      assert.deepEqual(dev.developers, []);
      // coverageStartedAt reflects included repos' ingestion history, not the selected range
      assert.ok(dev.coverageStartedAt === null || typeof dev.coverageStartedAt === 'string');
    });
  });
}
