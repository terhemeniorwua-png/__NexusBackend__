import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import type { WorkspaceAccessContext } from '../workspaces/authorization';

export type ImportSource = 'CLICKUP' | 'TRELLO' | 'CSV';

export interface ImportPreview {
  counts: {
    projects: number;
    tasks: number;
    comments: number;
    users: number;
  };
  warnings: string[];
  /** Internal preview items used for execution (not exposed to clients). */
  items?: PreviewItem[];
}

interface PreviewItem {
  type: 'project' | 'task' | 'comment' | 'user';
  externalId: string;
  data: Record<string, unknown>;
}

interface Input {
  userId: string;
}

function sanitizePayload(input: { source: ImportSource; csv?: string; options?: Record<string, unknown> }): Prisma.InputJsonValue {
  // Never store API tokens.
  return {
    source: input.source,
    options: (input.options ?? {}) as Prisma.InputJsonValue,
    ...(input.csv ? { csv: input.csv } : {}),
  } as Prisma.InputJsonValue;
}

function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0] ?? '').map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h as string] = cols[idx] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

async function previewCsv(csv: string): Promise<ImportPreview> {
  const { rows } = parseCsv(csv);
  const warnings: string[] = [];
  const items: PreviewItem[] = [];
  const seenTasks = new Set<string>();
  const users = new Set<string>();
  let projects = 0;
  const projectNames = new Set<string>();

  rows.forEach((row, index) => {
    const title = (row.title || row.name || row.task || '').trim();
    if (!title) {
      warnings.push(`Row ${index + 2}: missing task title, will be skipped`);
      return;
    }
    const externalId = (row.external_id || row.id || `csv-row-${index + 2}`).trim();
    if (seenTasks.has(externalId)) {
      warnings.push(`Row ${index + 2}: duplicate external id ${externalId}, will be skipped`);
      return;
    }
    seenTasks.add(externalId);
    const projectName = (row.project || row.project_name || '').trim();
    if (projectName) {
      if (!projectNames.has(projectName)) {
        projectNames.add(projectName);
        projects += 1;
        items.push({ type: 'project', externalId: `project:${projectName}`, data: { name: projectName } });
      }
    }
    const assignee = (row.assignee_email || row.email || row.assignee || '').trim().toLowerCase();
    if (assignee) {
      users.add(assignee);
      items.push({ type: 'user', externalId: `user:${assignee}`, data: { email: assignee } });
    }
    items.push({
      type: 'task',
      externalId,
      data: {
        title,
        description: (row.description || '').trim() || null,
        projectName: projectName || null,
        assigneeEmail: assignee || null,
        status: (row.status || '').trim() || null,
        dueDate: (row.due_date || row.due || '').trim() || null,
      },
    });
  });

  return {
    counts: { projects, tasks: items.filter((i) => i.type === 'task').length, comments: 0, users: users.size },
    warnings,
    items,
  };
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new AppError(502, 'IMPORT_SOURCE_UNAVAILABLE', 'The import source could not be read');
  }
  return res.json();
}

async function previewClickUp(apiToken: string, options: Record<string, unknown>): Promise<ImportPreview> {
  const listId = typeof options.listId === 'string' ? options.listId : '';
  if (!listId) {
    throw new AppError(400, 'IMPORT_OPTIONS_INVALID', 'ClickUp import requires options.listId');
  }
  const data = (await fetchJson(`https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task`, apiToken)) as {
    tasks?: Array<{ id?: string; name?: string; description?: string; assignees?: Array<{ email?: string }>; comments?: unknown[] }>;
  };
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const warnings: string[] = [];
  const items: PreviewItem[] = [];
  const users = new Set<string>();
  let comments = 0;
  for (const t of tasks) {
    if (!t.id || !t.name) continue;
    const assignee = t.assignees?.[0]?.email?.toLowerCase();
    if (assignee) {
      users.add(assignee);
      items.push({ type: 'user', externalId: `user:${assignee}`, data: { email: assignee } });
    }
    comments += Array.isArray(t.comments) ? t.comments.length : 0;
    items.push({
      type: 'task',
      externalId: String(t.id),
      data: {
        title: t.name,
        description: t.description ?? null,
        assigneeEmail: assignee ?? null,
        listId,
      },
    });
  }
  return { counts: { projects: 1, tasks: items.filter((i) => i.type === 'task').length, comments, users: users.size }, warnings, items };
}

