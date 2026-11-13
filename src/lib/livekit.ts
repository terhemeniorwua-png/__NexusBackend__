import { AccessToken } from 'livekit-server-sdk';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const livekitConfig = {
  get url() { return required('LIVEKIT_URL'); },
  get apiKey() { return required('LIVEKIT_API_KEY'); },
  get apiSecret() { return required('LIVEKIT_API_SECRET'); },
  // RoomServiceClient needs https, not wss
  get httpUrl() { return required('LIVEKIT_URL').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'); },
};

export async function createLivekitToken(opts: {
  userId: string;
  displayName: string;
  room: string;
  canPublish?: boolean;
  ttl?: string;
}): Promise<string> {
  const at = new AccessToken(livekitConfig.apiKey, livekitConfig.apiSecret, {
    identity: opts.userId,
    name: opts.displayName,
    ttl: opts.ttl ?? '1h',
  });
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: opts.canPublish ?? true,
    canSubscribe: true,
  });
  return at.toJwt();
}
