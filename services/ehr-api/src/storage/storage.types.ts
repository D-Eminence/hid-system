export interface UploadIntent {
  key: string;
  mediaType: string;
  sizeBytes: number;
  sha256Hex: string;
  expiresInSeconds: number;
}

export interface PresignedUpload {
  method: 'PUT';
  url: string;
  expiresInSeconds: number;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface StoredObjectMetadata {
  versionId: string;
  sizeBytes: number;
  mediaType: string;
  sha256Hex: string;
}

export interface StorageProvider {
  bucket(): string;
  checkReadiness(): Promise<void>;
  createUpload(intent: UploadIntent): Promise<PresignedUpload>;
  inspect(key: string): Promise<StoredObjectMetadata>;
  createDownload(key: string, versionId: string): Promise<{ url: string; expiresInSeconds: number }>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
