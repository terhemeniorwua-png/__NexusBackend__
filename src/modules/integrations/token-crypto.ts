import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../../utils/errors';

/** AES-256-GCM for integration tokens. Key: INTEGRATION_ENCRYPTION_KEY (base64url, 32 bytes). */
function key(): Buffer {
  const buf = Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY ?? '', 'base64url');
  if (buf.length !== 32) {
    throw new AppError(503, 'INTEGRATIONS_NOT_CONFIGURED', 'Integration token encryption is not configured');
  }
  return buf;
}

export function encryptIntegrationToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptIntegrationToken(payload: string): string {
  const [version, iv, tag, ct] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) {
    throw new AppError(500, 'INTEGRATION_TOKEN_INVALID', 'Stored integration token is unreadable');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
