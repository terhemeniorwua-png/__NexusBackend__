export type ProviderId = 'google_drive' | 'onedrive' | 'dropbox';

export type ExternalFile = {
  provider: ProviderId;
  externalId: string;
  name: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
  webUrl?: string;
};

export interface FileProvider {
  id: ProviderId;
  search(token: string, query: string, limit: number): Promise<ExternalFile[]>;
  download(token: string, file: { externalId: string }): Promise<{ buffer: Buffer; mimeType: string; name: string }>;
  downloadAsPdf(token: string, file: { externalId: string; mimeType?: string; name?: string }): Promise<Buffer | null>;
}
