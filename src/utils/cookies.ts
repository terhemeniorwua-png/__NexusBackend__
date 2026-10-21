import type { Request, Response } from 'express';

/**
 * Minimal cookie helpers.
 *
 * The backend does not use `cookie-parser`; only the handful of cookies that
 * the authentication flow needs are read, and Express' own `res.cookie`
 * implementation is used for writing.
 */

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  domain?: string;
  path?: string;
  maxAge?: number;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};

  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');

    if (separator < 1) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();

    if (!name || name in cookies) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}

export function readCookie(req: Request, name: string): string | undefined {
  return parseCookies(req.headers.cookie)[name];
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  options: CookieOptions = {},
): void {
  res.cookie(name, value, {
    httpOnly: options.httpOnly ?? true,
    secure: options.secure ?? false,
    sameSite: options.sameSite ?? 'lax',
    ...(options.domain ? { domain: options.domain } : {}),
    path: options.path ?? '/',
    ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
  });
}

export function clearCookie(res: Response, name: string, options: CookieOptions = {}): void {
  res.clearCookie(name, {
    httpOnly: options.httpOnly ?? true,
    secure: options.secure ?? false,
    sameSite: options.sameSite ?? 'lax',
    ...(options.domain ? { domain: options.domain } : {}),
    path: options.path ?? '/',
  });
}
