import 'reflect-metadata';
import { type ExecutionContext, type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { LabExecutionsController } from './lab-executions.controller';
import { LabExecutionsService } from './lab-executions.service';

// The verify body of owner decision 33.3 (migration 0111) over HTTP, with the global ValidationPipe exactly as main.ts
// sets it: selfCheck is an optional boolean on verify only; release still refuses it. Both routes answer 201, as before. The service is a fake, so a 400
// here never reaches the database.
const facilityId = '10000000-0000-4000-8000-000000000001';
const resultId = 'b0000000-0000-4000-8000-000000000001';
const permissions = ['lab.result.verify', 'lab.result.release'];
const actor: ActorContext = { kind: 'staff', id: 'staff:lab', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['lab'], permissions, facilityIds: [facilityId], authenticationMethod: 'local',
  facilities: [{ id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '30000000-0000-4000-8000-000000000001', name: 'Synthetic Laboratory', roles: ['lab'], permissions, isPrimary: true }] };
const executions = { verifyResult: jest.fn(async () => ({ id: resultId })), releaseResult: jest.fn(async () => ({ id: resultId })) };
const guard = { canActivate: jest.fn((execution: ExecutionContext) => {
  const incoming = execution.switchToHttp().getRequest<HidRequest>();
  incoming.actor = { ...actor, facility: actor.facilities[0], permissions };
  incoming.facilityId = facilityId;
  incoming.correlationId = 'lab-verify-body-0001';
  return true;
}) };

@Module({
  controllers: [LabExecutionsController],
  providers: [{ provide: LabExecutionsService, useValue: executions }, { provide: APP_GUARD, useFactory: () => guard }],
})
class LabVerifyHttpModule {}

describe('POST lab/results/:id/verify and /release bodies (owner decision 33.3)', () => {
  let app: INestApplication;
  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({ imports: [LabVerifyHttpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterEach(async () => { await app.close(); });

  const base = { expectedResultVersion: 1, occurredAt: '2026-11-03T10:00:00Z', reason: 'Only scientist on duty today' };
  const post = (operation: 'verify' | 'release', body: Record<string, unknown>) => request(app.getHttpServer())
    .post(`/api/v1/lab/results/${resultId}/${operation}`).set('Authorization', 'Bearer synthetic')
    .set('X-Facility-ID', facilityId).set('X-Purpose-Of-Use', 'direct-care').set('Idempotency-Key', 'verify-body-key-00001')
    .send(body);

  it.each([[{ selfCheck: true }, true], [{ selfCheck: false }, false], [{}, undefined]])(
    'verify accepts %j and passes selfCheck on as sent', async (extra, expected) => {
      const answer = await post('verify', { ...base, ...extra });
      expect(answer.status).toBe(201);
      expect(executions.verifyResult).toHaveBeenCalledTimes(1);
      const input = (executions.verifyResult.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      expect(input.selfCheck).toBe(expected);
      expect(input.reason).toBe(base.reason);
    });

  it.each([['true'], [1], [null], [{}]])('verify refuses selfCheck %j with 400 VALIDATION_FAILED before the service',
    async (value) => {
      const answer = await post('verify', { ...base, selfCheck: value });
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(answer.body)).toContain('selfCheck');
      expect(executions.verifyResult).not.toHaveBeenCalled();
    });

  it('release keeps its body: selfCheck is refused with 400, the ordinary body passes', async () => {
    const refused = await post('release', { ...base, selfCheck: true });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(executions.releaseResult).not.toHaveBeenCalled();
    const released = await post('release', base);
    expect(released.status).toBe(201);
    expect(executions.releaseResult).toHaveBeenCalledTimes(1);
  });
});
