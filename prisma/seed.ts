import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Password123!', 12);

  const owner = await prisma.user.upsert({
    where: { email: 'owner@nexus.dev' },
    update: {},
    create: {
      email: 'owner@nexus.dev',
      name: 'Nexus Owner',
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      profile: {
        create: {
          jobTitle: 'Product Owner',
          timeZone: 'UTC',
          locale: 'en',
        },
      },
    },
  });

  const member = await prisma.user.upsert({
    where: { email: 'member@nexus.dev' },
    update: {},
    create: {
      email: 'member@nexus.dev',
      name: 'Nexus Member',
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      profile: {
        create: {
          jobTitle: 'Engineer',
          timeZone: 'UTC',
          locale: 'en',
        },
      },
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: 'nexus-dev' },
    update: {},
    create: {
      name: 'Nexus Dev',
      slug: 'nexus-dev',
      description: 'Phase 2 seed workspace',
      status: 'ACTIVE',
      ownerId: owner.id,
    },
  });

  await prisma.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.id } },
    update: { role: 'OWNER' },
    create: {
      workspaceId: workspace.id,
      userId: owner.id,
      role: 'OWNER',
    },
  });

  await prisma.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: member.id } },
    update: { role: 'MEMBER' },
    create: {
      workspaceId: workspace.id,
      userId: member.id,
      role: 'MEMBER',
    },
  });

  const team = await prisma.team.create({
    data: {
      workspaceId: workspace.id,
      name: 'Platform',
      description: 'Core platform team',
      leadId: owner.id,
    },
  });

  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: team.id, userId: owner.id } },
    update: { role: 'TEAM_LEAD' },
    create: {
      teamId: team.id,
      userId: owner.id,
      role: 'TEAM_LEAD',
    },
  });

  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: team.id, userId: member.id } },
    update: { role: 'MEMBER' },
    create: {
      teamId: team.id,
      userId: member.id,
      role: 'MEMBER',
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: team.id,
      name: 'Nexus Platform',
      key: 'NEX',
      description: 'Phase 2 seed project',
      status: 'ACTIVE',
      visibility: 'WORKSPACE',
      ownerId: owner.id,
    },
  });

  await prisma.projectMembership.upsert({
    where: { projectId_userId: { projectId: project.id, userId: owner.id } },
    update: { role: 'PROJECT_MANAGER' },
    create: {
      projectId: project.id,
      userId: owner.id,
      role: 'PROJECT_MANAGER',
    },
  });

  await prisma.projectMembership.upsert({
    where: { projectId_userId: { projectId: project.id, userId: member.id } },
    update: { role: 'MEMBER' },
    create: {
      projectId: project.id,
      userId: member.id,
      role: 'MEMBER',
    },
  });

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      key: 'NEX-1',
      title: 'Establish foundation',
      description: 'Seed task for Phase 2',
      status: 'ASSIGNED',
      priority: 'HIGH',
      creatorId: owner.id,
    },
  });

  await prisma.taskAssignee.upsert({
    where: { taskId_userId: { taskId: task.id, userId: member.id } },
    update: {},
    create: {
      taskId: task.id,
      userId: member.id,
      assignedBy: owner.id,
    },
  });

  await prisma.comment.create({
    data: {
      taskId: task.id,
      authorId: owner.id,
      body: 'Initial project setup in progress.',
    },
  });

  const invitation = await prisma.invitation.create({
    data: {
      workspaceId: workspace.id,
      email: 'invitee@nexus.dev',
      role: 'MEMBER',
      type: 'WORKSPACE',
      tokenHash: await bcrypt.hash('seed-invite-token', 12),
      status: 'PENDING',
      invitedById: owner.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.notification.create({
    data: {
      userId: member.id,
      type: 'TASK_ASSIGNED',
      title: 'You were assigned a task',
      body: 'NEX-1 — Establish foundation',
      data: { taskId: task.id },
    },
  });

  console.log(`Seed complete: workspace=${workspace.slug}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
