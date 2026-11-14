import type { FileProvider, ProviderId, ExternalFile } from './types';
import { googleDrive } from './googleDrive';
import { onedrive } from './onedrive';
import { dropbox } from './dropbox';
import { getConnectedProviders, getAccessToken, findImported, storagePut, saveImported } from './deps';

const providers: Record<ProviderId, FileProvider> = {
  google_drive: googleDrive,
  onedrive,
  dropbox,
};

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export async function searchExternalFiles(userId: string, query: string): Promise<ExternalFile[]> {
  const connected = (await getConnectedProviders(userId)).filter((p) => p in providers);
  const results = await Promise.allSettled(
    connected.map(async (p) => {
      const token = await getAccessToken(userId, p);
      return providers[p].search(token, query, 8);
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[files] ${connected[i]} search failed:`, r.reason?.message);
  });
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

export async function importExternalFile(userId: string, workspaceId: string, provider: ProviderId, externalId: string) {
  const existing = await findImported(workspaceId, provider, externalId);
  if (existing) return existing;

  const p = providers[provider];
  const token = await getAccessToken(userId, provider);

  const original = await p.download(token, { externalId });
  if (original.buffer.length > MAX_IMPORT_BYTES) throw new Error('File is too large to import (max 25 MB)');

  const pdf = await p.downloadAsPdf(token, { externalId, mimeType: original.mimeType, name: original.name });

  const originalKey = await storagePut(workspaceId, original.name, original.buffer, original.mimeType);
  const pdfKey = pdf ? await storagePut(workspaceId, `${original.name}.pdf`, pdf, 'application/pdf') : null;

  return saveImported({ workspaceId, uploadedBy: userId, name: original.name, provider, externalId, originalKey, pdfKey });
}
