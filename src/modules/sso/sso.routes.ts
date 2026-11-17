import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { getPrismaClient } from '../../db/prisma';
import { parseEnv } from '../../config/env';
import { setCookie, readCookie, clearCookie } from '../../utils/cookies';
import { AppError } from '../../utils/errors';
import { CSRF_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../auth/csrf';
import { createAuthService } from '../auth/auth.service';
import { createRateLimiter } from '../../middleware/rate-limit';
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
  disableSsoConfig,
  deleteSsoConfig,
} from './sso.service';
import {
  SSO_BROWSER_BINDING_COOKIE,
  createSsoOidcState,
  consumeSsoOidcState,
  createPkceChallenge,
  discoverOidcIssuer,
  exchangeAuthorizationCode,
  verifyIdTokenWithRemoteJwks,
  assertVerifiedIdpEmail,
  isEmailDomainAllowed,
  getVerifiedDomainsForWorkspace,
  resolveSsoUser,
  decryptClientSecret,
} from './oidc.service';

const router = Router();

const ssoStartRateLimit = createRateLimiter({
  namespace: 'sso:start',
  windowMs: 60_000,
  limit: 20,
  code: 'SSO_RATE_LIMITED',
  message: 'Too many SSO sign-in attempts. Please try again later.',
});

const ssoCallbackRateLimit = createRateLimiter({
  namespace: 'sso:callback',
  windowMs: 60_000,
  limit: 30,
  code: 'SSO_RATE_LIMITED',
  message: 'Too many SSO callback attempts. Please try again later.',
});

const ssoBreakGlassRateLimit = createRateLimiter({
  namespace: 'sso:break-glass',
  windowMs: 15 * 60_000,
  limit: 5,
  code: 'SSO_BREAK_GLASS_RATE_LIMITED',
  message: 'Too many break-glass attempts. Please try again later.',
});

function getConfig() {
  return parseEnv(process.env);
}

function assertSsoEnabled() {
  const enabled = (process.env.SSO_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    throw new AppError(404, 'SSO_DISABLED', 'SSO is not enabled');
  }
}

function cookieOptions(config: ReturnType<typeof parseEnv>) {
  return {
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
}

function setSessionCookies(res: Response, config: ReturnType<typeof parseEnv>, refreshToken: string, csrfToken: string) {
  const opts = cookieOptions(config);
  setCookie(res, REFRESH_COOKIE_NAME, refreshToken, {
    ...opts,
    httpOnly: true,
    maxAge: config.refreshTokenTtlSeconds * 1_000,
  });
  setCookie(res, CSRF_COOKIE_NAME, csrfToken, {
    ...opts,
    httpOnly: false,
    maxAge: config.refreshTokenTtlSeconds * 1_000,
  });
}

// Gate all SSO routes behind SSO_ENABLED (default false)
router.use((_req, _res, next) => {
  try {
    const enabled = (process.env.SSO_ENABLED ?? 'false').toLowerCase() === 'true';
    if (!enabled) {
      return next(new AppError(404, 'SSO_DISABLED', 'SSO is not enabled'));
    }
    next();
  } catch (e) {
    next(e);
  }
});

// --- Admin/config endpoints (owner/admin enforced in service) ---
router.get('/workspaces/:workspaceId/configs', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const configs = await listSsoConfigs(prisma, userId, req.params.workspaceId as string);
    res.json({ configs });
  } catch (e) { next(e); }
});

router.get('/workspaces/:workspaceId/configs/:configId', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const item = await getSsoConfig(prisma, userId, req.params.workspaceId as string, req.params.configId as string);
    res.json(item);
  } catch (e) { next(e); }
});

router.post('/workspaces/:workspaceId/configs', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const item = await createSsoConfig(prisma, userId, req.params.workspaceId as string, req.body);
    res.status(201).json(item);
  } catch (e) { next(e); }
});

