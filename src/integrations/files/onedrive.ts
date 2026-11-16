/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FileProvider } from './types';

const G = 'https://graph.microsoft.com/v1.0/me/drive';

export const onedrive: FileProvider = {
  id: 'onedrive',

  async search(token, query, limit) {
    const q = encodeURIComponent(query.replace(/'/g, "''"));
    const res = await fetch(`${G}/root/search(q='${q}')?$top=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`OneDrive search failed: ${res.status}`);
    const { value = [] } = (await res.json()) as any;
    return value
      .filter((i: any) => i.file)
      .map((i: any) => ({
        provider: 'onedrive' as const,
        externalId: i.id,
        name: i.name,
        mimeType: i.file.mimeType,
        size: i.size,
        modifiedAt: i.lastModifiedDateTime,
        webUrl: i.webUrl,
      }));
  },

  async download(token, file) {
    const metaRes = await fetch(`${G}/items/${file.externalId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaRes.ok) throw new Error(`OneDrive metadata failed: ${metaRes.status}`);
    const meta = (await metaRes.json()) as any;
    const res = await fetch(`${G}/items/${file.externalId}/content`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`OneDrive download failed: ${res.status}`);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: meta.file?.mimeType ?? 'application/octet-stream',
      name: meta.name,
    };
  },

  async downloadAsPdf(token, file) {
    if (file.mimeType === 'application/pdf') return null;
    const res = await fetch(`${G}/items/${file.externalId}/content?format=pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  },
};
