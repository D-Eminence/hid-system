import { Buffer } from 'node:buffer';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  GetObjectCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnvironment } from '../config/environment';
import type {
  PresignedUpload,
  StorageProvider,
  StoredObjectMetadata,
  UploadIntent,
} from './storage.types';

@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly environment = getEnvironment();
  private readonly client = new S3Client({
    region: this.environment.S3_REGION,
    ...(this.environment.S3_ENDPOINT ? { endpoint: this.environment.S3_ENDPOINT } : {}),
    forcePathStyle: this.environment.S3_FORCE_PATH_STYLE,
    ...(this.environment.S3_ACCESS_KEY_ID && this.environment.S3_SECRET_ACCESS_KEY
      ? { credentials: {
          accessKeyId: this.environment.S3_ACCESS_KEY_ID,
          secretAccessKey: this.environment.S3_SECRET_ACCESS_KEY,
        } }
      : {}),
  });

  bucket(): string {
    if (!this.environment.S3_BUCKET) throw new ServiceUnavailableException('Document storage is unavailable');
    return this.environment.S3_BUCKET;
  }

  async checkReadiness(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket() }));
    const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket() }));
    if (versioning.Status !== 'Enabled') {
      throw new ServiceUnavailableException('Document bucket versioning is not enabled');
    }
  }

  async createUpload(intent: UploadIntent): Promise<PresignedUpload> {
    const checksumBase64 = Buffer.from(intent.sha256Hex, 'hex').toString('base64');
    const encryption = this.environment.S3_KMS_KEY_ID ? 'aws:kms' : 'AES256';
    const command = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: intent.key,
      ContentType: intent.mediaType,
      ContentLength: intent.sizeBytes,
      ChecksumSHA256: checksumBase64,
      Metadata: { 'declared-sha256': intent.sha256Hex },
      ...(this.environment.S3_KMS_KEY_ID
        ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.environment.S3_KMS_KEY_ID }
        : { ServerSideEncryption: 'AES256' }),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: intent.expiresInSeconds });
    return {
      method: 'PUT',
      url,
      expiresInSeconds: intent.expiresInSeconds,
      requiredHeaders: {
        'content-type': intent.mediaType,
        'x-amz-checksum-sha256': checksumBase64,
        'x-amz-meta-declared-sha256': intent.sha256Hex,
        'x-amz-server-side-encryption': encryption,
        ...(this.environment.S3_KMS_KEY_ID
          ? { 'x-amz-server-side-encryption-aws-kms-key-id': this.environment.S3_KMS_KEY_ID }
          : {}),
      },
    };
  }

  async inspect(key: string): Promise<StoredObjectMetadata> {
    const result = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket(), Key: key, ChecksumMode: 'ENABLED',
    }));
    if (!result.VersionId || typeof result.ContentLength !== 'number' || !result.ContentType || !result.ChecksumSHA256) {
      throw new ServiceUnavailableException('Uploaded object metadata is incomplete');
    }
    const checksum = Buffer.from(result.ChecksumSHA256, 'base64');
    if (checksum.length !== 32) {
      throw new ServiceUnavailableException('Uploaded object checksum is invalid');
    }
    const sha256Hex = checksum.toString('hex');
    if (result.Metadata?.['declared-sha256'] !== sha256Hex) {
      throw new ServiceUnavailableException('Uploaded object checksum provenance is invalid');
    }
    if (this.environment.S3_KMS_KEY_ID) {
      if (result.ServerSideEncryption !== 'aws:kms' || !result.SSEKMSKeyId) {
        throw new ServiceUnavailableException('Uploaded object is not protected by the required KMS encryption');
      }
    } else if (result.ServerSideEncryption !== 'AES256') {
      throw new ServiceUnavailableException('Uploaded object server-side encryption is missing');
    }
    return {
      versionId: result.VersionId,
      sizeBytes: result.ContentLength,
      mediaType: result.ContentType,
      sha256Hex,
    };
  }

  async createDownload(key: string, versionId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const expiresInSeconds = 60;
    const url = await getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket(), Key: key, VersionId: versionId,
    }), { expiresIn: expiresInSeconds });
    return { url, expiresInSeconds };
  }
}