async function previewTrello(apiToken: string, options: Record<string, unknown>): Promise<ImportPreview> {
  const boardId = typeof options.boardId === 'string' ? options.boardId : '';
  if (!boardId) {
    throw new AppError(400, 'IMPORT_OPTIONS_INVALID', 'Trello import requires options.boardId');
  }
  const key = typeof options.apiKey === 'string' ? options.apiKey : '';
  const auth = key ? `key=${encodeURIComponent(key)}&token=${encodeURIComponent(apiToken)}` : `token=${encodeURIComponent(apiToken)}`;
  const cards = (await fetchJson(
    `https://api.trello.com/1/boards/${encodeURIComponent(boardId)}/cards?${auth}&fields=id,name,desc,idMembers`,
    apiToken,
  )) as Array<{ id?: string; name?: string; desc?: string; idMembers?: string[] }>;
  const warnings: string[] = [];
  const items: PreviewItem[] = [];
  const list = Array.isArray(cards) ? cards : [];
  for (const c of list) {
    if (!c.id || !c.name) continue;
    items.push({
      type: 'task',
      externalId: String(c.id),
      data: { title: c.name, description: c.desc ?? null, boardId },
    });
  }
  if (list.some((c) => (c.idMembers?.length ?? 0) > 0)) {
    warnings.push('Trello member IDs cannot be mapped by email automatically; imported tasks will be unassigned');
  }
  return { counts: { projects: 1, tasks: items.filter((i) => i.type === 'task').length, comments: 0, users: 0 }, warnings, items };
}

