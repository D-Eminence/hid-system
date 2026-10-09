import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getEnvironment } from './config/environment';

async function bootstrap() {
  const environment = getEnvironment();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new Logger('HidNotificationApi'));
  app.setGlobalPrefix('api/v1');
  app.use(helmet({ contentSecurityPolicy: false, hsts: environment.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(environment.PORT, '0.0.0.0');
  Logger.log(`Listening on port ${environment.PORT}`, 'Bootstrap');
}
void bootstrap();
