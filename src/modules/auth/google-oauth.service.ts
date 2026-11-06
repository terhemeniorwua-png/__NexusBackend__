import { OAuth2Client } from 'google-auth-library';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { generateSecureToken, hashSecret, safeCompare } from '../../utils/crypto';
import type { AuthService } from './auth.service';

const STATE_TTL_MS = 10 * 60_000;
const LOGIN_CODE_TTL_MS = 60_000;
const FRONTEND_CALLBACK_PATH = '/auth/google/callback';

export function createGoogleOAuthService(
  config: AppConfig,
  authService: AuthService,
  prisma: PrismaClient = getPrismaClient(),
  createOAuthClient: (
    clientId: string,
    clientSecret: string,
    callbackUrl: string,
  ) => OAuth2Client = (clientId, clientSecret, callbackUrl) =>
    new OAuth2Client(clientId, clientSecret, callbackUrl),
) {
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  const callbackUrl = config.googleCallbackUrl;

  function requireConfiguration(): void {
    if (!clientId || !clientSecret || !callbackUrl) {
      throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is not configured');
    }
  }

  function oauthClient(): OAuth2Client {
    requireConfiguration();
    return createOAuthClient(clientId, clientSecret, callbackUrl);
  }

  function frontendCallbackUrl(): string {
    if (!config.frontendUrl) {
      throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Frontend redirect is not configured');
    }
    return new URL(FRONTEND_CALLBACK_PATH, config.frontendUrl).toString();
  }

  return {
    async initiate(): Promise<string> {
      const oauth = oauthClient();
      const state = generateSecureToken();
      const nonce = generateSecureToken();
      const now = new Date();
      await prisma.googleOAuthState.deleteMany({ where: { expiresAt: { lte: now } } });
      await prisma.googleOAuthState.create({
        data: {
          stateHash: hashSecret(state),
          nonceHash: hashSecret(nonce),
          expiresAt: new Date(now.getTime() + STATE_TTL_MS),
        },
      });
      return oauth.generateAuthUrl({
        access_type: 'online',
        prompt: 'select_account',
        response_type: 'code',
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
      });
    },

    async callback(input: { code?: string; state?: string; error?: string }): Promise<string> {
      if (!input.state || input.state.length > 256) {
        throw new AppError(400, 'GOOGLE_CALLBACK_INVALID', 'The Google callback is invalid');
      }
      const stateHash = hashSecret(input.state);
      const state = await prisma.googleOAuthState.findUnique({ where: { stateHash } });
      const now = new Date();
      if (!state || state.consumedAt || state.expiresAt <= now) {
        throw new AppError(400, 'OAUTH_STATE_INVALID', 'The Google sign-in request has expired');
      }
      const claimed = await prisma.googleOAuthState.updateMany({
        where: { id: state.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) {
        throw new AppError(
          400,
          'OAUTH_STATE_INVALID',
          'The Google sign-in request has already been used',
        );
      }
      if (input.error) {
        const redirect = new URL(frontendCallbackUrl());
        redirect.searchParams.set(
          'error',
          input.error === 'access_denied' ? 'OAUTH_CANCELLED' : 'OAUTH_FAILED',
        );
        return redirect.toString();
      }
      if (!input.code || input.code.length > 2048) {
        throw new AppError(400, 'GOOGLE_CALLBACK_INVALID', 'The Google callback is invalid');
      }

      const oauth = oauthClient();
      let tokens;
      try {
        ({ tokens } = await oauth.getToken(input.code));
      } catch {
        throw new AppError(
          401,
          'GOOGLE_TOKEN_INVALID',
          'The Google authorization code is invalid or expired',
        );
      }
      if (!tokens.id_token) {
        throw new AppError(401, 'GOOGLE_TOKEN_INVALID', 'Google did not return an identity token');
      }
      let ticket;
      try {
        ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      } catch {
        throw new AppError(
          401,
          'GOOGLE_TOKEN_INVALID',
          'The Google identity token is invalid or expired',
        );
      }
      const claims = ticket.getPayload();
      if (
        !claims ||
        !claims.sub ||
        !claims.email ||
        claims.email_verified !== true ||
        typeof claims.nonce !== 'string' ||
        !safeCompare(hashSecret(claims.nonce), state.nonceHash)
      ) {
        throw new AppError(
          401,
          'GOOGLE_TOKEN_INVALID',
          'The Google identity could not be verified',
        );
      }

      const user = await authService.ensureGoogleAccount({
        subject: claims.sub,
        email: claims.email,
        name: claims.name || claims.email,
      });
      const code = generateSecureToken();
      const createdAt = new Date();
      await prisma.googleOAuthLoginCode.deleteMany({ where: { expiresAt: { lte: createdAt } } });
      await prisma.googleOAuthLoginCode.create({
        data: {
          codeHash: hashSecret(code),
          userId: user.id,
          expiresAt: new Date(createdAt.getTime() + LOGIN_CODE_TTL_MS),
        },
      });
      const redirect = new URL(frontendCallbackUrl());
      redirect.searchParams.set('code', code);
      return redirect.toString();
    },

    async exchange(code: string, ctx: { ip?: string; userAgent?: string }) {
      if (code.length < 32 || code.length > 256) {
        throw new AppError(
          400,
          'OAUTH_CODE_INVALID',
          'The Google sign-in code is invalid or expired',
        );
      }
      const codeHash = hashSecret(code);
      const now = new Date();
      const record = await prisma.googleOAuthLoginCode.findUnique({ where: { codeHash } });
      if (!record || record.consumedAt || record.expiresAt <= now) {
        throw new AppError(
          400,
          'OAUTH_CODE_INVALID',
          'The Google sign-in code is invalid or expired',
        );
      }
      const consumed = await prisma.googleOAuthLoginCode.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw new AppError(
          400,
          'OAUTH_CODE_INVALID',
          'The Google sign-in code has already been used',
        );
      }
      return authService.loginGoogleAccount(record.userId, ctx);
    },
  };
}

export type GoogleOAuthService = ReturnType<typeof createGoogleOAuthService>;
