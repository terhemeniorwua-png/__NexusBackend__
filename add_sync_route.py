with open('src/modules/integrations/integration.routes.ts', 'r') as f:
    content = f.read()

# Add Google Calendar sync route after the callback route
sync_route = '''

  // Google Calendar: incremental sync (workspace admins only).
  router.post(
    '/google-calendar/sync',
    requireAuth,
    requireActive,
    validate({ query: listSyncJobsQuerySchema }),
    async (req, res) => {
      const prisma = getPrismaClient();
      const { workspaceId } = req.query as { workspaceId: string };
      await requireWorkspaceAccess(prisma, {
        userId: userId(req),
        workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      const integration = await prisma.integration.findFirst({
        where: { provider: 'GOOGLE_CALENDAR', workspaceId },
        select: { id: true, accessTokenCiphertext: true, refreshTokenCiphertext: true, syncState: true, config: true },
      });
      if (!integration) return sendSuccess(res, { added: 0, updated: 0, deleted: 0, errors: ['Google Calendar integration not connected'] });
      const service = createIntegrationService(prisma);
      const result = await service.syncGoogleCalendarEvents(integration, prisma, workspaceId, userId(req));
      sendSuccess(res, result);
    },
  );

'''

# Find the position after the Google Calendar callback route
old_text = '''router.get('/google-calendar/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, calendarResultUrl(status));
    const parsed = calendarCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyCalendarState(state);
      const token = await exchangeCalendarCode({ code, codeVerifier: claims.codeVerifier });
      await service.connect({
        userId: claims.userId,
        provider: 'GOOGLE_CALENDAR',
        workspaceId: claims.workspaceId,
        ...token,
      });
      return done('connected');
    } catch {
      logger.warn('google_calendar_oauth_failed');
      return done('error');
    }
  });

  // Outlook Calendar is a personal connection (workspaceId null).'''

new_text = '''router.get('/google-calendar/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, calendarResultUrl(status));
    const parsed = calendarCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyCalendarState(state);
      const token = await exchangeCalendarCode({ code, codeVerifier: claims.codeVerifier });
      await service.connect({
        userId: claims.userId,
        provider: 'GOOGLE_CALENDAR',
        workspaceId: claims.workspaceId,
        ...token,
      });
      return done('connected');
    } catch {
      logger.warn('google_calendar_oauth_failed');
      return done('error');
    }
  });

  // Google Calendar: incremental sync (workspace admins only).
  router.post(
    '/google-calendar/sync',
    requireAuth,
    requireActive,
    validate({ query: listSyncJobsQuerySchema }),
    async (req, res) => {
      const prisma = getPrismaClient();
      const { workspaceId } = req.query as { workspaceId: string };
      await requireWorkspaceAccess(prisma, {
        userId: userId(req),
        workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      const integration = await prisma.integration.findFirst({
        where: { provider: 'GOOGLE_CALENDAR', workspaceId },
        select: { id: true, accessTokenCiphertext: true, refreshTokenCiphertext: true, syncState: true, config: true },
      });
      if (!integration) return sendSuccess(res, { added: 0, updated: 0, deleted: 0, errors: ['Google Calendar integration not connected'] });
      const service = createIntegrationService(prisma);
      const result = await service.syncGoogleCalendarEvents(integration, prisma, workspaceId, userId(req));
      sendSuccess(res, result);
    },
  );

  // Outlook Calendar is a personal connection (workspaceId null).'''

content = content.replace(old_text, new_text)
with open('src/modules/integrations/integration.routes.ts', 'w') as f:
    f.write(content)
print('Google Calendar sync route added')
PYEOF