// Connect these 5 functions to your existing integrations table, token
// storage, file storage and DB. Everything else works without changes.
import type { ProviderId } from './types';

export type ImportedFileRecord = {
  id: string;
  workspaceId: string;
  name: string;
  provider: ProviderId;
  externalId: string;
  originalKey: string;
  pdfKey: string | null;
};

/** Providers this user has connected (status ACTIVE). */
export async function getConnectedProviders(userId: string): Promise<ProviderId[]> {
  throw new Error('TODO: query your integrations table');
}

/** Decrypted, non-expired access token (refresh it if needed). */
export async function getAccessToken(userId: string, provider: ProviderId): Promise<string> {
  throw new Error('TODO: load + decrypt + refresh the integration token');
}

/** Find an earlier import so clicking Import twice does not duplicate. */
export async function findImported(workspaceId: string, provider: ProviderId, externalId: string): Promise<ImportedFileRecord | null> {
  throw new Error('TODO: db lookup');
}

/** Save a file in your storage (S3 / disk / etc). Return its storage key. */
export async function storagePut(workspaceId: string, filename: string, data: Buffer, mimeType: string): Promise<string> {
  throw new Error('TODO: write to your file storage');
}

/** Insert the file record in your DB. */
export async function saveImported(input: Omit<ImportedFileRecord, 'id'> & { uploadedBy: string }): Promise<ImportedFileRecord> {
  throw new Error('TODO: db insert');
}
