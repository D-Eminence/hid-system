import { Controller, Get, Inject } from '@nestjs/common';
import { NoAudit, Public } from './common/decorators';
import { DatabaseService } from './database/database.service';
import { STORAGE_PROVIDER, type StorageProvider } from './storage/storage.types';

@Controller('health')
@Public()
@NoAudit()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    await this.database.healthCheck();
    await this.storage.checkReadiness();
    return { status: 'ready' };
  }
}
