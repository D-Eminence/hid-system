import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators';
import { DomainProblem } from './common/problem';
import { DatabaseService } from './database/database.service';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('live') live() { return { status: 'ok' }; }

  /**
   * Ready when the database answers and has the schema this image needs
   * (ORD-12: migration 0152's pharmacy.dispensings.fill_number, which every
   * work-item statement names); otherwise 503, so a deploy that reaches a
   * database without 0152 fails its health check instead of answering 500.
   */
  @Get('ready') async ready() {
    await this.database.healthCheck();
    if (!(await this.database.requiredSchemaPresent())) {
      throw new DomainProblem(503, 'PHARMACY_SCHEMA_NOT_READY',
        'The pharmacy database is not ready for this release yet.');
    }
    return { status: 'ready' };
  }
}
