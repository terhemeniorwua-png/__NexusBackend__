import 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      validated?: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
      auth?: {
        userId: string;
        sessionId: string;
        email: string;
        name: string;
        status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'PENDING_DELETION';
        authMethod: 'password' | 'social' | 'sso' | 'break_glass';
        authMethodExpiresAt?: Date | null;
      };
    }
  }
}

export {};
