import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, beforeEach, describe } from 'node:test';
import { NotificationType, PrismaClient } from '@prisma/client';
import { createChecklistService } from '../src/modules/checklists/checklist.service';
import { createFileService } from '../src/modules/files/file.service';
import {
  listNotificationsQuerySchema,
  updatePreferenceSchema,
} from '../src/modules/notifications/notification.schemas';
import { createReviewService } from '../src/modules/reviews/review.service';
import { recordFanoutEvent } from '../src/services/notification-fanout';
import type { PrivateObjectStorage } from '../src/services/storage/private-object-storage';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const DB_FLAG = 'RUN_BE5_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-5 notification fan-out PostgreSQL tests', () =>
    test('skipped — set RUN_BE5_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface FixtureUser {
  id: string;
  email: string;
}

function runTests(rawDbUrl: string): void {
  const tag = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let prisma: PrismaClient;

  let owner: FixtureUser;
  let submitter: FixtureUser;
  let reviewer: FixtureUser;
  let otherMember: FixtureUser;
  let viewer: FixtureUser;
  let suspended: FixtureUser;
  let crossWorkspace: FixtureUser;
  let nonMember: FixtureUser;
  let deletedUser: FixtureUser;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;

  const storage: PrivateObjectStorage = {
    async put() {},
    async get() {
      return { body: Buffer.from('x'), contentType: 'text/plain' };
    },
    async delete() {},
    async exists() {
      return true;
    },
  };

  async function user(label: string, options: { suspended?: boolean; deleted?: boolean } = {}) {
    const email = `be5-${label}-${tag}@test.example`;
    const row = await prisma.user.create({
      data: {
        email,
        name: `BE5 ${label}`,
        passwordHash: 'test-hash',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        ...(options.deleted ? { deletedAt: new Date() } : {}),
      },
    });
    userIds.push(row.id);
    return { id: row.id, email };
  }

  async function membership(
    u: FixtureUser,
    wsId: string,
    options: { role?: 'OWNER' | 'MEMBER' | 'VIEWER'; status?: 'ACTIVE' | 'SUSPENDED' } = {},
  ) {
    await prisma.workspaceMembership.create({
      data: {
        workspaceId: wsId,
        userId: u.id,
        role: options.role ?? 'MEMBER',
        status: options.status ?? 'ACTIVE',
      },
    });
  }

  async function notifications(type: string, userId?: string) {
    return prisma.notification.findMany({
      where: {
        type: type as NotificationType,
        userId: userId ?? { in: userIds },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function checklistWithCompletedItem(completedById: string) {
    const checklist = await prisma.checklist.create({
      data: {
        workspaceId,
        projectId,
        title: `BE5 checklist ${randomUUID()}`,
        createdById: owner.id,
      },
    });
    const item = await prisma.checklistItem.create({
      data: {
        checklistId: checklist.id,
        position: 0,
        text: 'line',
        completed: true,
        completedById,
        completedAt: new Date(),
      },
    });
    return { checklistId: checklist.id, itemId: item.id };
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    prisma = db.prisma;

    owner = await user('owner');
    submitter = await user('submitter');
    reviewer = await user('reviewer');
    otherMember = await user('other');
    viewer = await user('viewer');
    suspended = await user('suspended');
    crossWorkspace = await user('cross');
    nonMember = await user('nonmember');
    deletedUser = await user('deleted', { deleted: true });

    const ws = await prisma.workspace.create({
      data: {
        name: `BE5 workspace ${tag}`,
        slug: `be5-ws-${tag}`,
        type: 'COMPANY',
        ownerId: owner.id,
        status: 'ACTIVE',
      },
    });
    workspaceId = ws.id;
    workspaceIds.push(ws.id);

    const otherWs = await prisma.workspace.create({
      data: {
        name: `BE5 other ${tag}`,
        slug: `be5-other-${tag}`,
        type: 'COMPANY',
        ownerId: crossWorkspace.id,
        status: 'ACTIVE',
      },
    });
    otherWorkspaceId = otherWs.id;
    workspaceIds.push(otherWs.id);

    await membership(owner, workspaceId, { role: 'OWNER' });
    for (const u of [submitter, reviewer, otherMember]) await membership(u, workspaceId);
    await membership(viewer, workspaceId, { role: 'VIEWER' });
    await membership(suspended, workspaceId, { status: 'SUSPENDED' });
    await membership(crossWorkspace, otherWorkspaceId, { role: 'OWNER' });

    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: `BE5 project ${tag}`,
        key: `B5${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
        visibility: 'WORKSPACE',
        status: 'ACTIVE',
        ownerId: owner.id,
      },
    });
    projectId = project.id;

    await prisma.projectMembership.create({
      data: { projectId, userId: reviewer.id, role: 'PROJECT_MANAGER' },
    });
    // A project MEMBER may submit reviews and upload file versions.
    await prisma.projectMembership.create({
      data: { projectId, userId: submitter.id, role: 'MEMBER' },
    });
  });

  // Keep notification assertions isolated from earlier tests in this suite.
  beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  });

  after(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notificationPreference.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.reviewDecision.deleteMany({
      where: { review: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.review.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.checklistItem.deleteMany({ where: { checklist: { workspaceId: { in: workspaceIds } } } });
    await prisma.checklist.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.attachmentVersion.deleteMany({
      where: { attachment: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.fileAttachment.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.auditLog.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.project.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  test('review submitted notifies eligible reviewers only, never the actor', async () => {
    const { checklistId } = await checklistWithCompletedItem(submitter.id);
    const reviews = createReviewService(prisma);
    await reviews.create({
      userId: submitter.id,
      workspaceId,
      projectId,
      checklistId,
    });

    const rows = await notifications('REVIEW_SUBMITTED');
    assert.deepEqual(
      rows.map((row) => row.userId).sort(),
      [owner.id, reviewer.id].sort(),
    );
    for (const excluded of [submitter, otherMember, viewer, suspended, crossWorkspace, nonMember, deletedUser]) {
      assert.equal(rows.some((row) => row.userId === excluded.id), false);
    }
  });

  test('review assignment, start and resubmission notify the DB-stored recipients', async () => {
    const { checklistId } = await checklistWithCompletedItem(submitter.id);
    const reviews = createReviewService(prisma);
    const created = await reviews.create({
      userId: submitter.id,
      workspaceId,
      projectId,
      checklistId,
    });
    const reviewId = created.review.id;

    await reviews.assign({ userId: owner.id, workspaceId, projectId, reviewId, assigneeId: reviewer.id });
    assert.deepEqual(
      (await notifications('REVIEW_ASSIGNED')).map((row) => row.userId),
      [reviewer.id],
    );

    await reviews.start({ userId: reviewer.id, workspaceId, projectId, reviewId });
    assert.deepEqual(
      (await notifications('REVIEW_STARTED')).map((row) => row.userId),
      [submitter.id],
    );

    await reviews.requestChanges({ userId: reviewer.id, workspaceId, projectId, reviewId, round: 1, note: 'revise' });
    await reviews.resubmit({ userId: submitter.id, workspaceId, projectId, reviewId, round: 1 });
    assert.deepEqual(
      (await notifications('REVIEW_RESUBMITTED')).map((row) => row.userId).sort(),
      [owner.id, reviewer.id].sort(),
    );
  });

  test('review decisions create the matching notification type for the submitter', async () => {
    const cases = [
      { action: 'approve' as const, type: 'REVIEW_APPROVED' },
      { action: 'reject' as const, type: 'REVIEW_REJECTED' },
      { action: 'requestChanges' as const, type: 'REVIEW_CHANGES_REQUESTED' },
    ];

    for (const item of cases) {
      const { checklistId } = await checklistWithCompletedItem(submitter.id);
      const reviews = createReviewService(prisma);
      const created = await reviews.create({
        userId: submitter.id,
        workspaceId,
        projectId,
        checklistId,
      });
      const input = {
        userId: reviewer.id,
        workspaceId,
        projectId,
        reviewId: created.review.id,
        round: 1,
        note: 'decision',
      };
      await reviews[item.action](input);
      const rows = await notifications(item.type);
      assert.deepEqual(rows.map((row) => row.userId), [submitter.id], item.type);
      assert.equal(rows.some((row) => row.userId === reviewer.id), false);
    }
  });

  test('checklist sign-off notifies active project members and excludes ineligible users', async () => {
    const { checklistId, itemId } = await checklistWithCompletedItem(submitter.id);
    const checklists = createChecklistService(prisma);
    await checklists.signOff({
      userId: owner.id,
      workspaceId,
      projectId,
      checklistId,
      itemId,
    });

    const rows = await notifications('CHECKLIST_SIGNED_OFF');
    assert.deepEqual(rows.map((row) => row.userId).sort(), [submitter.id, reviewer.id, otherMember.id, viewer.id].sort());
    for (const excluded of [owner, suspended, crossWorkspace, nonMember, deletedUser]) {
      assert.equal(rows.some((row) => row.userId === excluded.id), false, excluded.id);
    }
  });

  test('new project attachment version notifies active project members', async () => {
    const file = await prisma.fileAttachment.create({
      data: {
        workspaceId,
        projectId,
        uploadedById: owner.id,
        fileName: 'doc.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
        storageKey: `be5-${randomUUID()}`,
      },
    });
    const files = createFileService(prisma, storage);
    await files.uploadVersion({
      userId: submitter.id,
      workspaceId,
      fileId: file.id,
      fileName: 'doc-v2.txt',
      mimeType: 'text/plain',
      body: Buffer.from('v2'),
    });

    const rows = await notifications('ATTACHMENT_VERSION_ADDED');
    assert.deepEqual(rows.map((row) => row.userId).sort(), [owner.id, reviewer.id, otherMember.id, viewer.id].sort());
    for (const excluded of [submitter, suspended, crossWorkspace, nonMember, deletedUser]) {
      assert.equal(rows.some((row) => row.userId === excluded.id), false, excluded.id);
    }
  });

  test('repeated delivery of one dedupe key creates a single row', async () => {
    const dedupeKey = `be5-test-dedupe-${randomUUID()}`;
    const event = {
      action: 'checklist_item.signed_off',
      workspaceId,
      projectId,
      actorId: null,
      targetType: 'ChecklistItem',
      targetId: randomUUID(),
      dedupeKey,
      context: {},
    };
    await recordFanoutEvent(prisma, event);
    await recordFanoutEvent(prisma, event);

    const count = await prisma.notification.count({
      where: { data: { path: ['dedupeKey'], equals: dedupeKey } },
    });
    assert.equal(count, 5, 'one row per eligible project member (actor is null)');
  });

  test('recipient list is capped at 25', async () => {
    const capWs = await prisma.workspace.create({
      data: {
        name: `BE5 cap ${tag}`,
        slug: `be5-cap-${tag}`,
        type: 'COMPANY',
        ownerId: owner.id,
        status: 'ACTIVE',
      },
    });
    workspaceIds.push(capWs.id);
    const capProject = await prisma.project.create({
      data: {
        workspaceId: capWs.id,
        name: `BE5 cap project ${tag}`,
        key: `C${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
        visibility: 'WORKSPACE',
        status: 'ACTIVE',
        ownerId: owner.id,
      },
    });

    const capUserIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const u = await user(`cap${index}`);
      capUserIds.push(u.id);
      await membership(u, capWs.id);
    }

    const dedupeKey = `be5-test-cap-${randomUUID()}`;
    await recordFanoutEvent(prisma, {
      action: 'checklist_item.signed_off',
      workspaceId: capWs.id,
      projectId: capProject.id,
      actorId: null,
      targetType: 'ChecklistItem',
      targetId: randomUUID(),
      dedupeKey,
      context: {},
    });

    const count = await prisma.notification.count({
      where: { data: { path: ['dedupeKey'], equals: dedupeKey } },
    });
    assert.equal(count, 25);
  });

  test('inAppEnabled=false suppresses the in-app row for that type', async () => {
    await prisma.notificationPreference.create({
      data: {
        workspaceId,
        userId: reviewer.id,
        type: 'REVIEW_SUBMITTED',
        inAppEnabled: false,
      },
    });
    const { checklistId } = await checklistWithCompletedItem(submitter.id);
    const reviews = createReviewService(prisma);
    await reviews.create({ userId: submitter.id, workspaceId, projectId, checklistId });

    const rows = await notifications('REVIEW_SUBMITTED');
    assert.equal(rows.some((row) => row.userId === reviewer.id), false);
    assert.equal(rows.some((row) => row.userId === owner.id), true);
    await prisma.notificationPreference.deleteMany({
      where: { workspaceId, userId: reviewer.id, type: 'REVIEW_SUBMITTED' },
    });
  });

  test('self review is rejected and emits no notification', async () => {
    const { checklistId } = await checklistWithCompletedItem(submitter.id);
    const before = await prisma.notification.count({ where: { userId: { in: userIds } } });
    const reviews = createReviewService(prisma);

    await assert.rejects(
      reviews.create({
        userId: submitter.id,
        workspaceId,
        projectId,
        checklistId,
        assigneeId: submitter.id,
      }),
      (error: unknown) => (error as { code?: string }).code === 'SELF_REVIEW_FORBIDDEN',
    );

    const after = await prisma.notification.count({ where: { userId: { in: userIds } } });
    assert.equal(after, before);
  });

  test('notification failure rolls back the review decision', async () => {
    const { checklistId } = await checklistWithCompletedItem(submitter.id);
    const reviews = createReviewService(prisma);
    const created = await reviews.create({ userId: submitter.id, workspaceId, projectId, checklistId });

    const failingClient = prisma.$extends({
      query: {
        notification: {
          async createMany() {
            throw new Error('in-app write failed');
          },
        },
      },
    });
    const failingReviews = createReviewService(failingClient as unknown as PrismaClient);

    await assert.rejects(
      failingReviews.approve({
        userId: reviewer.id,
        workspaceId,
        projectId,
        reviewId: created.review.id,
        round: 1,
      }),
      /in-app write failed/,
    );

    const review = await prisma.review.findUniqueOrThrow({ where: { id: created.review.id } });
    assert.equal(review.status, 'SUBMITTED');
    const decisions = await prisma.reviewDecision.count({ where: { reviewId: created.review.id } });
    assert.equal(decisions, 0);
    const audit = await prisma.auditLog.count({
      where: { targetType: 'Review', targetId: created.review.id, action: 'review.approved' },
    });
    assert.equal(audit, 0);
  });

  test('SECURITY_ALERT is accepted by the notification list and preference validators', () => {
    const list = listNotificationsQuerySchema.parse({ type: 'SECURITY_ALERT' });
    assert.equal(list.type, 'SECURITY_ALERT');
    const preference = updatePreferenceSchema.parse({ type: 'SECURITY_ALERT', inAppEnabled: false });
    assert.equal(preference.type, 'SECURITY_ALERT');
  });
}