export function createImportService(prisma: PrismaClient = getPrismaClient()) {
  async function requireWorkspace(input: { userId: string; workspaceId: string; context: WorkspaceAccessContext }) {
    await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
           context: (input as { context: WorkspaceAccessContext }).context,
      });
  }

  async function createPreview(input: Input & { workspaceId: string; source: ImportSource; csv?: string; apiToken?: string; options?: Record<string, unknown> }) {
    await requireWorkspace(input);

    let preview: ImportPreview;
    if (input.source === 'CSV') {
      preview = await previewCsv(input.csv ?? '');
    } else if (input.source === 'CLICKUP') {
      preview = await previewClickUp(input.apiToken ?? '', input.options ?? {});
    } else {
      preview = await previewTrello(input.apiToken ?? '', input.options ?? {});
    }

    const publicReport = { counts: preview.counts, warnings: preview.warnings };
    const job = await prisma.importJob.create({
      data: {
        workspaceId: input.workspaceId,
        createdById: input.userId,
        source: input.source,
        mode: 'DRY_RUN',
        status: 'PREVIEWED',
        payload: sanitizePayload({ source: input.source, csv: input.csv, options: input.options }) as Prisma.InputJsonValue,
        report: { ...publicReport, items: preview.items ?? [] } as unknown as Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(prisma, {
      workspaceId: input.workspaceId,
      actorId: input.userId,
      action: 'import.previewed',
      targetType: 'ImportJob',
      targetId: job.id,
      metadata: { source: input.source, counts: preview.counts },
    });

    return {
      id: job.id,
      workspaceId: job.workspaceId,
      source: job.source,
      status: job.status,
      mode: job.mode,
      preview: publicReport,
      createdAt: job.createdAt.toISOString(),
    };
  }

  async function confirm(input: Input & { importId: string; idempotencyKey?: string }) {
    const job = await prisma.importJob.findUnique({ where: { id: input.importId } });
    if (!job) throw new AppError(404, 'IMPORT_NOT_FOUND', 'That import job does not exist');
    await requireWorkspace({ userId: input.userId, workspaceId: job.workspaceId });
    if (job.mode !== 'DRY_RUN' || job.status !== 'PREVIEWED') {
      throw new AppError(409, 'IMPORT_NOT_CONFIRMABLE', 'Only a previewed dry-run import can be confirmed');
    }

    const key = input.idempotencyKey ?? `confirm:${job.id}`;
    const existing = await prisma.importJob.findFirst({
      where: { workspaceId: job.workspaceId, idempotencyKey: key, mode: 'EXECUTE' },
    });
    if (existing) {
      return toJobSummary(existing);
    }

    const execJob = await prisma.importJob.create({
      data: {
        workspaceId: job.workspaceId,
        createdById: input.userId,
        source: job.source,
        mode: 'EXECUTE',
        status: 'QUEUED',
        payload: job.payload as Prisma.InputJsonValue,
        report: job.report as Prisma.InputJsonValue,
        idempotencyKey: key,
      },
    });

    await recordAuditEvent(prisma, {
      workspaceId: job.workspaceId,
      actorId: input.userId,
      action: 'import.confirmed',
      targetType: 'ImportJob',
      targetId: execJob.id,
      metadata: { source: job.source, previewJobId: job.id },
    });

    return toJobSummary(execJob);
  }

  function toJobSummary(job: {
    id: string;
    workspaceId: string;
    source: string;
    status: string;
    mode: string;
    report: unknown;
    lastError: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  }) {
    const report = (job.report ?? {}) as { counts?: unknown; warnings?: unknown };
    return {
      id: job.id,
      workspaceId: job.workspaceId,
      source: job.source,
      status: job.status,
      mode: job.mode,
      report: {
        counts: report.counts ?? { projects: 0, tasks: 0, comments: 0, users: 0 },
        warnings: Array.isArray(report.warnings) ? report.warnings : [],
      },
      lastError: job.lastError,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  async function get(input: Input & { importId: string }) {
    const job = await prisma.importJob.findUnique({ where: { id: input.importId } });
    if (!job) throw new AppError(404, 'IMPORT_NOT_FOUND', 'That import job does not exist');
    await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: job.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
           context: (input as { context: WorkspaceAccessContext }).context,
      });
    return toJobSummary(job);
  }

  async function list(input: Input & { workspaceId: string; limit?: number }) {
    await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
           context: (input as { context: WorkspaceAccessContext }).context,
      });
    const jobs = await prisma.importJob.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: input.limit ?? 50,
    });
    return jobs.map(toJobSummary);
  }

  async function processQueued(limit = 5): Promise<{ processed: number; succeeded: number; failed: number }> {
    const jobs = await prisma.importJob.findMany({
      where: { mode: 'EXECUTE', status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      processed += 1;
      await prisma.importJob.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } } });
      try {
        const report = (job.report ?? {}) as { items?: PreviewItem[]; counts?: unknown; warnings?: string[] };
        const items = Array.isArray(report.items) ? (report.items as PreviewItem[]) : [];
        const warnings = Array.isArray(report.warnings) ? [...report.warnings] : [];
        const created = { projects: 0, tasks: 0, comments: 0, users: 0 };

        const ensureProject = async (name: string, externalId: string): Promise<string> => {
          const existing = await prisma.importExternalId.findUnique({
            where: {
              workspaceId_source_externalType_externalId: {
                workspaceId: job.workspaceId,
                source: job.source,
                externalType: 'project',
                externalId,
              },
            },
          });
          if (existing) return existing.localId;
          const baseKey = (name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'IMP');
          let key = baseKey;
          for (let i = 0; i < 50; i += 1) {
            const taken = await prisma.project.findFirst({ where: { workspaceId: job.workspaceId, key } });
            if (!taken) break;
            key = `${baseKey}${i + 1}`.slice(0, 10);
          }
          const project = await prisma.project.create({
            data: {
              name: name.slice(0, 200),
              key,
              workspaceId: job.workspaceId,
              ownerId: job.createdById,
              status: 'PLANNING',
              visibility: 'WORKSPACE',
            },
          });
          await prisma.importExternalId.create({
            data: {
              jobId: job.id,
              workspaceId: job.workspaceId,
              source: job.source,
              externalType: 'project',
              externalId,
              localType: 'project',
              localId: project.id,
            },
          });
          created.projects += 1;
          return project.id;
        };

        const nextTaskKey = async (projectId: string): Promise<string> => {
          const project = await prisma.project.findUnique({ where: { id: projectId }, select: { key: true } });
          const prefix = project?.key || 'IMP';
          const count = await prisma.task.count({ where: { projectId } });
          return `${prefix}-${count + 1}`;
        };

        // Idempotent execution: skip items whose external id already imported.
        for (const item of items) {
          const existing = await prisma.importExternalId.findUnique({
            where: {
              workspaceId_source_externalType_externalId: {
                workspaceId: job.workspaceId,
                source: job.source,
                externalType: item.type,
                externalId: item.externalId,
              },
            },
          });
          if (existing) continue;

          if (item.type === 'project') {
            const name = String(item.data.name ?? 'Imported Project').slice(0, 200);
            await ensureProject(name, item.externalId);
          } else if (item.type === 'task') {
            const title = String(item.data.title ?? 'Imported Task').slice(0, 500);
            const projectName = typeof item.data.projectName === 'string' ? item.data.projectName : null;
            const projectId = await ensureProject(projectName || 'Imported', projectName ? `project:${projectName}` : 'project:__import__');

            let assigneeId: string | null = null;
            const email = typeof item.data.assigneeEmail === 'string' ? item.data.assigneeEmail.toLowerCase() : null;
            if (email) {
              const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
              if (user) {
                const member = await prisma.workspaceMembership.findFirst({ where: { workspaceId: job.workspaceId, userId: user.id, status: 'ACTIVE' } });
                if (member) assigneeId = user.id;
                else warnings.push(`User ${email} is not a workspace member; task "${title}" left unassigned`);
              } else {
                warnings.push(`User ${email} not found; task "${title}" left unassigned`);
              }
            }

            const task = await prisma.task.create({
              data: {
                title,
                key: await nextTaskKey(projectId),
                description: typeof item.data.description === 'string' ? item.data.description : null,
                projectId,
                creatorId: job.createdById,
                status: 'ASSIGNED',
                priority: 'MEDIUM',
                ...(assigneeId
                  ? { assignees: { create: { userId: assigneeId, assignedBy: job.createdById } } }
                  : {}),
              },
            });
            await prisma.importExternalId.create({
              data: {
                jobId: job.id,
                workspaceId: job.workspaceId,
                source: job.source,
                externalType: 'task',
                externalId: item.externalId,
                localType: 'task',
                localId: task.id,
              },
            });
            created.tasks += 1;
          } else if (item.type === 'user') {
            created.users += 0;
          }
        }

        const reportCounts = (report.counts ?? {}) as { users?: number };
        const finalReport = {
          counts: { projects: created.projects, tasks: created.tasks, comments: 0, users: reportCounts.users ?? 0 },
          warnings,
        };
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: null, report: finalReport as unknown as Prisma.InputJsonValue },
        });
        await recordAuditEvent(prisma, {
          workspaceId: job.workspaceId,
          actorId: job.createdById,
          action: 'import.completed',
          targetType: 'ImportJob',
          targetId: job.id,
          metadata: { source: job.source, counts: finalReport.counts },
        });
        succeeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 500) : 'Import failed';
        logger.warn('import_job_failed', { importId: job.id });
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', completedAt: new Date(), lastError: message },
        });
        failed += 1;
      }
    }
    return { processed, succeeded, failed };
  }

  return { createPreview, confirm, get, list, processQueued, toJobSummary };
}

export type ImportService = ReturnType<typeof createImportService>;