router.patch('/workspaces/:workspaceId/configs/:configId', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const item = await updateSsoConfig(prisma, userId, req.params.workspaceId as string, req.params.configId as string, req.body);
    res.json(item);
  } catch (e) { next(e); }
});

router.post('/workspaces/:workspaceId/configs/:configId/domains', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const record = await requestDomainVerification(prisma, userId, req.params.workspaceId as string, req.params.configId as string, req.body.domain);
    res.status(201).json(record);
  } catch (e) { next(e); }
});

router.post('/workspaces/:workspaceId/domains/:domainId/verify', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const record = await verifyDomainDnsTxt(prisma, userId, req.params.workspaceId as string, req.params.domainId as string);
    res.json(record);
  } catch (e) { next(e); }
});

router.post('/workspaces/:workspaceId/configs/:configId/break-glass-codes', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const result = await generateBreakGlassCodes(prisma, userId, req.params.workspaceId as string, req.params.configId as string, req.body.count);
    res.status(201).json(result);
  } catch (e) { next(e); }
});



router.post('/workspaces/:workspaceId/break-glass/consume', ssoBreakGlassRateLimit, async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const result = await consumeBreakGlassCode(prisma, req.params.workspaceId as string, req.body.code, userId, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/workspaces/:workspaceId/requirement', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const result = await checkRequireSso(prisma, req.params.workspaceId as string);
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/workspaces/:workspaceId/configs/:configId/disable', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const result = await disableSsoConfig(prisma, userId, req.params.workspaceId as string, req.params.configId as string);
    res.json(result);
  } catch (e) { next(e); }
});

router.delete('/workspaces/:workspaceId/configs/:configId', async (req: Request, res: Response, next) => {
  try {
    const prisma = getPrismaClient();
    const userId = (req as any).auth?.userId as string;
    const result = await deleteSsoConfig(prisma, userId, req.params.workspaceId as string, req.params.configId as string);
    res.json(result);
  } catch (e) { next(e); }
});

