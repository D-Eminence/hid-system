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

/**
 * What a signed download is served as. Without it S3 answers with the object's
 * stored Content-Type (the type declared at upload). disposition defaults to
 * attachment.
 */
export interface DownloadPresentation {
  fileName: string;
  mediaType: string;
  disposition?: 'attachment' | 'inline';
}

export interface StorageProvider {
  bucket(): string;
  checkReadiness(): Promise<void>;
  createUpload(intent: UploadIntent): Promise<PresignedUpload>;
  inspect(key: string): Promise<StoredObjectMetadata>;
  inspectVersion(key: string, versionId: string,signal?:AbortSignal): Promise<StoredObjectMetadata>;
  /** The first maxBytes bytes of exactly that version (a ranged GET pinned to its VersionId). */
  readPrefix(key: string, versionId: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
  createDownload(key: string, versionId: string, presentation?: DownloadPresentation): Promise<{ url: string; expiresInSeconds: number }>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
