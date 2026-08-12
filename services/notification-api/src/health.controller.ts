import { Controller, Get } from '@nestjs/common';
import { getEnvironment } from './config/environment';
@Controller('health')
export class HealthController {
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready') ready() { const mode = getEnvironment().NOTIFICATION_PROVIDER_MODE; return { status: mode === 'disabled' ? 'not_configured' : 'ready', providerMode: mode }; }
}
