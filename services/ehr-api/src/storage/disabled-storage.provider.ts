import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PresignedUpload, StorageProvider, StoredObjectMetadata, UploadIntent } from './storage.types';

@Injectable()
export class DisabledStorageProvider implements StorageProvider {
  bucket(): string { throw new ServiceUnavailableException('Document storage is disabled'); }
  checkReadiness(): Promise<void> { return Promise.resolve(); }
  createUpload(_intent: UploadIntent): Promise<PresignedUpload> {
    throw new ServiceUnavailableException('Document storage is disabled');
  }
  inspect(_key: string): Promise<StoredObjectMetadata> {
    throw new ServiceUnavailableException('Document storage is disabled');
  }
  createDownload(_key: string, _versionId: string): Promise<{ url: string; expiresInSeconds: number }> {
    throw new ServiceUnavailableException('Document storage is disabled');
  }
}
