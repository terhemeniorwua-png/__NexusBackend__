import type { FileProvider } from './types';

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

export const dropbox: FileProvider = {
  id: 'dropbox',

  async search(token, query, limit) {
    const res = await fetch(`${RPC}/files/search_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, options: { max_results: limit, file_status: 'active' } }),
    });
    if (!res.ok) throw new Error(`Dropbox search failed: ${res.status}`);
    const { matches = [] } = (await res.json()) as any;
    return matches
      .map((m: any) => m.metadata?.metadata)
      .filter((f: any) => f && f['.tag'] === 'file')
      .map((f: any) => ({
        provider: 'dropbox' as const,
        externalId: f.id,
        name: f.name,
        size: f.size,
        modifiedAt: f.server_modified,
      }));
  },

  async download(token, file) {
    const res = await fetch(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: file.externalId }) },
    });
    if (!res.ok) throw new Error(`Dropbox download failed: ${res.status}`);
    const meta = JSON.parse(res.headers.get('dropbox-api-result') ?? '{}');
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      name: meta.name ?? 'file',
    };
  },

  async downloadAsPdf(token, file) {
    if (file.mimeType === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf')) return null;
    const res = await fetch(`${CONTENT}/files/get_preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: file.externalId }) },
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  },
};
