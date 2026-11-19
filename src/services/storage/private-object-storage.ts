import { createHash, createHmac } from 'node:crypto';
import { AppError } from '../../utils/errors';

export interface StorageGetOptions {
  /** When true, accept any content type instead of the default image-only allowlist. */
  allowAnyContentType?: boolean;
  /** Allowed content types when not allowing any. Defaults to image types for backward compatibility. */
  allowedContentTypes?: readonly string[];
  /** Maximum bytes to read into memory. Defaults to config.maxReadBytes ?? 2MB. */
  maxReadBytes?: number;
  /** App error code used when the response exceeds maxReadBytes. */
  tooLargeCode?: string;
  /** App error message used when the response exceeds maxReadBytes. */
  tooLargeMessage?: string;
  /** App error code used when content type is not allowed. */
  invalidContentTypeCode?: string;
  /** App error message used when content type is not allowed. */
  invalidContentTypeMessage?: string;
}

export interface PrivateObjectStorage {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  get(key: string, options?: StorageGetOptions): Promise<{ body: Buffer; contentType: string }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface S3CompatibleStorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  requestTimeoutMs: number;
  maxReadBytes?: number;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createS3CompatibleObjectStorage(
  config: S3CompatibleStorageConfig,
): PrivateObjectStorage {
  function assertKey(key: string): void {
    if (
      key.length === 0 ||
      key.length > 1024 ||
      key.startsWith('/') ||
      key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
      [...key].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new AppError(400, 'INVALID_OBJECT_KEY', 'The private object key is invalid');
    }
  }

  async function request(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    input?: { body: Buffer; contentType: string },
  ): Promise<Response | null> {
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new AppError(
        503,
        'OBJECT_STORAGE_UNAVAILABLE',
        'Private object storage is not configured',
      );
    }

    const endpoint = new URL(config.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== 'https:' &&
        endpoint.hostname !== 'localhost' &&
        endpoint.hostname !== '127.0.0.1')
    ) {
      throw new AppError(
        503,
        'OBJECT_STORAGE_UNAVAILABLE',
        'Private object storage configuration is invalid',
      );
    }
    assertKey(key);
    const basePath = endpoint.pathname.replace(/\/$/, '');
    endpoint.pathname = `${basePath}/${encodePathSegment(config.bucket)}/${key
      .split('/')
      .map(encodePathSegment)
      .join('/')}`;
    const body = input?.body ?? Buffer.alloc(0);
    const payloadHash = sha256(body);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const contentType = input?.contentType;
    const canonicalHeaders = [
      ...(contentType ? [`content-type:${contentType}\n`] : []),
      `host:${endpoint.host}\n`,
      `x-amz-content-sha256:${payloadHash}\n`,
      `x-amz-date:${amzDate}\n`,
    ].join('');
    const signedHeaders = [
      ...(contentType ? ['content-type'] : []),
      'host',
      'x-amz-content-sha256',
      'x-amz-date',
    ].join(';');
    const canonicalRequest = [
      method,
      endpoint.pathname,
      endpoint.searchParams.toString(),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, config.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const headers = new Headers({
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    });
    if (contentType) headers.set('content-type', contentType);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method,
        headers,
        ...(method === 'PUT' ? { body } : {}),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch {
      throw new AppError(
        502,
        'OBJECT_STORAGE_REQUEST_FAILED',
        'Private object storage is unavailable',
      );
    }
    // S3 DELETE is idempotent: an already absent key is the desired state.
    if ((method === 'HEAD' || method === 'DELETE') && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new AppError(
        502,
        'OBJECT_STORAGE_REQUEST_FAILED',
        'Private object storage rejected the request',
      );
    }
    return response;
  }

  return {
    async put(input) {
      await request('PUT', input.key, input);
    },
    async get(key, options) {
      const response = await request('GET', key);
      if (!response) throw new Error('Unexpected missing object response');
      const contentLength = Number(response.headers.get('content-length'));
      const maxReadBytes = options?.maxReadBytes ?? config.maxReadBytes ?? 2 * 1024 * 1024;
      const tooLargeCode = options?.tooLargeCode ?? 'OBJECT_STORAGE_RESPONSE_TOO_LARGE';
      const tooLargeMessage = options?.tooLargeMessage ?? 'Stored logo exceeds the supported size';
      if (Number.isFinite(contentLength) && contentLength > maxReadBytes) {
        await response.body?.cancel();
        throw new AppError(502, tooLargeCode, tooLargeMessage);
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxReadBytes) {
            await reader.cancel();
            throw new AppError(502, tooLargeCode, tooLargeMessage);
          }
          chunks.push(Buffer.from(value));
        }
      }
      const body = Buffer.concat(chunks, totalBytes);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() ?? '';
      const allowAnyContentType = options?.allowAnyContentType === true;
      const allowedContentTypes = options?.allowedContentTypes ?? ['image/png', 'image/jpeg', 'image/webp'];
      if (!allowAnyContentType && !allowedContentTypes.includes(contentType)) {
        throw new AppError(
          502,
          options?.invalidContentTypeCode ?? 'OBJECT_STORAGE_CONTENT_TYPE_INVALID',
          options?.invalidContentTypeMessage ?? 'Stored logo has an unsupported content type',
        );
      }
      return {
        body,
        contentType: contentType || 'application/octet-stream',
      };
    },
    async delete(key) {
      await request('DELETE', key);
    },
    async exists(key) {
      return (await request('HEAD', key)) !== null;
    },
  };
}
