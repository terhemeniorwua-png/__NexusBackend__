import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptProviderToken(token: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64url');
  if (key.length !== 32) throw new Error('The billing encryption key is invalid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptProviderToken(value: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64url');
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (key.length !== 32 || !ivText || !tagText || !ciphertextText)
    throw new Error('The stored billing token is invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
