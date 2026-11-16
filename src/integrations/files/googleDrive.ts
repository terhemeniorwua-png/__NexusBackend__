import type { FileProvider } from './types';

const API = 'https://www.googleapis.com/drive/v3';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isNative = (m?: string) => !!m?.startsWith('application/vnd.google-apps.');

export const googleDrive: FileProvider = {
  id: 'google_drive',

  async search(token, query, limit) {
    const safe = query.replace(/['\\]/g, '\\$&');
    const params = new URLSearchParams({
      q: `name contains '${safe}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
      pageSize: String(limit),
      orderBy: 'modifiedTime desc',
    });
    const res = await fetch(`${API}/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
    const { files = [] } = (await res.json()) as any;
    return files.map((f: any) => ({
      provider: 'google_drive' as const,
      externalId: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? Number(f.size) : undefined,
      modifiedAt: f.modifiedTime,
      webUrl: f.webViewLink,
    }));
  },

  async download(token, file) {
    const metaRes = await fetch(`${API}/files/${file.externalId}?fields=name,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) throw new Error(`Drive metadata failed: ${metaRes.status}`);
    const meta = (await metaRes.json()) as any;
    const native = isNative(meta.mimeType);
    const url = native
      ? `${API}/files/${file.externalId}/export?mimeType=${encodeURIComponent(DOCX)}`
      : `${API}/files/${file.externalId}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: native ? DOCX : meta.mimeType,
      name: native && !meta.name.endsWith('.docx') ? `${meta.name}.docx` : meta.name,
    };
  },

  async downloadAsPdf(token, file) {
    if (file.mimeType === 'application/pdf') return null;
    if (!isNative(file.mimeType)) return null;
    const res = await fetch(`${API}/files/${file.externalId}/export?mimeType=application/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  },
};
