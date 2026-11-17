import { Router, type Request, type Response } from 'express';
import { getPrismaClient } from '../../db/prisma';
import {
  listSsoConfigs,
  getSsoConfig,
  createSsoConfig,
  updateSsoConfig,
  requestDomainVerification,
  verifyDomainDnsTxt,
  generateBreakGlassCodes,
  consumeBreakGlassCode,
  checkRequireSso,
  verifySsoState,
} from './sso.service';

const router = Router();

// NOTE: In production these routes must be mounted behind authentication and
// workspace authorization middleware. Owner/admin checks are enforced in the service layer.

router.get('/workspaces/:workspaceId/configs', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const configs = await listSsoConfigs(prisma, userId, req.params.workspaceId as string);
  res.json({ configs });
});

router.get('/workspaces/:workspaceId/configs/:configId', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const item = await getSsoConfig(prisma, userId, req.params.workspaceId as string, req.params.configId as string);
  res.json(item);
});

router.post('/workspaces/:workspaceId/configs', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const item = await createSsoConfig(prisma, userId, req.params.workspaceId as string, req.body);
  res.status(201).json(item);
});

router.patch('/workspaces/:workspaceId/configs/:configId', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const item = await updateSsoConfig(prisma, userId, req.params.workspaceId as string, req.params.configId as string, req.body);
  res.json(item);
});

router.post('/workspaces/:workspaceId/configs/:configId/domains', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const record = await requestDomainVerification(prisma, userId, req.params.workspaceId as string, req.params.configId as string, req.body.domain);
  res.status(201).json(record);
});

router.post('/workspaces/:workspaceId/domains/:domainId/verify', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const record = await verifyDomainDnsTxt(prisma, userId, req.params.workspaceId as string, req.params.domainId as string);
  res.json(record);
});

router.post('/workspaces/:workspaceId/configs/:configId/break-glass-codes', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const result = await generateBreakGlassCodes(prisma, userId, req.params.workspaceId as string, req.params.configId as string, req.body.count);
  res.status(201).json(result);
});

router.post('/workspaces/:workspaceId/break-glass/consume', async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as any).auth?.userId as string;
  const result = await consumeBreakGlassCode(prisma, req.params.workspaceId as string, req.body.code, userId, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.json(result);
});

router.get('/workspaces/:workspaceId/requirement', async (_req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const result = await checkRequireSso(prisma, _req.params.workspaceId as string);
  res.json(result);
});

router.post('/callback/verify-state', async (req: Request, res: Response) => {
  const claims = await verifySsoState(req.body.provider, req.body.state);
  res.json({ claims });
});

export default router;