// --- OIDC authorization-code flow with PKCE ---
router.get('/workspaces/:workspaceId/oidc/:configId/authorize', ssoStartRateLimit, async (req: Request, res: Response, next) => {
  try {
    const config = getConfig();
    const prisma = getPrismaClient();
    const workspaceId = req.params.workspaceId as string;
    const configId = req.params.configId as string;

    const ssoConfig = await prisma.workspaceSsoConfig.findFirst({
      where: { id: configId, workspaceId, providerType: 'OIDC', isEnabled: true },
    });
    if (!ssoConfig || !ssoConfig.issuer || !ssoConfig.clientId || !ssoConfig.redirectUri) {
      throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found or not enabled');
    }

    const browserBindingValue = crypto.randomBytes(32).toString('base64url');
    const stateRecord = await createSsoOidcState({
      workspaceId,
      configId,
      browserBindingValue,
      redirectUri: ssoConfig.redirectUri,
    }, prisma);

    const { codeChallenge, codeChallengeMethod } = createPkceChallenge(stateRecord.codeVerifier);
    const discovery = await discoverOidcIssuer(ssoConfig.issuer);

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', ssoConfig.clientId);
    authUrl.searchParams.set('redirect_uri', ssoConfig.redirectUri);
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', stateRecord.state);
    authUrl.searchParams.set('nonce', stateRecord.nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', codeChallengeMethod);

    setCookie(res, SSO_BROWSER_BINDING_COOKIE, browserBindingValue, {
      ...cookieOptions(config),
      httpOnly: true,
      maxAge: 10 * 60,
      path: '/',
    });

    res.redirect(authUrl.toString());
  } catch (e) { next(e); }
});

router.get('/oidc/callback', ssoCallbackRateLimit, async (req: Request, res: Response, next) => {
  try {
    const config = getConfig();
    const prisma = getPrismaClient();
    const authService = createAuthService(config);
    const { code, state, error } = req.query as Record<string, string | undefined>;

    if (error) {
      throw new AppError(400, 'SSO_PROVIDER_ERROR', 'Identity provider returned an error');
    }
    if (!code || !state) {
      throw new AppError(400, 'SSO_CALLBACK_INVALID', 'Missing code or state');
    }

    const browserBindingValue = readCookie(req, SSO_BROWSER_BINDING_COOKIE);
    if (!browserBindingValue) {
      throw new AppError(400, 'SSO_STATE_INVALID', 'Missing SSO browser binding');
    }

    // Consume state (DB-backed, single-use, bound to workspace+browser, fail closed)
    const consumed = await consumeSsoOidcState({ state, browserBindingValue }, prisma);

    const ssoConfig = await prisma.workspaceSsoConfig.findFirst({
      where: { id: consumed.configId ?? undefined, workspaceId: consumed.workspaceId, providerType: 'OIDC', isEnabled: true },
      include: { domains: true },
    });
    if (!ssoConfig || !ssoConfig.issuer || !ssoConfig.clientId || !ssoConfig.redirectUri) {
      throw new AppError(404, 'SSO_CONFIG_NOT_FOUND', 'SSO configuration not found or not enabled');
    }

    const discovery = await discoverOidcIssuer(ssoConfig.issuer);
    const clientSecret = ssoConfig.clientSecretCiphertext ? decryptClientSecret(ssoConfig.clientSecretCiphertext) : undefined;
    const tokenResponse = await exchangeAuthorizationCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: ssoConfig.clientId,
      clientSecret,
      code,
      redirectUri: ssoConfig.redirectUri,
      codeVerifier: consumed.codeVerifier,
    });

    const claims = await verifyIdTokenWithRemoteJwks({
      idToken: tokenResponse.id_token,
      jwksUri: discovery.jwks_uri,
      issuer: ssoConfig.issuer, // verify against configured issuer
      audience: ssoConfig.clientId,
      nonce: consumed.nonce,
      clockSkewSec: 60,
    });

    const email = assertVerifiedIdpEmail({ email: claims.email, email_verified: claims.email_verified });
    const verifiedDomains = await getVerifiedDomainsForWorkspace(consumed.workspaceId, prisma);
    const domainVerified = isEmailDomainAllowed(email, verifiedDomains);
    if (!domainVerified) {
      throw new AppError(403, 'SSO_DOMAIN_NOT_VERIFIED', 'Email domain is not verified for this workspace');
    }

    const resolved = await resolveSsoUser({
      workspaceId: consumed.workspaceId,
      email,
      emailVerifiedByIdp: claims.email_verified === true,
      jitEnabled: ssoConfig.jitProvisioningEnabled,
      domainVerified,
      sub: String(claims.sub ?? ''),
      provider: `oidc:${ssoConfig.providerName}`,
      name: typeof claims.name === 'string' ? claims.name : null,
    }, prisma);

    // Create session through the SAME function path as password login
    const ctx = { ip: req.ip, userAgent: req.header('user-agent') };
    const result = await authService.loginSsoAccount(resolved.userId, ctx, {
      provider: `oidc:${ssoConfig.providerName}`,
      workspaceId: consumed.workspaceId,
    });

    if ('twoFactorRequired' in result) {
      // 2FA challenge issued - redirect to frontend 2FA flow (frontend handles challenge token)
      const redirectTo = new URL(config.frontendUrl.replace(/\/+$/, '') + '/auth/2fa');
      redirectTo.searchParams.set('challengeToken', result.challengeToken);
      res.redirect(redirectTo.toString());
      return;
    }

    setSessionCookies(res, config, result.refreshToken, result.csrfToken);
    clearCookie(res, SSO_BROWSER_BINDING_COOKIE, { ...cookieOptions(config), httpOnly: true, path: '/' });

    // Redirect to frontend with success (tokens are in cookies; access token can be fetched via refresh/session flow)
    const redirectTo = new URL(config.frontendUrl.replace(/\/+$/, '') + '/auth/sso/callback');
    redirectTo.searchParams.set('status', 'success');
    res.redirect(redirectTo.toString());
  } catch (e) { next(e); }
});


export default router;
