/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const wsAuth = vi.hoisted(() => ({
  requireWorkspaceAccess: vi.fn(),
  WorkspaceCapability: { ViewWorkspace: 'workspace:view' },
}));
const audit = vi.hoisted(() => ({ recordAuditEvent: vi.fn(async () => undefined) }));

vi.mock('../workspaces/authorization', () => wsAuth);
vi.mock('../../services/audit', () => audit);
vi.mock('../../middleware/authenticate', () => ({
  createRequireAuth: () => (req: any, _res: any, next: any) => {
    req.auth = { userId: 'u1', sessionId: 's1', email: 'u1@test', name: 'U1', status: 'ACTIVE' };
    next();
  },
  createRequireActiveAccount: () => (_req: any, _res: any, next: any) => next(),
}));

import { createFormService } from './form.service';
import { createFormRouter } from './form.routes';
import { AppError } from '../../utils/errors';

const ws = '11111111-1111-4111-8111-111111111111';
const fid = '22222222-2222-4222-8222-222222222222';
const fieldId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-01-02T10:00:00.000Z');

function makeField(overrides: any = {}) {
  return { id: fieldId, formId: fid, label: 'Name', type: 'TEXT', required: true, options: [], placeholder: null, position: 0, createdAt: now, updatedAt: now, ...overrides };
}
function makeForm(overrides: any = {}) {
  return {
    id: fid, workspaceId: ws, createdById: 'u1', title: 'Survey', description: null,
    status: 'DRAFT', isPublic: false, createdAt: now, updatedAt: now, deletedAt: null,
    fields: [makeField()], _count: { responses: 0 }, ...overrides,
  };
}

function makePrisma() {
  const base: any = {
    form: {
      create: vi.fn(async ({ data }: any) => makeForm({ ...data })),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async ({ data }: any) => makeForm({ ...data })),
    },
    formField: { create: vi.fn(async ({ data }: any) => makeField({ ...data })) },
    formResponse: { create: vi.fn(async () => ({ id: 'r1' })), findMany: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(base)),
  };
  return base;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))); }
}

describe('forms module (service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
  });

  it('happy path: create/list/get/update/addField/submit/listResponses/delete with audits and cursor', async () => {
    const prisma = makePrisma();
    const form = makeForm();
    prisma.form.findFirst.mockResolvedValue(form);
    prisma.form.findMany.mockResolvedValue([form, makeForm({ id: 'f0' })]);
    prisma.formResponse.findMany.mockResolvedValue([
      { id: 'r1', formId: fid, submittedBy: 'u1', createdAt: now, answers: [{ fieldId, value: 'A', field: { label: 'Name', type: 'TEXT' } }] },
      { id: 'r0', formId: fid, submittedBy: 'u1', createdAt: now, answers: [] },
    ]);

    const svc = createFormService(prisma as any);

    const created = await svc.create({ userId: 'u1', workspaceId: ws, title: 'Survey' });
    expect(created._count.responses).toBe(0);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'form.created' }));

    const listed = await svc.list({ userId: 'u1', workspaceId: ws, limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBe(fid);

    const got = await svc.get({ userId: 'u1', workspaceId: ws, formId: fid });
    expect(got.fields).toHaveLength(1);

    const updated = await svc.update({ userId: 'u1', workspaceId: ws, formId: fid, title: 'New' });
    expect(updated._count.responses).toBe(0);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'form.updated' }));

    const field = await svc.addField({ userId: 'u1', workspaceId: ws, formId: fid, label: 'Email', type: 'EMAIL' });
    expect(field.formId).toBe(fid);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'form.field_added' }));

    prisma.form.findFirst.mockResolvedValue(makeForm({ status: 'PUBLISHED' }));
    await svc.submitResponse({ userId: 'u1', workspaceId: ws, formId: fid, answers: [{ fieldId, value: 'Alice' }] });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'form.response_submitted' }));

    prisma.form.findFirst.mockResolvedValue(form);
    const resps = await svc.listResponses({ userId: 'u1', workspaceId: ws, formId: fid, limit: 1 });
    expect(resps.items).toHaveLength(1);
    expect(resps.nextCursor).toBe('r1');
    expect(resps.items[0].answers[0].field).toEqual({ label: 'Name', type: 'TEXT' });

    await svc.delete({ userId: 'u1', workspaceId: ws, formId: fid });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'form.deleted' }));
  });

  it('permission denied: workspace access denied and non-manager/non-creator cannot manage or view responses', async () => {
    const prisma = makePrisma();
    const svc = createFormService(prisma as any);

    wsAuth.requireWorkspaceAccess.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'no access'));
    await expect(svc.list({ userId: 'u2', workspaceId: ws, limit: 10 })).rejects.toMatchObject({ statusCode: 403 });

    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
    prisma.form.findFirst.mockResolvedValue(makeForm({ createdById: 'owner' }));
    await expect(svc.update({ userId: 'u2', workspaceId: ws, formId: fid, title: 'x' })).rejects.toMatchObject({ statusCode: 403, code: 'FORM_EDIT_FORBIDDEN' });
    await expect(svc.delete({ userId: 'u2', workspaceId: ws, formId: fid })).rejects.toMatchObject({ statusCode: 403, code: 'FORM_DELETE_FORBIDDEN' });
    await expect(svc.addField({ userId: 'u2', workspaceId: ws, formId: fid, label: 'x', type: 'TEXT' })).rejects.toMatchObject({ statusCode: 403, code: 'FORM_EDIT_FORBIDDEN' });
    await expect(svc.listResponses({ userId: 'u2', workspaceId: ws, formId: fid, limit: 10 })).rejects.toMatchObject({ statusCode: 403, code: 'FORM_ACCESS_DENIED' });
  });

  it('cross-workspace isolation: form lookup scoped to workspace returns not found', async () => {
    const prisma = makePrisma();
    const svc = createFormService(prisma as any);
    prisma.form.findFirst.mockResolvedValue(null);
    const otherWs = '44444444-4444-4444-8444-444444444444';

    await expect(svc.get({ userId: 'u1', workspaceId: otherWs, formId: fid })).rejects.toMatchObject({ statusCode: 404, code: 'FORM_NOT_FOUND' });
    expect(prisma.form.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: fid, workspaceId: otherWs, deletedAt: null }),
    }));

    await expect(svc.submitResponse({ userId: 'u1', workspaceId: otherWs, formId: fid, answers: [{ fieldId, value: 'x' }] }))
      .rejects.toMatchObject({ statusCode: 404, code: 'FORM_NOT_FOUND' });
  });
});

