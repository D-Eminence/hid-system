import { Controller, Get } from '@nestjs/common';
import { NoAudit, Public } from './common/decorators';
import { DatabaseService } from './database/database.service';

@Controller('health')
@Public()
@NoAudit()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    await this.database.healthCheck();
    return { status: 'ready' };
  }
}
