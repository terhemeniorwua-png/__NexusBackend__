import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { sendSuccess } from '../../utils/http';
import { addChannelMemberSchema, channelMemberParams, channelParams, channelWorkspaceParams, createChannelSchema, listChannelsSchema, updateChannelSchema } from './channel.schemas';
import { createChannelService } from './channel.service';

function authCtx(req: Request) { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue'); return req.auth; }
function ctx(req: Request) { return { ip: req.ip, userAgent: req.header('user-agent') }; }
export function createChannelRouter({ config, service = createChannelService() }: { config: AppConfig; service?: ReturnType<typeof createChannelService> }) {
  const router = Router({ mergeParams: true }); const auth = createRequireAuth(config); const active = createRequireActiveAccount();
  router.get('/', auth, active, validate({ params: channelWorkspaceParams, query: listChannelsSchema }), async (req,res) => { const p=req.validated!.params as {workspaceId:string}; const q=req.validated!.query as {cursor?:string;limit:number}; sendSuccess(res, await service.list({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p,...q})); });
  router.post('/', auth, active, validate({ params: channelWorkspaceParams, body: createChannelSchema }), async(req,res)=> { const p=req.validated!.params as {workspaceId:string}; const b=req.validated!.body as Parameters<typeof service.create>[0] extends infer X ? Omit<X,'userId'|'workspaceId'> : never; const { context: _omitContext, ...rest } = b as Record<string, unknown>; void _omitContext; sendSuccess(res, await service.create({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p,...(rest as typeof b)},ctx(req)),201); });
  router.get('/:channelId', auth, active, validate({params:channelParams}), async(req,res)=> { const p=req.validated!.params as {workspaceId:string;channelId:string}; sendSuccess(res,await service.get({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p})); });
  router.patch('/:channelId', auth, active, validate({params:channelParams,
  body:updateChannelSchema}), async(req,res)=> { const p=req.validated!.params as {workspaceId:string;channelId:string}; const b=req.validated!.body as {name?:string;description?:string|null}; sendSuccess(res,await service.update({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p,...b},ctx(req))); });
  router.post('/:channelId/archive', auth, active, validate({params:channelParams}), async(req,res)=> { const p=req.validated!.params as {workspaceId:string;channelId:string}; sendSuccess(res,await service.archive({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p},ctx(req))); });
  router.delete('/:channelId', auth, active, validate({params:channelParams}), async(req,res)=> { const p=req.validated!.params as {workspaceId:string;channelId:string}; await service.remove({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p},ctx(req)); sendSuccess(res,{id:p.channelId,deleted:true}); });
  router.post('/:channelId/members', auth, active, validate({params:channelParams,body:addChannelMemberSchema}), async(req,res)=> { const p=req.validated!.params as {workspaceId:string;channelId:string}; const b=req.validated!.body as {userId:string}; sendSuccess(res,await service.addMember({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)),...p,targetUserId:b.userId},ctx(req)),201); });
  router.delete('/:channelId/members/:userId', auth, active, validate({params:channelMemberParams}), async(req,res)=> { const p=req.validated!.params as {workspaceId:string;channelId:string;userId:string}; sendSuccess(res,await service.removeMember({userId:authCtx(req).userId, context:userWorkspaceAccessContext(authCtx(req)), workspaceId:p.workspaceId, channelId:p.channelId, memberUserId:p.userId},ctx(req))); });

  return router;
}
