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
import { getEnvironment } from './config/environment';

async function bootstrap(): Promise<void> {
  const environment = getEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule,
    { bufferLogs: true, bodyParser: false });
  app.useLogger(new Logger('HidOutreachApi'));
  const expressApplication = app.getHttpAdapter().getInstance() as Express;
  expressApplication.set('trust proxy', environment.TRUST_PROXY_CIDRS
    ? environment.TRUST_PROXY_CIDRS.split(',').map((cidr) => cidr.trim()) : false);
  app.setGlobalPrefix('api/v1');
  app.use(preventResponseCaching);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: 256 * 1024, strict: true,
    type: ['application/json', 'application/*+json'] });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: environment.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false }));
  const allowedOrigins = new Set(environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origin is not permitted'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-match',
      'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-purpose-of-use'],
    exposedHeaders: ['location', 'x-correlation-id'],
    maxAge: 600,
  });
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
