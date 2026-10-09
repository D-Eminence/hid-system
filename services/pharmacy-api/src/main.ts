import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { DomainProblem, ProblemDetailsFilter } from './common/problem';
import { preventResponseCaching } from './common/response-security.middleware';
import { corsOptions } from './config/cors';
import { getEnvironment } from './config/environment';

async function bootstrap(): Promise<void> {
  const environment = getEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule,
    { bufferLogs: true, bodyParser: false });
  app.useLogger(new Logger('HidPharmacyApi'));
  const expressApplication = app.getHttpAdapter().getInstance() as Express;
  expressApplication.set('trust proxy', environment.TRUST_PROXY_CIDRS
    ? environment.TRUST_PROXY_CIDRS.split(',').map((cidr) => cidr.trim()) : false);
  app.setGlobalPrefix('api/v1');
  app.use(preventResponseCaching);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: 512 * 1024, strict: true,
    type: ['application/json', 'application/*+json'] });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: environment.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false }));
  app.enableCors(corsOptions(environment.CORS_ORIGINS));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
    forbidUnknownValues: true, transform: true,
    transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED',
      'One or more request fields are invalid.', errors.map((error) => ({ field: error.property,
        messages: Object.values(error.constraints ?? {}) }))),
  }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  await app.listen(environment.PORT, '0.0.0.0');
  Logger.log(`Listening at ${await app.getUrl()}`, 'Bootstrap');
}

void bootstrap();
