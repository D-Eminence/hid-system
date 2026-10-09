import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DisabledStorageProvider } from './disabled-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER } from './storage.types';

@Module({
  providers: [
    S3StorageProvider,
    DisabledStorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [S3StorageProvider, DisabledStorageProvider],
      useFactory: (s3: S3StorageProvider, disabled: DisabledStorageProvider) =>
        getEnvironment().STORAGE_MODE === 's3' ? s3 : disabled,
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
