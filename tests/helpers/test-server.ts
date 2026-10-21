import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Express } from 'express';

/**
 * Starts the application on an ephemeral port for the duration of a test.
 */
export async function withServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await startServer(app);

  try {
    await run(server.baseUrl);
  } finally {
    await server.close();
  }
}

export interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Starts the application and keeps it listening until it is closed.
 */
export async function startServer(app: Express): Promise<RunningServer> {
  const server = app.listen(0, '127.0.0.1') as Server;
  await once(server, 'listening');

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

/**
 * Minimal cookie jar. Node's fetch does not persist cookies, so the tests
 * keep track of them explicitly.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');

      if (!pair) {
        continue;
      }

      const separator = pair.indexOf('=');

      if (separator < 1) {
        continue;
      }

      const name = pair.slice(0, separator).trim();
      const rawValue = pair.slice(separator + 1).trim();

      if (rawValue.length === 0) {
        this.cookies.delete(name);
        continue;
      }

      try {
        this.cookies.set(name, decodeURIComponent(rawValue));
      } catch {
        this.cookies.set(name, rawValue);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }

    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ');
  }
}

export interface JsonResponse<T = unknown> {
  status: number;
  body: {
    success: boolean;
    data?: T;
    error?: { code: string; message: string; details?: unknown; requestId?: string };
  };
  response: Response;
}

/**
 * Performs a JSON request and returns the parsed response.
 */
export async function jsonRequest<T = unknown>(
  url: string,
  init: RequestInit & { jar?: CookieJar } = {},
): Promise<JsonResponse<T>> {
  const { jar, headers, ...rest } = init;

  const requestHeaders = new Headers(headers);

  if (rest.body !== undefined && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }

  const cookieHeader = jar?.header();

  if (cookieHeader) {
    requestHeaders.set('cookie', cookieHeader);
  }

  const response = await fetch(url, { ...rest, headers: requestHeaders });

  jar?.absorb(response);

  const text = await response.text();
  let body: JsonResponse<T>['body'];

  try {
    body = JSON.parse(text) as JsonResponse<T>['body'];
  } catch {
    body = {
      success: false,
      error: { code: 'INVALID_JSON', message: text.slice(0, 200) },
    };
  }

  return { status: response.status, body, response };
}
