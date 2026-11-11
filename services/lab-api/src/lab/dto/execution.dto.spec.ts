import 'reflect-metadata';
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import request from 'supertest';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import type { ActorContext, HidRequest } from '../../common/request-context';
import { LabExecutionsController } from '../lab-executions.controller';
import { LabExecutionsService } from '../lab-executions.service';
import { CorrectResultDto, GovernResultDto, REASON_MIN } from './execution.dto';

// Lab keeps a check, release or correction reason of 3 to 500 characters, not counting spaces at either end (0020,
// 0021), and the website asks for as many (REASON_MIN). The DTOs checked only the 500, so a reason of 1 or 2
// characters, or of spaces, reached the database and came back as a 500 (lab-release step 4).
const govern = { expectedResultVersion: 1, occurredAt: '2026-11-03T10:00:00Z', reason: 'Checked against the analyser print' };
const correct = { expectedExecutionVersion: 2, resultType: 'numeric', numericValue: 12.4, expectedResultVersion: 1,
  reason: 'Transcription error', revisionKind: 'correction' };
const MESSAGE = 'reason must be at least 3 characters';

/** The reason messages class-validator gives for a body. */
const reasonMessages = async (dto: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(dto, body) as object)).filter((error) => error.property === 'reason')
    .flatMap((error) => Object.values(error.constraints ?? {}));

describe.each([['GovernResultDto (check and release)', GovernResultDto, govern],
  ['CorrectResultDto (correction)', CorrectResultDto, correct]] as const)('%s reason', (_name, dto, body) => {
  it('asks for the 3 characters the website does', () => {
    expect(REASON_MIN).toBe(3);
  });

  it.each(['OK', 'a', '', '   ', '  ab  ', '\tab\n', '\u{1F600}\u{1F600}'])('refuses %j, which Lab would not keep, in plain words', async (reason) => {
    expect(await reasonMessages(dto, { ...body, reason })).toEqual([MESSAGE]);
  });

  it.each(['abc', '  abc  ', 'Checked', '\u{1F600}\u{1F600}\u{1F600}', 'r'.repeat(500)])('accepts %j', async (reason) => {
    expect(await reasonMessages(dto, { ...body, reason })).toEqual([]);
  });

  it('still refuses a reason over 500 characters, and leaves one that is not text to the string check', async () => {
    expect(await reasonMessages(dto, { ...body, reason: 'r'.repeat(501) })).toEqual(['reason must be shorter than or equal to 500 characters']);
    const notText = await reasonMessages(dto, { ...body, reason: 42 });
    expect(notText).toContain('reason must be a string');
    expect(notText).not.toContain(MESSAGE);
  });
});

/** The routes as lab-api serves them (main.ts's validation pipe and problem filter), with the service faked. */
describe('A short check, release or correction reason over HTTP', () => {
  const facilityId = '10000000-0000-4000-8000-000000000001';
  const resultId = 'a0000000-0000-4000-8000-000000000001';
  const executionId = '70000000-0000-4000-8000-000000000001';
  const executions = { verifyResult: jest.fn(), releaseResult: jest.fn(), correctResult: jest.fn() };
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const call of Object.values(executions)) call.mockResolvedValue({ id: resultId });
    const moduleRef = await Test.createTestingModule({ controllers: [LabExecutionsController],
      providers: [{ provide: LabExecutionsService, useValue: executions }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: unknown, next: () => void) => {
      incoming.correlationId = 'lab-reason-http-0001';
      incoming.facilityId = facilityId;
      incoming.actor = { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001', roles: ['lab'],
        permissions: ['lab.result.verify', 'lab.result.release', 'lab.result.correct'], facilityIds: [facilityId], facilities: [],
        authenticationMethod: 'local' } satisfies ActorContext;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await app.init();
  });

  afterEach(async () => { await app.close(); jest.restoreAllMocks(); });

  const post = (path: string, payload: object) => request(app.getHttpServer()).post(`/api/v1/lab/${path}`)
    .set('Authorization', 'Bearer synthetic').set('X-Purpose-Of-Use', 'direct-care')
    .set('Idempotency-Key', 'lab-reason-key-0001').send(payload);
  const ROUTES = [['check', `results/${resultId}/verify`, govern, 'verifyResult'],
    ['release', `results/${resultId}/release`, govern, 'releaseResult'],
    ['correction', `executions/${executionId}/results/${resultId}/corrections`, correct, 'correctResult']] as const;

  it.each(ROUTES)('answers a %s reason of "OK" 400 VALIDATION_FAILED, saying why, and never calls Lab', async (_name, path, body, method) => {
    const response = await post(path, { ...body, reason: 'OK' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'One or more request fields are invalid.',
      errors: [{ field: 'reason', messages: [MESSAGE] }] });
    expect(executions[method]).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('passes a %s reason of 3 characters on to Lab', async (_name, path, body, method) => {
    const response = await post(path, { ...body, reason: 'Abc' });
    expect(response.status).toBeLessThan(300);
    expect(executions[method]).toHaveBeenCalledTimes(1);
  });
});
