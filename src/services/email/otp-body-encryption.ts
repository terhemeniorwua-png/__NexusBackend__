import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'otpenc:v1:';

function key(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptOtpBody(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptOtpBody(value: string, secret: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, ciphertext] = value.slice(PREFIX.length).split(':');
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted OTP email body');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
