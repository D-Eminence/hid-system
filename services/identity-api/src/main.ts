import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem';
import { preventResponseCaching } from './common/response-security.middleware';
import { globalValidationPipe } from './common/validation-problem';
import { corsOptions } from './config/cors';
import { getEnvironment } from './config/environment';

async function bootstrap(): Promise<void> {
  const environment = getEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(new Logger('HidIdentityApi'));
  const expressApplication = app.getHttpAdapter().getInstance() as Express;
  expressApplication.set('trust proxy', environment.TRUST_PROXY_CIDRS
    ? environment.TRUST_PROXY_CIDRS.split(',').map((cidr) => cidr.trim()) : false);
  app.setGlobalPrefix('api/v1');
  app.use(preventResponseCaching);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: 256 * 1024, strict: true, type: ['application/json', 'application/*+json'] });
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: environment.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  }));
  app.enableCors(corsOptions(environment.CORS_ORIGINS));
  app.useGlobalPipes(globalValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  await app.listen(environment.PORT, '0.0.0.0');
  Logger.log(`Listening at ${await app.getUrl()}`, 'Bootstrap');
}

void bootstrap();
