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

/** How a signed download presents the object: as an attachment with this name and media type. */
export interface DownloadAttachment {
  fileName: string;
  mediaType: string;
}

/**
 * The stored object version is not the one recorded (another version, no or a
 * malformed checksum, no size, or not under the required encryption). An
 * object-store failure is any other error.
 */
export class StoredObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoredObjectIntegrityError';
  }
}

export interface StorageProvider {
  bucket(): string;
  checkReadiness(): Promise<void>;
  createUpload(intent: UploadIntent): Promise<PresignedUpload>;
  inspect(key: string): Promise<StoredObjectMetadata>;
  /** The metadata of one exact version, its checksum read back from the store. */
  inspectVersion(key: string, versionId: string): Promise<StoredObjectMetadata>;
  createDownload(key: string, versionId: string, attachment?: DownloadAttachment):
    Promise<{ url: string; expiresInSeconds: number }>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