describe('forms module (routes contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes return contract shapes including cursor pagination and {ok:true}', async () => {
    const summary = { id: fid, workspaceId: ws, createdById: 'u1', title: 'Survey', description: null, status: 'DRAFT', isPublic: false, createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z', _count: { responses: 0 } };
    const detail = { ...summary, fields: [{ id: fieldId, formId: fid, label: 'Name', type: 'TEXT', required: true, options: [], placeholder: null, position: 0, createdAt: '2026-01-02T10:00:00.000Z' }] };
    const field = detail.fields[0];
    const service: any = {
      list: vi.fn(async () => ({ items: [summary], nextCursor: null })),
      create: vi.fn(async () => detail),
      get: vi.fn(async () => detail),
      update: vi.fn(async () => detail),
      delete: vi.fn(async () => undefined),
      addField: vi.fn(async () => field),
      submitResponse: vi.fn(async () => undefined),
      listResponses: vi.fn(async () => ({ items: [{ id: 'r1', formId: fid, submittedBy: 'u1', createdAt: '2026-01-02T10:00:00.000Z', answers: [{ fieldId, value: 'A', field: { label: 'Name', type: 'TEXT' } }] }], nextCursor: null })),
    };
    const app = express();
    app.use(express.json());
    app.use('/workspaces/:workspaceId/forms', createFormRouter({ config: {} as any, service }));
     
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'ERR', message: err.message } }));

    await withServer(app, async (baseUrl) => {
      let res = await fetch(`${baseUrl}/workspaces/${ws}/forms?limit=10`);
      let body = await res.json();
      expect(body.data).toEqual({ items: [summary], nextCursor: null });

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Survey' }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data.fields[0].id).toBe(fieldId);

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms/${fid}`);
      body = await res.json();
      expect(body.data._count.responses).toBe(0);

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms/${fid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'New' }) });
      body = await res.json();
      expect(body.data.id).toBe(fid);

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms/${fid}/fields`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Name', type: 'TEXT' }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data.label).toBe('Name');

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms/${fid}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: [{ fieldId, value: 'A' }] }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms/${fid}/responses?limit=10`);
      body = await res.json();
      expect(body.data.items[0].answers[0].field.label).toBe('Name');
      expect(body.data.nextCursor).toBeNull();

      res = await fetch(`${baseUrl}/workspaces/${ws}/forms/${fid}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });
    });
  });
});
