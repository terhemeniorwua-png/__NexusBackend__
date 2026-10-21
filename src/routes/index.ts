import { Router } from 'express';
import type { AppConfig } from '../config/env';
import { createAuthRouter } from '../modules/auth/auth.routes';
import { createAuthService, type AuthService } from '../modules/auth/auth.service';
import { createUsersRouter } from '../modules/users/users.routes';
import { createUsersService, type UsersService } from '../modules/users/users.service';
import type { ReadinessProbe } from '../services/health';
import { createHealthRouter } from './health';

interface ApiRouterOptions {
  config: AppConfig;
  readinessProbe: ReadinessProbe;
  authService?: AuthService;
  usersService?: UsersService;
}

export function createApiRouter({
  config,
  readinessProbe,
  authService = createAuthService(config),
  usersService = createUsersService(),
}: ApiRouterOptions): Router {
  const router = Router();

  router.use('/health', createHealthRouter({ config, readinessProbe }));
  router.use('/auth', createAuthRouter({ config, service: authService }));
  router.use('/users', createUsersRouter({ config, service: usersService }));

  return router;
}
