import { type CanActivate, type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import { OutreachController } from './outreach.controller';
import { OutreachFeatures, VisitsEnabledGuard } from './outreach-features';
import { OutreachService } from './outreach.service';
import { OutreachVisitsService } from './outreach-visits.service';

// The HTTP behaviour of the 0115 routes with main.ts's ValidationPipe and
// problem filter: the global security guard first, then the switch, then the
// body. The security guard is replaced by a stand-in that admits a request
// carrying `authorization` and sets the actor as OutreachSecurityGuard does.
const facilityId = '123e4567-e89b-42d3-a456-426614174001';
const caseId = '123e4567-e89b-42d3-a456-426614174004';

class StandInSecurityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.headers.authorization) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
    request.correlationId = 'correlation-12345678';
    request.facilityId = facilityId;
    request.actor = { id: 'staff:t', subject: 'staff:t', accountId: caseId, roles: [], permissions: [],
      facilityIds: [facilityId], facilities: [], authenticationMethod: 'local',
      facility: { id: facilityId, membershipId: caseId, organizationId: facilityId, name: 'F', roles: [],
        permissions: [], isPrimary: true } };
    return true;
  }
}

async function start(visitsEnabled: boolean) {
  const visits = { list: jest.fn().mockResolvedValue({ items: [] }), create: jest.fn().mockResolvedValue({ visit: {} }),
    linkPreview: jest.fn().mockResolvedValue({ patient: { fullName: 'A', dateOfBirth: null, healthIdLast4: 'M9XA' }, canLink: true }) };
  const outreach = { linkExisting: jest.fn().mockResolvedValue({ id: caseId }) };
  const moduleRef = await Test.createTestingModule({ controllers: [OutreachController], providers: [
    { provide: OutreachService, useValue: outreach }, { provide: OutreachVisitsService, useValue: visits },
    { provide: OutreachFeatures, useValue: { visitsEnabled } }, VisitsEnabledGuard] }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalGuards(new StandInSecurityGuard());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const call = async (method: string, path: string, body?: unknown, signedIn = true) => {
    const response = await fetch(`${url.replace('[::1]', '127.0.0.1')}/api/v1/outreach/registration-cases/${path}`, {
      method, headers: { 'content-type': 'application/json', 'idempotency-key': 'visit-key-12345678',
        ...(signedIn ? { authorization: 'Bearer test' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { code?: string; errors?: unknown } };
  };
  return { app, call, visits, outreach };
}

describe('0115 routes over HTTP', () => {
  const bad = { kind: 'home', occurredOn: 'yesterday' };

  it('answer a plain 404 NOT_FOUND while OUTREACH_VISITS_ENABLED is off, whatever the body', async () => {
    const { app, call, visits } = await start(false);
    try {
      for (const [method, path, body] of [['GET', `${caseId}/visits`, undefined], ['POST', `${caseId}/visits`, bad],
        ['POST', `${caseId}/link-preview`, { healthId: 'nope' }], ['POST', `${caseId}/link-preview`, {}]] as const) {
        expect(await call(method, path, body)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
      }
      // The security guard still answers first.
      expect(await call('GET', `${caseId}/visits`, undefined, false)).toMatchObject({ status: 401,
        body: { code: 'AUTHENTICATION_REQUIRED' } });
      expect(visits.list).not.toHaveBeenCalled();
      expect(visits.linkPreview).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('validate the body and reach the service while it is on', async () => {
    const { app, call, visits } = await start(true);
    try {
      const refused = await call('POST', `${caseId}/visits`, bad);
      expect(refused).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      expect(await call('POST', `${caseId}/visits`, { kind: 'visit', occurredOn: '2026-10-30' }))
        .toMatchObject({ status: 201 });
      expect(visits.create).toHaveBeenCalledWith(caseId, expect.objectContaining({ kind: 'visit' }),
        'visit-key-12345678', expect.anything());
      expect(await call('GET', `${caseId}/visits`)).toMatchObject({ status: 200, body: { items: [] } });
      expect(await call('POST', `${caseId}/link-preview`, { healthId: ' hid-7kq2m9xa ' }))
        .toMatchObject({ status: 200, body: { canLink: true } });
      expect(visits.linkPreview).toHaveBeenCalledWith(caseId, { healthId: 'HID-7KQ2M9XA' }, expect.anything());
      expect(await call('POST', `${caseId}/link-preview`, { healthId: 'HID-1' }))
        .toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      expect(await call('GET', 'not-a-uuid/visits')).toMatchObject({ status: 400 });
    } finally { await app.close(); }
  });

  it('keep link-existing\'s canonicalPatientId form unchanged in both modes', async () => {
    for (const enabled of [false, true]) {
      const { app, call, outreach } = await start(enabled);
      try {
        expect(await call('POST', `${caseId}/link-existing`, { canonicalPatientId: caseId, expectedVersion: 1,
          reason: 'Reviewed exact Identity match' })).toMatchObject({ status: 200 });
        expect(await call('POST', `${caseId}/link-existing`, { expectedVersion: 1,
          reason: 'Reviewed exact Identity match' })).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED',
          errors: [{ field: 'canonicalPatientId' }] } });
        expect(outreach.linkExisting).toHaveBeenCalledTimes(1);
      } finally { await app.close(); }
    }
  });
});
