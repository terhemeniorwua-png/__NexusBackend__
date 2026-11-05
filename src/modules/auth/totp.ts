import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '../../utils/errors';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encryptTotpSecret(secret: string, keyEncoded: string): string {
  const key = Buffer.from(keyEncoded, 'base64url');
  if (key.length !== 32)
    throw new AppError(
      503,
      'TOTP_CONFIGURATION_INVALID',
      'Two-factor authentication is unavailable',
    );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptTotpSecret(value: string, keyEncoded: string): string {
  const key = Buffer.from(keyEncoded, 'base64url');
  const [version, ivText, ciphertextText, tagText] = value.split('.');
  if (version !== 'v1' || key.length !== 32 || !ivText || !ciphertextText || !tagText) {
    throw new AppError(
      503,
      'TOTP_CONFIGURATION_INVALID',
      'Two-factor authentication is unavailable',
    );
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(503, 'TOTP_SECRET_UNAVAILABLE', 'Two-factor authentication is unavailable');
  }
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/g, '')) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function totpAt(secret: string, timestampMs = Date.now()): string {
  const counter = Math.floor(timestampMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, timestampMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const candidate = Buffer.from(code);
  const currentCounter = Math.floor(timestampMs / 30_000);
  for (const offset of [-1, 0, 1]) {
    const counter = currentCounter + offset;
    if (counter < 0) continue;
    const expected = Buffer.from(totpAt(secret, counter * 30_000));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected))
      return counter;
  }
  return null;
}

export function createRecoveryCode(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase();
}

export function createTotpUri(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
